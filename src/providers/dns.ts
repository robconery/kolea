/**
 * The DNS resolver port: how a sending domain's records are looked up to check
 * them. Two adapters:
 *
 * - `DohResolver` — Cloudflare's DNS-over-HTTPS JSON API (`1.1.1.1`), over
 *   `fetch`. A Worker has no UDP socket, so DoH is the only real DNS it has.
 * - `FakeDns` — canned answers held in memory. Tests set them; locally, the
 *   fake Cloudflare one-click setup writes into it, so the whole flow works on
 *   a laptop without touching anyone's zone.
 *
 * Chosen by `Env.DNS_RESOLVER` in `core/domains.ts`. Nothing in `core/` knows
 * which one it has.
 */

export type DnsType = 'TXT' | 'CNAME' | 'MX'

/**
 * What a name holds for a type. TXT strings are joined (a long DKIM key comes
 * back split into 255-byte chunks); MX is `"<priority> <host>"`; host names
 * have no trailing dot.
 */
export type DnsAnswer = { ok: true; values: string[] } | { ok: false; error: 'nxdomain' | 'servfail' | 'timeout' }

export interface DnsResolver {
  lookup(name: string, type: DnsType): Promise<DnsAnswer>
}

const TYPE_CODE: Record<DnsType, number> = { CNAME: 5, MX: 15, TXT: 16 }

/** DNS-over-HTTPS against 1.1.1.1. Public, read-only, needs no key. */
export class DohResolver implements DnsResolver {
  constructor(private readonly endpoint = 'https://cloudflare-dns.com/dns-query') {}

  async lookup(name: string, type: DnsType): Promise<DnsAnswer> {
    const url = `${this.endpoint}?name=${encodeURIComponent(name)}&type=${type}`
    let res: Response
    try {
      res = await fetch(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) })
    } catch {
      return { ok: false, error: 'timeout' }
    }
    if (!res.ok) return { ok: false, error: 'servfail' }
    const body = (await res.json().catch(() => null)) as
      | { Status?: number; Answer?: { type?: number; data?: string }[] }
      | null
    return parseDohAnswer(body, type)
  }
}

/**
 * The DoH JSON body → an answer. Pure, so the spec can feed it Cloudflare's
 * documented shape without a network.
 *
 * Only answers of the asked type count: asking TXT of a name that is a CNAME
 * returns the CNAME too, and the chain's target's records are not this name's.
 */
export function parseDohAnswer(
  body: { Status?: number; Answer?: { type?: number; data?: string }[] } | null,
  type: DnsType,
): DnsAnswer {
  if (!body) return { ok: false, error: 'servfail' }
  if (body.Status === 3) return { ok: false, error: 'nxdomain' }
  if (body.Status !== 0) return { ok: false, error: 'servfail' }
  const code = TYPE_CODE[type]
  const values = (body.Answer ?? [])
    .filter((a) => a.type === code && typeof a.data === 'string')
    .map((a) => cleanData(a.data!, type))
  return { ok: true, values }
}

function cleanData(data: string, type: DnsType): string {
  if (type === 'TXT') {
    // `"v=DKIM1; k=rsa; p=MIIB..." "...rest"` → one string.
    const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\(.)/g, '$1'))
    return parts.length ? parts.join('') : data
  }
  return data.trim().replace(/\.$/, '').toLowerCase()
}

// ───────────────────────────────────────────── the fake

/**
 * In-memory DNS. Module-level on purpose: one Worker isolate is one "internet",
 * and both the fake Cloudflare zone and the fake resolver must see the same
 * records for local one-click setup to verify.
 */
const fakeZone = new Map<string, string[]>()

const key = (name: string, type: DnsType) => `${type} ${name.toLowerCase().replace(/\.$/, '')}`

export const fakeDns = {
  set(name: string, type: DnsType, values: string[]): void {
    fakeZone.set(key(name, type), values)
  },
  add(name: string, type: DnsType, value: string): void {
    fakeZone.set(key(name, type), [...(fakeZone.get(key(name, type)) ?? []), value])
  },
  /** Every name the fake knows, for the fake Cloudflare zone's listing. */
  at(name: string): { type: DnsType; values: string[] }[] {
    return (['TXT', 'CNAME', 'MX'] as DnsType[])
      .map((type) => ({ type, values: fakeZone.get(key(name, type)) ?? [] }))
      .filter((r) => r.values.length > 0)
  },
  clear(): void {
    fakeZone.clear()
  },
}

export class FakeDns implements DnsResolver {
  async lookup(name: string, type: DnsType): Promise<DnsAnswer> {
    const values = fakeZone.get(key(name, type))
    if (values) return { ok: true, values }
    // A name with records of another type exists; one with none does not.
    return fakeDns.at(name).length ? { ok: true, values: [] } : { ok: false, error: 'nxdomain' }
  }
}
