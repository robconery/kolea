import { and, asc, eq, isNotNull, lte } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import {
  type DomainRecordStatus,
  type ProviderDomainRecord,
  type SendingDomain,
  sendingDomains,
} from '../db/schema.ts'
import { CloudflareApi, type CloudflareDns, type CfRecord, FakeCloudflare } from '../providers/cloudflare-dns.ts'
import { type DnsAnswer, type DnsResolver, DohResolver, FakeDns } from '../providers/dns.ts'
import type { DomainIdentity, ProviderDomain } from '../providers/types.ts'
import type { Env } from '../types.ts'
import { providerFor } from './sending.ts'
import { trackingHosts } from './tracking-host.ts'

/**
 * ⭐ Sending domains — the domain mail is sent from, the DNS records it needs,
 * and whether they are there (ported from Kōlea SPEC 6.1, single host).
 *
 * Left out on purpose, because they exist only for a hosted service: the
 * per-account ownership TXT (`_kolea.<domain>`, 6.2), the per-account limit on
 * pending domains, provider sub-accounts (6.4) and staff verification. On one
 * install there is one operator, and the provider's own verdict plus the DNS
 * check are proof enough.
 *
 * Every rule is here once. `web/admin-domains.tsx` and the minutely cron are
 * thin callers. The outside world comes in through three ports, picked from
 * `Env` by `domainPorts()` and overridable per call so a spec can hand in its
 * own:
 *
 * | Port | Real | Fake |
 * |---|---|---|
 * | DNS resolver | DoH to 1.1.1.1 | `providers/dns.ts` `FakeDns` |
 * | Cloudflare DNS | v4 API with `CLOUDFLARE_DNS_API_TOKEN` | `FakeCloudflare` |
 * | Provider's domain records | `EmailProvider.domains` (Resend) | the console provider's |
 */

// ───────────────────────────────────────────── names (pure)

const LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
const HOSTNAME = new RegExp(`^${LABEL}(\\.${LABEL})*\\.[a-z][a-z0-9-]{0,61}[a-z0-9]$`)

/**
 * Free mailbox providers. Nobody can publish records in their DNS, so a domain
 * there could never verify; refusing up front says why (Kōlea 6.3.1).
 */
const FREE_MAIL = new Set(
  `gmail.com googlemail.com yahoo.com yahoo.co.uk yahoo.fr ymail.com rocketmail.com
  hotmail.com hotmail.co.uk hotmail.fr outlook.com live.com msn.com
  icloud.com me.com mac.com aol.com proton.me protonmail.com pm.me
  gmx.com gmx.de gmx.net web.de mail.com yandex.com yandex.ru zoho.com
  fastmail.com hey.com tutanota.com tuta.io qq.com 163.com 126.com mail.ru`.split(/\s+/),
)

/** Two-label public suffixes common enough to matter, so example.co.uk is an apex. */
const SECOND_LEVEL = new Set(
  `co.uk org.uk me.uk ltd.uk plc.uk ac.uk gov.uk com.au net.au org.au co.nz org.nz net.nz co.za
  co.jp ne.jp or.jp com.br com.mx com.ar com.tr com.cn com.hk com.sg com.my
  co.in net.in org.in co.kr co.il co.id com.ph com.tw`.split(/\s+/),
)

/**
 * Whatever was typed → the lowercased name stored. `https://Example.COM/`,
 * `me@example.com` and `example.com.` all become `example.com`.
 */
