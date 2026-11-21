// Setting up a sending domain
// gap.md "Mail and sending" › Sending domain setup
// Ported from Kōlea SPEC 6.1.1, 6.1.2, 6.1.3, 6.1.4, 6.1.4a, 6.1.5 and 6.3.1
// (warned, not blocked), plus Kōlea's fix "refuse a sending domain that is a
// CNAME". Left out as hosted-only: the ownership TXT, pending-domain limits,
// provider sub-accounts, staff verification.
//
// The operator adds the domain their mail comes from, sees the records the
// provider wants (DKIM, SPF, the return path) plus a DMARC suggestion, checks
// them, and can have them added to Cloudflare in one click. A domain is
// verified only when every required record answers in DNS and the provider
// says it will send; a check that cannot reach DNS or the provider decides
// nothing.
//
// ⚠️ Three fakes, all at the ports, none on the wire: the in-memory DNS
// (`DNS_RESOLVER=fake`, pinned by `createWorld`), the in-memory Cloudflare
// (`CLOUDFLARE_DNS=fake`, only where a scenario asks), and the console
// provider's domains API. Everything else is driven through `worker.fetch`
// and `worker.scheduled`.
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  addDomain,
  afterCheck,
  checkDomain,
  type DomainPorts,
  planCloudflare,
  domainRecords,
  transition,
} from '../../src/core/domains.ts'
import { type SendingDomain, sendingDomains } from '../../src/db/schema.ts'
import { fakeCloudflare } from '../../src/providers/cloudflare-dns.ts'
import { fakeDns, parseDohAnswer } from '../../src/providers/dns.ts'
import { toProviderDomain } from '../../src/providers/resend-domains.ts'
import type { DomainIdentity } from '../../src/providers/types.ts'
import { aBroadcast, aPerson } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

async function domainNamed(w: World, name: string): Promise<SendingDomain | undefined> {
  return await w.db.select().from(sendingDomains).where(eq(sendingDomains.name, name)).get()
}

/** Publish, in the fake DNS, every record the console provider asks for, plus DMARC. */
function publishConsoleRecords(name: string): void {
  fakeDns.set(`kolea._domainkey.${name}`, 'TXT', [`p=CONSOLE-DKIM-KEY-FOR-${name.toUpperCase()}`])
  fakeDns.set(`send.${name}`, 'MX', ['10 feedback.console.invalid'])
  fakeDns.set(`send.${name}`, 'TXT', ['v=spf1 include:spf.console.invalid ~all'])
}

/** A provider that answers the way a scenario needs. */
function identity(verdict: 'active' | 'unverified' | 'unreachable'): DomainIdentity {
  const domain = (name: string) => ({
    id: `id-${name}`,
    state: verdict === 'active' ? ('active' as const) : ('unverified' as const),
    records: [{ purpose: 'dkim' as const, type: 'TXT' as const, name: `k._domainkey.${name}`, value: 'p=KEY' }],
  })
  return {
    register: async (name) => ({ ok: true, domain: domain(name) }),
    verify: async (name) => (verdict === 'unreachable' ? { ok: false, error: 'timed out' } : { ok: true, domain: domain(name) }),
  }
}

