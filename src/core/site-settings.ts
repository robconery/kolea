import { eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { type DocNode, type SiteSettings, siteSettings } from '../db/schema.ts'
import { docIsEmpty } from './render-doc.ts'
import { DEFAULT_TIME_ZONE, isTimeZone } from './send-window.ts'

/**
 * Who the site is and who writes it: one row, edited on the Profile screen (and,
 * later, filled in by the onboarding interview).
 *
 * Every field is optional. An unset field falls back to the `SITE_*`
 * environment variables that configured the site before this existed, so the
 * row can be introduced without the public site changing by a single word.
 */

export type SiteSettingsPatch = Partial<Omit<SiteSettings, 'id' | 'updatedAt'>>

export async function getSiteSettings(db: Db): Promise<SiteSettings | null> {
  return (await db.select().from(siteSettings).where(eq(siteSettings.id, 1)).get()) ?? null
}

/** Create or update the one row. Only the keys passed are written. */
export async function saveSiteSettings(db: Db, patch: SiteSettingsPatch): Promise<SiteSettings> {
  const now = new Date()
  const existing = await getSiteSettings(db)
  if (existing) {
    return (await db
      .update(siteSettings)
      .set({ ...patch, updatedAt: now })
      .where(eq(siteSettings.id, 1))
      .returning()
      .get()) as SiteSettings
  }
  return db
    .insert(siteSettings)
    .values({ id: 1, socialLinks: [], ...patch, updatedAt: now })
    .returning()
    .get()
}

/**
 * The operator's time zone: what every sequence's send window is read in.
 * UTC until one is chosen, and UTC again if a stored name ever stops being one
 * the runtime knows — a window read in the wrong zone is late, never lost.
 */
export async function getTimeZone(db: Db): Promise<string> {
  const row = await db
    .select({ timeZone: siteSettings.timeZone })
    .from(siteSettings)
    .where(eq(siteSettings.id, 1))
    .get()
  const zone = row?.timeZone
  return zone && isTimeZone(zone) ? zone : DEFAULT_TIME_ZONE
}

/** Set the operator's time zone. Refuses a name `Intl` cannot read. */
export async function setTimeZone(db: Db, zone: string): Promise<{ ok: boolean; reason?: string }> {
  const z = zone.trim()
  if (!isTimeZone(z)) return { ok: false, reason: `"${z}" is not a time zone this server knows, e.g. Pacific/Honolulu` }
  await saveSiteSettings(db, { timeZone: z })
  return { ok: true }
}

/** Whether there is anything to put on /about. */
export function hasLongBio(s: Pick<SiteSettings, 'longBioJson' | 'longBioMd'> | null): boolean {
  if (!s) return false
  if (s.longBioJson && !docIsEmpty(s.longBioJson as DocNode)) return true
  return Boolean(s.longBioMd?.trim())
}

/** Plain-text paragraphs, split on blank lines — how the short bio is written. */
export function paragraphs(text: string | null | undefined): string[] {
  return (text ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}
