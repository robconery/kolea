/**
 * A fake of the four APIs the importers read — Kit v4, the Ghost Admin API,
 * Mailchimp Marketing 3.0 and Drip v2 — bound as `Env.IMPORT_HTTP`, so the
 * real adapters in `src/providers/importers/` run unchanged and nothing leaves
 * the process.
 *
 * Every list is paginated two items at a time whatever page size the adapter
 * asks for, so a handful of fixtures is enough to make a run span several cron
 * ticks — which is the point: resuming from a stored cursor is the behaviour
 * under test. Every request is logged, so a spec can see which cursor a tick
 * resumed from.
 *
 * Auth is checked the way each tool checks it, Ghost's JWT included (signature
 * verified with WebCrypto), so a wrong key here fails the way it would there.
 */

export const PAGE = 2

export interface FakeData {
  kit?: {
    key: string
    tags: { id: number; name: string }[]
    subscribers: Record<string, unknown>[]
    /** tag id → subscriber emails */
    taggings: Record<number, string[]>
    broadcasts: (Record<string, unknown> & { stats?: Record<string, unknown> })[]
    sequences: (Record<string, unknown> & { emails: Record<string, unknown>[] })[]
  }
  ghost?: {
    origin: string
    adminKey: string
    members: Record<string, unknown>[]
    posts: Record<string, unknown>[]
  }
  mailchimp?: {
    key: string
    listId: string
    members: Record<string, unknown>[]
    campaigns: (Record<string, unknown> & { html?: string })[]
  }
  drip?: {
    token: string
    accountId: string
    tags: string[]
    subscribers: Record<string, unknown>[]
    broadcasts: Record<string, unknown>[]
  }
}

export interface FakeApis {
  fetcher: Fetcher
  /** Every URL requested, in order (path + query). */
  requests: string[]
  /** Make every later request answer this status (an outage, a revoked key). */
  failWith(status: number | null): void
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Kit-style cursor pagination over an index. */
function kitPage<T>(items: T[], url: URL) {
  const start = Number(url.searchParams.get('after') ?? 0)
  const slice = items.slice(start, start + PAGE)
  const more = start + PAGE < items.length
  return { slice, pagination: { has_next_page: more, end_cursor: more ? String(start + PAGE) : null } }
}

function numberPage<T>(items: T[], url: URL) {
  const page = Number(url.searchParams.get('page') ?? 1)
  const slice = items.slice((page - 1) * PAGE, page * PAGE)
  const pages = Math.max(1, Math.ceil(items.length / PAGE))
  return { slice, page, pages, next: page < pages ? page + 1 : null }
}

function offsetPage<T>(items: T[], url: URL) {
  const offset = Number(url.searchParams.get('offset') ?? 0)
  return items.slice(offset, offset + PAGE)
}

const b64urlDecode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

async function ghostTokenValid(header: string | null, adminKey: string): Promise<boolean> {
  if (!header?.startsWith('Ghost ')) return false
  const [h, p, sig] = header.slice(6).split('.')
  if (!h || !p || !sig) return false
  const [id, secret] = adminKey.split(':') as [string, string]
  const head = JSON.parse(new TextDecoder().decode(b64urlDecode(h)))
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)))
  if (head.kid !== id || payload.aud !== '/admin/' || payload.exp - payload.iat > 300) return false
  const bytes = new Uint8Array(secret.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(secret.slice(i * 2, i * 2 + 2), 16)
  const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  return await crypto.subtle.verify('HMAC', key, b64urlDecode(sig), new TextEncoder().encode(`${h}.${p}`))
}

