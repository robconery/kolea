import { eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { media } from '../db/schema.ts'
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

  await env.MEDIA.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type, cacheControl: 'public, max-age=31536000, immutable' },
  })

  await db.insert(media).values({
    key,
    filename: file.name || `upload.${ext}`,
    contentType: file.type,
    bytes: file.size,
    createdAt: new Date(),
  })

  // Absolute URL: this lands in an email and in an og:image, where a relative
  // path is meaningless.
  return { ok: true, url: `${env.PUBLIC_URL}/media/${key}`, key }
}

export async function deleteMedia(env: Env, db: Db, key: string): Promise<void> {
  await env.MEDIA.delete(key)
  await db.delete(media).where(eq(media.key, key))
}
