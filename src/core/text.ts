/**
 * Pure text helpers, shared by everything that renders a body.
 *
 * They live here rather than in `render.ts` because `render-doc.ts` (email) and
 * `render-web.ts` (the public site) both need them, and reaching into the email
 * pipeline for them coupled the web renderer to consent, the database and the
 * `Env` type — none of which a web page needs, and all of which made the two
 * renderers look related when the whole point is that they are not.
 *
 * Nothing in here touches a database or a request. That is what lets an offline
 * script (`scripts/publish-archive.ts`) reuse the real rules instead of writing
 * a second copy of them.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function mergeFields(
  body: string,
  sub: { email: string; name: string | null },
  extras?: Record<string, string>,
): string {
  const first = (sub.name ?? '').trim().split(/\s+/)[0] ?? ''
  let out = body
    .replace(/\{\{\s*name\s*\}\}/g, sub.name ?? 'there')
    .replace(/\{\{\s*first_name\s*\}\}/g, first || 'there')
    .replace(/\{\{\s*email\s*\}\}/g, sub.email)
  for (const [field, value] of Object.entries(extras ?? {})) {
    out = out.replaceAll(`{{${field}}}`, value)
  }
  return out
}
