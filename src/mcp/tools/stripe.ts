import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { desc, eq } from 'drizzle-orm'
import { stripeEvents } from '../../db/schema.ts'
import {
  downloadUrlFrom,
  listStripeProducts,
  pricesForProducts,
  syncStripeCatalog,
} from '../../core/stripe-catalog.ts'
import { lastCursor, listSyncRuns, syncStripe } from '../../core/stripe.ts'
import { type Ctx, clampLimit, defineTool, fail, money, ok } from '../kit.ts'

/** Stripe deals in epoch seconds; the tools take ISO dates because models do. */
function toEpochSeconds(iso: string | undefined): number | undefined | null {
  if (!iso) return undefined
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

export function registerStripe(server: McpServer, ctx: Ctx): void {
  const configured = () =>
    ctx.env.STRIPE_SECRET_KEY
      ? null
      : fail(
          'STRIPE_SECRET_KEY is not set on this Worker.',
          'The operator needs to run `wrangler secret put STRIPE_SECRET_KEY` with a restricted read key.',
        )

  defineTool(
    server,
    ctx,
    'stripe_sync_preview',
    {
      description:
        'Dry run: read charges from Stripe and report exactly what a real sync would record, without writing anything or moving the cursor. Always run this before stripe_sync_run on a new window.',
      inputSchema: z.object({
        since: z.string().optional().describe('ISO date. Defaults to the last run’s cursor, else 30 days back.'),
        until: z.string().optional().describe('ISO date, exclusive. Defaults to now.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ since, until }) => {
      const gate = configured()
      if (gate) return gate

      const from = toEpochSeconds(since)
      const to = toEpochSeconds(until)
      if (from === null || to === null) return fail('since/until must be parseable ISO dates.')

      const summary = await syncStripe(ctx.env, ctx.db, {
        ...(from !== undefined ? { since: from } : {}),
        ...(to !== undefined ? { until: to } : {}),
        dryRun: true,
        trigger: 'preview',
      })

      return ok({
        ...summary,
        window: {
          from: new Date(summary.from * 1000).toISOString(),
          to: new Date(summary.to * 1000).toISOString(),
        },
        wouldRecord: summary.wouldRecord?.map((r) => ({
          ...r,
          amount: money(r.amount, r.currency),
        })),
      })
    },
  )

  defineTool(
    server,
    ctx,
    'stripe_sync_run',
    {
      description:
        'Pull charges from Stripe and record them as sales, crediting each to the buyer’s last attribution touch (or to metadata.campaign when the charge carries one). Idempotent on the Stripe charge id — a repeated run records nothing twice. Advances the cursor, so the next run picks up where this one stopped.',
      inputSchema: z.object({
        since: z.string().optional().describe('ISO date. Defaults to the last run’s cursor.'),
        until: z.string().optional().describe('ISO date, exclusive. Defaults to now.'),
      }),
    },
    async ({ since, until }) => {
      const gate = configured()
      if (gate) return gate

      const from = toEpochSeconds(since)
      const to = toEpochSeconds(until)
      if (from === null || to === null) return fail('since/until must be parseable ISO dates.')

      const summary = await syncStripe(ctx.env, ctx.db, {
        ...(from !== undefined ? { since: from } : {}),
        ...(to !== undefined ? { until: to } : {}),
        trigger: 'mcp',
      })

      return ok({
        ...summary,
        next: summary.unattributed
          ? 'Some sales landed with no campaign — sales_unattributed lists them with the buyer’s touch history.'
          : undefined,
      })
    },
  )

  defineTool(
    server,
    ctx,
    'stripe_backfill',
    {
      description:
        'Sync a specific historical window regardless of the cursor. Use for first-time imports or to re-check a period. Still idempotent, so overlapping an earlier run is harmless.',
      inputSchema: z.object({
        since: z.string().describe('ISO date'),
        until: z.string().describe('ISO date, exclusive'),
      }),
    },
    async ({ since, until }) => {
      const gate = configured()
      if (gate) return gate

      const from = toEpochSeconds(since)
      const to = toEpochSeconds(until)
      if (from === null || to === null || from === undefined || to === undefined) {
        return fail('since and until must both be parseable ISO dates.')
      }
      if (from >= to) return fail('since must be before until.')

      return ok(await syncStripe(ctx.env, ctx.db, { since: from, until: to, trigger: 'mcp' }))
    },
  )

  defineTool(
    server,
    ctx,
    'stripe_catalog_sync',
    {
      description:
        'Pull the Stripe product catalog (products and their prices) into the local mirror. Upsert only — an archived product is marked inactive, never removed, because people who bought it still own it. Run this after editing products in Stripe if you do not want to wait for the nightly sync.',
      inputSchema: z.object({}),
    },
    async () => {
      const gate = configured()
      if (gate) return gate
      return ok(await syncStripeCatalog(ctx.env, ctx.db, { trigger: 'mcp' }))
    },
  )

  defineTool(
    server,
    ctx,
    'stripe_catalog_list',
    {
      description:
        'The locally mirrored Stripe catalog: products, their active prices, and the download location found in each product’s Stripe metadata. Use this to check that a product carries a usable download link before writing a thank-you mail around it.',
      inputSchema: z.object({
        active_only: z.boolean().optional().describe('Hide archived products. Defaults to false.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ active_only }) => {
      const products = await listStripeProducts(ctx.db, active_only ?? false)
      const prices = await pricesForProducts(
        ctx.db,
        products.map((p) => p.id),
      )

      return ok({
        products: products.map((p) => ({
          id: p.id,
          name: p.name,
          active: p.active,
          downloadUrl: downloadUrlFrom(p.metadata),
          metadataKeys: Object.keys(p.metadata),
          prices: prices
            .filter((pr) => pr.productId === p.id)
            .map((pr) => ({
              id: pr.id,
              amount: pr.unitAmount === null ? null : money(pr.unitAmount, pr.currency),
              interval: pr.interval,
            })),
        })),
        withoutDownload: products.filter((p) => !downloadUrlFrom(p.metadata)).map((p) => p.id),
      })
    },
  )

  defineTool(
    server,
    ctx,
    'stripe_events_list',
    {
      description:
        'Recent Stripe webhooks and what was done with each one. This is where to look when a sale did not appear: `failed` means the handler threw and Stripe will retry, `ignored` means we deliberately did nothing, `processed` means it landed.',
      inputSchema: z.object({
        limit: z.number().int().optional(),
        status: z
          .enum(['received', 'processed', 'ignored', 'failed'])
          .optional()
          .describe('Filter to one outcome. Omit for everything.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit, status }) => {
      const rows = await ctx.db
        .select()
        .from(stripeEvents)
        .where(status ? eq(stripeEvents.status, status) : undefined)
        .orderBy(desc(stripeEvents.receivedAt))
        .limit(clampLimit(limit, 25, 100))
        .all()

      return ok({
        configured: Boolean(ctx.env.STRIPE_WEBHOOK_SECRET),
        events: rows,
      })
    },
  )

  defineTool(
    server,
    ctx,
    'sync_runs_list',
    {
      description:
        'History of Stripe sync runs — both the charge reconcile (kind "stripe") and the catalog pull (kind "stripe_catalog") — with counts and any notes. Check here to confirm the nightly jobs are actually running and what they did.',
      inputSchema: z.object({ limit: z.number().int().optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const runs = await listSyncRuns(ctx.db, clampLimit(limit, 20, 100))
      const cursor = await lastCursor(ctx.db)
      return ok({
        cursor: cursor ? new Date(cursor * 1000).toISOString() : null,
        runs,
      })
    },
  )
}
