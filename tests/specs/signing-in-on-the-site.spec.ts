// Signing in on the site, and posts only members can read
//
// Members and Premium (the members half).
// The rules: a member IS the subscriber row; the magic link is single-use,
// hashed, 20 minutes, system mail through the transactional consent rule, with
// the same answer for unknown addresses, and never creates a subscriber
// (confirmation button, HttpOnly SameSite=Lax cookie, Origin-checked POSTs,
// sign-out); signing in never changes consent; access levels; teaser + call to
// action, no-store; feed, search and excerpt never carry a gated body.
//
// Everything is driven through `worker.fetch` on the site's hostname. Mail
// goes to the console provider; the link is read back out of the outbox.
import { beforeAll, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { unsubscribeBroadcasts } from '../../src/core/consent.ts'
import { publishPost } from '../../src/core/posts.ts'
import { memberSessions, memberSignInLinks, messages, subscribers, suppressions } from '../../src/db/schema.ts'
import { aBroadcast, aPerson } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

const SITE = 'https://site.example.test'
const SECRET = 'test-member-secret-0123456789abcdef'
const SECRET_LINE = 'The secret ingredient is patience and a very hot pan.'

function siteWorld(extra: Record<string, string> = {}): World {
  return createWorld({ SITE_URL: SITE, SITE_TITLE: 'Field Notes', MEMBER_SESSION_SECRET: SECRET, ...extra })
}

/** A form post from the site's own pages, the way a browser sends one. */
function sitePost(w: World, path: string, form: Record<string, string>, headers: Record<string, string> = {}) {
  return w.fetch(`${SITE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', Origin: SITE, ...headers },
    body: new URLSearchParams(form),
    redirect: 'manual',
  })
}

function get(w: World, path: string, cookie?: string) {
  return w.fetch(`${SITE}${path}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' })
}

/** The token in the newest sign-in mail to `email`. */
async function linkTokenFor(w: World, email: string): Promise<string> {
  const mail = (await w.outbox()).filter((m) => m.toEmail === email).at(-1)
  const token = /members\/verify\?token=([a-z0-9]+)/.exec(mail?.html ?? '')?.[1]
  if (!token) throw new Error(`no sign-in link mailed to ${email}`)
  return token
}

/** `name=value` from a Set-Cookie header, ready to send back. */
function cookieFrom(res: Response): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
}

async function membersPost(w: World, slug: string): Promise<number> {
  const id = await aBroadcast(w, { subject: 'The members recipe', body: `Opening line.\n\n${SECRET_LINE}` })
  await publishPost(w.db, id, { slug, excerpt: 'How I cook for twelve.', accessLevel: 'members' })
  return id
}

async function signInAs(w: World, email: string): Promise<string> {
  await sitePost(w, '/members/sign-in', { email })
  const res = await sitePost(w, '/members/verify', { token: await linkTokenFor(w, email) })
  return cookieFrom(res)
}

describe('Feature: signing in on the site, and posts only members can read', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: a subscriber asks for a sign-in link', () => {
    let w: World
    let page: string
    let mailHtml: string
    let row: typeof messages.$inferSelect | undefined
    let link: typeof memberSignInLinks.$inferSelect | undefined

    beforeAll(async () => {
      w = siteWorld()
      await aPerson(w, { email: 'ada@example.test' })
      const res = await sitePost(w, '/members/sign-in', { email: 'ada@example.test' }, { 'CF-Connecting-IP': '1.2.3.4' })
      page = await res.text()
      mailHtml = (await w.mailTo('ada@example.test')).html
      row = await w.db.select().from(messages).get()
      link = await w.db.select().from(memberSignInLinks).get()
    })

    it('answers "check your inbox"', () => {
      expect(page).toContain('a sign-in link is on its way')
    })

    it('mails a link to the site', () => {
      expect(mailHtml).toContain(`${SITE}/members/verify?token=`)
    })

    it('records the mail as a transactional message', () => {
      expect(row?.kind).toBe('transactional')
    })

    it('marks the message sent', () => {
      expect(row?.status).toBe('sent')
    })

    it('⭐ never stores the token on the message row', () => {
      expect(row?.bodyMd).toContain('{{sign_in_link}}')
    })

    it('⭐ stores the token only as a hash', async () => {
      const token = await linkTokenFor(w, 'ada@example.test')
      expect(link?.tokenHash).not.toBe(token)
    })

    it('records the link as sent', () => {
      expect(link?.status).toBe('sent')
    })

    it('records who asked from where', () => {
      expect(link?.requestedIp).toBe('1.2.3.4')
    })

    it('expires the link in twenty minutes', () => {
      const minutes = ((link?.expiresAt?.getTime() ?? 0) - (link?.createdAt.getTime() ?? 0)) / 60_000
      expect(minutes).toBe(20)
    })

    it('carries no unsubscribe footer, because it is system mail', () => {
      expect(mailHtml).not.toContain('/p/')
    })
  })

  describe('Scenario: the reader opens the link and signs in', () => {
    let w: World
    let confirm: string
    let signedIn: Response
    let setCookie: string
    let replay: Response

    beforeAll(async () => {
      w = siteWorld()
      await aPerson(w, { email: 'ada@example.test' })
      await sitePost(w, '/members/sign-in', { email: 'ada@example.test' })
      const token = await linkTokenFor(w, 'ada@example.test')
      confirm = await (await get(w, `/members/verify?token=${token}`)).text()
      signedIn = await sitePost(w, '/members/verify', { token })
      setCookie = signedIn.headers.get('set-cookie') ?? ''
      replay = await sitePost(w, '/members/verify', { token })
    })

    it('opens a confirmation page with a button, so a mail scanner spends nothing', () => {
      expect(confirm).toContain('<button type="submit">Sign in</button>')
    })

    it('signs in with the button', () => {
      expect(signedIn.status).toBe(303)
    })

    it('sets the cookie HttpOnly', () => {
      expect(setCookie).toContain('HttpOnly')
    })

    it('sets the cookie Secure on an https site', () => {
      expect(setCookie).toContain('Secure')
    })

    it('sets the cookie SameSite=Lax', () => {
      expect(setCookie).toContain('SameSite=Lax')
    })

    it('uses the __Host- prefix so no other host can set it', () => {
      expect(setCookie.startsWith('__Host-')).toBe(true)
    })

    it('⭐ spends the link: a second use signs nobody in', () => {
      expect(replay.status).toBe(410)
    })

    it('opens one session', async () => {
      expect((await w.db.select().from(memberSessions).all()).length).toBe(1)
    })
  })

  describe('Scenario: a members-only post, read signed out and signed in', () => {
    let w: World
    let anonymous: Response
    let anonymousHtml: string
    let memberHtml: string
    let memberCache: string | null

    beforeAll(async () => {
      w = siteWorld()
      await aPerson(w, { email: 'ada@example.test' })
      await membersPost(w, 'members-recipe')
      anonymous = await get(w, '/members-recipe')
      anonymousHtml = await anonymous.text()
      const cookie = await signInAs(w, 'ada@example.test')
      const member = await get(w, '/members-recipe', cookie)
      memberCache = member.headers.get('cache-control')
      memberHtml = await member.text()
    })

    it('shows a signed-out reader the title', () => {
      expect(anonymousHtml).toContain('The members recipe')
    })

    it('shows them the hand-written excerpt', () => {
      expect(anonymousHtml).toContain('How I cook for twelve.')
    })

    it('⭐ does not show them the body', () => {
      expect(anonymousHtml).not.toContain(SECRET_LINE)
    })

    it('offers them a way to sign in that names the post', () => {
      expect(anonymousHtml).toContain('/members/sign-in?from=members-recipe')
    })

    it('⭐ never lets a shared cache hold the page', () => {
      expect(anonymous.headers.get('cache-control')).toBe('private, no-store')
    })

    it('shows a signed-in member the body', () => {
      expect(memberHtml).toContain(SECRET_LINE)
    })

    it('serves the member page no-store too', () => {
      expect(memberCache).toBe('private, no-store')
    })
  })

  describe('Scenario: a gated post never leaves by another door', () => {
    let w: World
    let feed: string
    let searchHtml: string
    let writing: string
    let excerpt: string | null | undefined

    beforeAll(async () => {
      w = siteWorld()
      // No excerpt written: publishing must not derive one from a gated body.
      const id = await aBroadcast(w, { subject: 'Kitchen notes', body: `${SECRET_LINE}\n\nMore.` })
      await publishPost(w.db, id, { slug: 'kitchen-notes', accessLevel: 'members' })
      excerpt = (await w.db.query.broadcasts.findFirst({ where: (b, { eq }) => eq(b.id, id) }))?.excerpt
      feed = await (await get(w, '/feed.xml')).text()
      searchHtml = await (await get(w, '/search?q=patience')).text()
      writing = await (await get(w, '/writing')).text()
    })

    it('⭐ derives no excerpt from the body', () => {
      expect(excerpt).toBeNull()
    })

    it('lists the post in the feed', () => {
      expect(feed).toContain('Kitchen notes')
    })

    it('⭐ carries only the teaser in the feed', () => {
      expect(feed).not.toContain(SECRET_LINE)
    })

    it('⭐ does not find the post by a word in its body', () => {
      expect(searchHtml).not.toContain('Kitchen notes')
    })

    it('⭐ shows only the teaser in the archive', () => {
      expect(writing).not.toContain(SECRET_LINE)
    })
  })

  describe('Scenario: switching a live public post to members drops what was derived from it', () => {
    let excerpt: string | null | undefined

    beforeAll(async () => {
      const w = siteWorld()
      const id = await aBroadcast(w, { subject: 'Was public', body: `${SECRET_LINE}\n\nMore.` })
      await publishPost(w.db, id, { slug: 'was-public' })
      await publishPost(w.db, id, { accessLevel: 'members' })
      excerpt = (await w.db.query.broadcasts.findFirst({ where: (b, { eq }) => eq(b.id, id) }))?.excerpt
    })

    it('⭐ clears the excerpt it had taken from the body', () => {
      expect(excerpt).toBeNull()
    })
  })

  describe('Scenario: an unsubscribed reader signs in', () => {
    let w: World
    let status: string | undefined
    let mailed: number

    beforeAll(async () => {
      w = siteWorld()
      const ada = await aPerson(w, { email: 'ada@example.test' })
      await unsubscribeBroadcasts(w.db, ada.id)
      await signInAs(w, 'ada@example.test')
      mailed = (await w.outbox()).length
      status = (await w.db.select().from(subscribers).where(eq(subscribers.id, ada.id)).get())?.status
    })

    it('still gets the link, because it is system mail', () => {
      expect(mailed).toBe(1)
    })

    it('⭐ stays unsubscribed from the newsletter', () => {
      expect(status).toBe('unsubscribed')
    })
  })

  describe('Scenario: a member signs out', () => {
    let after: string
    let revoked: Date | null | undefined

    beforeAll(async () => {
      const w = siteWorld()
      await aPerson(w, { email: 'ada@example.test' })
      await membersPost(w, 'members-recipe')
      const cookie = await signInAs(w, 'ada@example.test')
      await sitePost(w, '/members/sign-out', {}, { cookie })
      after = await (await get(w, '/members-recipe', cookie)).text()
      revoked = (await w.db.select().from(memberSessions).get())?.revokedAt
    })

    it('revokes the session', () => {
      expect(revoked).toBeInstanceOf(Date)
    })

    it('⭐ the old cookie reads the teaser again', () => {
      expect(after).not.toContain(SECRET_LINE)
    })
  })

  // ───────────────────────────────────────────── sad paths

  describe('Scenario: somebody types an address that is not on the list', () => {
    let w: World
    let page: string
    let created: number
    let mailed: number

    beforeAll(async () => {
      w = siteWorld()
      page = await (await sitePost(w, '/members/sign-in', { email: 'stranger@example.test' })).text()
      created = (await w.db.select().from(subscribers).all()).length
      mailed = (await w.outbox()).length
    })

    it('gets the same answer as a subscriber', () => {
      expect(page).toContain('a sign-in link is on its way')
    })

    it('⭐ creates no subscriber', () => {
      expect(created).toBe(0)
    })

    it('⭐ mails nobody', () => {
      expect(mailed).toBe(0)
    })
  })

  describe('Scenario: a hard-bounced address asks for a link', () => {
    let link: typeof memberSignInLinks.$inferSelect | undefined
    let message: typeof messages.$inferSelect | undefined
    let mailed: number

    beforeAll(async () => {
      const w = siteWorld()
      await aPerson(w, { email: 'gone@example.test' })
      await w.db.insert(suppressions).values({ email: 'gone@example.test', reason: 'hard_bounce', createdAt: new Date() })
      await sitePost(w, '/members/sign-in', { email: 'gone@example.test' })
      link = await w.db.select().from(memberSignInLinks).get()
      message = await w.db.select().from(messages).get()
      mailed = (await w.outbox()).length
    })

    it('⭐ is not mailed', () => {
      expect(mailed).toBe(0)
    })

    it('records the link as blocked', () => {
      expect(link?.status).toBe('blocked')
    })

    it('keeps no usable token for it', () => {
      expect(link?.tokenHash).toBeNull()
    })

    it('records the message as suppressed, visibly', () => {
      expect(message?.suppressedReason).toBe('hard_bounce')
    })
  })

  describe('Scenario: one address asks again and again', () => {
    let mailed: number
    let throttled: number

    beforeAll(async () => {
      const w = siteWorld()
      await aPerson(w, { email: 'ada@example.test' })
      for (let i = 0; i < 7; i++) await sitePost(w, '/members/sign-in', { email: 'ada@example.test' })
      mailed = (await w.outbox()).length
      throttled = (
        await w.db.select().from(memberSignInLinks).where(eq(memberSignInLinks.status, 'throttled')).all()
      ).length
    })

    it('mails at most five links an hour', () => {
      expect(mailed).toBe(5)
    })

    it('records the rest as throttled', () => {
      expect(throttled).toBe(2)
    })
  })

  describe('Scenario: another site tries to post the sign-in form', () => {
    let res: Response

    beforeAll(async () => {
      const w = siteWorld()
      await aPerson(w, { email: 'ada@example.test' })
      await sitePost(w, '/members/sign-in', { email: 'ada@example.test' })
      res = await sitePost(
        w,
        '/members/verify',
        { token: await linkTokenFor(w, 'ada@example.test') },
        { Origin: 'https://evil.example.test' },
      )
    })

    it('⭐ is refused', () => {
      expect(res.status).toBe(403)
    })
  })

  describe('Scenario: an expired link', () => {
    let res: Response

    beforeAll(async () => {
      const w = siteWorld()
      await aPerson(w, { email: 'ada@example.test' })
      await sitePost(w, '/members/sign-in', { email: 'ada@example.test' })
      const token = await linkTokenFor(w, 'ada@example.test')
      await w.db
        .update(memberSignInLinks)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(and(eq(memberSignInLinks.status, 'sent')))
      res = await sitePost(w, '/members/verify', { token })
    })

    it('signs nobody in', () => {
      expect(res.status).toBe(410)
    })
  })

  describe('Scenario: a site with no session secret', () => {
    let page: string

    beforeAll(async () => {
      const w = createWorld({ SITE_URL: SITE })
      page = await (await get(w, '/members/sign-in')).text()
    })

    it('says signing in is not available', () => {
      expect(page).toContain('Signing in isn’t available')
    })
  })
})
