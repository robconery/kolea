import type { Env } from '../types.ts'

/**
 * ⭐ Where the open pixel and tracked links point.
 *
 * By default that is `PUBLIC_URL`, the console's own host. `TRACKING_HOST` moves
 * new mail onto the sender's own subdomain instead (`links.example.com`), so a
 * reader hovering a link sees the sender's name, and the console's hostname is
 * not written into every mail that goes out.
 *
 * ⚠️ A tracking URL is baked into mail at send time and can never be fixed after
 * delivery (ARCHITECTURE "Traps"). So hosts are append-only:
 *
 *   - `PUBLIC_URL` keeps answering `/t/open` and `/t/click` forever, whatever
 *     `TRACKING_HOST` says, so mail sent before the setting existed still works.
 *   - `TRACKING_HOST` may be a comma-separated list. The FIRST entry is used for
 *     new mail; every entry keeps answering. Retiring a host means moving it
 *     later in the list, never deleting it.
 *
 * A tracking host reaches only the tracking routes (`worker.tsx`). It is a
 * public hostname with no Cloudflare Access in front of it, so the admin app —
 * and everything behind `requireOperator` — must never be reachable on it.
 */

/** Each configured host, as a lower-cased `host[:port]`, newest first. */
export function trackingHosts(env: Pick<Env, 'TRACKING_HOST' | 'SITE_URL' | 'PUBLIC_URL'>): string[] {
  const raw = env.TRACKING_HOST?.trim()
  if (!raw) return []
  const reserved = new Set([hostOf(env.PUBLIC_URL), hostOf(env.SITE_URL)].filter(Boolean))
  const hosts: string[] = []
  for (const entry of raw.split(',')) {
    const host = parseHost(entry)
    // The public site's host belongs to the site, and the console's host already
    // serves tracking itself. Claiming either would hijack its whole app.
    if (!host || reserved.has(host) || hosts.includes(host)) continue
    hosts.push(host)
  }
  return hosts
}

/**
 * The origin new mail's pixel and tracked links are built on.
 *
 * Scheme follows `PUBLIC_URL`'s — `https` in production, `http` in local dev,
 * where `links.localhost:8787` reaches the same `wrangler dev`.
 */
export function trackingBaseUrl(env: Pick<Env, 'TRACKING_HOST' | 'SITE_URL' | 'PUBLIC_URL'>): string {
  const [current] = trackingHosts(env)
  if (!current) return env.PUBLIC_URL
  const scheme = env.PUBLIC_URL?.startsWith('http://') ? 'http' : 'https'
  return `${scheme}://${current}`
}

/** Whether a request arrived on one of the tracking hosts. */
export function isTrackingHost(request: Request, env: Env): boolean {
  const hosts = trackingHosts(env)
  if (hosts.length === 0) return false
  try {
    return hosts.includes(new URL(request.url).host.toLowerCase())
  } catch {
    return false
  }
}

/** `links.example.com`, `https://links.example.com/`, `Links.Example.com.` → `links.example.com`. */
function parseHost(entry: string): string | null {
  const trimmed = entry.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
    return url.host.toLowerCase().replace(/\.$/, '') || null
  } catch {
    return null
  }
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return null
  }
}
