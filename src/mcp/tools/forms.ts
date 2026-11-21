import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { downloadUrl, fileStats } from '../../core/downloads.ts'
import {
  createForm,
  deleteForm,
  failedReplies,
  formDeliveryCount,
  formTagIds,
  formTagList,
  getForm,
  listForms,
  resendFailedReplies,
  setFormReply,
  updateForm,
} from '../../core/forms.ts'
import { type Ctx, defineTool, fail, ok } from '../kit.ts'
import { agentSendAllowed, agentSendRefusal } from '../../core/agents.ts'
import { consumePreflight, digestOf, mintPreflight } from '../../core/preflight.ts'

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
      const stats = await fileStats(ctx.db, id)
      return ok({
        ...form,
        endpoint,
        reply: {
          // No subject means no reply is sent. That check is the on/off switch.
          active: Boolean(form.deliverySubject?.trim()),
          sent: await formDeliveryCount(ctx.db, id),
          file: form.downloadKey
            ? {
                filename: form.downloadFilename,
                bytes: form.downloadBytes,
                linksIssued: stats.links,
                downloads: stats.taken,
                // The one URL that hands the file to anybody, for the operator
                // to send out. Null until the form's page has minted it.
                directLink: form.downloadShareToken
                  ? downloadUrl(ctx.env.PUBLIC_URL, form.downloadShareToken)
                  : null,
                directDownloads: stats.shared,
              }
            : null,
        },
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
        'Create a signup form. Submissions upsert the subscriber, apply the tags, enroll them in sequence_id if set, and record an attribution touch for campaign_id if set. double_opt_in defaults to true: a submit then creates the person as pending and sends one confirmation email, and the tags, sequence, reply and touch all wait until they click the link in it.',
      inputSchema: z.object({
        name: z.string().min(1),
        slug: z.string().optional().describe('Defaults to a slug of the name; uniqueness is enforced'),
        tag_ids: z.array(z.number().int()).optional(),
        sequence_id: z.number().int().nullable().optional(),
        campaign_id: z.number().int().nullable().optional(),
        redirect_url: z.string().nullable().optional().describe('Where the browser lands after posting'),
        success_message: z.string().optional(),
        double_opt_in: z
          .boolean()
          .optional()
          .describe('Require an email confirmation before anything else happens. Defaults to true'),
      }),
    },
    async (args) => {
      const id = await createForm(ctx.db, {
        doubleOptIn: args.double_opt_in ?? true,
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
        'Update a form. Omitted fields are cleared, not kept — read the form with form_get first and pass the whole shape back. The one exception is double_opt_in: omitted keeps what the form has, so confirmation is never switched off by accident. The reply and its file are not touched here; the reply has its own tool, form_set_reply.',
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
        double_opt_in: z
          .boolean()
          .optional()
          .describe('Require an email confirmation first. Omitted keeps the current setting'),
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
        ...(args.double_opt_in === undefined ? {} : { doubleOptIn: args.double_opt_in }),
      })
      return ok({ updated: true })
    },
  )

  defineTool(
    server,
    ctx,
    'form_set_reply',
    {
      description: [
        "Write the form's reply — the email that goes out the instant somebody submits, carrying the file they signed up for.",
        'It is NOT a sequence step: it sends inside the submit request, under the transactional consent rule, so an unsubscribed reader still gets what they asked for. Use the form\'s sequence for the nurture that follows.',
        'Put {{link}} in the body where the download belongs; it renders as that one person\'s private URL.',
        'An empty subject turns the reply off. The file itself is uploaded from the form\'s page in the admin console — binary, so there is no tool for it.',
      ].join(' '),
      inputSchema: z.object({
        id: z.number().int(),
        subject: z.string().describe('Empty string turns the reply off'),
        body: z.string().describe('Markdown. Include {{link}} when the form has a file attached'),
      }),
      annotations: { idempotentHint: true },
    },
    async (args) => {
      const form = await getForm(ctx.db, args.id)
      if (!form) return fail('No such form.')

      if (args.subject.trim() && !args.body.trim()) {
        return fail('A reply needs a body. An empty email is worse than none.')
      }
      if (form.downloadKey && args.subject.trim() && !args.body.includes('{{link}}')) {
        return fail(
          `This form hands over ${form.downloadFilename}, but the body has no {{link}} in it, so the reader would get no download. Add it.`,
        )
      }

      await setFormReply(ctx.db, args.id, {
        subject: args.subject,
        // Markdown only from here: the rich document is authored in the admin
        // editor, and writing null clears it so what you passed is what sends.
        bodyJson: null,
        bodyMd: args.body,
      })
      return ok({ updated: true, replyActive: Boolean(args.subject.trim()) })
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

  defineTool(
    server,
    ctx,
    'form_resend_replies',
    {
      description:
        "The people whose reply (the lead-magnet mail) from this form failed and never went since, and who are still on the list. By default it only LISTS them (who, when, why) and returns a single-use preflight_token (10 minutes) bound to exactly that set. With send: true and that token it sends the reply to each of them once; if anyone was added to or dropped from the set since the listing, the token is refused and you list again. Anyone who has since received it, may have received it (an unknown outcome), or has unsubscribed, bounced or complained is left out, and consent is checked again just before the provider call. Fix whatever made them fail first (see health).",
      inputSchema: z.object({
        id: z.number().int().describe('The form'),
        send: z.boolean().optional().describe('false (the default) only lists who would get it, and mints the token.'),
        preflight_token: z.string().optional().describe('Required with send: true. From the listing call.'),
      }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ id, send, preflight_token }) => {
      if (!(await getForm(ctx.db, id))) return fail('No such form.', 'List them with form_list.')
      const people = (rows: Awaited<ReturnType<typeof failedReplies>>) =>
        rows.map((r) => ({ email: r.email, failedAt: r.failedAt, error: r.error }))
      const digest = async (rows: Awaited<ReturnType<typeof failedReplies>>) =>
        await digestOf(['form_resend_replies', id, rows.map((r) => r.messageId)])

      if (send !== true) {
        const rows = await failedReplies(ctx.db, id)
        if (rows.length === 0) return ok({ sent: false, wouldSend: 0, people: [] })
        const { token, expiresAt } = await mintPreflight(ctx.db, 'form_resend_replies', id, await digest(rows), rows.length)
        return ok({ sent: false, wouldSend: rows.length, people: people(rows), preflight_token: token, expiresAt })
      }
      if (!(await agentSendAllowed(ctx.env, ctx.db))) return fail(agentSendRefusal(ctx.env))

      const check = await consumePreflight(
        ctx.db,
        'form_resend_replies',
        id,
        await digest(await failedReplies(ctx.db, id)),
        preflight_token ?? '',
      )
      if (!check.ok) {
        return fail(
          `Refusing to send: ${check.reason}.`,
          `Call form_resend_replies({ id: ${id} }) to list them, then pass the preflight_token it returns with send: true.`,
        )
      }
      const rows = await resendFailedReplies(ctx.env, ctx.db, id)
      return ok({ sent: true, queued: rows.length, people: people(rows) })
    },
  )
}
