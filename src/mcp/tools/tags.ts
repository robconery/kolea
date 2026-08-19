import type { McpServer } from '@modelcontextprotocol/server'
import { asc, eq } from 'drizzle-orm'
import * as z from 'zod/v4'
import { findOrCreateTag } from '../../core/subscribers.ts'
import {
  type TagRuleEvent,
  createTagRule,
  deleteTag,
  deleteTagRule,
  listTagRules,
  mergeTag,
  renameTag,
  setTagRuleActive,
  tagCounts,
  tagDependents,
} from '../../core/tagging.ts'
import { tags } from '../../db/schema.ts'
import { type Ctx, defineTool, fail, failed, ok } from '../kit.ts'

const EVENTS = ['delivered', 'open', 'click', 'bounce', 'complaint'] as const

export function registerTags(server: McpServer, ctx: Ctx): void {
  defineTool(
    server,
    ctx,
    'tag_list',
    {
      description: 'Every tag with how many subscribers carry it.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const all = await ctx.db.select().from(tags).orderBy(asc(tags.name)).all()
      const counts = await tagCounts(ctx.db)
      return ok(all.map((t) => ({ ...t, subscribers: counts.get(t.id) ?? 0 })))
    },
  )

  defineTool(
    server,
    ctx,
    'tag_create',
    {
      description: 'Create a tag, or return the existing one with the same slug.',
      inputSchema: z.object({ name: z.string().min(1) }),
      annotations: { idempotentHint: true },
    },
    async ({ name }) => ok({ id: await findOrCreateTag(ctx.db, name) }),
  )

  defineTool(
    server,
    ctx,
    'tag_rename',
    {
      description: 'Rename a tag. The slug follows the name; every reference is by id, so nothing breaks.',
      inputSchema: z.object({ id: z.number().int(), name: z.string().min(1) }),
    },
    async ({ id, name }) => {
      const result = await renameTag(ctx.db, id, name)
      return result.ok ? ok({ renamed: true }) : failed(result)
    },
  )

  defineTool(
    server,
    ctx,
    'tag_merge',
    {
      description:
        'Fold one tag into another: moves the people and repoints sequences, tag rules, saved segments and draft broadcasts, then deletes the source tag. This is the fix for "Customer" and "customers".',
      inputSchema: z.object({
        from_id: z.number().int().describe('The tag to absorb and delete'),
        into_id: z.number().int().describe('The tag that survives'),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ from_id, into_id }) => {
      const result = await mergeTag(ctx.db, from_id, into_id)
      return result.ok ? ok({ merged: true, moved: result.moved }) : failed(result)
    },
  )

  defineTool(
    server,
    ctx,
    'tag_delete',
    {
      description:
        'Delete a tag. Refused while a sequence or tag rule still depends on it — the response names what is in the way.',
      inputSchema: z.object({ id: z.number().int() }),
      annotations: { destructiveHint: true },
    },
    async ({ id }) => {
      const result = await deleteTag(ctx.db, id)
      if (result.ok) return ok({ deleted: true })

      const blockers = await tagDependents(ctx.db, id)
      return fail(
        result.reason ?? 'refused',
        blockers.length
          ? `Repoint or remove: ${blockers.join(', ')}. Or use tag_merge to fold it into another tag.`
          : undefined,
      )
    },
  )

  defineTool(
    server,
    ctx,
    'tag_check',
    {
      description: 'What would break if this tag were deleted. Read-only.',
      inputSchema: z.object({ id: z.number().int() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const tag = await ctx.db.select().from(tags).where(eq(tags.id, id)).get()
      if (!tag) return fail('No such tag.')
      const dependents = await tagDependents(ctx.db, id)
      return ok({ tag, dependents, deletable: dependents.length === 0 })
    },
  )

  // ─────────────────────────────────────────────── tag rules

  defineTool(
    server,
    ctx,
    'tagrule_list',
    {
      description:
        'Automatic tagging rules ("when this event happens, apply this tag"), with how often each has fired.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => ok(await listTagRules(ctx.db)),
  )

  defineTool(
    server,
    ctx,
    'tagrule_create',
    {
      description:
        'Create an auto-tagging rule. Scope it to one broadcast or one sequence, or leave both unset to watch every message. url_contains only applies to click rules. Rules apply to events from now on — they do not backfill.',
      inputSchema: z.object({
        name: z.string().min(1),
        event: z.enum(EVENTS),
        tag_name: z.string().min(1).describe('Created if it does not exist yet'),
        broadcast_id: z.number().int().nullable().optional(),
        sequence_id: z.number().int().nullable().optional(),
        url_contains: z
          .string()
          .nullable()
          .optional()
          .describe('Click rules only: case-insensitive substring of the clicked URL'),
      }),
    },
    async (args) => {
      const result = await createTagRule(ctx.db, {
        name: args.name,
        event: args.event as TagRuleEvent,
        tagName: args.tag_name,
        broadcastId: args.broadcast_id ?? null,
        sequenceId: args.sequence_id ?? null,
        urlContains: args.url_contains ?? null,
      })
      return result.ok ? ok({ rule_id: result.ruleId }) : failed(result)
    },
  )

  defineTool(
    server,
    ctx,
    'tagrule_toggle',
    {
      description: 'Pause or resume a tag rule.',
      inputSchema: z.object({ id: z.number().int(), active: z.boolean() }),
    },
    async ({ id, active }) => {
      const result = await setTagRuleActive(ctx.db, id, active)
      return result.ok ? ok({ active }) : failed(result)
    },
  )

  defineTool(
    server,
    ctx,
    'tagrule_delete',
    {
      description: 'Delete a tag rule. Tags it already applied stay applied.',
      inputSchema: z.object({ id: z.number().int() }),
      annotations: { destructiveHint: true },
    },
    async ({ id }) => {
      const result = await deleteTagRule(ctx.db, id)
      return result.ok ? ok({ deleted: true }) : failed(result)
    },
  )
}