export function normalizeDomain(input: string): string {
  let v = input.trim().toLowerCase()
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  v = v.split(/[/?#]/, 1)[0] ?? ''
  const at = v.split('@')
  if (at.length === 2) v = at[1] ?? ''
  return v.replace(/\.+$/, '')
}

/** Why `name` (already normalized) cannot be a sending domain, or null. */
export function invalidDomainName(name: string): string | null {
  if (!name) return 'Enter the domain your mail should come from.'
  if (name.length > 253 || !HOSTNAME.test(name)) return `${name} is not a domain name, like example.com.`
  if ([...FREE_MAIL].some((f) => name === f || name.endsWith(`.${f}`))) {
    return `${name} is a free mailbox provider. Send from a domain you own instead.`
  }
  return null
}

/** Whether `name` is a registrable domain (example.com, example.co.uk) rather than a subdomain. */
export function isApex(name: string): boolean {
  const labels = name.split('.')
  if (labels.length === 2) return true
  return labels.length === 3 && SECOND_LEVEL.has(labels.slice(1).join('.'))
}

/** The name to suggest instead of one that cannot hold mail records. */
function instead(name: string): string {
  if (isApex(name)) return `Send from another name, like mail.${name}.`
  const parent = name.split('.').slice(1).join('.')
  return `Send from ${parent} instead, or another name like mail.${parent}.`
}

/** The domain part of an address, lowercased, or null. */
export function domainOfAddress(address: string): string | null {
  const parts = address.trim().toLowerCase().split('@')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  return HOSTNAME.test(parts[1]) ? parts[1] : null
}

// ───────────────────────────────────────────── lifecycle (pure)

export type DomainStatus = SendingDomain['status']

const TRANSITIONS: Record<DomainStatus, DomainStatus[]> = {
  pending: ['verified', 'failed'],
  verified: ['failed'],
  failed: ['verified'],
}

/** Whether a domain may move `from` → `to`. Staying put is always allowed. */
export function transition(from: DomainStatus, to: DomainStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to)
}

/**
 * The status a conclusive check leads to (Kōlea 6.1.4, 6.1.5). Passing makes any
 * domain verified. A verified domain that stops passing has failed. A pending
 * one keeps waiting, unless the provider itself has given up on it.
 */
export function afterCheck(status: DomainStatus, passed: boolean, providerGaveUp: boolean): DomainStatus {
  if (passed) return 'verified'
  if (status === 'pending') return providerGaveUp ? 'failed' : 'pending'
  return 'failed'
}

// The pending poll's backoff: quick while the operator is likely still at their
// DNS host, then every six hours, then only by hand (Kōlea 6.1.4).
const POLL_SCHEDULE = [60, 120, 300, 600, 1_800, 3_600]
const SLOW_POLL = 21_600
const MAX_POLLS = 20
const DAILY = 86_400

/** Seconds until the next pending poll after poll number `attempt`, or null once polling has given up. */
export function nextPollIn(attempt: number): number | null {
  if (attempt > MAX_POLLS) return null
  return POLL_SCHEDULE[attempt - 1] ?? SLOW_POLL
}

// ───────────────────────────────────────────── records (pure)

export const DMARC_VALUE = 'v=DMARC1; p=none;'

export type RecordPurpose = 'dkim' | 'spf' | 'return_path' | 'dmarc' | 'tracking'

/** One record the operator creates at their DNS host, with what the last check saw. */
export interface DomainRecord {
  /** Unique among the domain's records: `dkim1`, `spf`, `return_path1`, `dmarc`, `tracking`. */
  id: string
  purpose: RecordPurpose
  type: 'TXT' | 'CNAME' | 'MX'
  /** Fully qualified. */
  name: string
  /** The part left of the domain, as DNS hosts want it typed; `@` for the domain itself. */
  host: string
  value: string
  priority?: number
  requirement: 'required' | 'recommended'
  status: DomainRecordStatus
}

/**
 * The custom tracking hostname (`TRACKING_HOST`, `core/tracking-host.ts`).
 * When opens and clicks are served from the sender's own subdomain, that
 * subdomain needs a CNAME to this Worker's host (`PUBLIC_URL`), and if it sits
 * under a sending domain it belongs on that domain's checklist.
 *
 * Only the CURRENT host (the first entry) is asked for: older entries keep
 * answering for mail already sent, and their records already exist.
 */
export function customTracking(env: Env): { host: string; target: string } | null {
  const [host] = trackingHosts(env)
  if (!host) return null
  let target: string
  try {
    target = new URL(env.PUBLIC_URL).host
  } catch {
    return null
  }
  return { host: host.split(':')[0]!, target }
}

function hostOf(name: string, domain: string): string {
  if (name === domain) return '@'
  return name.endsWith(`.${domain}`) ? name.slice(0, -(domain.length + 1)) : name
}

/**
 * Every record the operator is asked for, in screen order (Kōlea 6.1.3): the
 * provider's (DKIM, SPF, return path), the tracking CNAME when a custom
 * tracking host sits under this domain, then the DMARC suggestion.
 */
export function domainRecords(
  domain: Pick<SendingDomain, 'name' | 'providerRecords' | 'recordStatuses'>,
  tracking: { host: string; target: string } | null = null,
): DomainRecord[] {
  const { name } = domain
  const statuses = domain.recordStatuses ?? {}
  const seen = new Map<string, number>()
  const order: Record<ProviderDomainRecord['purpose'], number> = { dkim: 0, spf: 1, return_path: 2 }
  const provider = [...(domain.providerRecords ?? [])].sort(
    (a, b) => order[a.purpose] - order[b.purpose] || a.name.localeCompare(b.name) || a.type.localeCompare(b.type),
  )

  const out: DomainRecord[] = provider.map((r) => {
    const n = (seen.get(r.purpose) ?? 0) + 1
    seen.set(r.purpose, n)
    const id = r.purpose === 'spf' ? (n === 1 ? 'spf' : `spf${n}`) : `${r.purpose}${n}`
    return {
      id,
      purpose: r.purpose,
      type: r.type,
      name: r.name,
      host: hostOf(r.name, name),
      value: r.value,
      ...(r.priority !== undefined ? { priority: r.priority } : {}),
      requirement: 'required',
      status: statuses[id] ?? 'unchecked',
    }
  })

  if (tracking && (tracking.host === name || tracking.host.endsWith(`.${name}`))) {
    out.push({
      id: 'tracking',
      purpose: 'tracking',
      type: 'CNAME',
      name: tracking.host,
      host: hostOf(tracking.host, name),
      value: tracking.target,
      requirement: 'required',
      status: statuses.tracking ?? 'unchecked',
    })
  }

  out.push({
    id: 'dmarc',
    purpose: 'dmarc',
    type: 'TXT',
    name: `_dmarc.${name}`,
    host: hostOf(`_dmarc.${name}`, name),
    value: DMARC_VALUE,
    requirement: 'recommended',
    status: statuses.dmarc ?? 'unchecked',
  })
  return out
}

const bareName = (s: string) => s.trim().toLowerCase().replace(/\.$/, '')
const squash = (s: string) => s.replace(/\s+/g, '').replace(/;+$/, '')

/**
 * What an SPF record allows besides the default: every term after `v=spf1` and
 * before the first `all`. A receiver stops reading at `all`, so anything after
 * it allows nothing.
 */
export function spfMechanisms(spf: string): string[] {
  const terms = spf.toLowerCase().split(/\s+/).filter((t) => t && t !== 'v=spf1')
  const end = terms.findIndex((t) => /^[-~?+]?all$/.test(t))
  return end === -1 ? terms : terms.slice(0, end)
}

const covers = (spf: string, wanted: string[]) => {
  const have = new Set(spfMechanisms(spf))
  return wanted.every((m) => have.has(m))
}

/** One record's status from what DNS answered at its name (Kōlea 6.1.3). */
export function recordStatus(record: Pick<DomainRecord, 'purpose' | 'type' | 'value'>, answer: DnsAnswer): DomainRecordStatus {
  if (!answer.ok || answer.values.length === 0) return 'missing'
  const values = answer.values

  if (record.type === 'CNAME') {
    return values.some((v) => bareName(v) === bareName(record.value)) ? 'found' : 'mismatch'
  }
  if (record.type === 'MX') {
    const hosts = values.map((v) => bareName(v.split(/\s+/).pop() ?? ''))
    return hosts.includes(bareName(record.value)) ? 'found' : 'mismatch'
  }
  if (record.purpose === 'dmarc') {
    const dmarc = values.filter((v) => v.trim().startsWith('v=DMARC1'))
    if (dmarc.length === 0) return 'missing'
    return dmarc.some((v) => squash(v) === squash(DMARC_VALUE)) ? 'found' : 'existing'
  }
  if (record.value.trim().startsWith('v=spf1')) {
    // A name holds one SPF record. The operator's own is never replaced: it is
    // right once it lists everything the provider's record lists.
    const spf = values.filter((v) => v.trim().startsWith('v=spf1'))
    if (spf.length === 0) return 'missing'
    return spf.some((v) => covers(v, spfMechanisms(record.value))) ? 'found' : 'mismatch'
  }
  return values.some((v) => squash(v) === squash(record.value)) ? 'found' : 'mismatch'
}

/** Whether a record's status counts as done. A DMARC record of the operator's own does. */
export const satisfied = (s: DomainRecordStatus) => s === 'found' || s === 'existing'

/**
 * What one-click setup will do, decided from what is already at each name
 * before anything is written (Kōlea 6.1.4a, BigMailer's onboard rules):
 *
 * - a record already holding the right value is kept, not rewritten;
 * - anything else already at one of these names is never overwritten — it is
 *   reported, and the operator decides;
 * - DMARC is added (`p=none`) only if the name has none;
 * - SPF is added only if the name has none. An SPF record of the operator's
 *   own that lacks the provider's terms is reported for them to edit by hand.
 */
export function planCloudflare(
  records: DomainRecord[],
  existingAt: (name: string) => CfRecord[],
): { create: DomainRecord[]; kept: string[]; conflicts: { id: string; existing: string }[] } {
  const create: DomainRecord[] = []
  const kept: string[] = []
  const conflicts: { id: string; existing: string }[] = []
  const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, '$1')

  for (const record of records) {
    const here = existingAt(record.name).filter((r) => bareName(r.name) === bareName(record.name))
    const txt = here.filter((r) => r.type === 'TXT').map((r) => unquote(r.content))
    const cname = here.find((r) => r.type === 'CNAME')

    // A CNAME at the name forbids every other record there (RFC 1034).
    if (cname && record.type !== 'CNAME') {
      conflicts.push({ id: record.id, existing: `CNAME ${cname.content}` })
      continue
    }

    if (record.purpose === 'dmarc') {
      if (txt.some((t) => t.startsWith('v=DMARC1'))) kept.push(record.id)
      else create.push(record)
      continue
    }

    if (record.type === 'TXT' && record.value.startsWith('v=spf1')) {
      const spf = txt.filter((t) => t.startsWith('v=spf1'))
      if (spf.length === 0) create.push(record)
      else if (spf.some((t) => covers(t, spfMechanisms(record.value)))) kept.push(record.id)
      else conflicts.push({ id: record.id, existing: spf[0]! })
      continue
    }

    if (record.type === 'TXT') {
      if (txt.some((t) => squash(t) === squash(record.value))) kept.push(record.id)
      else if (txt.length === 0) create.push(record)
      else conflicts.push({ id: record.id, existing: txt[0]! })
      continue
    }

    if (record.type === 'MX') {
      const mx = here.filter((r) => r.type === 'MX')
      if (mx.some((r) => bareName(r.content) === bareName(record.value))) kept.push(record.id)
      else if (here.length === 0) create.push(record)
      // MX records sit beside each other; adding ours to someone else's would
      // split their bounce handling. Reported instead.
      else conflicts.push({ id: record.id, existing: `${mx[0]?.type ?? here[0]!.type} ${mx[0]?.content ?? here[0]!.content}` })
      continue
    }

    // CNAME
    if (here.length === 0) create.push(record)
    else if (cname && bareName(cname.content) === bareName(record.value)) kept.push(record.id)
    else conflicts.push({ id: record.id, existing: `${here[0]!.type} ${here[0]!.content}` })
  }
  return { create, kept, conflicts }
}

