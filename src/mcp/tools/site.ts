import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { PROFILE_ICONS, ProfileLink, SOCIAL, WhatIDoItem, readProfile } from '../../core/site-profile.ts'
import { applySiteUpdate, getSiteSettings } from '../../core/site-settings.ts'
import { switchTheme, themeSummaries } from '../../core/theme/store.ts'
import { type Ctx, defineTool, fail, failed, ok } from '../kit.ts'

/**
 * Who the site is and who writes it — the same data as the admin's Site
 * screen, so Claude can fill in or change the front page and /about without
 * anyone editing a template or redeploying. Writes go through the same
 * schema as the screen (`core/site-profile.ts`). Nothing here sends mail.
 */
export function registerSite(server: McpServer, ctx: Ctx): void {
  defineTool(
    server,
    ctx,
    'site_get',
    {
      description:
        'The public site\'s settings: name, tagline, logo, the author (name, photo, short bio, long bio as markdown) and the profile (lede, what_i_do, links, and social: the author\'s profiles keyed by network). Empty fields fall back to the SITE_* environment variables on the live site.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const s = await getSiteSettings(ctx.db)
      return ok({
        title: s?.title ?? null,
        tagline: s?.tagline ?? null,
        logoUrl: s?.logoUrl ?? null,
        authorName: s?.authorName ?? null,
        authorPhotoUrl: s?.authorPhotoUrl ?? null,
        shortBio: s?.shortBio ?? null,
        longBioMarkdown: s?.longBioMd ?? null,
        longBioIsRichText: Boolean(s?.longBioJson),
        profile: readProfile(s?.profile),
        socialKeys: SOCIAL.map((n) => n.key),
        iconChoices: PROFILE_ICONS,
      })
    },
  )

  defineTool(
    server,
    ctx,
    'site_update',
    {
      description:
        'Change the public site\'s settings. Only the fields you pass change. `social` sets the author\'s profiles by key (see site_get\'s socialKeys): pass only the keys to change, with a full https URL, or "" to remove one. `lede`, `what_i_do` (max 6, icon from site_get\'s iconChoices) and `links` (max 8, http(s) URLs) are the front page profile; passing `what_i_do` or `links` replaces that whole list. `longBioMarkdown` replaces the /about page (and drops any rich-text version). Pass an empty string to clear a text field. Sends nothing.',
      inputSchema: z.object({
        title: z.string().max(120).optional(),
        tagline: z.string().max(200).optional(),
        logoUrl: z.string().max(500).optional(),
        authorName: z.string().max(120).optional(),
        authorPhotoUrl: z.string().max(500).optional(),
        shortBio: z.string().max(1200).optional(),
        longBioMarkdown: z.string().max(20000).optional(),
        social: z.record(z.string(), z.string().max(500)).optional(),
        lede: z.string().max(600).optional(),
        what_i_do: z.array(WhatIDoItem).max(6).optional(),
        links: z.array(ProfileLink).max(8).optional(),
      }),
    },
    async (input) => {
      const r = await applySiteUpdate(ctx.db, input)
      if (!r.ok) return fail(r.reason)
      return ok({ saved: true, profile: r.profile })
    },
  )

  defineTool(
    server,
    ctx,
    'theme_list',
    {
      description:
        "The public site's themes, built-ins first, and which one readers see now (`live`). With no theme switched on, the default built-in is live.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => ok(await themeSummaries(ctx.db)),
  )

  defineTool(
    server,
    ctx,
    'theme_activate',
    {
      description:
        'Make one theme live on the public site, and every other not. Instant and reversible: switch back the same way. Sends nothing. Ids come from theme_list.',
      inputSchema: z.object({ id: z.number().int() }),
      annotations: { idempotentHint: true },
    },
    async ({ id }) => {
      const r = await switchTheme(ctx.db, id)
      if (!r.ok) return failed(r, 'List them with theme_list.')
      return ok({ live: r.name, themes: await themeSummaries(ctx.db) })
    },
  )
}