export function fakeImportApis(data: FakeData): FakeApis {
  const requests: string[] = []
  let forced: number | null = null

  async function answer(url: URL, headers: Headers): Promise<Response> {
    if (forced !== null) return json({ error: 'forced' }, forced)
    const path = url.pathname

    if (url.host === 'api.kit.com' && data.kit) {
      const kit = data.kit
      if (headers.get('x-kit-api-key') !== kit.key) return json({ errors: ['unauthorized'] }, 401)
      const p = path.replace('/v4', '')
      if (p === '/account') return json({ account: { name: 'Fake' } })
      if (p === '/tags') {
        const { slice, pagination } = kitPage(kit.tags, url)
        return json({ tags: slice, pagination })
      }
      if (p === '/subscribers') {
        const { slice, pagination } = kitPage(kit.subscribers, url)
        return json({ subscribers: slice, pagination })
      }
      const tagSubs = /^\/tags\/(\d+)\/subscribers$/.exec(p)
      if (tagSubs) {
        const emails = kit.taggings[Number(tagSubs[1])] ?? []
        const { slice, pagination } = kitPage(emails, url)
        return json({ subscribers: slice.map((email_address) => ({ email_address })), pagination })
      }
      if (p === '/broadcasts') {
        const { slice, pagination } = kitPage(kit.broadcasts, url)
        return json({ broadcasts: slice.map(({ stats: _s, ...b }) => b), pagination })
      }
      const stats = /^\/broadcasts\/(\d+)\/stats$/.exec(p)
      if (stats) {
        const b = kit.broadcasts.find((x) => String(x.id) === stats[1])
        return b ? json({ broadcast: { id: b.id, stats: b.stats ?? {} } }) : json({}, 404)
      }
      if (p === '/sequences') {
        const { slice, pagination } = kitPage(kit.sequences, url)
        return json({ sequences: slice.map(({ emails: _e, ...s }) => s), pagination })
      }
      const emails = /^\/sequences\/(\d+)\/emails$/.exec(p)
      if (emails) {
        const s = kit.sequences.find((x) => String(x.id) === emails[1])
        return json({ emails: s?.emails ?? [], pagination: { has_next_page: false, end_cursor: null } })
      }
    }

    if (data.ghost && url.origin === data.ghost.origin && path.startsWith('/ghost/api/admin/')) {
      const ghost = data.ghost
      if (!(await ghostTokenValid(headers.get('authorization'), ghost.adminKey))) return json({ errors: [] }, 401)
      const p = path.replace('/ghost/api/admin', '')
      if (p === '/site/') return json({ site: { title: 'Fake Ghost' } })
      const list = p === '/members/' ? ghost.members : p === '/posts/' ? ghost.posts : null
      if (list) {
        const { slice, page, pages, next } = numberPage(list, url)
        return json({
          [p === '/members/' ? 'members' : 'posts']: slice,
          meta: { pagination: { page, pages, next } },
        })
      }
    }

    if (data.mailchimp && /^[a-z]{2}\d+\.api\.mailchimp\.com$/.test(url.host)) {
      const mc = data.mailchimp
      if (headers.get('authorization') !== `Basic ${btoa(`kolea:${mc.key}`)}`) return json({}, 401)
      const p = path.replace('/3.0', '')
      if (p === `/lists/${mc.listId}`) return json({ id: mc.listId })
      if (p === `/lists/${mc.listId}/members`) {
        return json({ members: offsetPage(mc.members, url), total_items: mc.members.length })
      }
      if (p === '/campaigns') {
        return json({
          campaigns: offsetPage(mc.campaigns, url).map(({ html: _h, ...c }) => c),
          total_items: mc.campaigns.length,
        })
      }
      const content = /^\/campaigns\/([^/]+)\/content$/.exec(p)
      if (content) return json({ html: mc.campaigns.find((c) => String(c.id) === content[1])?.html ?? '' })
    }

    if (data.drip && url.host === 'api.getdrip.com') {
      const drip = data.drip
      if (headers.get('authorization') !== `Basic ${btoa(`${drip.token}:`)}`) return json({}, 401)
      const p = path.replace('/v2', '')
      if (p === '/accounts') return json({ accounts: [{ id: drip.accountId }] })
      if (p === `/${drip.accountId}/tags`) return json({ tags: drip.tags })
      const list =
        p === `/${drip.accountId}/subscribers` ? 'subscribers' : p === `/${drip.accountId}/broadcasts` ? 'broadcasts' : null
      if (list) {
        const { slice, pages } = numberPage(drip[list], url)
        return json({ [list]: slice, meta: { total_pages: pages } })
      }
    }

    return json({ error: `fake has no ${url.host}${path}` }, 404)
  }

  const fetcher = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      requests.push(`${url.host}${url.pathname}${url.search}`)
      return await answer(url, new Headers(init?.headers))
    },
    connect() {
      throw new Error('not supported')
    },
  } as unknown as Fetcher

  return {
    fetcher,
    requests,
    failWith(status) {
      forced = status
    },
  }
}

/** The default binding in every world: an importer that reaches for the network gets nothing. */
export const noNetwork = {
  async fetch(input: RequestInfo | URL) {
    return new Response(JSON.stringify({ error: `no network in tests: ${String(input)}` }), { status: 599 })
  },
  connect() {
    throw new Error('no network in tests')
  },
} as unknown as Fetcher
