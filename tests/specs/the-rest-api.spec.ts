// REST API: /api/v1 over subscribers, tags, segments, forms,
// broadcasts, sequences, templates, posts, topics, site, sales and stats, with
// an OpenAPI document and keys scoped send / read / admin.
// The rules: the API and its scopes, `send` reaching only the transactional
// endpoint; preflight tokens guard sending a broadcast and activating a
// sequence for the API as for MCP; a per-key rate, 429 with Retry-After; one
// error shape naming the field; unsubscribing is broadcast-scoped; a single
// active create is a signup, and pending starts nothing.
//
// Decisions: ids are the integer row ids. Paging is page / per_page /
// has_more. A `send` key reaches nothing in v1 — `send` is "POST /api/send and
// nothing else", and that is outside v1. The agent send switch does not apply
// to a REST key; the preflight token does.
import { beforeAll, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { createApiKey, RATE_LIMIT_PER_MINUTE, revokeApiKey } from '../../src/core/api-keys.ts'
import { recordSale } from '../../src/core/sales.ts'
import { enroll } from '../../src/core/sequences.ts'
import {
  type AuditEntry,
  type Subscriber,
  apiRateWindows,
  auditEntries,
  broadcasts,
  sequenceEnrollments,
  subscribers,
  suppressions,
} from '../../src/db/schema.ts'
import { aBroadcast, aPerson, aSequence, aTag, enrollmentOf, reload } from '../support/factories.ts'
import { setAgentSwitches } from '../../src/core/agents.ts'
import { createWorld, type World } from '../support/world.ts'

type Json = Record<string, any>

interface Answer {
  status: number
  body: Json
  headers: Headers
  text: string
}

async function call(world: World, token: string | null, method: string, path: string, body?: unknown): Promise<Answer> {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await world.fetch(`/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: Json = {}
  try {
    parsed = JSON.parse(text)
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed, headers: res.headers, text }
}

async function keys(world: World) {
  return {
    admin: (await createApiKey(world.db, 'Admin', 'admin')).token,
    read: (await createApiKey(world.db, 'Reader', 'read')).token,
    send: (await createApiKey(world.db, 'Checkout', 'send')).token,
  }
}

function apiWorld(): World {
  return createWorld({ SITE_URL: 'https://site.example.test' })
}

describe('Feature: programs work the mailer through /api/v1', () => {
  // ───────────────────────────────────────────── happy paths

  describe('Scenario: a program adds a subscriber and looks after them', () => {
    let world: World
    let created: Answer
    let fetched: Answer
    let listed: Answer
    let patched: Answer
    let tagged: Answer
    let row: Subscriber

    beforeAll(async () => {
      world = apiWorld()
      const { admin, read } = await keys(world)
      created = await call(world, admin, 'POST', '/subscribers', {
        email: 'Ada@Example.test',
        name: 'Ada',
        tags: ['Customer'],
        unknown_field: 'dropped',
      })
      const id = created.body.data.subscriber.id
      fetched = await call(world, read, 'GET', `/subscribers/${id}`)
      listed = await call(world, read, 'GET', '/subscribers?per_page=10')
      patched = await call(world, admin, 'PATCH', `/subscribers/${id}`, { name: 'Ada Lovelace' })
      tagged = await call(world, admin, 'POST', `/subscribers/${id}/tags`, { tags: ['Speaker'] })
      row = (await world.db.select().from(subscribers).where(eq(subscribers.id, id)).get())!
    })

    it('answers the create with 201', () => {
      expect(created.status).toBe(201)
    })

    it('says the person was created', () => {
      expect(created.body.data.outcome).toBe('created')
    })

    it('stores the address normalized', () => {
      expect(fetched.body.data.email).toBe('ada@example.test')
    })

    it('shows the tag the create applied', () => {
      expect(fetched.body.data.tags.map((t: Json) => t.name)).toEqual(['Customer'])
    })

    it('lists them', () => {
      expect(listed.body.data.map((s: Json) => s.email)).toEqual(['ada@example.test'])
    })

    it('pages the list', () => {
      expect([listed.body.page, listed.body.per_page, listed.body.has_more]).toEqual([1, 10, false])
    })

    it('renames them', () => {
      expect(patched.body.data.name).toBe('Ada Lovelace')
    })

    it('tags them by name', () => {
      expect(tagged.body.data.subscriber.tags.map((t: Json) => t.name).sort()).toEqual(['Customer', 'Speaker'])
    })

    it('⭐ never returns their unsubscribe token', () => {
      expect([created.text, fetched.text, listed.text, patched.text, tagged.text].join('')).not.toContain(row.unsubToken)
    })
  })

  describe('Scenario: one person added through the API is a signup; a pending one is not', () => {
    let world: World
    let activeEnrollment: unknown
    let pendingEnrollment: unknown

    beforeAll(async () => {
      world = apiWorld()
      const { admin } = await keys(world)
      const welcome = await aSequence(world, { name: 'Welcome', trigger: 'subscribe' })
      const a = await call(world, admin, 'POST', '/subscribers', { email: 'joiner@example.test' })
      const p = await call(world, admin, 'POST', '/subscribers', { email: 'buyer@example.test', status: 'pending' })
      const enrolled = async (id: number) =>
        await world.db
          .select()
          .from(sequenceEnrollments)
          .where(and(eq(sequenceEnrollments.subscriberId, id), eq(sequenceEnrollments.sequenceId, welcome.id)))
          .get()
      activeEnrollment = await enrolled(a.body.data.subscriber.id)
      pendingEnrollment = await enrolled(p.body.data.subscriber.id)
    })

    it('enrolls an active new subscriber in the welcome series', () => {
      expect(activeEnrollment).toBeDefined()
    })

    it('starts nothing for a pending one', () => {
      expect(pendingEnrollment).toBeUndefined()
    })
  })

  describe('Scenario: tags and segments', () => {
    let world: World
    let tagCreated: Answer
    let renamed: Answer
    let tagList: Answer
    let segCreated: Answer
    let segUpdated: Answer
    let segList: Answer

    beforeAll(async () => {
      world = apiWorld()
      const { admin, read } = await keys(world)
      await aPerson(world, { tags: ['VIP'] })
      tagCreated = await call(world, admin, 'POST', '/tags', { name: 'Launch' })
      renamed = await call(world, admin, 'PATCH', `/tags/${tagCreated.body.data.id}`, { name: 'Launch 2026' })
      tagList = await call(world, read, 'GET', '/tags')
      const vip = tagList.body.data.find((t: Json) => t.name === 'VIP')
      segCreated = await call(world, admin, 'POST', '/segments', { name: 'VIPs', rule: { include_tag_ids: [vip.id] } })
      segUpdated = await call(world, admin, 'PATCH', `/segments/${segCreated.body.data.id}`, { name: 'Our VIPs' })
      segList = await call(world, read, 'GET', '/segments')
    })

    it('creates a tag', () => {
      expect(tagCreated.status).toBe(201)
    })

    it('renames it', () => {
      expect(renamed.body.data.name).toBe('Launch 2026')
    })

    it('counts who carries each tag', () => {
      expect(tagList.body.data.find((t: Json) => t.name === 'VIP').subscribers).toBe(1)
    })

    it('saves a segment and sizes it', () => {
      expect(segCreated.body.data.size).toBe(1)
    })

    it('renames the segment', () => {
      expect(segUpdated.body.data.name).toBe('Our VIPs')
    })

    it('lists segments', () => {
      expect(segList.body.data.map((s: Json) => s.name)).toEqual(['Our VIPs'])
    })
  })

  describe('Scenario: a form is made and changed', () => {
    let world: World
    let created: Answer
    let patched: Answer
    let listed: Answer

    beforeAll(async () => {
      world = apiWorld()
      const { admin, read } = await keys(world)
      created = await call(world, admin, 'POST', '/forms', { name: 'Newsletter', slug: 'news' })
      patched = await call(world, admin, 'PATCH', `/forms/${created.body.data.id}`, { success_message: 'Thanks!' })
      listed = await call(world, read, 'GET', '/forms')
    })

    it('creates it with double opt-in on', () => {
      expect(created.body.data.doubleOptIn).toBe(true)
    })

    it('gives its endpoint', () => {
      expect(created.body.data.endpoint).toBe('https://mail.example.test/f/news')
    })

    it('changes only the field given', () => {
      expect([patched.body.data.name, patched.body.data.successMessage]).toEqual(['Newsletter', 'Thanks!'])
    })

    it('lists it', () => {
      expect(listed.body.data.length).toBe(1)
    })
  })

  describe('Scenario: a broadcast is drafted, previewed, and sent with its preflight token', () => {
    let world: World
    let created: Answer
    let patched: Answer
    let withoutToken: Answer
    let preflight: Answer
    let sent: Answer
    let replay: Answer
    let status: string | undefined

    beforeAll(async () => {
      world = apiWorld()
      await setAgentSwitches(world.db, { allowSend: true })
      const { admin } = await keys(world)
      await aPerson(world, { email: 'reader@example.test' })
      created = await call(world, admin, 'POST', '/broadcasts', { subject: 'Hello', body_markdown: 'First draft.' })
      const id = created.body.data.id
      patched = await call(world, admin, 'PATCH', `/broadcasts/${id}`, { subject: 'Hello, readers' })
      withoutToken = await call(world, admin, 'POST', `/broadcasts/${id}/send`, { preflight_token: 'made-up' })
      preflight = await call(world, admin, 'POST', `/broadcasts/${id}/preflight`)
      sent = await call(world, admin, 'POST', `/broadcasts/${id}/send`, { preflight_token: preflight.body.data.preflight_token })
      replay = await call(world, admin, 'POST', `/broadcasts/${id}/send`, { preflight_token: preflight.body.data.preflight_token })
      status = (await world.db.select().from(broadcasts).where(eq(broadcasts.id, id)).get())?.status
    })

    it('creates a draft', () => {
      expect(created.body.data.status).toBe('draft')
    })

    it('edits the draft', () => {
      expect(patched.body.data.subject).toBe('Hello, readers')
    })

    it('⭐ refuses to send without a real preflight token', () => {
      expect(withoutToken.status).toBe(409)
    })

    it('says the preflight token was the problem', () => {
      expect(withoutToken.body.error.field).toBe('preflight_token')
    })

    it('previews who it would reach', () => {
      expect(preflight.body.data.willReceive).toBe(1)
    })

    it('accepts the send with the token', () => {
      expect(sent.status).toBe(202)
    })

    it('starts the send', () => {
      expect(status).not.toBe('draft')
    })

    it('⭐ refuses the same token twice', () => {
      expect(replay.status).toBe(409)
    })
  })

  describe('Scenario: a sequence is made, previewed and taken live', () => {
    let world: World
    let created: Answer
    let patched: Answer
    let activatedWithout: Answer
    let activated: Answer
    let fetched: Answer

    beforeAll(async () => {
      world = apiWorld()
      await setAgentSwitches(world.db, { allowSend: true })
      const { admin, read } = await keys(world)
      const built = await aSequence(world, { name: 'Course', active: false })
      created = await call(world, admin, 'POST', '/sequences', { name: 'Onboarding', trigger: 'manual' })
      patched = await call(world, admin, 'PATCH', `/sequences/${created.body.data.id}`, { description: 'Five days' })
      activatedWithout = await call(world, admin, 'POST', `/sequences/${built.id}/activate`, { preflight_token: 'nope' })
      const pre = await call(world, admin, 'POST', `/sequences/${built.id}/preflight`)
      activated = await call(world, admin, 'POST', `/sequences/${built.id}/activate`, { preflight_token: pre.body.data.preflight_token })
      fetched = await call(world, read, 'GET', `/sequences/${built.id}`)
    })

    it('creates it paused', () => {
      expect(created.body.data.isActive).toBe(false)
    })

    it('changes its description', () => {
      expect(patched.body.data.description).toBe('Five days')
    })

    it('⭐ refuses to activate without a preflight token', () => {
      expect(activatedWithout.status).toBe(409)
    })

    it('activates with the token', () => {
      expect(activated.body.data.isActive).toBe(true)
    })

    it('shows its steps', () => {
      expect(fetched.body.data.steps.length).toBe(1)
    })
  })

  describe('Scenario: transactional templates', () => {
    let world: World
    let created: Answer
    let patched: Answer
    let fetched: Answer
    let listed: Answer

    beforeAll(async () => {
      world = apiWorld()
      const { admin, read } = await keys(world)
      created = await call(world, admin, 'POST', '/templates', {
        name: 'Receipt',
        subject: 'Your {{product}}',
        body_md: 'Thanks for buying {{product}}.',
      })
      patched = await call(world, admin, 'PATCH', '/templates/receipt', { is_active: false })
      fetched = await call(world, read, 'GET', '/templates/receipt')
      listed = await call(world, read, 'GET', '/templates')
    })

    it('creates one with a slug from its name', () => {
      expect(created.body.data.slug).toBe('receipt')
    })

    it('names the variables it asks for', () => {
      expect(created.body.data.variables).toEqual(['product'])
    })

    it('switches it off', () => {
      expect(patched.body.data.isActive).toBe(false)
    })

    it('reads it by slug', () => {
      expect(fetched.body.data.sent).toBe(0)
    })

    it('lists it', () => {
      expect(listed.body.data.length).toBe(1)
    })
  })

  describe('Scenario: posts, topics and the site', () => {
    let world: World
    let published: Answer
    let fetched: Answer
    let listed: Answer
    let patched: Answer
    let topic: Answer
    let site: Answer

    beforeAll(async () => {
      world = apiWorld()
      const { admin, read } = await keys(world)
      const id = await aBroadcast(world, { subject: 'A long letter' })
      published = await call(world, admin, 'POST', `/posts/${id}/publish`, { topics: ['Craft'] })
      fetched = await call(world, read, 'GET', `/posts/${id}`)
      listed = await call(world, read, 'GET', '/posts')
      patched = await call(world, admin, 'PATCH', `/posts/${id}`, { excerpt: 'In short.' })
      topic = await call(world, admin, 'PATCH', '/topics/craft', { description: 'On making things' })
      site = await call(world, admin, 'PATCH', '/site', { title: 'Plover Notes', social: { github: 'https://github.com/example' } })
    })

    it('publishes a broadcast as a post', () => {
      expect(published.body.data.published).toBe(true)
    })

    it('puts it under its topic', () => {
      expect(published.body.data.url).toStartWith('https://site.example.test/craft/')
    })

    it('reads the post', () => {
      expect(fetched.body.data.subject).toBe('A long letter')
    })

    it('lists posts', () => {
      expect(listed.body.data.length).toBe(1)
    })

    it('keeps it live through a metadata edit', () => {
      expect(patched.body.data.published).toBe(true)
    })

    it('describes the topic', () => {
      expect(topic.body.data.description).toBe('On making things')
    })

    it('renames the site', () => {
      expect(site.body.data.title).toBe('Plover Notes')
    })

    it('sets a social link', () => {
      expect(site.body.data.profile.social.github).toBe('https://github.com/example')
    })
  })

  describe('Scenario: sales and stats are read in integer cents', () => {
    let world: World
    let listed: Answer
    let fetched: Answer
    let stats: Answer

    beforeAll(async () => {
      world = apiWorld()
      const { read } = await keys(world)
      await recordSale(world.db, { email: 'buyer@example.test', amountCents: 4100, product: 'Course', externalId: 'ch_1' })
      listed = await call(world, read, 'GET', '/sales')
      fetched = await call(world, read, 'GET', `/sales/${listed.body.data[0].id}`)
      stats = await call(world, read, 'GET', '/stats')
    })

    it('lists the sale', () => {
      expect(listed.body.data[0].amountCents).toBe(4100)
    })

    it('reads one sale', () => {
      expect(fetched.body.data.product).toBe('Course')
    })

    it('reports revenue in the overview', () => {
      expect(stats.body.data.revenue[0].cents).toBe(4100)
    })
  })

  describe('Scenario: the API describes itself', () => {
    let doc: Answer

    beforeAll(async () => {
      doc = await call(apiWorld(), null, 'GET', '/openapi.json')
    })

    it('serves OpenAPI 3.1 without a key', () => {
      expect(doc.body.openapi).toBe('3.1.0')
    })

    it('documents every resource', () => {
      expect(
        ['/subscribers', '/tags', '/segments', '/forms', '/broadcasts', '/sequences', '/templates', '/posts', '/topics', '/site', '/sales', '/stats'].every(
          (p) => p in doc.body.paths,
        ),
      ).toBe(true)
    })

    it('documents a body schema', () => {
      expect(doc.body.paths['/subscribers'].post.requestBody.content['application/json'].schema.required).toContain('email')
    })
  })

  // ───────────────────────────────────────────── consent

  describe('Scenario: ⭐ an API unsubscribe takes someone off broadcasts and leaves their series running', () => {
    let world: World
    let answer: Answer
    let reader: Subscriber
    let enrollment: Awaited<ReturnType<typeof enrollmentOf>>
    let suppressed: unknown

    beforeAll(async () => {
      world = apiWorld()
      const { admin } = await keys(world)
      reader = await aPerson(world, { email: 'reader@example.test' })
      const course = await aSequence(world, { name: 'The course' })
      await enroll(world.db, course.id, reader.id)
      answer = await call(world, admin, 'POST', `/subscribers/${reader.id}/unsubscribe`)
      enrollment = await enrollmentOf(world, reader, course.id)
      suppressed = await world.db.select().from(suppressions).where(eq(suppressions.email, reader.email)).get()
      reader = await reload(world, reader)
    })

    it('says they are unsubscribed', () => {
      expect(answer.body.data.outcome).toBe('unsubscribed')
    })

    it('marks them off the newsletter', () => {
      expect(reader.status).toBe('unsubscribed')
    })

    it('⭐ leaves their sequence enrollment active', () => {
      expect(enrollment?.status).toBe('active')
    })

    it('⭐ writes no suppression', () => {
      expect(suppressed).toBeUndefined()
    })
  })

  // ───────────────────────────────────────────── the door

  describe('Scenario: keys that may not do the thing are turned away', () => {
    let world: World
    let noKey: Answer
    let revoked: Answer
    let readPost: Answer
    let sendGet: Answer
    let readGet: Answer

    beforeAll(async () => {
      world = apiWorld()
      const { read, send } = await keys(world)
      const gone = await createApiKey(world.db, 'Old', 'admin')
      await revokeApiKey(world.db, gone.id)
      noKey = await call(world, null, 'GET', '/subscribers')
      revoked = await call(world, gone.token, 'GET', '/subscribers')
      readPost = await call(world, read, 'POST', '/tags', { name: 'Nope' })
      sendGet = await call(world, send, 'GET', '/subscribers')
      readGet = await call(world, read, 'GET', '/subscribers')
    })

    it('answers no key with 401', () => {
      expect(noKey.status).toBe(401)
    })

    it('answers in the one error shape', () => {
      expect(noKey.body.error.code).toBe('unauthorized')
    })

    it('answers a revoked key with 401', () => {
      expect(revoked.status).toBe(401)
    })

    it('refuses a read key a write with 403', () => {
      expect(readPost.status).toBe(403)
    })

    it('refuses a send key everything in v1', () => {
      expect(sendGet.status).toBe(403)
    })

    it('lets a read key read', () => {
      expect(readGet.status).toBe(200)
    })
  })

  describe('Scenario: ⭐ a key tries to send while agent sending is switched off', () => {
    // MCP authenticates with the same admin keys, so the switch must hold here too.
    let world: World
    let res: Answer

    beforeAll(async () => {
      world = apiWorld()
      const { admin } = await keys(world)
      await aPerson(world, { email: 'reader@example.test' })
      const created = await call(world, admin, 'POST', '/broadcasts', { subject: 'Hi', body_markdown: 'Body.' })
      const id = (created.body as { data: { id: number } }).data.id
      res = await call(world, admin, 'POST', `/broadcasts/${id}/send`, { preflight_token: 'x' })
    })

    it('is refused', () => {
      expect(res.status).toBe(403)
    })
  })

  describe('Scenario: ⭐ a key tries to erase someone while sensitive changes are off', () => {
    let world: World
    let res: Answer

    beforeAll(async () => {
      world = apiWorld()
      const { admin } = await keys(world)
      const p = await aPerson(world, { email: 'gone@example.test' })
      res = await call(world, admin, 'DELETE', `/subscribers/${p.id}?confirm_email=gone@example.test`)
    })

    it('is refused', () => {
      expect(res.status).toBe(403)
    })
  })

  describe('Scenario: a segment naming more tags than one query can bind', () => {
    let world: World
    let res: Answer

    beforeAll(async () => {
      world = apiWorld()
      const { admin } = await keys(world)
      const ids: number[] = []
      for (let i = 0; i < 25; i++) ids.push(await aTag(world, `t${i}`))
      const more: number[] = []
      for (let i = 25; i < 50; i++) more.push(await aTag(world, `t${i}`))
      const exclude: number[] = []
      for (let i = 50; i < 75; i++) exclude.push(await aTag(world, `t${i}`))
      res = await call(world, admin, 'POST', '/segments', {
        name: 'Huge',
        rule: { include_tag_ids: ids, exclude_tag_ids: exclude, fields: [] },
      })
    })

    it('is refused rather than saved and left to break the segments screen', () => {
      expect(res.status).toBe(422)
    })
  })

  describe('Scenario: a key over its rate is told to wait', () => {
    let answer: Answer

    beforeAll(async () => {
      const world = apiWorld()
      const key = await createApiKey(world.db, 'Busy', 'read')
      await world.db
        .insert(apiRateWindows)
        .values({ apiKeyId: key.id, minute: Math.floor(Date.now() / 60_000), count: RATE_LIMIT_PER_MINUTE })
      answer = await call(world, key.token, 'GET', '/tags')
    })

    it('answers 429', () => {
      expect(answer.status).toBe(429)
    })

    it('says when to come back', () => {
      expect(Number(answer.headers.get('retry-after'))).toBeGreaterThan(0)
    })
  })

  describe('Scenario: bad input is refused naming the field', () => {
    let world: World
    let missingEmail: Answer
    let badStatus: Answer
    let longSubject: Answer
    let notJson: Answer
    let unknownId: Answer
    let badAddress: Answer

    beforeAll(async () => {
      world = apiWorld()
      const { admin } = await keys(world)
      missingEmail = await call(world, admin, 'POST', '/subscribers', { name: 'No address' })
      badStatus = await call(world, admin, 'POST', '/subscribers', { email: 'a@example.test', status: 'unsubscribed' })
      longSubject = await call(world, admin, 'POST', '/broadcasts', { subject: 'x'.repeat(501), body_markdown: 'Hi' })
      notJson = await call(world, admin, 'POST', '/tags', 'not json')
      unknownId = await call(world, admin, 'GET', '/subscribers/999')
      badAddress = await call(world, admin, 'POST', '/subscribers', { email: 'not-an-address' })
    })

    it('answers a missing field with 422', () => {
      expect(missingEmail.status).toBe(422)
    })

    it('names the missing field', () => {
      expect(missingEmail.body.error.field).toBe('email')
    })

    it('⭐ will not create anyone as unsubscribed', () => {
      expect(badStatus.body.error.field).toBe('status')
    })

    it('caps sizes', () => {
      expect(longSubject.body.error.field).toBe('subject')
    })

    it('answers a body that is not JSON with 400', () => {
      expect(notJson.status).toBe(400)
    })

    it('answers an unknown id with 404', () => {
      expect(unknownId.status).toBe(404)
    })

    it('refuses an address that is not one, naming it', () => {
      expect(badAddress.body.error.field).toBe('email')
    })
  })

  describe('Scenario: every write a key makes is in the audit trail, refusals included', () => {
    let world: World
    let entries: AuditEntry[]
    let keyId: number

    beforeAll(async () => {
      world = apiWorld()
      const admin = await createApiKey(world.db, 'Audited', 'admin')
      const read = await createApiKey(world.db, 'Audited reader', 'read')
      keyId = admin.id
      await call(world, admin.token, 'POST', '/tags', { name: 'Launch' })
      await call(world, admin.token, 'GET', '/tags')
      await call(world, read.token, 'POST', '/tags', { name: 'Nope' })
      entries = await world.db.select().from(auditEntries).orderBy(auditEntries.id).all()
    })

    it('records the write and the refusal, not the read', () => {
      expect(entries.map((e) => [e.action, e.outcome])).toEqual([
        ['POST /api/v1/tags', 'ok'],
        ['POST /api/v1/tags', 'denied'],
      ])
    })

    it('attributes the write to the key', () => {
      expect(entries[0]?.apiKeyId).toBe(keyId)
    })

    it('keeps the refusal’s reason', () => {
      expect(entries[1]?.detail).toContain('scope')
    })
  })
})
