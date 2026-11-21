import type { McpServer } from '@modelcontextprotocol/server'
import { eq } from 'drizzle-orm'
import * as z from 'zod/v4'
import { agentSendAllowed, agentSendRefusal } from '../../core/agents.ts'
import { leaveSequence, rejoinSequence } from '../../core/consent.ts'
import { normalizeEmail } from '../../core/ids.ts'
import { mdToDoc } from '../../core/md-to-doc.ts'
import {
  addStep,
  createSequence,
  deleteSequence,
  deleteStep,
  enroll,
  enrollmentsFor,
  getSequence,
  listSequences,
  reorderSteps,
  removeExit,
  sequenceFlow,
  sequenceStats,
  setExit,
  setSequenceActive,
  stepsFor,
  storedWindow,
  tickSequences,
  updateSequence,
  updateStep,
} from '../../core/sequences.ts'
import { clock, parseClock } from '../../core/send-window.ts'
import { getTimeZone, setTimeZone } from '../../core/site-settings.ts'
import { subscribers, tags } from '../../db/schema.ts'
import { type Ctx, clampLimit, defineTool, fail, failed, ok } from '../kit.ts'
import { activateSequenceWithToken, preflightSequence } from '../../core/send-preflight.ts'

const TRIGGERS = ['subscribe', 'tag_added', 'manual'] as const

