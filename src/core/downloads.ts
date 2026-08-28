import { and, count, eq, inArray, sql, sum } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { downloadGrants, forms } from '../db/schema.ts'
import { randomToken } from './ids.ts'

/**
 * The file a form hands over — the lead magnet.
 *
 * It belongs to the form, not to a library: this form trades this file for an
 * address. The bytes live in their own R2 bucket (`DOWNLOADS`) that no route
 * serves by key, and they leave only through a *grant* — one row per person, per
 * form, carrying the token that is the URL. That is what makes "who actually
 * opened the toolkit" answerable next quarter instead of a log line that expired.
 */

/** How large a lead magnet may be. Bounded by what a Worker will stream, not by taste. */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024

/**
 * Types we will hand out. An allowlist rather than a blocklist, because these
 * bytes come back with a `Content-Disposition` from our own origin — the same
 * reason `api/media.ts` refuses SVG.
 */
export const ALLOWED_DOWNLOAD_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/pdf',
  'application/epub+zip',
  'application/gzip',
  'application/x-tar',
  // What a browser sends when it has no idea. Common for .zip from Safari.
  'application/octet-stream',
])

const EXT: Record<string, string> = {
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/pdf': 'pdf',
  'application/epub+zip': 'epub',
  'application/gzip': 'gz',
  'application/x-tar': 'tar',
}

/** The R2 key for a new upload. Random, because the key is the only secret R2 has. */
export function downloadKey(formId: number, contentType: string, filename: string): string {
  const fromName = filename.split('.').pop()?.toLowerCase() ?? ''
  const ext = EXT[contentType] ?? (/^[a-z0-9]{1,8}$/.test(fromName) ? fromName : 'bin')
  return `f${formId}/${randomToken(24)}.${ext}`
}

// ───────────────────────────────────────────────── the file on a form

export interface FormFile {
  key: string
  filename: string
  contentType: string
  bytes: number
}

export async function attachFile(db: Db, formId: number, file: FormFile): Promise<void> {
  await db
    .update(forms)
    .set({
      downloadKey: file.key,
      downloadFilename: file.filename,
      downloadContentType: file.contentType,
      downloadBytes: file.bytes,
      downloadUploadedAt: new Date(),
    })
    .where(eq(forms.id, formId))
}

/**
 * Forget the file. The caller deletes the object from R2 — this drops the
 * columns and every grant, which is the one place a link is revoked.
 */
export async function detachFile(db: Db, formId: number): Promise<void> {
  await db
    .update(forms)
    .set({
      downloadKey: null,
      downloadFilename: null,
      downloadContentType: null,
      downloadBytes: null,
      downloadUploadedAt: null,
    })
    .where(eq(forms.id, formId))
  await db.delete(downloadGrants).where(eq(downloadGrants.formId, formId))
}

/** Links handed out, and how many times the file actually moved. */
export async function fileStats(db: Db, formId: number): Promise<{ links: number; taken: number }> {
  const row = await db
    .select({ links: count(), taken: sum(downloadGrants.downloadCount) })
    .from(downloadGrants)
    .where(eq(downloadGrants.formId, formId))
    .get()
  return { links: row?.links ?? 0, taken: Number(row?.taken ?? 0) }
}

// ───────────────────────────────────────────────── grants

/** The whole authentication story for `/d/:token`: an unguessable row lookup. */
export async function resolveGrant(db: Db, token: string) {
  const row = await db
    .select({ grant: downloadGrants, form: forms })
    .from(downloadGrants)
    .innerJoin(forms, eq(forms.id, downloadGrants.formId))
    .where(eq(downloadGrants.token, token))
    .get()
  return row ?? null
}

/**
 * The link this person uses for this form's file, minting it on first ask.
 *
 * Idempotent by the `(form_id, subscriber_id)` unique index: somebody who
 * submits three times gets the same URL three times, so every copy of the reply
 * keeps working and re-sending it is safe.
 */
export async function grantDownload(db: Db, formId: number, subscriberId: number): Promise<string> {
  const find = () =>
    db
      .select({ token: downloadGrants.token })
      .from(downloadGrants)
      .where(and(eq(downloadGrants.formId, formId), eq(downloadGrants.subscriberId, subscriberId)))
      .get()

  const existing = await find()
  if (existing) return existing.token

  const token = randomToken(28)
  await db
    .insert(downloadGrants)
    .values({ formId, subscriberId, token, createdAt: new Date() })
    .onConflictDoNothing()

  // Lost the race with a double-submit: read back whoever won, so both requests
  // hand out the same link rather than one of them returning a token that isn't
  // in the table.
  return (await find())?.token ?? token
}

export function downloadUrl(publicUrl: string, token: string): string {
  return `${publicUrl}/d/${token}`
}

/** Every byte that leaves is a row, not a log line (invariant 7). */
export async function countDownload(db: Db, grantId: number): Promise<void> {
  await db
    .update(downloadGrants)
    .set({
      downloadCount: sql`${downloadGrants.downloadCount} + 1`,
      lastDownloadedAt: new Date(),
    })
    .where(eq(downloadGrants.id, grantId))
}

/**
 * Grant tokens for a batch of queued reply messages, keyed `formId:subscriberId` —
 * how `core/sending.ts` resolves `{{link}}` without a query per message.
 */
export async function grantsForMessages(
  db: Db,
  pairs: { formId: number; subscriberId: number }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const byForm = new Map<number, number[]>()
  for (const { formId, subscriberId } of pairs) {
    byForm.set(formId, [...(byForm.get(formId) ?? []), subscriberId])
  }

  for (const [formId, subIds] of byForm) {
    // D1 caps bound parameters at 100 per query.
    for (let i = 0; i < subIds.length; i += 90) {
      const rows = await db
        .select({ subscriberId: downloadGrants.subscriberId, token: downloadGrants.token })
        .from(downloadGrants)
        .where(
          and(
            eq(downloadGrants.formId, formId),
            inArray(downloadGrants.subscriberId, subIds.slice(i, i + 90)),
          ),
        )
        .all()
      for (const r of rows) out.set(`${formId}:${r.subscriberId}`, r.token)
    }
  }
  return out
}