// ───────────────────────────────────────────── ports

export interface DomainPorts {
  dns: DnsResolver
  /** Null when no Cloudflare token is configured: the one-click button is hidden. */
  cloudflare: CloudflareDns | null
  /** Null when the provider has no domains API: the verdict is the DNS check's alone. */
  identity: DomainIdentity | null
  /** The `EMAIL_PROVIDER` the identity speaks for. */
  provider: string
}

/** The ports this install is configured with. Production: real DNS, real Cloudflare, the real provider. */
export function domainPorts(env: Env, db: Db, overrides: Partial<DomainPorts> = {}): DomainPorts {
  const fakeCf = env.CLOUDFLARE_DNS === 'fake'
  let identity: DomainIdentity | null = null
  let provider = env.EMAIL_PROVIDER
  try {
    const p = providerFor(env, db)
    identity = p.domains ?? null
    provider = p.name
  } catch {
    // Misconfigured provider (resend without a key): the sends say so loudly;
    // here the DNS check still works.
  }
  return {
    dns: env.DNS_RESOLVER === 'fake' ? new FakeDns() : new DohResolver(),
    cloudflare: fakeCf ? new FakeCloudflare() : env.CLOUDFLARE_DNS_API_TOKEN ? new CloudflareApi(env.CLOUDFLARE_DNS_API_TOKEN) : null,
    identity,
    provider,
    ...overrides,
  }
}

