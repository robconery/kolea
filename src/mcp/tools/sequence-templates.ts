import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import {
  type SequenceTemplate,
  type SequenceTemplateRow,
  createSequenceFromTemplate,
  createTemplate,
  deleteTemplate,
  findPlaceholders,
  getTemplate,
  listTemplates,
  missingStarters,
  templateSchedule,
  updateTemplate,
} from '../../core/sequence-templates/index.ts'
import { type Ctx, defineTool, fail, failed, ok } from '../kit.ts'

const TRIGGERS = ['subscribe', 'tag_added', 'manual'] as const

/** The writable shape of a template, in the wire's snake_case. */
const fields = {
  name: z.string().min(1),
  family: z.enum(['funnel', 'launch', 'welcome', 'sale', 'customer']).optional(),
  source: z.string().optional().describe('Who the shape comes from. Credit, not endorsement.'),
  tagline: z.string().optional(),
  description: z.string().optional(),
  best_for: z.array(z.string()).optional(),
  needs: z.array(z.string()).optional(),
  suggested_trigger: z.enum(TRIGGERS).optional(),
  trigger_hint: z.string().optional(),
  default_name: z.string().optional(),
  default_description: z
    .string()
    .optional()
    .describe('Shown to subscribers in the preference center on sequences made from this.'),
  steps: z
    .array(
      z.object({
        delay_days: z.number().int().min(0).describe('Days after the PREVIOUS mail; the first is usually 0.'),
        label: z.string().optional(),
        purpose: z.string().optional().describe('What this mail is for. Never sent.'),
        subject: z.string().optional(),
        body_md: z.string().optional(),
      }),
    )
    .max(60)
    .optional()
    .describe(
      'Up to 60 mails. Wrap anything the writer must rewrite in [[ double brackets ]]: a sequence made from the template cannot go live while any survive. A blank subject or body becomes a placeholder.',
    ),
}
const templateInput = z.object(fields)
type TemplateArgs = z.output<typeof templateInput>

function fromArgs(a: TemplateArgs): Partial<SequenceTemplate> {
  return {
    name: a.name,
    family: a.family,
    source: a.source,
    tagline: a.tagline,
    description: a.description,
    bestFor: a.best_for,
    needs: a.needs,
    suggestedTrigger: a.suggested_trigger,
    triggerHint: a.trigger_hint,
    defaultName: a.default_name,
    defaultDescription: a.default_description,
    steps: (a.steps ?? []).map((s) => ({
      delayDays: s.delay_days,
      label: s.label ?? '',
      purpose: s.purpose ?? '',
      subject: s.subject ?? '',
      bodyMd: s.body_md ?? '',
    })),
  }
}

function view(t: SequenceTemplateRow, withSteps: boolean) {
  const days = templateSchedule(t.steps)
  return {
    slug: t.slug,
    name: t.name,
    family: t.family,
    source: t.source,
    tagline: t.tagline,
    suggestedTrigger: t.suggestedTrigger,
    mails: t.steps.length,
    spanDays: days[days.length - 1] ?? 0,
    ...(withSteps
      ? {
          description: t.description,
          bestFor: t.bestFor,
          needs: t.needs,
          triggerHint: t.triggerHint,
          defaultName: t.defaultName,
          defaultDescription: t.defaultDescription,
          steps: t.steps.map((s, i) => ({
            position: i + 1,
            day: days[i],
            delay_days: s.delayDays,
            label: s.label,
            purpose: s.purpose,
            subject: s.subject,
            body_md: s.bodyMd,
            placeholders: findPlaceholders({ subject: s.subject, bodyJson: null, bodyMd: s.bodyMd }),
          })),
        }
      : {}),
    updatedAt: t.updatedAt,
  }
}

/**
 * Sequence templates: reusable *shapes* for a drip. Thin wrappers over
 * `core/sequence-templates`, the same functions the Templates screen calls.
 *
 * Nothing here sends or enrolls. `sequence_template_use` makes a PAUSED
 * sequence through `createSequence` and `addStep`, and `setSequenceActive`
 * refuses while any `[[ placeholder ]]` survives — so the worst a wrong call
 * here can do is leave a draft lying around.
 */
