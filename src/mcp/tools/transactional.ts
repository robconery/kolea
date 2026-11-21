import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import {
  createTxTemplate,
  deleteTxTemplate,
  getTxTemplateBySlug,
  listTxTemplates,
  templateAsks,
  txTemplateUsage,
  updateTxTemplate,
} from '../../core/transactional.ts'
import type { TransactionalTemplate } from '../../db/schema.ts'
import { type Ctx, defineTool, fail, ok } from '../kit.ts'

/**
 * Transactional templates (Kōlea SPEC 13.1, 20.1 templates): the stored mail a
 * `POST /api/send` names by slug. Names and arguments follow Kōlea's five
 * `template_*` tools, addressed by `slug` because Big Mailer has no tokens and
 * the slug is the one identifier that never changes.
 *
 * None of these send anything. Writing a template is not a send: mail only goes
 * out when another app calls the API with a `send` key.
 */

const view = (t: TransactionalTemplate) => ({
  id: t.id,
  slug: t.slug,
  name: t.name,
  subject: t.subject,
  body_md: t.bodyMd,
  hasRichBody: Boolean(t.bodyJson),
  variables: templateAsks(t),
  isActive: t.isActive,
  updatedAt: t.updatedAt ?? t.createdAt,
})

const NOT_FOUND_HINT = 'call template_list to see the slugs that exist'

export function registerTransactional(server: McpServer, ctx: Ctx): void {
  defineTool(
    server,
    ctx,
    'template_list',
    {
      description:
        'Stored transactional templates a POST /api/send can name by slug (receipts, password resets, notices sent by other apps). Not purchase templates and not sequence templates. Each lists the {{variables}} a request must supply.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => ok((await listTxTemplates(ctx.db)).map(view)),
  )

  defineTool(
    server,
    ctx,
    'template_get',
    {
      description:
        'One transactional template by slug: subject, markdown body, the {{variables}} it asks for, whether it is active, and how many messages have gone out from it.',
      inputSchema: z.object({ slug: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ slug }) => {
      const t = await getTxTemplateBySlug(ctx.db, slug.trim().toLowerCase())
      if (!t) return fail(`No transactional template "${slug}".`, NOT_FOUND_HINT)
      return ok({ ...view(t), sent: await txTemplateUsage(ctx.db, t.slug) })
    },
  )

  defineTool(
    server,
    ctx,
    'template_create',
    {
      description:
        'Creates a transactional template. The slug comes from the name (or slug, if given) and never changes afterwards, because calling apps hard-code it. Subject and body (markdown) may carry {{variables}}; {{first_name}}, {{name}} and {{email}} come from the recipient. A request that leaves a variable out is refused with a 422, never sent with a blank. This never sends anything.',
      inputSchema: z.object({
        name: z.string(),
        subject: z.string(),
        body_md: z.string(),
        slug: z.string().optional(),
        is_active: z.boolean().optional(),
      }),
    },
    async (input) => {
      const result = await createTxTemplate(ctx.db, {
        name: input.name,
        subject: input.subject,
        bodyMd: input.body_md,
        bodyJson: null,
        slug: input.slug ?? null,
        isActive: input.is_active,
      })
      if (!result.ok) return fail(result.reason)
      return ok(view(result.template))
    },
  )

  defineTool(
    server,
    ctx,
    'template_update',
    {
      description:
        'Changes a transactional template’s name, subject, markdown body or active flag. The slug never changes. Mail already sent keeps the copy it went out with. Supplying body_md replaces any body written in the editor; leave it out to keep the body. An inactive template makes POST /api/send answer 422 for it.',
      inputSchema: z.object({
        slug: z.string(),
        name: z.string().optional(),
        subject: z.string().optional(),
        body_md: z.string().optional(),
        is_active: z.boolean().optional(),
      }),
      annotations: { idempotentHint: true },
    },
    async (input) => {
      const t = await getTxTemplateBySlug(ctx.db, input.slug.trim().toLowerCase())
      if (!t) return fail(`No transactional template "${input.slug}".`, NOT_FOUND_HINT)
      const result = await updateTxTemplate(ctx.db, t.id, {
        name: input.name,
        subject: input.subject,
        // Only touch the body when one was given, so a rename cannot blank
        // what the operator wrote in the editor.
        ...(input.body_md === undefined ? {} : { bodyMd: input.body_md, bodyJson: null }),
        isActive: input.is_active,
      })
      if (!result.ok) return fail(result.reason)
      return ok(view(result.template))
    },
  )

  defineTool(
    server,
    ctx,
    'template_delete',
    {
      description:
        'Deletes a transactional template. Messages already sent from it keep their own copy and its slug. Any app still sending this slug gets a 422 from then on, so check template_get first. confirm_slug must repeat the slug exactly.',
      inputSchema: z.object({ slug: z.string(), confirm_slug: z.string() }),
      annotations: { destructiveHint: true },
    },
    async ({ slug, confirm_slug }) => {
      const t = await getTxTemplateBySlug(ctx.db, slug.trim().toLowerCase())
      if (!t) return fail(`No transactional template "${slug}".`, NOT_FOUND_HINT)
      if (confirm_slug !== t.slug) return fail(`confirm_slug must be exactly "${t.slug}".`)
      const sent = await txTemplateUsage(ctx.db, t.slug)
      await deleteTxTemplate(ctx.db, t.id)
      return ok({ slug: t.slug, deleted: true, messagesKept: sent })
    },
  )
}