// ───────────────────────────────────────────── commands

export type DomainResult<T> = { ok: true; value: T } | { ok: false; error: string }

export async function listDomains(db: Db): Promise<SendingDomain[]> {
  return await db.select().from(sendingDomains).orderBy(asc(sendingDomains.name)).all()
}

export async function getDomain(db: Db, id: number): Promise<SendingDomain | null> {
  return (await db.select().from(sendingDomains).where(eq(sendingDomains.id, id)).get()) ?? null
}

/** This install's own hostnames. None of them can also be a sending domain. */
function ownHosts(env: Env): string[] {
  const hosts: string[] = []
  for (const url of [env.PUBLIC_URL, env.SITE_URL]) {
    try {
      if (url) hosts.push(new URL(url).hostname.toLowerCase())
    } catch {
      /* not a URL; nothing to compare */
    }
  }
  const tracking = customTracking(env)
  if (tracking) hosts.push(tracking.host)
  return hosts
}

/**
 * Add a sending domain (Kōlea 6.1.1, 6.1.2), then register it with the provider.
 *
 * Refused: anything that is not a domain, a free mailbox, a name already added,
 * this install's own addresses, and **any name that is a CNAME** (Kōlea fix
 * "refuse a sending domain that is a CNAME"): a CNAME can hold no other record
 * (RFC 1034), so the provider's SPF TXT could never be published there and the
 * domain would sit pending forever. A lookup that cannot answer does not refuse.
 *
 * If the provider cannot be reached the domain is still added, and the next
 * check registers it.
 */
