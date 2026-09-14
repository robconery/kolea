import type { Env } from '../types.ts'

/**
 * Unsplash — stock photography for featured images.
 *
 * Read-only and keyless-until-configured: with no `UNSPLASH_ACCESS_KEY` the
 * picker doesn't appear and nothing here is ever called.
 *
 * Two rules from the API guidelines are load-bearing, not decoration:
 *
 *  1. **Hotlink, never rehost.** The `images.unsplash.com` URL is what goes in
 *     the column. Copying the bytes into R2 would be faster to serve and would
 *     also break the photographer's view counts, which is the thing Unsplash
 *     gives the API away in exchange for.
 *  2. **Ping the download endpoint when a photo is actually chosen** — not when
 *     it appears in search results. That ping is what credits the photographer;
 *     `triggerDownload` below is called from the "use this photo" handler and
 *     nowhere else.
 *
 * Attribution is stored on the broadcast alongside the URL and rendered under
 * the image on the public page. A photo credit that lives only in the admin is
 * not a credit.
 */

const API = 'https://api.unsplash.com'

/** Appended to every link back, as the guidelines require. */
const UTM = 'utm_source=kolea&utm_medium=referral'

export interface Photo {
  id: string
  /** Grid thumbnail — small, for the picker. */
  thumbUrl: string
  /**
   * What gets stored and served. Width-capped rather than `raw`: a featured
   * image 4,000px wide is a slow page and an email that never loads.
   */
  url: string
  alt: string
  credit: string
  creditUrl: string
  /** Opaque per-photo endpoint. Pinged on selection; never built by hand. */
  downloadLocation: string
  color: string | null
}

export function unsplashConfigured(env: Env): boolean {
  return Boolean(env.UNSPLASH_ACCESS_KEY)
}

export async function searchPhotos(env: Env, query: string, page = 1): Promise<Photo[]> {
  if (!env.UNSPLASH_ACCESS_KEY) return []
  const q = query.trim()
  if (!q) return []

  const url = `${API}/search/photos?query=${encodeURIComponent(q)}&per_page=12&page=${page}&orientation=landscape&content_filter=high`

  const res = await fetch(url, {
    headers: {
      Authorization: `Client-ID ${env.UNSPLASH_ACCESS_KEY}`,
      'Accept-Version': 'v1',
    },
  })
  if (!res.ok) throw new Error(`Unsplash search failed (${res.status})`)

  const body = (await res.json()) as { results?: UnsplashPhoto[] }
  return (body.results ?? []).map(toPhoto)
}

/**
 * Tell Unsplash a photo was used. Fire-and-forget by design: a failed ping must
 * never stop the operator setting their image, and there is nothing useful to do
 * about it either way.
 */
export async function triggerDownload(env: Env, downloadLocation: string): Promise<void> {
  if (!env.UNSPLASH_ACCESS_KEY || !downloadLocation.startsWith(`${API}/`)) return
  try {
    await fetch(downloadLocation, {
      headers: { Authorization: `Client-ID ${env.UNSPLASH_ACCESS_KEY}`, 'Accept-Version': 'v1' },
    })
  } catch {
    /* the picture is already chosen; this is a courtesy */
  }
}

/** The profile link that must accompany the photographer's name. */
export function creditUrlFor(username: string): string {
  return `https://unsplash.com/@${username}?${UTM}`
}

interface UnsplashPhoto {
  id: string
  color?: string | null
  alt_description?: string | null
  description?: string | null
  urls?: { small?: string; regular?: string; raw?: string }
  links?: { download_location?: string }
  user?: { name?: string; username?: string }
}

function toPhoto(p: UnsplashPhoto): Photo {
  const username = p.user?.username ?? ''
  return {
    id: p.id,
    thumbUrl: p.urls?.small ?? '',
    url: p.urls?.regular ?? p.urls?.small ?? '',
    alt: (p.alt_description ?? p.description ?? '').trim(),
    credit: p.user?.name ?? 'Unknown',
    creditUrl: username ? creditUrlFor(username) : 'https://unsplash.com',
    downloadLocation: p.links?.download_location ?? '',
    color: p.color ?? null,
  }
}