describe('Feature: setting up a sending domain', () => {
  // ───────────────────────────────────────────── happy paths

  describe('Scenario: the operator adds a domain', () => {
    let w: World
    let res: Response
    let page: string
    let row: SendingDomain | undefined

    beforeAll(async () => {
      fakeDns.clear()
      w = createWorld()
      res = await w.post('/domains', { name: 'https://News.Example.com/' })
      row = await domainNamed(w, 'news.example.com')
      page = await (await w.fetch(res.headers.get('location')!)).text()
    })

    it('stores the name the way DNS spells it', () => {
      expect(row?.name).toBe('news.example.com')
    })

    it('starts pending', () => {
      expect(row?.status).toBe('pending')
    })

    it('goes to the domain screen', () => {
      expect(res.headers.get('location')).toStartWith(`/domains/${row?.id}?`)
    })

    it('keeps the records the provider asked for', () => {
      expect(row?.providerRecords.map((r) => `${r.purpose} ${r.type} ${r.name}`)).toEqual([
        'dkim TXT kolea._domainkey.news.example.com',
        'return_path MX send.news.example.com',
        'return_path TXT send.news.example.com',
      ])
    })

    it('shows the DKIM record as a host to type in', () => {
      expect(page).toContain('kolea._domainkey')
    })

    it('shows the return path MX with its priority', () => {
      expect(page).toContain('priority 10')
    })

    it('suggests DMARC', () => {
      expect(page).toContain('v=DMARC1; p=none;')
    })

    it('marks DMARC as recommended rather than required', () => {
      expect(page).toContain('recommended')
    })

    it('schedules the first automatic look a minute out', () => {
      expect(row!.nextCheckAt!.getTime() - row!.createdAt.getTime()).toBe(60_000)
    })

    it('lists the domain on the Sending domains screen', async () => {
      expect(await (await w.fetch('/domains')).text()).toContain('news.example.com')
    })
  })

  describe('Scenario: one click adds the records to Cloudflare', () => {
    let w: World
    let row: SendingDomain | undefined
    let flash: string

    beforeAll(async () => {
      fakeDns.clear()
      fakeCloudflare.reset()
      w = createWorld({ CLOUDFLARE_DNS: 'fake' })
      await w.post('/domains', { name: 'mail.oneclick.test' })
      const id = (await domainNamed(w, 'mail.oneclick.test'))!.id
      const res = await w.post(`/domains/${id}/cloudflare`, {})
      flash = decodeURIComponent(res.headers.get('location') ?? '')
      row = await domainNamed(w, 'mail.oneclick.test')
    })

    it('looks the zone up first', () => {
      expect(fakeCloudflare.calls[0]).toEqual({ op: 'findZone', arg: 'mail.oneclick.test' })
    })

    it('creates the DKIM, both return-path records and DMARC', () => {
      expect(fakeCloudflare.calls.filter((c) => c.op === 'createRecord').map((c) => `${c.record?.type} ${c.arg}`)).toEqual([
        'TXT kolea._domainkey.mail.oneclick.test',
        'MX send.mail.oneclick.test',
        'TXT send.mail.oneclick.test',
        'TXT _dmarc.mail.oneclick.test',
      ])
    })

    it('sends the MX priority along', () => {
      expect(fakeCloudflare.calls.find((c) => c.record?.type === 'MX')?.record?.priority).toBe(10)
    })

    it('checks straight after, and the domain is verified', () => {
      expect(row?.status).toBe('verified')
    })

    it('says what it added', () => {
      expect(flash).toContain('Added 4 records to Cloudflare.')
    })
  })

  describe('Scenario: the operator checks after publishing the records by hand', () => {
    let w: World
    let row: SendingDomain | undefined

    beforeAll(async () => {
      fakeDns.clear()
      w = createWorld()
      await w.post('/domains', { name: 'byhand.test' })
      publishConsoleRecords('byhand.test')
      await w.post(`/domains/${(await domainNamed(w, 'byhand.test'))!.id}/check`, {})
      row = await domainNamed(w, 'byhand.test')
    })

    it('verifies the domain', () => {
      expect(row?.status).toBe('verified')
    })

    it('marks each required record found', () => {
      expect(row?.recordStatuses).toMatchObject({ dkim1: 'found', return_path1: 'found', return_path2: 'found' })
    })

    it('verifies without DMARC, which is only recommended', () => {
      expect(row?.recordStatuses.dmarc).toBe('missing')
    })

    it('stamps when it was verified', () => {
      expect(row?.verifiedAt).toBeInstanceOf(Date)
    })

    it('moves to the daily re-check', () => {
      expect(row!.nextCheckAt!.getTime() - row!.lastCheckedAt!.getTime()).toBe(86_400_000)
    })
  })

  describe('Scenario: the minutely cron looks at a domain that is due', () => {
    let row: SendingDomain | undefined

    beforeAll(async () => {
      fakeDns.clear()
      const w = createWorld()
      await w.post('/domains', { name: 'polled.test' })
      publishConsoleRecords('polled.test')
      await w.db.update(sendingDomains).set({ nextCheckAt: new Date(Date.now() - 1000) }).where(eq(sendingDomains.name, 'polled.test'))
      await w.tick()
      row = await domainNamed(w, 'polled.test')
    })

    it('checks it and verifies it', () => {
      expect(row?.status).toBe('verified')
    })
  })

  describe('Scenario: an SPF and a DMARC record of the operator\'s own are already in the zone', () => {
    const records = domainRecords({
      name: 'own.test',
      recordStatuses: {},
      providerRecords: [
        { purpose: 'spf', type: 'TXT', name: 'own.test', value: 'v=spf1 include:mailgun.org ~all' },
        { purpose: 'dkim', type: 'CNAME', name: 'pdk1._domainkey.own.test', value: 'pdk1.mailgun.org' },
      ],
    })
    const plan = planCloudflare(records, (name) =>
      name === 'own.test'
        ? [{ type: 'TXT', name, content: '"v=spf1 include:_spf.google.com ~all"' }]
        : name === '_dmarc.own.test'
          ? [{ type: 'TXT', name, content: 'v=DMARC1; p=quarantine;' }]
          : [],
    )

    it('creates only what is missing', () => {
      expect(plan.create.map((r) => r.id)).toEqual(['dkim1'])
    })

    it('⭐ never overwrites their SPF record; it is reported instead', () => {
      expect(plan.conflicts).toEqual([{ id: 'spf', existing: 'v=spf1 include:_spf.google.com ~all' }])
    })

    it('keeps their DMARC record', () => {
      expect(plan.kept).toEqual(['dmarc'])
    })
  })

  describe('Scenario: their SPF record already carries the provider\'s include', () => {
    const records = domainRecords({
      name: 'merged.test',
      recordStatuses: {},
      providerRecords: [{ purpose: 'spf', type: 'TXT', name: 'merged.test', value: 'v=spf1 include:mailgun.org ~all' }],
    })
    const plan = planCloudflare(records, (name) =>
      name === 'merged.test' ? [{ type: 'TXT', name, content: 'v=spf1 include:_spf.google.com include:mailgun.org -all' }] : [],
    )

    it('keeps it as it is', () => {
      expect(plan.kept).toContain('spf')
    })
  })

  describe('Scenario: Resend says which records it wants', () => {
    const domain = toProviderDomain('news.example.com', {
      id: 'd_123',
      status: 'pending',
      records: [
        { record: 'SPF', name: 'send', type: 'MX', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
        { record: 'SPF', name: 'send', type: 'TXT', value: '"v=spf1 include:amazonses.com ~all"' },
        { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=MIGfMA0' },
        { record: 'Receiving', name: '@', type: 'MX', value: 'inbound-smtp.us-east-1.amazonaws.com', priority: 10 },
      ],
    })

    it('takes the DKIM key and both return-path records, fully qualified', () => {
      expect(domain.records.map((r) => `${r.purpose} ${r.type} ${r.name}`)).toEqual([
        'return_path MX send.news.example.com',
        'return_path TXT send.news.example.com',
        'dkim TXT resend._domainkey.news.example.com',
      ])
    })

    it('⭐ leaves out the receiving MX, which would take over the domain\'s inbound mail', () => {
      expect(domain.records.some((r) => r.value.startsWith('inbound-smtp'))).toBe(false)
    })

    it('unquotes the SPF value', () => {
      expect(domain.records[1]?.value).toBe('v=spf1 include:amazonses.com ~all')
    })

    it('reads a pending domain as not yet active', () => {
      expect(domain.state).toBe('unverified')
    })
  })

  describe('Scenario: DNS-over-HTTPS answers', () => {
    it('joins a long TXT record split into chunks', () => {
      const answer = parseDohAnswer({ Status: 0, Answer: [{ type: 16, data: '"v=DKIM1; p=AAA" "BBB"' }] }, 'TXT')
      expect(answer).toEqual({ ok: true, values: ['v=DKIM1; p=AAABBB'] })
    })

    it('ignores the CNAME a TXT question picks up on the way', () => {
      const answer = parseDohAnswer(
        { Status: 0, Answer: [{ type: 5, data: 'elsewhere.test.' }, { type: 16, data: '"v=spf1 -all"' }] },
        'TXT',
      )
      expect(answer).toEqual({ ok: true, values: ['v=spf1 -all'] })
    })

    it('reads status 3 as a name that does not exist', () => {
      expect(parseDohAnswer({ Status: 3 }, 'CNAME')).toEqual({ ok: false, error: 'nxdomain' })
    })
  })

  describe('Scenario: the status moves only along its lifecycle', () => {
    it('lets pending become verified', () => {
      expect(transition('pending', 'verified')).toBe(true)
    })

    it('lets pending become failed', () => {
      expect(transition('pending', 'failed')).toBe(true)
    })

    it('lets a failed domain recover on a re-check', () => {
      expect(transition('failed', 'verified')).toBe(true)
    })

    it('never sends a verified domain back to pending', () => {
      expect(transition('verified', 'pending')).toBe(false)
    })

    it('keeps a pending domain pending while records are missing', () => {
      expect(afterCheck('pending', false, false)).toBe('pending')
    })

    it('fails a pending domain the provider has given up on', () => {
      expect(afterCheck('pending', false, true)).toBe('failed')
    })
  })

  describe('Scenario: the send confirmation, when the From domain is verified', () => {
    let html: string

    beforeAll(async () => {
      fakeDns.clear()
      const w = createWorld({ FROM_EMAIL: 'rob@verified.test' })
      await aPerson(w)
      await w.post('/domains', { name: 'verified.test' })
      publishConsoleRecords('verified.test')
      await w.post(`/domains/${(await domainNamed(w, 'verified.test'))!.id}/check`, {})
      const id = await aBroadcast(w, { subject: 'Hello', body: 'Words. '.repeat(200) })
      html = await (await w.fetch(`/broadcasts/${id}/send`)).text()
    })

    it('raises no sending-domain warning', () => {
      expect(html).not.toContain('under Sending domains')
    })
  })

  // ───────────────────────────────────────────── sad paths

  describe('Scenario: the operator tries a name that is a CNAME', () => {
    let w: World
    let flash: string

    beforeAll(async () => {
      fakeDns.clear()
      fakeDns.set('news.tosi.test', 'CNAME', ['sites.host.test'])
      w = createWorld()
      const res = await w.post('/domains', { name: 'news.tosi.test' })
      flash = decodeURIComponent(res.headers.get('location') ?? '')
    })

    it('⭐ refuses it, since a CNAME can hold no SPF record', async () => {
      expect(await domainNamed(w, 'news.tosi.test')).toBeUndefined()
    })

    it('says why', () => {
      expect(flash).toContain('it has a CNAME record')
    })

    it('suggests the parent domain or mail.<parent>', () => {
      expect(flash).toContain('Send from tosi.test instead, or another name like mail.tosi.test.')
    })
  })

  describe('Scenario: the operator tries the public site\'s own address', () => {
    let w: World
    let flash: string

    beforeAll(async () => {
      fakeDns.clear()
      w = createWorld({ SITE_URL: 'https://blog.example.test' })
      const res = await w.post('/domains', { name: 'blog.example.test' })
      flash = decodeURIComponent(res.headers.get('location') ?? '')
    })

    it('refuses it', async () => {
      expect(await domainNamed(w, 'blog.example.test')).toBeUndefined()
    })

    it('says it is this app\'s own address', () => {
      expect(flash).toContain("is this app's own address")
    })
  })

  describe('Scenario: names that cannot be sending domains', () => {
    let w: World
    const errors: Record<string, string> = {}

    beforeAll(async () => {
      fakeDns.clear()
      w = createWorld()
      await addDomain(w.env, w.db, 'twice.test')
      for (const name of ['gmail.com', 'not a domain', 'twice.test']) {
        const r = await addDomain(w.env, w.db, name)
        errors[name] = r.ok ? '' : r.error
      }
    })

    it('refuses a free mailbox provider', () => {
      expect(errors['gmail.com']).toContain('free mailbox provider')
    })

    it('refuses something that is not a domain', () => {
      expect(errors['not a domain']).toContain('is not a domain name')
    })

    it('refuses a domain already added', () => {
      expect(errors['twice.test']).toContain('already added')
    })
  })

  describe('Scenario: a check finds nothing published yet', () => {
    let row: SendingDomain | undefined

    beforeAll(async () => {
      fakeDns.clear()
      const w = createWorld()
      await w.post('/domains', { name: 'empty.test' })
      await w.post(`/domains/${(await domainNamed(w, 'empty.test'))!.id}/check`, {})
      row = await domainNamed(w, 'empty.test')
    })

    it('leaves it pending', () => {
      expect(row?.status).toBe('pending')
    })

    it('marks the DKIM record missing', () => {
      expect(row?.recordStatuses.dkim1).toBe('missing')
    })
  })

  describe('Scenario: DNS is right but the provider has not verified it yet', () => {
    let row: SendingDomain | undefined

    beforeAll(async () => {
      fakeDns.clear()
      const w = createWorld()
      const ports: Partial<DomainPorts> = { identity: identity('unverified') }
      const added = await addDomain(w.env, w.db, 'slow.test', ports)
      fakeDns.set('k._domainkey.slow.test', 'TXT', ['p=KEY'])
      row = (await checkDomain(w.env, w.db, (added as { value: SendingDomain }).value.id, 'manual', ports)).ok
        ? await domainNamed(w, 'slow.test')
        : undefined
    })

    it('stays pending: both halves must agree', () => {
      expect(row?.status).toBe('pending')
    })
  })

  describe('Scenario: a verified domain loses its records', () => {
    let row: SendingDomain | undefined

    beforeAll(async () => {
      fakeDns.clear()
      const w = createWorld()
      await w.post('/domains', { name: 'lapsed.test' })
      const id = (await domainNamed(w, 'lapsed.test'))!.id
      publishConsoleRecords('lapsed.test')
      await w.post(`/domains/${id}/check`, {})
      fakeDns.clear()
      await w.post(`/domains/${id}/check`, {})
      row = await domainNamed(w, 'lapsed.test')
    })

    it('fails', () => {
      expect(row?.status).toBe('failed')
    })

    it('stamps when it failed', () => {
      expect(row?.failedAt).toBeInstanceOf(Date)
    })
  })

  describe('Scenario: the provider cannot be reached during a check', () => {
    let row: SendingDomain | undefined

    beforeAll(async () => {
      fakeDns.clear()
      const w = createWorld()
      const added = await addDomain(w.env, w.db, 'outage.test', { identity: identity('active') })
      const id = (added as { value: SendingDomain }).value.id
      fakeDns.set('k._domainkey.outage.test', 'TXT', ['p=KEY'])
      await checkDomain(w.env, w.db, id, 'manual', { identity: identity('active') })
      fakeDns.clear()
      await checkDomain(w.env, w.db, id, 'manual', { identity: identity('unreachable') })
      row = await domainNamed(w, 'outage.test')
    })

    it('⭐ changes nothing: an outage is not the operator\'s fault', () => {
      expect(row?.status).toBe('verified')
    })

    it('says the check could not finish', () => {
      expect(row?.lastError).toContain('could not be asked')
    })
  })

  describe('Scenario: Cloudflare refuses the token', () => {
    let flash: string
    let created: number

    beforeAll(async () => {
      fakeDns.clear()
      fakeCloudflare.reset()
      fakeCloudflare.unauthorized = true
      const w = createWorld({ CLOUDFLARE_DNS: 'fake' })
      await w.post('/domains', { name: 'refused.test' })
      const res = await w.post(`/domains/${(await domainNamed(w, 'refused.test'))!.id}/cloudflare`, {})
      flash = decodeURIComponent(res.headers.get('location') ?? '')
      created = fakeCloudflare.calls.filter((c) => c.op === 'createRecord').length
    })

    it('says what the token needs', () => {
      expect(flash).toContain('Zone:Read and DNS:Edit')
    })

    it('creates nothing', () => {
      expect(created).toBe(0)
    })
  })

  describe('Scenario: no Cloudflare token is configured', () => {
    let page: string

    beforeAll(async () => {
      fakeDns.clear()
      const w = createWorld()
      await w.post('/domains', { name: 'notoken.test' })
      page = await (await w.fetch(`/domains/${(await domainNamed(w, 'notoken.test'))!.id}`)).text()
    })

    it('hides the one-click button', () => {
      expect(page).not.toContain('Add to Cloudflare</button>')
    })
  })

  describe('Scenario: the send confirmation, when the From domain is not verified', () => {
    let unknown: string
    let pending: string

    beforeAll(async () => {
      fakeDns.clear()
      const w = createWorld({ FROM_EMAIL: 'rob@unverified.test' })
      await aPerson(w)
      const id = await aBroadcast(w, { subject: 'Hello', body: 'Words. '.repeat(200) })
      unknown = await (await w.fetch(`/broadcasts/${id}/send`)).text()
      await w.post('/domains', { name: 'unverified.test' })
      pending = await (await w.fetch(`/broadcasts/${id}/send`)).text()
    })

    it('warns when the domain was never added', () => {
      expect(unknown).toContain('unverified.test isn&#39;t set up under Sending domains')
    })

    it('warns when the domain is still pending', () => {
      expect(pending).toContain('unverified.test is pending under Sending domains')
    })
  })

  describe('Scenario: someone without an Access session asks for the screen', () => {
    let status: number

    beforeAll(async () => {
      const w = createWorld({
        DEV_AUTH_BYPASS: undefined,
        CF_ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
        CF_ACCESS_AUD: 'an-audience-tag',
      })
      status = (await w.fetch('/domains')).status
    })

    it('is turned away', () => {
      expect(status).not.toBe(200)
    })
  })
})
