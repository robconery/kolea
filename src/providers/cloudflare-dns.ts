import { fakeDns } from './dns.ts'

/**
 * The Cloudflare DNS API port, for one-click setup of a sending domain's records
 * (Kōlea SPEC 6.1.4a). Find the zone that holds a name, list what is already at
 * a name, create a record. Nothing else: it never edits or deletes, so the worst
 * a bug here can do is add a record the operator then removes.
 *
 * Adapters: `CloudflareApi` (v4 REST over `fetch`, with a scoped API token from
 * `CLOUDFLARE_DNS_API_TOKEN` — Zone:Read + DNS:Edit on the zones you send from)
 * and `FakeCloudflare` (in memory; records every call, and writes what it
 * "creates" into the fake DNS so a local check sees it). Chosen by
 * `Env.CLOUDFLARE_DNS` in `core/domains.ts`.
 */

export interface CfZone {
  id: string
  name: string
}

export interface CfRecord {
  type: string
  name: string
  content: string
  priority?: number
}

export type CfResult<T> = { ok: true; value: T } | { ok: false; error: 'unauthorized' | 'zone_not_found' | 'provider_error'; detail?: string }

export interface CloudflareDns {
  findZone(domain: string): Promise<CfResult<CfZone>>
  listRecords(zone: CfZone, name: string): Promise<CfResult<CfRecord[]>>
  createRecord(zone: CfZone, record: CfRecord): Promise<CfResult<null>>
}

/** The zone among `zones` that holds `domain`: longest match wins. Pure. */
export function pickZone(zones: CfZone[], domain: string): CfZone | null {
  const holding = zones.filter((z) => domain === z.name || domain.endsWith(`.${z.name}`))
  return holding.sort((a, b) => b.name.length - a.name.length)[0] ?? null
}

/** `mail.example.co.uk` → `example.co.uk`, `co.uk`… every name that could be its zone. */
function candidateZones(domain: string): string[] {
  const labels = domain.split('.')
  const out: string[] = []
  for (let n = 2; n <= labels.length; n++) out.push(labels.slice(-n).join('.'))
  return out
}

const API = 'https://api.cloudflare.com/client/v4'

export class CloudflareApi implements CloudflareDns {
  constructor(private readonly token: string) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<CfResult<T>> {
    let res: Response
    try {
      res = await fetch(`${API}${path}`, {
        method,
        redirect: 'manual',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (e) {
      return { ok: false, error: 'provider_error', detail: (e as Error).message }
    }
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'unauthorized' }
    const json = (await res.json().catch(() => null)) as
      | { success?: boolean; result?: T; errors?: { code?: number; message?: string }[] }
      | null
    if (!res.ok || !json?.success) {
      // Cloudflare's own codes and messages, never the request (it carries the token).
      const detail = (json?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ')
      return { ok: false, error: 'provider_error', detail: detail || `HTTP ${res.status}` }
    }
    return { ok: true, value: json.result as T }
  }

  async findZone(domain: string): Promise<CfResult<CfZone>> {
    // Ask for each candidate by name rather than listing every zone the token
    // can see. A refusal stops the search: it means the token is wrong, not
    // that the zone is missing.
    const zones: CfZone[] = []
    for (const name of candidateZones(domain)) {
      const got = await this.request<{ id: string; name: string }[]>('GET', `/zones?name=${encodeURIComponent(name)}&status=active`)
      if (!got.ok) return got
      zones.push(...got.value.map((z) => ({ id: z.id, name: z.name })))
    }
    const zone = pickZone(zones, domain)
    return zone ? { ok: true, value: zone } : { ok: false, error: 'zone_not_found' }
  }

  async listRecords(zone: CfZone, name: string): Promise<CfResult<CfRecord[]>> {
    const got = await this.request<{ type: string; name: string; content: string; priority?: number }[]>(
      'GET',
      `/zones/${zone.id}/dns_records?name=${encodeURIComponent(name)}`,
    )
    if (!got.ok) return got
    return { ok: true, value: got.value.map((r) => ({ type: r.type, name: r.name, content: r.content, priority: r.priority })) }
  }

  async createRecord(zone: CfZone, record: CfRecord): Promise<CfResult<null>> {
    const got = await this.request<unknown>('POST', `/zones/${zone.id}/dns_records`, {
      type: record.type,
      name: record.name,
      content: record.content,
      ...(record.type === 'MX' ? { priority: record.priority ?? 10 } : {}),
      ttl: 1,
      // DNS only. A proxied record answers with Cloudflare's IPs, and a proxied
      // CNAME is flattened — neither is what a mail provider looks for.
      proxied: false,
      comment: 'Added by Kōlea',
    })
    return got.ok ? { ok: true, value: null } : got
  }
}

// ───────────────────────────────────────────── the fake

export interface FakeCloudflareCall {
  op: 'findZone' | 'listRecords' | 'createRecord'
  arg: string
  record?: CfRecord
}

/**
 * State for the fake. `zones` null means "every domain's last two labels are a
 * zone this token can edit", which is what makes local one-click work for any
 * name; a spec narrows it, or sets `unauthorized`.
 */
export const fakeCloudflare = {
  calls: [] as FakeCloudflareCall[],
  zones: null as string[] | null,
  unauthorized: false,
  reset(): void {
    this.calls = []
    this.zones = null
    this.unauthorized = false
  },
}

export class FakeCloudflare implements CloudflareDns {
  async findZone(domain: string): Promise<CfResult<CfZone>> {
    fakeCloudflare.calls.push({ op: 'findZone', arg: domain })
    if (fakeCloudflare.unauthorized) return { ok: false, error: 'unauthorized' }
    const names = fakeCloudflare.zones ?? [domain.split('.').slice(-2).join('.')]
    const zone = pickZone(names.map((name) => ({ id: `zone-${name}`, name })), domain)
    return zone ? { ok: true, value: zone } : { ok: false, error: 'zone_not_found' }
  }

  async listRecords(_zone: CfZone, name: string): Promise<CfResult<CfRecord[]>> {
    fakeCloudflare.calls.push({ op: 'listRecords', arg: name })
    return {
      ok: true,
      value: fakeDns.at(name).flatMap(({ type, values }) =>
        values.map((content) => {
          if (type !== 'MX') return { type, name, content }
          const [priority, host] = content.split(' ')
          return { type, name, content: host ?? content, priority: Number(priority) }
        }),
      ),
    }
  }

  async createRecord(_zone: CfZone, record: CfRecord): Promise<CfResult<null>> {
    fakeCloudflare.calls.push({ op: 'createRecord', arg: record.name, record })
    if (fakeCloudflare.unauthorized) return { ok: false, error: 'unauthorized' }
    const type = record.type as 'TXT' | 'CNAME' | 'MX'
    fakeDns.add(record.name, type, type === 'MX' ? `${record.priority ?? 10} ${record.content}` : record.content)
    return { ok: true, value: null }
  }
}
