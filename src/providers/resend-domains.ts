import type { DomainIdentity, ProviderDomain, ProviderDomainResult, ProviderRecord } from './types.ts'

const DOMAINS = 'https://api.resend.com/domains'

/** One record as Resend's domains API returns it. Names are relative to the domain. */
export interface ResendRecord {
  record?: string
  name?: string
  type?: string
  value?: string
  priority?: number
  status?: string
}

interface ResendDomain {
  id?: string
  name?: string
  status?: string
  records?: ResendRecord[]
}

/**
 * Resend's domains API: the records it wants, and whether it will send.
 *
 * ⚠️ Needs a **full access** API key. A sending-only key (the safer kind for
 * `RESEND_API_KEY`) gets a 401 here, which the screen shows as the check's
 * error; sending is unaffected and the DNS check still runs.
 *
 * Never called by the test suite: `createWorld()` pins `EMAIL_PROVIDER=console`,
 * whose fake lives in `console.ts`. `toProviderDomain` is pure and is what the
 * spec exercises, with Resend's documented response shape.
 */
export class ResendDomains implements DomainIdentity {
  constructor(private readonly apiKey: string) {}

  private async call(method: string, path: string, body?: unknown): Promise<{ ok: true; json: unknown } | { ok: false; error: string; status: number }> {
    let res: Response
    try {
      res = await fetch(`${DOMAINS}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (e) {
      return { ok: false, error: `resend unreachable: ${(e as Error).message}`, status: 0 }
    }
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      return { ok: false, error: `resend ${res.status}: ${text.slice(0, 300)}`, status: res.status }
    }
    return { ok: true, json: await res.json().catch(() => ({})) }
  }

  private async get(id: string, name: string): Promise<ProviderDomainResult> {
    const got = await this.call('GET', `/${encodeURIComponent(id)}`)
    if (!got.ok) return { ok: false, error: got.error }
    return { ok: true, domain: toProviderDomain(name, got.json as ResendDomain) }
  }

  async register(name: string): Promise<ProviderDomainResult> {
    // Look first: creating a name Resend already holds is refused, and the
    // holder is very likely this install (added before, removed here, re-added).
    const list = await this.call('GET', '')
    if (list.ok) {
      const found = ((list.json as { data?: ResendDomain[] }).data ?? []).find(
        (d) => d.name?.toLowerCase() === name,
      )
      if (found?.id) return await this.get(found.id, name)
    }
    const created = await this.call('POST', '', { name })
    if (!created.ok) return { ok: false, error: created.error }
    return { ok: true, domain: toProviderDomain(name, created.json as ResendDomain) }
  }

  async verify(name: string, providerDomainId: string): Promise<ProviderDomainResult> {
    // Verification at Resend is asynchronous: this starts a look, and the
    // GET reports where it has got to. The next poll sees the outcome.
    const started = await this.call('POST', `/${encodeURIComponent(providerDomainId)}/verify`)
    if (!started.ok) return { ok: false, error: started.error }
    return await this.get(providerDomainId, name)
  }
}

/**
 * Resend's domain JSON → the port's shape. Pure.
 *
 * Resend's `SPF` records are the return path: an MX and a TXT on
 * `send.<domain>`, the envelope MAIL FROM. `DKIM` is a TXT key. Anything else
 * (`Receiving` MX for inbound mail, tracking records) is left out on purpose.
 */
export function toProviderDomain(domain: string, json: ResendDomain): ProviderDomain {
  const records: ProviderRecord[] = []
  for (const r of json.records ?? []) {
    if (!r.name || !r.type || r.value === undefined) continue
    const name = qualify(r.name, domain)
    const value = r.value.trim().replace(/^"(.*)"$/, '$1')
    const kind = (r.record ?? '').toUpperCase()
    const type = r.type.toUpperCase()
    if (kind === 'DKIM' && (type === 'TXT' || type === 'CNAME')) {
      records.push({ purpose: 'dkim', type, name, value })
    } else if (kind === 'SPF' && type === 'TXT') {
      // On `send.<domain>` it is the bounce domain's SPF; on the domain itself, the domain's.
      records.push({ purpose: name === domain ? 'spf' : 'return_path', type, name, value })
    } else if (kind === 'SPF' && type === 'MX') {
      records.push({ purpose: 'return_path', type, name, value, priority: r.priority ?? 10 })
    }
  }
  const status = (json.status ?? '').toLowerCase()
  return {
    id: json.id ?? '',
    state: status === 'verified' ? 'active' : status === 'failed' ? 'failed' : 'unverified',
    records,
  }
}

function qualify(name: string, domain: string): string {
  const n = name.trim().toLowerCase().replace(/\.$/, '')
  if (n === '@' || n === '' || n === domain) return domain
  return n.endsWith(`.${domain}`) ? n : `${n}.${domain}`
}
