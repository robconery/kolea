import type { McpServer } from '@modelcontextprotocol/server'
import { eq } from 'drizzle-orm'
import * as z from 'zod/v4'
import {
  campaignPeople,
  campaignStats,
  createCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  recordTouch,
  setCampaignStatus,
  updateCampaign,
} from '../../core/campaigns.ts'
import { salesForCampaign } from '../../core/sales.ts'
import { broadcasts, forms, sequences } from '../../db/schema.ts'
import { type Ctx, clampLimit, defineTool, fail, money, ok } from '../kit.ts'

export function registerCampaigns(server: McpServer, ctx: Ctx): void {
  defineTool(
    server,
    ctx,
    'campaign_list',
    {
      description: 'Every campaign with people touched, orders, refunds and net revenue.',
      inputSchema: z.object({ include_archived: z.boolean().optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ include_archived }) => {
      const all = await listCampaigns(ctx.db)
      const visible = include_archived ? all : all.filter((c) => c.status === 'active')

      const out = []
      for (const c of visible) {
        const stats = await campaignStats(ctx.db, c.id)
        out.push({
          id: c.id,
          slug: c.slug,
          name: c.name,
          status: c.status,
          goal: c.goalCents === null ? null : money(c.goalCents),
          ...stats,
          revenue: stats.revenue.map((r) => money(r.cents, r.currency)),
        })
      }
      return ok(out)
    },
  )

  defineTool(
    server,
    ctx,
    'campaign_get',
    {
      description:
        'One campaign in full: stats, progress against its goal, and every broadcast, sequence and form pointing at it.',
      inputSchema: z.object({ id: z.number().int() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const c = await getCampaign(ctx.db, id)
      if (!c) return fail('No such campaign.')

      const stats = await campaignStats(ctx.db, id)
      // Goals are single-currency by nature; the first bucket is the one to
      // measure against, and mixed currencies show up in `revenue` regardless.
      const primary = stats.revenue[0]?.cents ?? 0

      return ok({
        ...c,
        goal: c.goalCents === null ? null : money(c.goalCents),
        progressPct:
          c.goalCents && c.goalCents > 0 ? Math.round((primary / c.goalCents) * 100) : null,
        ...stats,
        revenue: stats.revenue.map((r) => money(r.cents, r.currency)),
        broadcasts: await ctx.db
          .select({ id: broadcasts.id, subject: broadcasts.subject, status: broadcasts.status })
          .from(broadcasts)
          .where(eq(broadcasts.campaignId, id))
          .all(),
        sequences: await ctx.db
          .select({ id: sequences.id, name: sequences.name, isActive: sequences.isActive })
          .from(sequences)
          .where(eq(sequences.campaignId, id))
          .all(),
        forms: await ctx.db
          .select({ id: forms.id, slug: forms.slug, name: forms.name })
          .from(forms)
          .where(eq(forms.campaignId, id))
          .all(),
      })
    },
  )

  defineTool(
    server,
    ctx,
    'campaign_create',
    {
      description:
        'Create a campaign — a named push (a launch, a course sale, a book). Point broadcasts, sequences and forms at it, and sales get credited to it by last touch.',
      inputSchema: z.object({
        name: z.string().min(1),
        description: z.string().nullable().optional(),
        goal_cents: z.number().int().nullable().optional().describe('Revenue target in cents'),
      }),
    },
    async ({ name, description, goal_cents }) =>
      ok({
        id: await createCampaign(ctx.db, name, {
          description: description ?? null,
          goalCents: goal_cents ?? null,
        }),
      }),
  )

  defineTool(
    server,
    ctx,
    'campaign_update',
    {
      description: 'Rename a campaign or change its description or revenue goal.',
      inputSchema: z.object({
        id: z.number().int(),
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        goal_cents: z.number().int().nullable().optional(),
      }),
    },
    async (args) => {
      const c = await getCampaign(ctx.db, args.id)
      if (!c) return fail('No such campaign.')

      await updateCampaign(ctx.db, args.id, {
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.goal_cents !== undefined ? { goalCents: args.goal_cents } : {}),
      })
      return ok({ updated: true })
    },
  )

  defineTool(
    server,
    ctx,
    'campaign_archive',
    {
      description:
        'Archive or reactivate a campaign. Archiving hides it from the default list and stamps an end date; it changes no data.',
      inputSchema: z.object({ id: z.number().int(), archived: z.boolean() }),
    },
    async ({ id, archived }) => {
      const c = await getCampaign(ctx.db, id)
      if (!c) return fail('No such campaign.')
      await setCampaignStatus(ctx.db, id, archived ? 'archived' : 'active')
      return ok({ status: archived ? 'archived' : 'active' })
    },
  )

  defineTool(
    server,
    ctx,
    'campaign_delete',
    {
      description:
        'Delete a campaign and its attribution touches. Broadcasts, sequences, forms and sales survive — the sales just become unattributed, so revenue reporting for this push is lost. Prefer campaign_archive.',
      inputSchema: z.object({ id: z.number().int(), confirm_name: z.string() }),
      annotations: { destructiveHint: true },
    },
    async ({ id, confirm_name }) => {
      const c = await getCampaign(ctx.db, id)
      if (!c) return fail('No such campaign.')
      if (confirm_name !== c.name) {
        return fail(`confirm_name must be exactly "${c.name}".`)
      }

      const stats = await campaignStats(ctx.db, id)
      await deleteCampaign(ctx.db, id)
      return ok({
        deleted: true,
        warning: stats.orders
          ? `${stats.orders} sale(s) are now unattributed.`
          : 'No sales were attached.',
      })
    },
  )

  defineTool(
    server,
    ctx,
    'campaign_people',
    {
      description: 'Everyone a campaign has touched, most recent first, one row per person.',
      inputSchema: z.object({ id: z.number().int(), limit: z.number().int().optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id, limit }) => ok(await campaignPeople(ctx.db, id, clampLimit(limit))),
  )

  defineTool(
    server,
    ctx,
    'campaign_sales',
    {
      description: 'Sales credited to one campaign.',
      inputSchema: z.object({ id: z.number().int(), limit: z.number().int().optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id, limit }) => {
      const rows = await salesForCampaign(ctx.db, id, clampLimit(limit))
      return ok(
        rows.map(({ sale, email, subscriberName }) => ({
          id: sale.id,
          email,
          name: subscriberName,
          product: sale.product,
          amount: money(sale.amountCents, sale.currency),
          status: sale.status,
          externalId: sale.externalId,
          occurredAt: sale.occurredAt,
        })),
      )
    },
  )

  defineTool(
    server,
    ctx,
    'campaign_attribute',
    {
      description:
        'Record a manual attribution touch: "this person came to this campaign". Idempotent — one touch per person per source, so re-running changes nothing. Use it when somebody arrived through a channel the mailer cannot see.',
      inputSchema: z.object({
        campaign_id: z.number().int(),
        subscriber_id: z.number().int(),
        occurred_at: z.string().optional().describe('ISO timestamp; defaults to now'),
      }),
      annotations: { idempotentHint: true },
    },
    async ({ campaign_id, subscriber_id, occurred_at }) => {
      const c = await getCampaign(ctx.db, campaign_id)
      if (!c) return fail('No such campaign.')

      let when: Date | undefined
      if (occurred_at) {
        const ms = Date.parse(occurred_at)
        if (Number.isNaN(ms)) return fail(`"${occurred_at}" is not a parseable timestamp.`)
        when = new Date(ms)
      }

      const recorded = await recordTouch(ctx.db, {
        subscriberId: subscriber_id,
        campaignId: campaign_id,
        sourceKind: 'manual',
        sourceId: 0,
        ...(when ? { occurredAt: when } : {}),
      })
      return ok({ recorded, note: recorded ? 'New touch.' : 'Already recorded — no change.' })
    },
  )
}
