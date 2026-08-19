import type { McpServer } from '@modelcontextprotocol/server'
import { asc, eq, inArray } from 'drizzle-orm'
import * as z from 'zod/v4'
import {
  countSegment,
  createSegment,
  deleteSegment,
  describeRule,
  getSegment,
  listSegments,
  resolveSegment,
  updateSegment,
} from '../../core/segments.ts'
import type { SegmentRule } from '../../db/schema.ts'
import { subscribers, tags } from '../../db/schema.ts'
import { type Ctx, clampLimit, defineTool, fail, ok } from '../kit.ts'

/**
 * The segment rule, as the model sees it. Deliberately flat — no boolean tree,
 * no nesting. Tags are the facts; a segment is a named question asked of them.
 */
const RULE = z.object({
  match: z
    .enum(['any', 'all'])
    .optional()
    .describe("How include_tag_ids combine: 'any' = union (default), 'all' = intersection"),
  include_tag_ids: z.array(z.number().int()).optional(),
  exclude_tag_ids: z.array(z.number().int()).optional(),
  joined_after: z.string().optional().describe('ISO date — subscribers created after this'),
  joined_before: z.string().optional().describe('ISO date'),
})

type RuleInput = z.output<typeof RULE>

function toRule(input: RuleInput): { ok: true; rule: SegmentRule } | { ok: false; reason: string } {
  const rule: SegmentRule = {}
  if (input.match) rule.match = input.match
  if (input.include_tag_ids?.length) rule.includeTagIds = input.include_tag_ids
  if (input.exclude_tag_ids?.length) rule.excludeTagIds = input.exclude_tag_ids

  for (const [key, value] of [
    ['joinedAfter', input.joined_after],
    ['joinedBefore', input.joined_before],
  ] as const) {
    if (!value) continue
    const ms = Date.parse(value)
    if (Number.isNaN(ms)) return { ok: false, reason: `"${value}" is not a parseable date` }
    rule[key] = ms
  }

  return { ok: true, rule }
}

export function registerSegments(server: McpServer, ctx: Ctx): void {
  /** Rules store tag ids; a plain-English description needs the names. */
  const allTags = () => ctx.db.select().from(tags).orderBy(asc(tags.name)).all()

  defineTool(
    server,
    ctx,
    'segment_list',
    {
      description: 'Saved audience rules, each with its plain-English description and current size.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const segs = await listSegments(ctx.db)
      const names = await allTags()
      const out = []
      for (const s of segs) {
        out.push({
          id: s.id,
          slug: s.slug,
          name: s.name,
          rule: s.rule,
          describes: describeRule(s.rule ?? {}, names),
          size: await countSegment(ctx.db, s.rule ?? {}),
        })
      }
      return ok(out)
    },
  )

  defineTool(
    server,
    ctx,
    'segment_get',
    {
      description: 'One saved segment with its rule, description and size.',
      inputSchema: z.object({ id: z.number().int() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const seg = await getSegment(ctx.db, id)
      if (!seg) return fail('No such segment.')
      return ok({
        ...seg,
        describes: describeRule(seg.rule ?? {}, await allTags()),
        size: await countSegment(ctx.db, seg.rule ?? {}),
      })
    },
  )

  defineTool(
    server,
    ctx,
    'segment_preview',
    {
      description:
        'Count and sample an audience rule WITHOUT saving it. Always do this before pointing a broadcast at a rule you just built — it is the only way to see who you actually selected.',
      inputSchema: z.object({
        rule: RULE,
        sample: z.number().int().optional().describe('How many example members to return (default 10)'),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const parsed = toRule(args.rule)
      if (!parsed.ok) return fail(parsed.reason)

      // `countSegment` is one query over the whole rule; `resolveSegment` is
      // paged, so it gives the sample but never the true size.
      const size = await countSegment(ctx.db, parsed.rule)
      const n = clampLimit(args.sample, 10, 100)
      const page = await resolveSegment(ctx.db, parsed.rule, 0, n)
      const sample = page.length
        ? await ctx.db
            .select({ id: subscribers.id, email: subscribers.email, name: subscribers.name })
            .from(subscribers)
            .where(
              inArray(
                subscribers.id,
                page.map((p) => p.id),
              ),
            )
            .all()
        : []

      return ok({
        size,
        describes: describeRule(parsed.rule, await allTags()),
        rule: parsed.rule,
        sample,
      })
    },
  )

  defineTool(
    server,
    ctx,
    'segment_create',
    {
      description: 'Save an audience rule under a name. Preview it first with segment_preview.',
      inputSchema: z.object({ name: z.string().min(1), rule: RULE }),
    },
    async ({ name, rule }) => {
      const parsed = toRule(rule)
      if (!parsed.ok) return fail(parsed.reason)
      return ok({ id: await createSegment(ctx.db, name, parsed.rule) })
    },
  )

  defineTool(
    server,
    ctx,
    'segment_update',
    {
      description:
        'Change a saved segment. Broadcasts copy the rule when they are created, so this never rewrites who an existing broadcast went to.',
      inputSchema: z.object({
        id: z.number().int(),
        name: z.string().min(1).optional(),
        rule: RULE.optional(),
      }),
    },
    async ({ id, name, rule }) => {
      const seg = await getSegment(ctx.db, id)
      if (!seg) return fail('No such segment.')

      let next = seg.rule ?? {}
      if (rule) {
        const parsed = toRule(rule)
        if (!parsed.ok) return fail(parsed.reason)
        next = parsed.rule
      }

      await updateSegment(ctx.db, id, name ?? seg.name, next)
      return ok({ updated: true, size: await countSegment(ctx.db, next) })
    },
  )

  defineTool(
    server,
    ctx,
    'segment_delete',
    {
      description:
        'Delete a saved segment. Broadcasts built from it keep working — they hold their own copy of the rule.',
      inputSchema: z.object({ id: z.number().int() }),
      annotations: { destructiveHint: true },
    },
    async ({ id }) => {
      const seg = await getSegment(ctx.db, id)
      if (!seg) return fail('No such segment.')
      await deleteSegment(ctx.db, id)
      return ok({ deleted: true })
    },
  )
}
