import { count, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { broadcasts, media, purchaseTemplates, sequenceSteps, siteSettings } from '../db/schema.ts'
import type { Env } from '../types.ts'
import { randomToken } from './ids.ts'

/**
 * Storing an uploaded image.
 *
 * Pulled down here out of `api/media.ts` when the featured-image picker needed
 * the same behaviour from a different screen. Two upload paths would have meant
 * two allowlists, and the one that drifted would be the one that let an SVG in.
 */

const MAX_BYTES = 10 * 1024 * 1024

// Allowlist rather than blocklist: an uploaded SVG can carry script, and these
// files are served from our own origin.
const ALLOWED: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
}

export type StoreResult =
  | { ok: true; url: string; key: string }
  | { ok: false; status: 400 | 413 | 415; message: string }

export async function storeMedia(env: Env, db: Db, file: File): Promise<StoreResult> {
  if (file.size === 0) {
    return { ok: false, status: 400, message: 'That file is empty.' }
  }
  if (file.size > MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `That file is ${(file.size / 1024 / 1024).toFixed(1)}MB — the limit is ${MAX_BYTES / 1024 / 1024}MB.`,
    }
  }
  const ext = ALLOWED[file.type]
  if (!ext) {
    return {
      ok: false,
      status: 415,
      message: `${file.type || 'That file type'} isn't a supported image (PNG, JPEG, GIF, WebP or AVIF).`,
    }
  }

  // Content-addressed by a random token, which is what lets `/media/:key` be
  // served immutable forever — a key never changes meaning.
  const key = `${new Date().toISOString().slice(0, 7)}/${randomToken(20)}.${ext}`

  const bytes = await file.arrayBuffer()
  const size = imageDimensions(new Uint8Array(bytes))

  await env.MEDIA.put(key, bytes, {
    httpMetadata: { contentType: file.type, cacheControl: 'public, max-age=31536000, immutable' },
  })

  await db.insert(media).values({
    key,
    filename: file.name || `upload.${ext}`,
    contentType: file.type,
    bytes: file.size,
    width: size?.width ?? null,
    height: size?.height ?? null,
    createdAt: new Date(),
  })

  // Absolute URL: this lands in an email and in an og:image, where a relative
  // path is meaningless.
  return { ok: true, url: mediaUrl(env, key), key }
}

/** Where a reader or a mail client fetches an image. */
export function mediaUrl(env: Env, key: string): string {
  return `${env.PUBLIC_URL}/media/${key}`
}

// ───────────────────────────────────────────────────────────── the library

export interface MediaItem {
  id: number
  key: string
  url: string
  filename: string
  contentType: string
  bytes: number
  width: number | null
  height: number | null
  createdAt: Date
}

export interface MediaPage {
  items: MediaItem[]
  page: number
  perPage: number
  total: number
  pages: number
}

/**
 * One page of the library, newest first (the `media` table is the catalogue,
 * so this never pages the bucket). `id` breaks ties between uploads in the same
 * millisecond.
 */
export async function listMedia(
  env: Env,
  db: Db,
  opts: { page?: number; perPage?: number } = {},
): Promise<MediaPage> {
  const perPage = Math.min(Math.max(Math.trunc(opts.perPage ?? 48) || 48, 1), 200)
  const page = Math.max(Math.trunc(opts.page ?? 1) || 1, 1)
  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(media)
      .orderBy(desc(media.createdAt), desc(media.id))
      .limit(perPage)
      .offset((page - 1) * perPage)
      .all(),
    db.select({ n: count() }).from(media).get(),
  ])
  const total = totalRow?.n ?? 0
  return {
    items: rows.map((m) => ({ ...m, url: mediaUrl(env, m.key) })),
    page,
    perPage,
    total,
    pages: Math.max(1, Math.ceil(total / perPage)),
  }
}

/** Something that still shows an image: deleting it would leave a broken picture there. */
export interface MediaUse {
  kind: 'broadcast' | 'feature_image' | 'sequence_step' | 'purchase_mail' | 'site'
  label: string
  href: string
}

/**
 * Everywhere an image's key appears in something that is still read: a
 * broadcast or post body, a post's feature image, a sequence step, a purchase
 * mail, the site profile. Sent `messages` are left out on purpose: they are
 * history, and a sent mail already points at the URL whatever happens next.
 *
 * Matched on the key, not the full URL, so a body written while PUBLIC_URL was
 * different still counts. Keys carry a random 20-character token, so a
 * substring match cannot hit anything by accident.
 */
