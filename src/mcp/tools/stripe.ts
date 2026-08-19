import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
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
    'sync_runs_list',
    {
      description:
        'History of Stripe sync runs with counts and any notes. Check here to confirm the nightly job is actually running and what it did.',
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
