import { eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { type DocNode, type SiteSettings, siteSettings } from '../db/schema.ts'
import { docIsEmpty } from './render-doc.ts'

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
