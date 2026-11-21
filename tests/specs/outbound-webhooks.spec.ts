// gap.md "Outbound webhooks" + the five `webhook_*` MCP tools
// Kōlea SPEC 20.2 (subscribe URLs to events; signed; retried with backoff;
// delivery log kept), 20.3 (MCP surface), and Kōlea's webhook rules: only
// public https URLs, the secret shown once, `Kolea-Signature: t=,v1=`, nothing
// from a bulk import, a failing endpoint switched off with the reason.
//
// The rule that matters most is the negative one: emitting a webhook happens
// inside consent changes, so it must never be able to fail or slow them, and a
// narrow consent action (leaving one sequence) must never be reported as a
// wide one (leaving the newsletter).
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createApiKey } from '../../src/core/api-keys.ts'
import { startBroadcast } from '../../src/core/broadcasts.ts'
import { leaveSequence, unsubscribeBroadcasts } from '../../src/core/consent.ts'
import { applyProviderEvent } from '../../src/core/events.ts'
import { publishPost } from '../../src/core/posts.ts'
import { recordSale } from '../../src/core/sales.ts'
import { importCsv } from '../../src/core/subscribers.ts'
import {
  checkWebhookUrl,
  createWebhookEndpoint,
  updateWebhookEndpoint,
  verifyWebhookSignature,
} from '../../src/core/webhooks.ts'
import type { Subscriber, WebhookDelivery, WebhookEndpoint } from '../../src/db/schema.ts'
import { messages, subscribers, webhookDeliveries, webhookEndpoints } from '../../src/db/schema.ts'
import { fakeTransportFor, type WebhookRequest } from '../../src/providers/webhooks.ts'
import { aBroadcast, aPerson, aSequence, reload } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

const ALL = ['subscribed', 'unsubscribed', 'bounced', 'complained', 'purchased', 'published']

async function anEndpoint(world: World, events: string[] = ALL) {
  const r = await createWebhookEndpoint(world.db, { url: 'https://hooks.example.com/kolea', events })
  if (!r.ok) throw new Error(r.reason)
  return r
}

const deliveries = (world: World) => world.db.select().from(webhookDeliveries).all()
const sent = (world: World) => fakeTransportFor(world.env).requests
const bodyOf = (req: WebhookRequest) => JSON.parse(req.body)

