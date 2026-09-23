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

export const ProfileSchema = z.object({
  /** One paragraph under the headline. */
  lede: text(600).default(''),
  what_i_do: z.array(WhatIDoItem).max(6).default([]),
  links: z.array(ProfileLink).max(8).default([]),
})

export type Profile = z.infer<typeof ProfileSchema>
export type ProfileInput = z.input<typeof ProfileSchema>

export const EMPTY_PROFILE: Profile = { lede: '', what_i_do: [], links: [] }

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
