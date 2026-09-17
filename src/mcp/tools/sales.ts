import type { McpServer } from '@modelcontextprotocol/server'
import { desc, eq, isNull } from 'drizzle-orm'
import * as z from 'zod/v4'
import { getCampaign, getCampaignBySlug, touchesFor } from '../../core/campaigns.ts'
import {
  FALLBACK_SLUG,
  createTemplate,
  getTemplateBySlug,
  listTemplates,
  planPurchaseMail,
  purchasedItems,
  sendPurchaseMail,
  updateTemplate,
} from '../../core/purchase-mail.ts'
import { listSales, recordSale, revenueTotals } from '../../core/sales.ts'
import { campaigns, sales, subscribers } from '../../db/schema.ts'
import { type Ctx, clampLimit, defineTool, fail, money, ok } from '../kit.ts'
import { SEND_DISABLED, sendingAllowed } from '../preflight.ts'

export function registerSales(server: McpServer, ctx: Ctx): void {
  defineTool(
    server,
    ctx,
    'sale_list',
    {
      description: 'Recent sales with buyer and attributed campaign, newest first.',
      inputSchema: z.object({ limit: z.number().int().optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const rows = await listSales(ctx.db, clampLimit(limit, 100))
      return ok(
        rows.map(({ sale, email, subscriberName, campaignName }) => ({
          id: sale.id,
          email,
          name: subscriberName,
          product: sale.product,
          amount: money(sale.amountCents, sale.currency),
          status: sale.status,
          campaign: campaignName,
          externalId: sale.externalId,
          occurredAt: sale.occurredAt,
        })),
      )
    },
  )

  defineTool(
    server,
    ctx,
    'sale_record',
    {
      description:
        'Record a purchase. Idempotent on external_id — replaying the same charge returns the original sale instead of double-counting. Without campaign_slug the buyer’s most recent attribution touch decides the credit, and the response says which rule was used.',
      inputSchema: z.object({
        email: z.string(),
        amount_cents: z.number().int().min(0).describe('Integer cents. Never a float.'),
        name: z.string().nullable().optional(),
        currency: z.string().optional().describe("Defaults to 'usd'"),
        product: z.string().nullable().optional(),
        external_id: z
          .string()
          .nullable()
          .optional()
          .describe('Your checkout id (Stripe charge, order number). Makes this idempotent.'),
        campaign_slug: z.string().nullable().optional().describe('Overrides last-touch attribution'),
        tag_names: z.array(z.string()).optional().describe('Applied normally, so a tag_added sequence can fire'),
        end_sequence_slug: z
          .string()
          .nullable()
          .optional()
          .describe('Stop selling to them: the "you already bought it" case'),
        occurred_at: z.string().optional().describe('ISO timestamp; defaults to now'),
      }),
      annotations: { idempotentHint: true },
    },
    async (args) => {
      let occurredAt: Date | undefined
      if (args.occurred_at) {
        const ms = Date.parse(args.occurred_at)
        if (Number.isNaN(ms)) return fail(`"${args.occurred_at}" is not a parseable timestamp.`)
        occurredAt = new Date(ms)
      }

      const result = await recordSale(ctx.db, {
        email: args.email,
        name: args.name ?? null,
        amountCents: args.amount_cents,
        ...(args.currency ? { currency: args.currency } : {}),
        product: args.product ?? null,
        externalId: args.external_id ?? null,
        campaignSlug: args.campaign_slug ?? null,
        tagNames: args.tag_names ?? [],
        endSequenceSlug: args.end_sequence_slug ?? null,
        ...(occurredAt ? { occurredAt } : {}),
      })

      if (result.status === 'invalid_email') return fail(`"${args.email}" is not a valid address.`)
      if (result.status === 'invalid_amount') return fail('amount_cents must be a whole number ≥ 0.')
      return ok(result)
    },
  )

  defineTool(
    server,
    ctx,
    'sale_refund',
    {
      description:
        'Mark a sale refunded by its external_id. A refund flips the existing row rather than adding a negative one, so revenue reports stop counting it — they do not subtract twice.',
      inputSchema: z.object({ external_id: z.string() }),
      annotations: { idempotentHint: true },
    },
    async ({ external_id }) => {
      const existing = await ctx.db
        .select()
        .from(sales)
        .where(eq(sales.externalId, external_id))
        .get()
      if (!existing) {
        return fail(
          `No sale with external_id "${external_id}".`,
          'Find it with sale_list, or record it first with sale_record.',
        )
      }

      const sub = await ctx.db
        .select({ email: subscribers.email })
        .from(subscribers)
        .where(eq(subscribers.id, existing.subscriberId))
        .get()

      const result = await recordSale(ctx.db, {
        email: sub?.email ?? '',
        amountCents: existing.amountCents,
        externalId: external_id,
        status: 'refunded',
      })
      return ok(result)
    },
  )

  defineTool(
    server,
    ctx,
    'revenue_totals',
    {
      description: 'Net revenue and order count across everything, split by currency.',
      inputSchema: z.object({
        since: z.string().optional().describe('ISO date — only sales on or after this'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ since }) => {
      let sinceMs: number | undefined
      if (since) {
        const ms = Date.parse(since)
        if (Number.isNaN(ms)) return fail(`"${since}" is not a parseable date.`)
        sinceMs = ms
      }
      const totals = await revenueTotals(ctx.db, sinceMs)
      return ok(totals.map((t) => ({ ...t, total: money(t.cents, t.currency) })))
    },
  )

  defineTool(
    server,
    ctx,
    'sales_unattributed',
    {
      description:
        'Sales credited to no campaign, each with the buyer’s attribution touches so you can work out where they should go. This is the worklist for a reconciliation pass — fix them with sale_attribute.',
      inputSchema: z.object({ limit: z.number().int().optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const rows = await ctx.db
        .select({ sale: sales, email: subscribers.email })
        .from(sales)
        .innerJoin(subscribers, eq(subscribers.id, sales.subscriberId))
        .where(isNull(sales.campaignId))
        .orderBy(desc(sales.occurredAt))
        .limit(clampLimit(limit, 25, 100))
        .all()

      const out = []
      for (const { sale, email } of rows) {
        out.push({
          saleId: sale.id,
          email,
          product: sale.product,
          amount: money(sale.amountCents, sale.currency),
          occurredAt: sale.occurredAt,
          externalId: sale.externalId,
          buyerTouches: await touchesFor(ctx.db, sale.subscriberId),
        })
      }
      return ok({ count: out.length, sales: out })
    },
  )

  defineTool(
    server,
    ctx,
    'sale_attribute',
    {
      description:
        'Change which campaign a sale is credited to. This rewrites stored revenue history, so it is deliberately the only tool that can — every call is in the audit log. Pass campaign_slug null to un-attribute.',
      inputSchema: z.object({
        sale_id: z.number().int(),
        campaign_slug: z.string().nullable(),
        reason: z.string().describe('Why — recorded on the sale so the change explains itself later'),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ sale_id, campaign_slug, reason }) => {
      const sale = await ctx.db.select().from(sales).where(eq(sales.id, sale_id)).get()
      if (!sale) return fail('No such sale.')

      let campaignId: number | null = null
      if (campaign_slug) {
        const campaign = await getCampaignBySlug(ctx.db, campaign_slug)
        if (!campaign) return fail(`No campaign with slug "${campaign_slug}".`)
        campaignId = campaign.id
      }

      const previous = sale.campaignId ? await getCampaign(ctx.db, sale.campaignId) : null

      await ctx.db
        .update(sales)
        .set({
          campaignId,
          // The old credit stays visible on the row. A reattribution that erases
          // what it overwrote is indistinguishable from a mistake.
          meta: {
            ...sale.meta,
            reattributed: {
              at: new Date().toISOString(),
              from: previous?.slug ?? null,
              to: campaign_slug,
              reason,
            },
          },
        })
        .where(eq(sales.id, sale_id))

      return ok({ updated: true, from: previous?.slug ?? null, to: campaign_slug })
    },
  )

  defineTool(
    server,
    ctx,
    'revenue_by_campaign',
    {
      description: 'Net revenue per campaign in one call — the leaderboard view.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rows = await ctx.db
        .select({
          campaignId: sales.campaignId,
          campaign: campaigns.name,
          slug: campaigns.slug,
          currency: sales.currency,
          status: sales.status,
          cents: sales.amountCents,
        })
        .from(sales)
        .leftJoin(campaigns, eq(campaigns.id, sales.campaignId))
        .all()

      const totals = new Map<string, { campaign: string; currency: string; cents: number; orders: number }>()
      for (const r of rows) {
        // Refunded rows stop counting rather than subtracting — same rule as
        // campaignStats, because the refund flipped the original row in place.
        if (r.status === 'refunded') continue
        const key = `${r.slug ?? '(unattributed)'}:${r.currency}`
        const entry = totals.get(key) ?? {
          campaign: r.campaign ?? '(unattributed)',
          currency: r.currency,
          cents: 0,
          orders: 0,
        }
        entry.cents += r.cents
        entry.orders++
        totals.set(key, entry)
      }

      return ok(
        [...totals.values()]
          .sort((a, b) => b.cents - a.cents)
          .map((t) => ({ ...t, total: money(t.cents, t.currency) })),
      )
    },
  )

  // ─────────────────────────────────────────── purchase mail

  defineTool(
    server,
    ctx,
    'purchase_template_list',
    {
      description:
        'The post-purchase email templates, one per offer sku. The template with slug "*" is the fallback used when a sale’s offer has none of its own.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rows = await listTemplates(ctx.db)
      return ok(
        rows.map((t) => ({
          id: t.id,
          offerSlug: t.offerSlug,
          isFallback: t.offerSlug === FALLBACK_SLUG,
          name: t.name,
          subject: t.subject,
          hasBody: Boolean(t.bodyJson) || Boolean(t.bodyMd?.trim()),
          discordInviteUrl: t.discordInviteUrl,
          isActive: t.isActive,
          updatedAt: t.updatedAt ?? t.createdAt,
        })),
      )
    },
  )

  defineTool(
    server,
    ctx,
    'purchase_template_upsert',
    {
      description:
        'Create or update the post-purchase template for one offer sku. The sku is the one on the Stripe product (metadata.sku) — "cohort", "yearly", "imposter-second" — or "*" for the fallback. Body is markdown. Placeholders: {{first_name}}, {{offer_name}}, {{account_url}}, {{downloads}}, {{discord_url}}. This only writes the template; it never sends anything.',
      inputSchema: z.object({
        offer_slug: z.string(),
        name: z.string(),
        subject: z.string(),
        body_md: z.string().optional(),
        discord_invite_url: z.string().nullable().optional(),
        is_active: z.boolean().optional(),
      }),
      annotations: { idempotentHint: true },
    },
    async (input) => {
      const existing = await getTemplateBySlug(ctx.db, input.offer_slug.trim().toLowerCase())

      if (existing) {
        await updateTemplate(ctx.db, existing.id, {
          name: input.name,
          subject: input.subject,
          // Only overwrite the body when one was supplied, so a metadata-only
          // update cannot silently blank what the operator wrote in the editor.
          ...(input.body_md === undefined ? {} : { bodyMd: input.body_md, bodyJson: null }),
          discordInviteUrl: input.discord_invite_url,
          isActive: input.is_active,
        })
        return ok({ id: existing.id, offerSlug: existing.offerSlug, created: false })
      }

      const id = await createTemplate(ctx.db, {
        offerSlug: input.offer_slug,
        name: input.name,
        subject: input.subject,
        bodyMd: input.body_md ?? null,
        discordInviteUrl: input.discord_invite_url ?? null,
        isActive: input.is_active,
      })
      if (!id) return fail('Could not create that template. Offer slug, name and subject are all required.')
      return ok({ id, offerSlug: input.offer_slug, created: true })
    },
  )

  defineTool(
    server,
    ctx,
    'purchase_mail_preview',
    {
      description:
        'What the post-purchase email for a sale would say, without sending it. Shows which template matched, what the buyer bought, the resolved merge values, and whether this sale was already thanked. Always run this before purchase_mail_send.',
      inputSchema: z.object({ sale_id: z.number().int() }),
      annotations: { readOnlyHint: true },
    },
    async ({ sale_id }) => {
      const planned = await planPurchaseMail(ctx.db, sale_id)
      if (!planned.ok) return fail(planned.reason)
      const items = await purchasedItems(ctx.db, sale_id)

      return ok({
        saleId: sale_id,
        to: planned.plan.to,
        subject: planned.plan.subject,
        template: { id: planned.plan.template.id, name: planned.plan.template.name },
        matchedSlug: planned.plan.matchedSlug,
        usedFallback: planned.plan.matchedSlug === FALLBACK_SLUG,
        bought: items,
        extras: planned.plan.extras,
        alreadySentMessageId: planned.plan.alreadySentMessageId,
      })
    },
  )

  defineTool(
    server,
    ctx,
    'purchase_mail_send',
    {
      description:
        'Send the post-purchase email for one sale. A real send to a real buyer. Idempotent per sale — refuses a second send unless resend is true. Transactional: no unsubscribe footer, no tracking, and only a hard bounce or spam complaint can stop it.',
      inputSchema: z.object({
        sale_id: z.number().int(),
        resend: z
          .boolean()
          .optional()
          .describe('Send again even though this sale was already thanked. Deliberate, never a default.'),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ sale_id, resend }) => {
      if (!sendingAllowed(ctx.env)) return fail(SEND_DISABLED)
      const result = await sendPurchaseMail(ctx.env, ctx.db, sale_id, { resend })
      if (!result.ok) return fail(result.reason)
      return ok({ messageId: result.messageId, to: result.to, status: 'queued' })
    },
  )
}
