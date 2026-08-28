import type { McpServer } from '@modelcontextprotocol/server'
import { and, count, desc, eq, gte, lt } from 'drizzle-orm'
import * as z from 'zod/v4'
import { createApiKey, listApiKeys, revokeApiKey } from '../../core/api-keys.ts'
import { revenueTotals } from '../../core/sales.ts'
import {
  broadcasts,
  campaigns,
  events,
  mcpCalls,
  messages,
  sequences,
  subscribers,
} from '../../db/schema.ts'
import { type Ctx, clampLimit, defineTool, fail, failed, money, ok } from '../kit.ts'
import { sendingAllowed } from '../preflight.ts'
import { MAX_ROWS, checkQuery } from '../sql.ts'

const DAY_MS = 24 * 60 * 60 * 1000

export function registerOps(server: McpServer, ctx: Ctx): void {
  defineTool(
    server,
    ctx,
    'stats_overview',
    {
      description:
        'The whole mailer at a glance: list size by status, sends and engagement over a window, revenue, live sequences and campaigns. Start here.',
      inputSchema: z.object({
        days: z.number().int().min(1).max(365).optional().describe('Window for send stats, default 30'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ days }) => {
      const window = days ?? 30
      const since = new Date(Date.now() - window * DAY_MS)

      const [byStatus, sends, engagement, liveSequences, activeCampaigns, totals] =
        await Promise.all([
          ctx.db
            .select({ status: subscribers.status, n: count() })
            .from(subscribers)
            .groupBy(subscribers.status)
            .all(),
          ctx.db
            .select({ status: messages.status, n: count() })
            .from(messages)
            .where(gte(messages.createdAt, since))
            .groupBy(messages.status)
            .all(),
          ctx.db
            .select({ type: events.type, n: count() })
            .from(events)
            .where(gte(events.occurredAt, since))
            .groupBy(events.type)
            .all(),
          ctx.db
            .select({ n: count() })
            .from(sequences)
            .where(eq(sequences.isActive, true))
            .get(),
          ctx.db
            .select({ n: count() })
            .from(campaigns)
            .where(eq(campaigns.status, 'active'))
            .get(),
          revenueTotals(ctx.db, since.getTime()),
        ])

      const sent = sends.find((s) => s.status === 'sent')?.n ?? 0
      const opens = engagement.find((e) => e.type === 'open')?.n ?? 0
      const clicks = engagement.find((e) => e.type === 'click')?.n ?? 0
      const pct = (n: number) => (sent ? `${Math.round((n / sent) * 100)}%` : 'n/a')

      return ok({
        windowDays: window,
        audience: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
        messages: Object.fromEntries(sends.map((r) => [r.status, r.n])),
        engagement: {
          ...Object.fromEntries(engagement.map((r) => [r.type, r.n])),
          // Rates against `sent`, not against delivered — the mailer only knows
          // it handed the message over, and pretending otherwise inflates them.
          openRate: pct(opens),
          clickRate: pct(clicks),
        },
        revenue: totals.map((t) => ({ ...t, total: money(t.cents, t.currency) })),
        liveSequences: liveSequences?.n ?? 0,
        activeCampaigns: activeCampaigns?.n ?? 0,
        draftBroadcasts:
          (
            await ctx.db
              .select({ n: count() })
              .from(broadcasts)
              .where(eq(broadcasts.status, 'draft'))
              .get()
          )?.n ?? 0,
      })
    },
  )

  defineTool(
    server,
    ctx,
    'db_query',
    {
      description:
        `Run a read-only SQL query against the mailer's SQLite (Cloudflare D1) database. SELECT and WITH only; one statement; capped at ${MAX_ROWS} rows. Read the kolea://schema resource first for table and column names. Use this for any analytics question the other tools do not answer directly.`,
      inputSchema: z.object({
        sql: z.string().min(1),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ sql }) => {
      const check = checkQuery(sql)
      if (!check.ok) {
        return fail(
          check.reason,
          'db_query reads only. To change data, use the matching tool — they enforce the consent and attribution rules that raw SQL would skip.',
        )
      }

      const result = await ctx.env.DB.prepare(check.sql).all()
      return ok({
        rows: result.results,
        rowCount: result.results.length,
        truncated: result.results.length >= MAX_ROWS,
        ran: check.sql,
      })
    },
  )

  defineTool(
    server,
    ctx,
    'health',
    {
      description:
        'Deployment state: which email provider is live, whether MCP sending is enabled, which bindings exist, and queue backlog. Check this when something is not sending.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const queued =
        (
          await ctx.db
            .select({ n: count() })
            .from(messages)
            .where(eq(messages.status, 'queued'))
            .get()
        )?.n ?? 0

      // Anything still queued an hour later is not waiting, it is stuck — the
      // queue retries for minutes, not hours.
      const stuck =
        (
          await ctx.db
            .select({ n: count() })
            .from(messages)
            .where(
              and(
                eq(messages.status, 'queued'),
                lt(messages.createdAt, new Date(Date.now() - 60 * 60 * 1000)),
              ),
            )
            .get()
        )?.n ?? 0

      return ok({
        provider: ctx.env.EMAIL_PROVIDER,
        from: `${ctx.env.FROM_NAME} <${ctx.env.FROM_EMAIL}>`,
        publicUrl: ctx.env.PUBLIC_URL,
        mcpSendingEnabled: sendingAllowed(ctx.env),
        bindings: {
          queue: Boolean(ctx.env.SEND_QUEUE),
          media: Boolean(ctx.env.MEDIA),
          downloads: Boolean(ctx.env.DOWNLOADS),
          stripe: Boolean(ctx.env.STRIPE_SECRET_KEY),
          resend: Boolean(ctx.env.RESEND_API_KEY),
        },
        queuedMessages: queued,
        stuckOverAnHour: stuck,
        note:
          queued > 0 && !ctx.env.SEND_QUEUE
            ? 'No queue binding — sends run inline. Fine locally, slow in production.'
            : stuck > 0
              ? `${stuck} message(s) have been queued for over an hour — check the provider and the queue consumer.`
              : undefined,
      })
    },
  )

  defineTool(
    server,
    ctx,
    'mcp_audit_list',
    {
      description:
        'The MCP tool-call log. Every call an agent made, including refusals, with arguments and duration. This is the record of what automation did to the mailer.',
      inputSchema: z.object({
        tool: z.string().optional().describe('Filter to one tool name'),
        outcome: z.enum(['ok', 'error', 'denied']).optional(),
        limit: z.number().int().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ tool, outcome, limit }) => {
      const filters = []
      if (tool) filters.push(eq(mcpCalls.tool, tool))
      if (outcome) filters.push(eq(mcpCalls.outcome, outcome))

      return ok(
        await ctx.db
          .select()
          .from(mcpCalls)
          .where(filters.length ? and(...filters) : undefined)
          .orderBy(desc(mcpCalls.createdAt))
          .limit(clampLimit(limit))
          .all(),
      )
    },
  )

  defineTool(
    server,
    ctx,
    'apikey_list',
    {
      description: 'API keys with their scope and last use. Never returns the tokens themselves.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => ok(await listApiKeys(ctx.db)),
  )

  defineTool(
    server,
    ctx,
    'apikey_create',
    {
      description:
        "Mint an API key. The token is shown exactly once and never stored — only its hash is. Scope 'send' reaches the transactional endpoint only; 'admin' also reaches this MCP server, so it can do everything you can.",
      inputSchema: z.object({
        name: z.string().min(1),
        scope: z.enum(['send', 'admin']).optional().describe("Defaults to 'send'"),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ name, scope }) => {
      const { id, token } = await createApiKey(ctx.db, name, scope ?? 'send')
      return ok({
        id,
        scope: scope ?? 'send',
        token,
        warning: 'This token is shown once. It cannot be recovered — only revoked.',
      })
    },
  )

  defineTool(
    server,
    ctx,
    'apikey_revoke',
    {
      description:
        'Revoke a key. The row survives so the audit log still resolves; the key stops working immediately. Revoking the key this session is using will end the session.',
      inputSchema: z.object({ id: z.number().int() }),
      annotations: { destructiveHint: true },
    },
    async ({ id }) => {
      const result = await revokeApiKey(ctx.db, id)
      if (!result.ok) return failed(result)
      return ok({
        revoked: true,
        warning: id === ctx.apiKeyId ? 'That was the key this session is using.' : undefined,
      })
    },
  )
}