export function registerSequenceTemplates(server: McpServer, ctx: Ctx): void {
  defineTool(
    server,
    ctx,
    'sequence_template_list',
    {
      description:
        'The sequence template library: starters and the operator\'s own, each with its family, suggested trigger, number of mails and how many days it spans. `missingStarters` names starters that were deleted or never loaded (the Templates screen can restore them).',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const [rows, missing] = await Promise.all([listTemplates(ctx.db), missingStarters(ctx.db)])
      return ok({ templates: rows.map((t) => view(t, false)), missingStarters: missing.map((t) => t.slug) })
    },
  )

  defineTool(
    server,
    ctx,
    'sequence_template_get',
    {
      description:
        'One template by slug with every mail: its delay, the day it lands, its job, subject, body, and the [[ placeholders ]] still to rewrite.',
      inputSchema: z.object({ slug: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ slug }) => {
      const t = await getTemplate(ctx.db, slug)
      if (!t) return fail(`No template "${slug}".`, 'List them with sequence_template_list.')
      return ok(view(t, true))
    },
  )

  defineTool(
    server,
    ctx,
    'sequence_template_create',
    {
      description:
        'Add a template to the library. Its slug comes from the name and never changes. Sends nothing, enrolls nobody.',
      inputSchema: templateInput,
    },
    async (args) => {
      const r = await createTemplate(ctx.db, fromArgs(args))
      if (!r.ok) return failed(r)
      return ok(view((await getTemplate(ctx.db, r.slug))!, true))
    },
  )

  defineTool(
    server,
    ctx,
    'sequence_template_update',
    {
      description:
        'Replace a template WHOLE: send every field and every mail you want kept — anything omitted is reset. Sequences already made from it never change (there is no link back to the template).',
      inputSchema: templateInput.extend({ slug: z.string() }),
      annotations: { idempotentHint: true },
    },
    async ({ slug, ...rest }) => {
      const r = await updateTemplate(ctx.db, slug, fromArgs(rest))
      if (!r.ok) return failed(r, 'List them with sequence_template_list.')
      return ok(view((await getTemplate(ctx.db, slug))!, true))
    },
  )

  defineTool(
    server,
    ctx,
    'sequence_template_delete',
    {
      description:
        'Delete a template from the library. Sequences made from it are untouched. A deleted starter can be restored from the Templates screen.',
      inputSchema: z.object({ slug: z.string() }),
      annotations: { destructiveHint: true },
    },
    async ({ slug }) => {
      const r = await deleteTemplate(ctx.db, slug)
      return r.ok ? ok({ deleted: true, slug }) : failed(r)
    },
  )

  defineTool(
    server,
    ctx,
    'sequence_template_use',
    {
      description:
        "Make a new sequence from a template, placeholders and all. It is ALWAYS created paused and enrolls nobody — this tool never activates anything. Next: rewrite every [[ placeholder ]] with step_update, then sequence_preflight and sequence_activate. `name` and `description` default to the template's; `trigger` defaults to its suggested one, and a tag_added sequence needs trigger_tag_id.",
      inputSchema: z.object({
        slug: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        trigger: z.enum(TRIGGERS).optional(),
        trigger_tag_id: z.number().int().nullable().optional(),
        campaign_id: z.number().int().nullable().optional(),
      }),
    },
    async (args) => {
      const r = await createSequenceFromTemplate(ctx.db, args.slug, {
        name: args.name,
        description: args.description,
        trigger: args.trigger,
        triggerTagId: args.trigger_tag_id ?? null,
        campaignId: args.campaign_id ?? null,
      })
      if (!r.ok) return failed(r, 'Find templates with sequence_template_list and tags with tag_list.')
      return ok({
        id: r.id,
        isActive: false,
        next: 'Rewrite every [[ placeholder ]] (sequence_get shows the steps), then sequence_preflight and sequence_activate.',
      })
    },
  )
}
