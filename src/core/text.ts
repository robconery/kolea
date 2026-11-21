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

/**
 * Who a mail is being merged for. `attributes` and `fieldKeys` are optional so
 * every caller that only knows a name and an address keeps working; supply them
 * and declared custom fields resolve too (Kōlea SPEC 10.1.3).
 */
export interface MergeSubject {
  email: string
  name: string | null
  /** The subscriber's custom field values, `subscribers.attributes`. */
  attributes?: Record<string, unknown> | null
  /**
   * Every field key that is *declared*. A declared field this person has no
   * value for resolves to its fallback, else nothing; a tag that is not declared
   * at all is left exactly as written, as it always has been, so the preflight
   * can still name it as unknown.
   */
  fieldKeys?: readonly string[]
}

/**
 * A literal merge tag, with an optional fallback after a bar:
 * `{{first_name}}`, `{{plan|free}}`, `{{ plan | "the free plan" }}`. Kōlea's
 * syntax, ported as written.
 */
export const MERGE_TAG = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\|\s*(?:"([^"]*)"|([^}"]*?))\s*)?\}\}/g

/** A field value as text: `Yes`/`No` for booleans, nothing for anything odd. */
function fieldText(value: unknown): string {
  if (value === true) return 'Yes'
  if (value === false) return 'No'
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return ''
}

/**
 * Resolve one tag, or `undefined` when nothing here knows it (the caller then
 * leaves the tag as written).
 *
 * Order: built-ins, then per-message extras, then declared custom fields. A
 * field can never shadow a built-in or an extra — `createField` refuses those
 * keys — so the order only matters for data written before that rule existed.
 */
export function resolveMergeTag(
  field: string,
  fallback: string | undefined,
  sub: MergeSubject,
  extras?: Record<string, string>,
): string | undefined {
  switch (field) {
    case 'first_name': {
      const first = (sub.name ?? '').trim().split(/\s+/)[0] ?? ''
      return first || fallback || 'there'
    }
    case 'name':
      return sub.name || (fallback ?? (sub.name === '' ? '' : 'there'))
    case 'email':
      return sub.email
  }
  if (extras && Object.hasOwn(extras, field)) return extras[field] || fallback || extras[field]
  if (sub.fieldKeys?.includes(field)) {
    const value = fieldText(sub.attributes?.[field])
    return value || fallback || ''
  }
  return undefined
}

/**
 * Merge literal `{{tags}}` in a string.
 *
 * `escape` is applied to custom-field values and fallbacks only — they are
 * whatever a subscriber typed into a form, and a body headed for HTML must not
 * carry their markup. Names and extras keep their existing behaviour.
 */
export function mergeFields(
  body: string,
  sub: MergeSubject,
  extras?: Record<string, string>,
  escape: (s: string) => string = (s) => s,
): string {
  return body.replace(MERGE_TAG, (whole, field: string, quoted?: string, bare?: string) => {
    const fallback = quoted ?? (bare?.trim() || undefined)
    const isField =
      !['first_name', 'name', 'email'].includes(field) &&
      !(extras && Object.hasOwn(extras, field)) &&
      sub.fieldKeys?.includes(field)
    const value = resolveMergeTag(field, fallback, sub, extras)
    if (value === undefined) return whole
    return isField ? escape(value) : value
  })
}

/**
 * Where a subscriber's `{{testimonial_link}}` points, relative to PUBLIC_URL.
 * Under `/p/` with the preference centre: the same token, the same proof, and
 * `renderEmail` already leaves `/p/` links untracked.
 */
export function testimonialPath(unsubToken: string): string {
  return `/p/${unsubToken}/testimonial`
}

/** Where `{{testimonial_link}}` points on the public web: the wall, never a person. */
export const TESTIMONIAL_WALL_PATH = '/testimonials'