export async function mediaUsage(db: Db, key: string): Promise<MediaUse[]> {
  const has = (col: unknown) => sql`instr(coalesce(${col}, ''), ${key}) > 0`
  const [bodies, features, steps, templates, site] = await Promise.all([
    db
      .select({ id: broadcasts.id, subject: broadcasts.subject })
      .from(broadcasts)
      .where(sql`${has(broadcasts.bodyJson)} or ${has(broadcasts.bodyMd)}`)
      .all(),
    db
      .select({ id: broadcasts.id, subject: broadcasts.subject })
      .from(broadcasts)
      .where(has(broadcasts.featureImage))
      .all(),
    db
      .select({ id: sequenceSteps.id, sequenceId: sequenceSteps.sequenceId, subject: sequenceSteps.subject })
      .from(sequenceSteps)
      .where(sql`${has(sequenceSteps.bodyJson)} or ${has(sequenceSteps.bodyMd)}`)
      .all(),
    db
      .select({ id: purchaseTemplates.id, name: purchaseTemplates.name })
      .from(purchaseTemplates)
      .where(sql`${has(purchaseTemplates.bodyJson)} or ${has(purchaseTemplates.bodyMd)}`)
      .all(),
    db
      .select({ id: siteSettings.id })
      .from(siteSettings)
      .where(
        sql`${has(siteSettings.logoUrl)} or ${has(siteSettings.authorPhotoUrl)} or ${has(siteSettings.longBioJson)} or ${has(siteSettings.longBioMd)} or ${has(siteSettings.profile)}`,
      )
      .all(),
  ])
  return [
    ...bodies.map((b) => ({ kind: 'broadcast' as const, label: b.subject, href: `/broadcasts/${b.id}` })),
    ...features.map((b) => ({
      kind: 'feature_image' as const,
      label: `Feature image: ${b.subject}`,
      href: `/broadcasts/${b.id}/publishing`,
    })),
    ...steps.map((s) => ({
      kind: 'sequence_step' as const,
      label: s.subject,
      href: `/sequences/${s.sequenceId}/steps/${s.id}`,
    })),
    ...templates.map((t) => ({ kind: 'purchase_mail' as const, label: t.name, href: `/purchase-mail/${t.id}` })),
    ...site.map(() => ({ kind: 'site' as const, label: 'Site profile', href: '/site' })),
  ]
}

export type DeleteResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'in_use'; usage: MediaUse[] }

/**
 * Remove an image from the library and the bucket.
 *
 * Refuses while anything still shows it, unless `force`: a deleted image is a
 * broken picture in a draft somebody then mails to the list. The row goes
 * first, so a bucket failure leaves an orphan object (harmless, sweepable)
 * rather than a library entry whose bytes are gone.
 */
export async function deleteMedia(
  env: Env,
  db: Db,
  key: string,
  opts: { force?: boolean } = {},
): Promise<DeleteResult> {
  const row = await db.select({ id: media.id }).from(media).where(eq(media.key, key)).get()
  if (!row) return { ok: false, reason: 'not_found' }
  if (!opts.force) {
    const usage = await mediaUsage(db, key)
    if (usage.length > 0) return { ok: false, reason: 'in_use', usage }
  }
  await db.delete(media).where(eq(media.id, row.id))
  await env.MEDIA.delete(key)
  return { ok: true }
}

// ───────────────────────────────────────────────────────────── dimensions

/**
 * An image's pixel size from its header. PNG, GIF, JPEG and WebP; AVIF and
 * anything unreadable give null rather than a guess. Only the header is read,
 * never pixels, so a hostile file costs a bounded scan.
 */
export function imageDimensions(b: Uint8Array): { width: number; height: number } | null {
  const u16be = (i: number) => (b[i]! << 8) | b[i + 1]!
  const u16le = (i: number) => b[i]! | (b[i + 1]! << 8)
  const u24le = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)
  const u32be = (i: number) => ((b[i]! << 24) >>> 0) + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!)
  const ascii = (i: number, s: string) => [...s].every((ch, j) => b[i + j] === ch.charCodeAt(0))
  const checked = (width: number, height: number) =>
    width >= 1 && height >= 1 && width <= 65535 && height <= 65535 ? { width, height } : null

  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 'PNG') && ascii(12, 'IHDR')) {
    return checked(u32be(16), u32be(20))
  }
  if (b.length >= 10 && ascii(0, 'GIF8') && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) {
    return checked(u16le(6), u16le(8))
  }
  if (b.length >= 30 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    if (ascii(12, 'VP8 ') && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return checked(u16le(26) & 0x3fff, u16le(28) & 0x3fff)
    }
    if (ascii(12, 'VP8L') && b[20] === 0x2f) {
      const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0
      return checked((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
    }
    if (ascii(12, 'VP8X')) return checked(u24le(24) + 1, u24le(27) + 1)
    return null
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk the markers to the first start-of-frame (SOF0..SOF15 except DHT,
    // JPG and DAC), which carries height then width.
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null
      const marker = b[i + 1]!
      if (marker === 0xff) {
        i++
        continue
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return checked(u16be(i + 7), u16be(i + 5))
      }
      if (marker === 0xd8 || marker === 0xd9 || marker === 0xda) return null
      const len = u16be(i + 2)
      if (len < 2) return null
      i += 2 + len
    }
  }
  return null
}