describe('Feature: the operator tells other systems what happens on the list', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: the operator adds an endpoint in the admin', () => {
    let world: World
    let response: Response
    let page: string
    let row: WebhookEndpoint | undefined

    beforeAll(async () => {
      world = createWorld()
      const body = new URLSearchParams()
      body.set('url', 'https://hooks.example.com/kolea')
      body.set('description', 'CRM sync')
      body.append('events', 'subscribed')
      body.append('events', 'unsubscribed')
      response = await world.fetch('/webhooks', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      })
      page = await response.text()
      row = await world.db.select().from(webhookEndpoints).get()
    })

    it('saves it', () => {
      expect(row?.url).toBe('https://hooks.example.com/kolea')
    })

    it('keeps only the events that were picked', () => {
      expect(row?.events).toEqual(['subscribed', 'unsubscribed'])
    })

    it('shows the signing secret on the page, once', () => {
      expect(page).toContain(row!.secret)
    })

    it('renders rather than redirects, so the secret never rides in a URL', () => {
      expect(response.status).toBe(200)
    })

    it('lists only the prefix afterwards', async () => {
      const list = await (await world.fetch('/webhooks')).text()
      expect(list).not.toContain(row!.secret)
    })
  })

  describe('Scenario: a reader leaves the newsletter and the next tick delivers it', () => {
    let world: World
    let endpoint: Awaited<ReturnType<typeof anEndpoint>>
    let reader: Subscriber
    let requestsBeforeTick: number
    let req: WebhookRequest
    let row: WebhookDelivery | undefined

    beforeAll(async () => {
      world = createWorld()
      reader = await aPerson(world, { email: 'leaver@example.test' })
      endpoint = await anEndpoint(world)
      await world.post(`/p/${reader.unsubToken}`, { action: 'unsub_broadcast', scope: 'broadcast', m: '' })
      requestsBeforeTick = sent(world).length
      await world.tick()
      req = sent(world)[0]!
      row = (await deliveries(world))[0]
    })

    it('does not POST on the consent path itself', () => {
      expect(requestsBeforeTick).toBe(0)
    })

    it('POSTs once the cron runs', () => {
      expect(sent(world)).toHaveLength(1)
    })

    it('names the event in a header', () => {
      expect(req.headers['kolea-event']).toBe('unsubscribed')
    })

    it('says it was the newsletter, not everything', () => {
      expect(bodyOf(req).data.scope).toBe('broadcasts')
    })

    it('says who', () => {
      expect(bodyOf(req).data.subscriber.email).toBe('leaver@example.test')
    })

    it('never sends the preference-center token', () => {
      expect(req.body).not.toContain(reader.unsubToken)
    })

    it('signs it with the endpoint secret', async () => {
      expect(await verifyWebhookSignature(endpoint.secret, req.body, req.headers['kolea-signature']!)).toBe(true)
    })

    it('carries the event id the body carries, for dedupe', () => {
      expect(req.headers['kolea-event-id']).toBe(bodyOf(req).id)
    })

    it('marks the delivery delivered', () => {
      expect(row?.status).toBe('delivered')
    })

    it('keeps the status code', () => {
      expect(row?.lastStatusCode).toBe(200)
    })
  })

  describe('Scenario: each fact is reported from where it happens', () => {
    let world: World
    let types: string[]
    let saleBody: { sale: { amount: number; currency: string } }
    let postBody: { post: { url: string; slug: string } }

    beforeAll(async () => {
      world = createWorld({ SITE_URL: 'https://site.example.test' })
      await anEndpoint(world)
      const joiner = await aPerson(world, { email: 'joiner@example.test' })
      await unsubscribeBroadcasts(world.db, joiner.id)
      await recordSale(world.db, { email: 'buyer@example.test', amountCents: 4100, externalId: 'ch_1' })
      await recordSale(world.db, { email: 'buyer@example.test', amountCents: 4100, externalId: 'ch_1' })
      const post = await aBroadcast(world, { subject: 'Hello world' })
      await publishPost(world.db, post)
      await publishPost(world.db, post)
      await world.tick()
      const bodies = sent(world).map(bodyOf)
      types = bodies.map((b) => b.type)
      saleBody = bodies.find((b) => b.type === 'purchased')!.data
      postBody = bodies.find((b) => b.type === 'published')!.data
    })

    it('reports a signup as subscribed', () => {
      expect(types).toContain('subscribed')
    })

    it('reports a sale once, though the charge was posted twice', () => {
      expect(types.filter((t) => t === 'purchased')).toHaveLength(1)
    })

    it('sends money as integer cents', () => {
      expect(saleBody.sale.amount).toBe(4100)
    })

    it('reports a post going up once, not every time it is re-saved', () => {
      expect(types.filter((t) => t === 'published')).toHaveLength(1)
    })

    it("gives the post's public URL", () => {
      expect(postBody.post.url).toBe(`https://site.example.test/${postBody.post.slug}`)
    })
  })

  describe('Scenario: a hard bounce, replayed by the provider', () => {
    let world: World
    let bounced: WebhookDelivery[]

    beforeAll(async () => {
      world = createWorld()
      await aPerson(world, { email: 'dead@example.test' })
      await startBroadcast(world.env, world.db, await aBroadcast(world, { subject: 'This week' }))
      const message = (await world.db.select().from(messages).get())!
      await anEndpoint(world)
      const ev = {
        providerMessageId: message.providerMessageId!,
        type: 'bounce' as const,
        hardBounce: true,
        occurredAt: new Date(),
      }
      await applyProviderEvent(world.db, ev)
      await applyProviderEvent(world.db, ev)
      bounced = (await deliveries(world)).filter((d) => d.event === 'bounced')
    })

    it('is reported once', () => {
      expect(bounced).toHaveLength(1)
    })
  })

  // ───────────────────────────────────────────── what is never reported

  describe('Scenario: a reader leaves one sequence', () => {
    let world: World
    let rows: WebhookDelivery[]

    beforeAll(async () => {
      world = createWorld()
      const reader = await aPerson(world)
      const series = await aSequence(world)
      await anEndpoint(world)
      await leaveSequence(world.db, reader.id, series.id)
      rows = await deliveries(world)
    })

    it('⭐ is not reported as unsubscribing — it is a narrower choice', () => {
      expect(rows).toHaveLength(0)
    })
  })

  describe('Scenario: the operator imports a CSV', () => {
    let world: World
    let rows: WebhookDelivery[]

    beforeAll(async () => {
      world = createWorld()
      await anEndpoint(world)
      await importCsv(world.db, 'email\nold-1@example.test\nold-2@example.test')
      rows = await deliveries(world)
    })

    it('emits nothing — an import is history, not news', () => {
      expect(rows).toHaveLength(0)
    })
  })

  describe('Scenario: endpoints that should not hear about it', () => {
    let world: World
    let rows: WebhookDelivery[]

    beforeAll(async () => {
      world = createWorld()
      await anEndpoint(world, ['purchased'])
      const off = await anEndpoint(world)
      await updateWebhookEndpoint(world.db, off.endpoint.id, { active: false })
      await aPerson(world)
      rows = await deliveries(world)
    })

    it('reaches neither one that did not pick the event nor one switched off', () => {
      expect(rows).toHaveLength(0)
    })
  })

  // ───────────────────────────────────────────── sad paths

  describe('Scenario: the receiver is down', () => {
    let world: World
    let row: WebhookDelivery | undefined
    let afterSecondTick: number

    beforeAll(async () => {
      world = createWorld()
      fakeTransportFor(world.env).respond(() => ({ ok: true, status: 503, body: 'down' }))
      await anEndpoint(world)
      await aPerson(world)
      await world.tick()
      row = (await deliveries(world))[0]
      await world.tick()
      afterSecondTick = sent(world).length
    })

    it('keeps the delivery pending', () => {
      expect(row?.status).toBe('pending')
    })

    it('counts the try', () => {
      expect(row?.attempts).toBe(1)
    })

    it('says what the receiver answered', () => {
      expect(row?.lastError).toBe('the endpoint answered 503')
    })

    it('backs off rather than trying again on the next tick', () => {
      expect(afterSecondTick).toBe(1)
    })
  })

  describe('Scenario: the last try fails, and the operator redelivers it', () => {
    let world: World
    let failed: WebhookDelivery | undefined
    let response: Response
    let redelivered: WebhookDelivery | undefined

    beforeAll(async () => {
      world = createWorld()
      const fake = fakeTransportFor(world.env)
      fake.respond(() => ({ ok: true, status: 302, body: '' }))
      await anEndpoint(world)
      await aPerson(world)
      await world.db.update(webhookDeliveries).set({ attempts: 7 })
      await world.tick()
      failed = (await deliveries(world))[0]
      fake.respond(() => ({ ok: true, status: 204, body: '' }))
      response = await world.fetch(`/webhooks/deliveries/${failed!.id}/redeliver`, { method: 'POST' })
      redelivered = (await deliveries(world))[0]
    })

    it('marks it failed, visibly', () => {
      expect(failed?.status).toBe('failed')
    })

    it('does not follow a redirect', () => {
      expect(failed?.lastError).toContain('redirects are not followed')
    })

    it('sends the operator back to the endpoint', () => {
      expect(response.headers.get('location')).toStartWith(`/webhooks/${failed!.endpointId}`)
    })

    it('delivers it on redeliver', () => {
      expect(redelivered?.status).toBe('delivered')
    })
  })

  describe('Scenario: an endpoint keeps failing', () => {
    let world: World
    let endpoint: WebhookEndpoint | undefined

    beforeAll(async () => {
      world = createWorld()
      fakeTransportFor(world.env).respond(() => ({ ok: false, error: 'connection refused' }))
      const { endpoint: e } = await anEndpoint(world)
      await world.db.update(webhookEndpoints).set({ consecutiveFailures: 14 }).where(eq(webhookEndpoints.id, e.id))
      await aPerson(world)
      await world.db.update(webhookDeliveries).set({ attempts: 7 })
      await world.tick()
      endpoint = await world.db.select().from(webhookEndpoints).get()
    })

    it('is switched off', () => {
      expect(endpoint?.isActive).toBe(false)
    })

    it('says why', () => {
      expect(endpoint?.disabledReason).toBe('switched off after 15 failed deliveries in a row')
    })
  })

  describe('Scenario: the webhook tables are broken when someone unsubscribes', () => {
    let world: World
    let after: Subscriber

    beforeAll(async () => {
      world = createWorld()
      const reader = await aPerson(world)
      await anEndpoint(world)
      await world.env.DB.prepare('DROP TABLE webhook_deliveries').run()
      await unsubscribeBroadcasts(world.db, reader.id)
      after = await reload(world, reader)
    })

    it('⭐ still unsubscribes them — a webhook can never fail the fact it reports', () => {
      expect(after.status).toBe('unsubscribed')
    })
  })

  describe('Scenario: URLs the mailer will not POST to', () => {
    const refused = [
      'http://hooks.example.com/x',
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://2130706433/x',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.5/x',
      'https://192.168.1.1/x',
      'https://[::1]/x',
      'https://[::ffff:127.0.0.1]/x',
      'https://[fd00::1]/x',
      'https://user:pass@hooks.example.com/x',
      'https://hooks.example.com:8080/x',
      'https://intranet/x',
      'https://printer.local/x',
    ]
    for (const url of refused) {
      it(`refuses ${url}`, () => {
        expect(checkWebhookUrl(url).ok).toBe(false)
      })
    }

    it('accepts a public IP literal', () => {
      expect(checkWebhookUrl('https://93.184.216.34/hook').ok).toBe(true)
    })

    it('accepts port 8443', () => {
      expect(checkWebhookUrl('https://hooks.example.com:8443/hook').ok).toBe(true)
    })
  })

  describe('Scenario: the admin refuses a private URL', () => {
    let world: World
    let response: Response
    let rows: WebhookEndpoint[]

    beforeAll(async () => {
      world = createWorld()
      response = await world.post('/webhooks', { url: 'https://169.254.169.254/', events: 'subscribed' })
      rows = await world.db.select().from(webhookEndpoints).all()
    })

    it('saves nothing', () => {
      expect(rows).toHaveLength(0)
    })

    it('says why', () => {
      expect(decodeURIComponent(response.headers.get('location') ?? '')).toContain('must be a public host')
    })
  })

  // ───────────────────────────────────────────── agents

  describe('Scenario: an agent works with webhooks over MCP', () => {
    let world: World
    let refused: string
    let allowedWorld: World
    let created: { id: number; secret: string }
    let listed: { id: number; url: string }[]

    async function call(w: World, token: string, name: string, args: Record<string, unknown>) {
      const res = await w.fetch('/mcp/s3cret', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      })
      const text = await res.text()
      const json = JSON.parse(text.slice(text.indexOf('{')))
      return json.result.content[0].text as string
    }

    beforeAll(async () => {
      world = createWorld({ MCP_PATH_SECRET: 's3cret' })
      const { token } = await createApiKey(world.db, 'agent', 'admin')
      const args = { url: 'https://hooks.example.com/agent', events: ['subscribed'] }
      refused = await call(world, token, 'webhook_create', args)

      allowedWorld = createWorld({ MCP_PATH_SECRET: 's3cret', MCP_ALLOW_SENSITIVE: 'true' })
      const allowed = await createApiKey(allowedWorld.db, 'agent', 'admin')
      created = JSON.parse(await call(allowedWorld, allowed.token, 'webhook_create', args))
      listed = JSON.parse(await call(allowedWorld, allowed.token, 'webhook_list', {}))
    })

    it('refuses webhook_create until sensitive changes are switched on', () => {
      expect(refused).toContain('MCP_ALLOW_SENSITIVE')
    })

    it('creates it once they are, returning the secret', () => {
      expect(created.secret).toStartWith('whsec_')
    })

    it('lists it without the secret', () => {
      expect(JSON.stringify(listed)).not.toContain(created.secret)
    })
  })
})
