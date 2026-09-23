import * as z from 'zod/v4'

/**
 * The front page's structured content — one JSON document on the
 * `site_settings` row, validated here on every write, whichever door it came
 * in by (the Profile screen, or Claude through the `site_update` MCP tool).
 *
 * Themes read it as `@profile`. It belongs to the site, not the theme:
 * switching themes restyles it and never loses it. Adding a section later is
 * a new key here, not a migration.
 */

/** Line icons every built-in theme can draw. A theme that doesn't know one shows none. */
export const PROFILE_ICONS = ['pen', 'book', 'cap', 'chat', 'code', 'mic', 'video', 'compass'] as const

const text = (max: number) => z.string().trim().max(max)

const httpUrl = z
  .string()
  .trim()
  .max(500)
  .refine((u) => /^https?:\/\/[^\s]+$/i.test(u), 'must be an http(s) URL')

export const WhatIDoItem = z.object({
  title: text(60).min(1),
  body: text(400).default(''),
  icon: z.enum(PROFILE_ICONS).default('pen'),
})

export const ProfileLink = z.object({
  /** A small label above the title: "Podcast", "Book", "Open source". */
  kind: text(30).default(''),
  title: text(80).min(1),
  url: httpUrl,
  blurb: text(200).default(''),
})

/**
 * The social profiles a site can link to, by key. Keyed rather than a free list
 * so onboarding (and Claude) can set exactly one, and every theme can show them
 * in the same order with the same names. Adding one is a line here.
 */
export const SOCIAL = [
  { key: 'website', label: 'Website' },
  { key: 'github', label: 'GitHub' },
  { key: 'linkedin', label: 'LinkedIn' },
  { key: 'x', label: 'X' },
  { key: 'mastodon', label: 'Mastodon' },
  { key: 'bluesky', label: 'Bluesky' },
  { key: 'youtube', label: 'YouTube' },
  { key: 'facebook', label: 'Facebook' },
  { key: 'instagram', label: 'Instagram' },
] as const

export type SocialKey = (typeof SOCIAL)[number]['key']

/** An http(s) URL, or empty for "not set". */
const optionalUrl = z.union([httpUrl, z.literal('')]).optional()

export const SocialSchema = z
  .object(Object.fromEntries(SOCIAL.map((s) => [s.key, optionalUrl])) as Record<SocialKey, typeof optionalUrl>)
  .transform((o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v)) as Partial<Record<SocialKey, string>>)

export const ProfileSchema = z.object({
  /** One paragraph under the headline. */
  lede: text(600).default(''),
  what_i_do: z.array(WhatIDoItem).max(6).default([]),
  links: z.array(ProfileLink).max(8).default([]),
  /** The author's social profiles, keyed: `{ github: 'https://…', x: 'https://…' }`. */
  social: SocialSchema.default({}),
})

export type Profile = z.infer<typeof ProfileSchema>
export type ProfileInput = z.input<typeof ProfileSchema>

export const EMPTY_PROFILE: Profile = { lede: '', what_i_do: [], links: [], social: {} }

/** The set social profiles as a list, in the fixed order, for themes to loop over. */
export function socialList(social: Profile['social']): { key: SocialKey; label: string; url: string }[] {
  return SOCIAL.flatMap((s) => (social[s.key] ? [{ key: s.key, label: s.label, url: social[s.key] as string }] : []))
}

/**
 * Read a stored profile. Never throws: a document that no longer matches the
 * schema (written by an older version, or edited by hand) reads as empty
 * rather than taking the front page down.
 */
export function readProfile(raw: unknown): Profile {
  const parsed = ProfileSchema.safeParse(raw ?? {})
  return parsed.success ? parsed.data : EMPTY_PROFILE
}

/** Validate a profile for writing. The error names the field that failed. */
export function validateProfile(
  input: unknown,
): { ok: true; profile: Profile } | { ok: false; error: string } {
  const parsed = ProfileSchema.safeParse(input)
  if (parsed.success) return { ok: true, profile: parsed.data }
  const issue = parsed.error.issues[0]
  const where = issue?.path.length ? issue.path.join('.') : 'profile'
  return { ok: false, error: `${where}: ${issue?.message ?? 'is not valid'}` }
}

/** `https://www.example.com/podcast/` → `example.com/podcast`, for showing a link's address. */
export function displayHost(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname.replace(/\/+$/, '')
    return `${u.host.replace(/^www\./, '')}${path === '/' ? '' : path}`
  } catch {
    return url
  }
}