export function registerSequences(server: McpServer, ctx: Ctx): void {
  defineTool(
    server,
    ctx,
    'sequence_list',
    {
      description: 'Every drip sequence with its trigger, live/paused state, and step count.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const seqs = await listSequences(ctx.db)
      const out = []
      for (const s of seqs) out.push({ ...s, stats: await sequenceStats(ctx.db, s.id) })
      return ok(out)
    },
  )

  defineTool(
    server,
    ctx,
    'sequence_get',
    {
      description:
        'One sequence with its ordered steps (including delays and bodies), stats, and its flow: where finishers go next, which tags pull people out early, and which sequences feed into it.',
      inputSchema: z.object({ id: z.number().int() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const seq = await getSequence(ctx.db, id)
      if (!seq) return fail('No such sequence.')

      const triggerTag = seq.triggerTagId
        ? await ctx.db.select().from(tags).where(eq(tags.id, seq.triggerTagId)).get()
        : null

      const window = storedWindow(seq.sendWindowStart, seq.sendWindowEnd)
      return ok({
        ...seq,
        sendWindow: window
          ? { start: clock(window.start), end: clock(window.end), timeZone: await getTimeZone(ctx.db) }
          : null,
        triggerTag: triggerTag?.name ?? null,
        steps: await stepsFor(ctx.db, id),
        stats: await sequenceStats(ctx.db, id),
        flow: await sequenceFlow(ctx.db, id),
      })
    },
  )

  defineTool(
    server,
    ctx,
    'sequence_create',
    {
      description:
        "Create a drip sequence. Always starts paused with no steps. Triggers: 'subscribe' (fires when someone joins the list), 'tag_added' (needs trigger_tag_id), or 'manual' (enroll people yourself). The description is shown to subscribers in the preference center, so write it as something a person chose to receive.",
      inputSchema: z.object({
        name: z.string().min(1),
        description: z.string().nullable().optional(),
        trigger: z.enum(TRIGGERS),
        trigger_tag_id: z.number().int().nullable().optional(),
        campaign_id: z.number().int().nullable().optional(),
        next_sequence_id: z
          .number()
          .int()
          .nullable()
          .optional()
          .describe('When someone finishes the last step, enroll them in this sequence.'),
      }),
    },
    async (args) => {
      if (args.trigger === 'tag_added' && !args.trigger_tag_id) {
        return fail('A tag_added sequence needs trigger_tag_id.', 'Find the tag with tag_list.')
      }
      const id = await createSequence(ctx.db, {
        name: args.name,
        description: args.description ?? null,
        trigger: args.trigger,
        triggerTagId: args.trigger_tag_id ?? null,
        campaignId: args.campaign_id ?? null,
        nextSequenceId: args.next_sequence_id ?? null,
      })
      return ok({ id, isActive: false, next: 'Add steps with step_add, then sequence_activate.' })
    },
  )

  defineTool(
    server,
    ctx,
    'sequence_update',
    {
      description:
        'Change a sequence’s name, description, trigger or campaign, and how people leave it. next_sequence_id: finishers of the last step are enrolled there (null ends the chain; applies only to people who finish from now on, and only while that sequence is live). exits_set: tags that pull someone out early, each optionally leading into another sequence. An exit cancels the enrollment and records why; it is NOT an opt-out and writes no consent record. It also keeps holders of that tag from being enrolled. Opt-outs, unsubscribe-from-everything, bounces and complaints always end an enrollment and cannot be configured. send_window: only send between start and end ("HH:MM", end exclusive; an end before the start runs past midnight), read in the install-wide time_zone; a step due outside it waits for the next opening and is never skipped; null clears it. time_zone: an IANA name like "Pacific/Honolulu"; it is ONE setting for the whole install, so changing it moves every sequence\'s window. Not its steps.',
      inputSchema: z.object({
        id: z.number().int(),
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        trigger: z.enum(TRIGGERS).optional(),
        trigger_tag_id: z.number().int().nullable().optional(),
        campaign_id: z.number().int().nullable().optional(),
        next_sequence_id: z.number().int().nullable().optional(),
        exits_set: z
          .array(
            z.object({
              tag_id: z.number().int(),
              then_sequence_id: z.number().int().nullable().optional(),
            }),
          )
          .optional()
          .describe('Add these exits, or change where an existing one leads.'),
        exits_remove: z.array(z.number().int()).optional().describe('Tag ids whose exit to remove.'),
        send_window: z
          .object({
            start: z.string().regex(/^\d{1,2}:\d{2}$/).describe('HH:MM, inclusive'),
            end: z.string().regex(/^\d{1,2}:\d{2}$/).describe('HH:MM, exclusive'),
          })
          .nullable()
          .optional()
          .describe('Only send inside this window, in time_zone. null removes it.'),
        time_zone: z
          .string()
          .optional()
          .describe('The install-wide IANA time zone every send window is read in.'),
      }),
    },
    async (args) => {
      if (args.time_zone !== undefined) {
        const tz = await setTimeZone(ctx.db, args.time_zone)
        if (!tz.ok) return failed(tz)
      }
      let sendWindow: { start: number | null; end: number | null } | null | undefined
      if (args.send_window === null) sendWindow = null
      else if (args.send_window) {
        const start = parseClock(args.send_window.start)
        const end = parseClock(args.send_window.end)
        if (start === 'invalid' || end === 'invalid') return fail('send_window times must be HH:MM, 00:00 to 23:59.')
        sendWindow = { start, end }
      }
      const result = await updateSequence(ctx.db, args.id, {
        ...(sendWindow !== undefined ? { sendWindow } : {}),
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.trigger !== undefined ? { trigger: args.trigger } : {}),
        ...(args.trigger_tag_id !== undefined ? { triggerTagId: args.trigger_tag_id } : {}),
        ...(args.campaign_id !== undefined ? { campaignId: args.campaign_id } : {}),
        ...(args.next_sequence_id !== undefined ? { nextSequenceId: args.next_sequence_id } : {}),
      })
      if (!result.ok) return failed(result)

      for (const tagId of args.exits_remove ?? []) await removeExit(ctx.db, args.id, tagId)
      for (const x of args.exits_set ?? []) {
        const set = await setExit(ctx.db, args.id, x.tag_id, x.then_sequence_id ?? null)
        if (!set.ok) return failed(set)
      }
      return ok({ updated: true, flow: await sequenceFlow(ctx.db, args.id) })
    },
  )

  defineTool(
    server,
    ctx,
    'sequence_exit_set',
    {
      description:
        'Add an exit to a sequence, or change where an existing one leads: when tag_id lands on someone enrolled here, their enrollment is cancelled (reason exit_tag) and, if then_sequence_id is set and live, they join that sequence. It also keeps holders of that tag from being enrolled at all. An exit is automation, NOT an opt-out: it writes no consent record, and the person can be enrolled again later by other means. The tag that triggers a tag_added sequence cannot also be its exit.',
      inputSchema: z.object({
        id: z.number().int().describe('The sequence'),
        tag_id: z.number().int(),
        then_sequence_id: z.number().int().nullable().optional(),
      }),
      annotations: { idempotentHint: true },
    },
    async ({ id, tag_id, then_sequence_id }) => {
      const result = await setExit(ctx.db, id, tag_id, then_sequence_id ?? null)
      if (!result.ok) return failed(result, 'Find tags with tag_list and sequences with sequence_list.')
      return ok({ saved: true, flow: await sequenceFlow(ctx.db, id) })
    },
  )

  defineTool(
    server,
    ctx,
    'sequence_exit_remove',
    {
      description:
        'Remove an exit from a sequence. People already pulled out by it stay out; nobody is re-enrolled.',
      inputSchema: z.object({ id: z.number().int().describe('The sequence'), tag_id: z.number().int() }),
      annotations: { idempotentHint: true },
    },
    async ({ id, tag_id }) => {
      if (!(await getSequence(ctx.db, id))) return fail('No such sequence.')
      await removeExit(ctx.db, id, tag_id)
      return ok({ removed: true, flow: await sequenceFlow(ctx.db, id) })
    },
  )

  defineTool(
    server,
    ctx,
    'sequence_delete',
    {
      description:
        'Delete a paused sequence, its steps, and every enrollment. Opt-out records go with it. Deactivate first.',
      inputSchema: z.object({ id: z.number().int() }),
      annotations: { destructiveHint: true },
    },
    async ({ id }) => {
      const result = await deleteSequence(ctx.db, id)
      return result.ok ? ok({ deleted: true }) : failed(result)
    },
  )

  defineTool(
    server,
    ctx,
    'sequence_preflight',
    {
      description:
        'MANDATORY before sequence_activate. Shows every step in order with its delay and a rendered sample, plus who would start receiving it. Returns a single-use token that expires in 10 minutes and dies on any step edit.',
      inputSchema: z.object({ id: z.number().int() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const r = await preflightSequence(ctx.db, id)
      if (!r.ok) return fail(r.reason)
      if (!(await agentSendAllowed(ctx.env, ctx.db))) r.report.warnings.push(agentSendRefusal(ctx.env))
      return ok(r.report)
    },
  )

  defineTool(
    server,
    ctx,
    'sequence_activate',
    {
      description:
        'Take a sequence live. Requires a preflight_token from sequence_preflight, minted after the last step edit. Once live, its trigger starts enrolling people and the cron tick starts sending.',
      inputSchema: z.object({
        id: z.number().int(),
        preflight_token: z.string(),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ id, preflight_token }) => {
      if (!(await agentSendAllowed(ctx.env, ctx.db))) return fail(agentSendRefusal(ctx.env))

      const result = await activateSequenceWithToken(ctx.db, id, preflight_token)
      if (!result.ok && result.code === 'preflight') {
        return fail(result.reason, `Call sequence_preflight({ id: ${id} }) and pass the token it returns.`)
      }
      return result.ok ? ok({ active: true }) : failed(result)
    },
  )

  defineTool(
    server,
    ctx,
    'sequence_deactivate',
    {
      description:
        'Pause a sequence. No new enrollments and no further sends. Existing enrollments keep their place and resume where they left off.',
      inputSchema: z.object({ id: z.number().int() }),
    },
    async ({ id }) => {
      const result = await setSequenceActive(ctx.db, id, false)
      return result.ok ? ok({ active: false }) : failed(result)
    },
  )

  // ─────────────────────────────────────────────── steps

  defineTool(
    server,
    ctx,
    'step_add',
    {
      description:
        'Append a step. delay_days counts from the PREVIOUS step, not from enrollment — 0 on the first step means "as soon as they join".',
      inputSchema: z.object({
        sequence_id: z.number().int(),
        subject: z.string().min(1),
        body_markdown: z.string().min(1),
        delay_days: z.number().int().min(0).max(365).optional(),
      }),
    },
    async (args) => {
      const result = await addStep(ctx.db, args.sequence_id, {
        subject: args.subject,
        bodyMd: args.body_markdown,
        bodyJson: mdToDoc(args.body_markdown),
        ...(args.delay_days !== undefined ? { delayDays: args.delay_days } : {}),
      })
      return result.ok
        ? ok({ stepId: result.stepId, position: result.position })
        : failed(result)
    },
  )

  defineTool(
    server,
    ctx,
    'step_update',
    {
      description:
        'Edit a step. Never re-sends it to anyone who already received it — only people who have not reached this step yet see the change.',
      inputSchema: z.object({
        step_id: z.number().int(),
        subject: z.string().min(1).optional(),
        body_markdown: z.string().min(1).optional(),
        delay_days: z.number().int().min(0).max(365).optional(),
      }),
    },
    async (args) => {
      const result = await updateStep(ctx.db, args.step_id, {
        ...(args.subject !== undefined ? { subject: args.subject } : {}),
        ...(args.body_markdown !== undefined
          ? { bodyMd: args.body_markdown, bodyJson: mdToDoc(args.body_markdown) }
          : {}),
        ...(args.delay_days !== undefined ? { delayDays: args.delay_days } : {}),
      })
      return result.ok ? ok({ updated: true }) : failed(result)
    },
  )

  defineTool(
    server,
    ctx,
    'step_delete',
    {
      description:
        'Delete a step. Enrollments sitting on it advance to the next one on the following tick — nobody is stranded.',
      inputSchema: z.object({ step_id: z.number().int() }),
      annotations: { destructiveHint: true },
    },
    async ({ step_id }) => {
      const result = await deleteStep(ctx.db, step_id)
      return result.ok ? ok({ deleted: true }) : failed(result)
    },
  )

  defineTool(
    server,
    ctx,
    'step_reorder',
    {
      description:
        'Rewrite step order. Pass every step id of the sequence exactly once, in the order you want.',
      inputSchema: z.object({
        sequence_id: z.number().int(),
        step_ids: z.array(z.number().int()).min(1),
      }),
    },
    async ({ sequence_id, step_ids }) => {
      const result = await reorderSteps(ctx.db, sequence_id, step_ids)
      return result.ok ? ok({ steps: await stepsFor(ctx.db, sequence_id) }) : failed(result)
    },
  )

  // ─────────────────────────────────────────────── enrollment

  defineTool(
    server,
    ctx,
    'sequence_enroll',
    {
      description:
        'Enroll one subscriber. Refused if they previously left this sequence — leaving is a standing preference and only they can undo it, from the preference center. Also refused (has_exit_tag) if they hold one of the sequence’s exit tags.',
      inputSchema: z.object({
        sequence_id: z.number().int(),
        subscriber_id: z.number().int().optional(),
        email: z.string().optional(),
      }),
    },
    async (args) => {
      let subscriberId = args.subscriber_id
      if (!subscriberId && args.email) {
        const sub = await ctx.db
          .select({ id: subscribers.id })
          .from(subscribers)
          .where(eq(subscribers.email, normalizeEmail(args.email)))
          .get()
        if (!sub) return fail(`${args.email} is not a subscriber.`)
        subscriberId = sub.id
      }
      if (!subscriberId) return fail('Pass subscriber_id or email.')

      const outcome = await enroll(ctx.db, args.sequence_id, subscriberId)
      return ok({ outcome })
    },
  )

  defineTool(
    server,
    ctx,
    'sequence_enrollments',
    {
      description: 'Who is in a sequence, where they are, and when their next step is due.',
      inputSchema: z.object({ sequence_id: z.number().int(), limit: z.number().int().optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ sequence_id, limit }) =>
      ok(await enrollmentsFor(ctx.db, sequence_id, clampLimit(limit))),
  )

  defineTool(
    server,
    ctx,
    'sequence_remove_person',
    {
      description:
        'Record that a subscriber has left one sequence. Scoped: they stay subscribed, stay on the newsletter, and stay in every other sequence. This is the operator-side version of the footer link.',
      inputSchema: z.object({
        sequence_id: z.number().int(),
        subscriber_id: z.number().int(),
      }),
    },
    async ({ sequence_id, subscriber_id }) => {
      await leaveSequence(ctx.db, subscriber_id, sequence_id)
      return ok({ left: true, note: 'Only the subscriber can rejoin, from the preference center.' })
    },
  )

  defineTool(
    server,
    ctx,
    'sequence_rejoin_person',
    {
      description:
        'Clear a subscriber’s opt-out from one sequence, at their explicit request. Do not use this to override somebody who left.',
      inputSchema: z.object({
        sequence_id: z.number().int(),
        subscriber_id: z.number().int(),
      }),
    },
    async ({ sequence_id, subscriber_id }) => {
      await rejoinSequence(ctx.db, subscriber_id, sequence_id)
      return ok({ rejoined: true })
    },
  )

  defineTool(
    server,
    ctx,
    'sequence_stats',
    {
      description: 'Steps, active/completed/cancelled enrollments and opt-outs for one sequence.',
      inputSchema: z.object({ id: z.number().int() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => ok(await sequenceStats(ctx.db, id)),
  )

  defineTool(
    server,
    ctx,
    'sequence_tick',
    {
      description:
        'Run the sequence tick now instead of waiting for the cron minute. Advances every due enrollment and sends what falls due. Idempotent.',
      inputSchema: z.object({}),
    },
    async () => {
      if (!(await agentSendAllowed(ctx.env, ctx.db))) return fail(agentSendRefusal(ctx.env))
      return ok({ sent: await tickSequences(ctx.env, ctx.db) })
    },
  )
}