export async function addDomain(
  env: Env,
  db: Db,
  input: string,
  overrides: Partial<DomainPorts> = {},
): Promise<DomainResult<SendingDomain>> {
  const name = normalizeDomain(input)
  const invalid = invalidDomainName(name)
  if (invalid) return { ok: false, error: invalid }

  if (ownHosts(env).includes(name)) {
    return { ok: false, error: `${name} is this app's own address, so it cannot hold mail records too. ${instead(name)}` }
  }
  const existing = await db.select({ id: sendingDomains.id }).from(sendingDomains).where(eq(sendingDomains.name, name)).get()
  if (existing) return { ok: false, error: `${name} is already added.` }

  const ports = domainPorts(env, db, overrides)
  const cname = await ports.dns.lookup(name, 'CNAME')
  if (cname.ok && cname.values.length > 0) {
    return {
      ok: false,
      error: `${name} points somewhere else (it has a CNAME record), so it cannot hold mail records. ${instead(name)}`,
    }
  }

  const now = new Date()
  const [row] = await db
    .insert(sendingDomains)
    .values({
      name,
      provider: ports.provider,
      createdAt: now,
      updatedAt: now,
      // Time to get to the DNS host before the first automatic look.
      nextCheckAt: new Date(now.getTime() + 60_000),
    })
    .onConflictDoNothing()
    .returning()
  if (!row) return { ok: false, error: `${name} is already added.` }

  return { ok: true, value: await ensureRegistered(db, row, ports) }
}

/** Register with the provider if this row has no provider handle (or a different provider's). */
async function ensureRegistered(db: Db, domain: SendingDomain, ports: DomainPorts): Promise<SendingDomain> {
  if (!ports.identity) return domain
  if (domain.providerDomainId && domain.provider === ports.provider) return domain
  const got = await ports.identity.register(domain.name)
  const patch = got.ok
    ? {
        provider: ports.provider,
        providerDomainId: got.domain.id,
        providerState: got.domain.state,
        providerRecords: storedRecords(got.domain),
        lastError: null,
      }
    : { lastError: `Could not register with ${ports.provider}: ${got.error}` }
  const [updated] = await db
    .update(sendingDomains)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(sendingDomains.id, domain.id))
    .returning()
  return updated ?? domain
}

