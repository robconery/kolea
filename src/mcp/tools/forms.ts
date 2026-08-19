import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import {
  createForm,
  deleteForm,
  formTagIds,
  formTagList,
  getForm,
  listForms,
  updateForm,
} from '../../core/forms.ts'
import { type Ctx, defineTool, fail, ok } from '../kit.ts'

export function registerForms(server: McpServer, ctx: Ctx): void {
  defineTool(
    server,
    ctx,
    'form_list',
    {
      description:
        'Signup forms. Each is a plain endpoint at POST /f/{slug} that any HTML <form> on any site can post to — no JavaScript, no embed script.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      ok(
        (await listForms(ctx.db)).map(({ form, sequenceName, sequenceActive, campaignName }) => ({
          ...form,
          sequence: sequenceName,
          sequenceActive,
          campaign: campaignName,
          endpoint: `${ctx.env.PUBLIC_URL}/f/${form.slug}`,
        })),
      ),
  )

  defineTool(
    server,
    ctx,
    'form_get',
    {
      description: 'One form with the tags it applies and the HTML needed to embed it.',
      inputSchema: z.object({ id: z.number().int() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const form = await getForm(ctx.db, id)
      if (!form) return fail('No such form.')

      const endpoint = `${ctx.env.PUBLIC_URL}/f/${form.slug}`
      return ok({
        ...form,
        endpoint,
        tags: await formTagList(ctx.db, id),
        embed: [
          `<form method="post" action="${endpoint}">`,
          '  <input type="email" name="email" required placeholder="you@example.com" />',
          '  <input type="text" name="name" placeholder="Your name" />',
          '  <button type="submit">Subscribe</button>',
          '</form>',
        ].join('\n'),
      })
    },
  )

  defineTool(
    server,
    ctx,
    'form_create',
    {
      description:
        'Create a signup form. Submissions upsert the subscriber, apply the tags, enroll them in sequence_id if set, and record an attribution touch for campaign_id if set.',
      inputSchema: z.object({
        name: z.string().min(1),
        slug: z.string().optional().describe('Defaults to a slug of the name; uniqueness is enforced'),
        tag_ids: z.array(z.number().int()).optional(),
        sequence_id: z.number().int().nullable().optional(),
        campaign_id: z.number().int().nullable().optional(),
        redirect_url: z.string().nullable().optional().describe('Where the browser lands after posting'),
        success_message: z.string().optional(),
      }),
    },
    async (args) => {
      const id = await createForm(ctx.db, {
        name: args.name,
        ...(args.slug ? { slug: args.slug } : {}),
        tagIds: args.tag_ids ?? [],
        sequenceId: args.sequence_id ?? null,
        campaignId: args.campaign_id ?? null,
        redirectUrl: args.redirect_url ?? null,
        ...(args.success_message ? { successMessage: args.success_message } : {}),
      })
      const form = await getForm(ctx.db, id)
      return ok({ id, slug: form?.slug, endpoint: `${ctx.env.PUBLIC_URL}/f/${form?.slug}` })
    },
  )

  defineTool(
    server,
    ctx,
    'form_update',
    {
      description:
        'Update a form. Omitted fields are cleared, not kept — read the form with form_get first and pass the whole shape back.',
      inputSchema: z.object({
        id: z.number().int(),
        name: z.string().min(1),
        slug: z.string().optional(),
        tag_ids: z.array(z.number().int()).optional(),
        sequence_id: z.number().int().nullable().optional(),
        campaign_id: z.number().int().nullable().optional(),
        redirect_url: z.string().nullable().optional(),
        success_message: z.string().optional(),
        is_active: z.boolean().optional(),
      }),
    },
    async (args) => {
      const form = await getForm(ctx.db, args.id)
      if (!form) return fail('No such form.')

      await updateForm(ctx.db, args.id, {
        name: args.name,
        ...(args.slug ? { slug: args.slug } : {}),
        tagIds: args.tag_ids ?? (await formTagIds(ctx.db, args.id)),
        sequenceId: args.sequence_id ?? null,
        campaignId: args.campaign_id ?? null,
        redirectUrl: args.redirect_url ?? null,
        ...(args.success_message ? { successMessage: args.success_message } : {}),
        isActive: args.is_active ?? true,
      })
      return ok({ updated: true })
    },
  )

  defineTool(
    server,
    ctx,
    'form_delete',
    {
      description:
        'Delete a form. Anything still posting to its URL starts failing — deactivate it with form_update first if you are not sure.',
      inputSchema: z.object({ id: z.number().int() }),
      annotations: { destructiveHint: true },
    },
    async ({ id }) => {
      const form = await getForm(ctx.db, id)
      if (!form) return fail('No such form.')
      await deleteForm(ctx.db, id)
      return ok({ deleted: true, wasSubmitted: form.submitCount })
    },
  )
}