function storedRecords(d: ProviderDomain): ProviderDomainRecord[] {
  return d.records.map((r) => ({
    purpose: r.purpose,
    type: r.type,
    name: r.name.toLowerCase(),
    value: r.value,
    ...(r.priority !== undefined ? { priority: r.priority } : {}),
  }))
}

export type CheckTrigger = 'manual' | 'poll' | 'setup'

/**
 * Check a domain now (Kōlea 6.1.4, 6.1.5): look up every record, ask the
 * provider, decide the status, schedule the next look.
 *
 * Verified needs both halves: every required record answers in DNS, and the
 * provider (when it has a domains API) says it will send. A check where DNS or
 * the provider could not answer records what it saw and **keeps the status**:
 * an outage is not the operator's fault.
 */
export async function checkDomain(
  env: Env,
  db: Db,
  id: number,
  trigger: CheckTrigger = 'manual',
  overrides: Partial<DomainPorts> = {},
): Promise<DomainResult<SendingDomain>> {
  const found = await getDomain(db, id)
  if (!found) return { ok: false, error: 'No such domain.' }
  const ports = domainPorts(env, db, overrides)
  const domain = await ensureRegistered(db, found, ports)

  const records = domainRecords(domain, customTracking(env))
  const statuses: Record<string, DomainRecordStatus> = {}
  let dnsDown = false
  for (const record of records) {
    const answer = await ports.dns.lookup(record.name, record.type)
    if (!answer.ok && answer.error !== 'nxdomain') dnsDown = true
    statuses[record.id] = recordStatus(record, answer)
  }

  let providerState = domain.providerState
  let providerRecords = domain.providerRecords
  let providerError: string | null = null
  if (ports.identity) {
    if (!domain.providerDomainId) {
      providerError = domain.lastError ?? `Not registered with ${ports.provider} yet.`
    } else {
      const asked = await ports.identity.verify(domain.name, domain.providerDomainId)
      if (asked.ok) {
        providerState = asked.domain.state
        // The provider can rotate what it asks for; keep what it says now.
        if (asked.domain.records.length) providerRecords = storedRecords(asked.domain)
      } else {
        providerError = `${ports.provider} could not be asked: ${asked.error}`
      }
    }
  }

  const required = records.filter((r) => r.requirement === 'required')
  const dnsPassed = required.length > 0 && required.every((r) => satisfied(statuses[r.id] ?? 'unchecked'))
  const providerPassed = ports.identity ? providerState === 'active' : true
  const conclusive = !dnsDown && providerError === null

  const now = new Date()
  const status = conclusive
    ? afterCheck(domain.status, dnsPassed && providerPassed, providerState === 'failed')
    : domain.status
  if (!transition(domain.status, status)) throw new Error(`sending domain ${domain.status} → ${status}`)

  const attempt = status === 'pending' ? (trigger === 'manual' ? domain.checkAttempt : domain.checkAttempt + 1) : 0
  const nextIn = status === 'pending' ? nextPollIn(Math.max(attempt, 1)) : DAILY
  const lastError = dnsDown ? 'DNS could not be reached; nothing was decided.' : providerError

  const [updated] = await db
    .update(sendingDomains)
    .set({
      status,
      providerState,
      providerRecords,
      recordStatuses: statuses,
      lastError,
      checkAttempt: attempt,
      lastCheckedAt: now,
      nextCheckAt: nextIn === null ? null : new Date(now.getTime() + nextIn * 1000),
      verifiedAt: status === 'verified' && domain.status !== 'verified' ? now : domain.verifiedAt,
      failedAt: status === 'failed' && domain.status !== 'failed' ? now : status === 'verified' ? null : domain.failedAt,
      updatedAt: now,
    })
    .where(eq(sendingDomains.id, domain.id))
    .returning()
  return { ok: true, value: updated ?? domain }
}

/**
 * The cron's share: check the one domain most overdue. One per tick keeps the
 * subrequest count (a handful of DNS lookups and one provider call) far inside
 * a Worker invocation's budget; pending domains are few and polls are minutes
 * apart, so nothing waits long. Never throws: a DNS outage must not take the
 * sequence tick down with it.
 */
export async function checkDueDomains(env: Env, db: Db, overrides: Partial<DomainPorts> = {}): Promise<number> {
  try {
    const due = await db
      .select({ id: sendingDomains.id })
      .from(sendingDomains)
      .where(and(isNotNull(sendingDomains.nextCheckAt), lte(sendingDomains.nextCheckAt, new Date())))
      .orderBy(asc(sendingDomains.nextCheckAt))
      .limit(1)
      .all()
    for (const d of due) await checkDomain(env, db, d.id, 'poll', overrides)
    return due.length
  } catch {
    return 0
  }
}

/** Remove a domain. Its provider registration is left alone: removing it there is the provider's screen's job. */
export async function removeDomain(db: Db, id: number): Promise<boolean> {
  const gone = await db.delete(sendingDomains).where(eq(sendingDomains.id, id)).returning({ id: sendingDomains.id })
  return gone.length > 0
}

export interface CloudflareSetup {
  created: string[]
  kept: string[]
  conflicts: { id: string; existing: string }[]
}

const CF_ERROR: Record<string, (name: string) => string> = {
  unauthorized: () => 'Cloudflare refused the token. It needs Zone:Read and DNS:Edit on the zone this domain is in.',
  zone_not_found: (name) => `No Cloudflare zone this token can see holds ${name}.`,
  provider_error: () => 'Cloudflare did not answer properly. Nothing was changed; try again, or add the records by hand.',
}

/**
 * One-click setup (Kōlea 6.1.4a): create the missing records in the Cloudflare
 * zone that holds the domain, by `planCloudflare`'s rules, then check.
 * Manual copy-paste always remains.
 */
export async function setupWithCloudflare(
  env: Env,
  db: Db,
  id: number,
  overrides: Partial<DomainPorts> = {},
): Promise<DomainResult<CloudflareSetup>> {
  const ports = domainPorts(env, db, overrides)
  if (!ports.cloudflare) return { ok: false, error: 'One-click setup needs CLOUDFLARE_DNS_API_TOKEN.' }
  const found = await getDomain(db, id)
  if (!found) return { ok: false, error: 'No such domain.' }
  const domain = await ensureRegistered(db, found, ports)

  const records = domainRecords(domain, customTracking(env))
  if (ports.identity && !records.some((r) => r.purpose === 'dkim')) {
    return { ok: false, error: `${ports.provider} has not said which records it wants yet. ${domain.lastError ?? ''}`.trim() }
  }

  const zone = await ports.cloudflare.findZone(domain.name)
  if (!zone.ok) return { ok: false, error: CF_ERROR[zone.error]!(domain.name) }

  const existing = new Map<string, CfRecord[]>()
  for (const name of new Set(records.map((r) => r.name))) {
    const got = await ports.cloudflare.listRecords(zone.value, name)
    if (!got.ok) return { ok: false, error: CF_ERROR[got.error]!(domain.name) }
    existing.set(name, got.value)
  }

  const plan = planCloudflare(records, (name) => existing.get(name) ?? [])
  const created: string[] = []
  for (const record of plan.create) {
    const made = await ports.cloudflare.createRecord(zone.value, {
      type: record.type,
      name: record.name,
      content: record.value,
      ...(record.priority !== undefined ? { priority: record.priority } : {}),
    })
    if (!made.ok) {
      return {
        ok: false,
        error: `${CF_ERROR[made.error]!(domain.name)}${created.length ? ` (${created.join(', ')} were added before it stopped.)` : ''}`,
      }
    }
    created.push(record.id)
  }

  await checkDomain(env, db, id, 'setup', overrides)
  return { ok: true, value: { created, kept: plan.kept, conflicts: plan.conflicts } }
}

/**
 * Is the configured From address on a verified sending domain? For the send
 * confirmation's warning (Kōlea 6.3.1 blocks; here, with one operator who may
 * have verified the domain at the provider long before this screen existed, it
 * warns). `unknown` means the domain has never been added here.
 */
export async function fromAddressStanding(
  env: Env,
  db: Db,
): Promise<{ domain: string | null; status: DomainStatus | 'unknown' }> {
  const domain = domainOfAddress(env.FROM_EMAIL ?? '')
  if (!domain) return { domain: null, status: 'unknown' }
  const row = await db
    .select({ status: sendingDomains.status })
    .from(sendingDomains)
    .where(eq(sendingDomains.name, domain))
    .get()
  return { domain, status: row?.status ?? 'unknown' }
}
