import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { AGENT_SENSITIVE_OFF, agentSensitiveAllowed } from '../../core/agents.ts'
import {
  WEBHOOK_EVENTS,
  type WebhookEndpointView,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getWebhookEndpoint,
  listWebhookDeliveries,
  listWebhookEndpoints,
  updateWebhookEndpoint,
} from '../../core/webhooks.ts'
import type { WebhookDelivery } from '../../db/schema.ts'
import { type Ctx, clampLimit, defineTool, fail, ok } from '../kit.ts'

/**
 * Outbound webhooks. The writes are sensitive — they decide where subscriber
 * data is POSTed — so they refuse unless `agentSensitiveAllowed(db)` (the
 * on-screen switch) says yes, on top of the admin-key gate every MCP call
 * already passed.
 */

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null)

function view(e: WebhookEndpointView) {
  return {
    id: e.id,
    url: e.url,
    description: e.description,
    events: e.events,
    active: e.isActive,
    disabled_reason: e.disabledReason,
    secret_prefix: e.secretPrefix,
    consecutive_failures: e.consecutiveFailures,
    pending: e.pending,
    failed: e.failed,
    last_delivered_at: iso(e.lastDeliveredAt),
    created_at: iso(e.createdAt),
  }
}

function delivery(d: WebhookDelivery) {
  return {
    id: d.id,
    event_id: d.eventId,
    type: d.event,
    status: d.status,
    attempts: d.attempts,
    last_status_code: d.lastStatusCode,
    last_error: d.lastError,
    last_attempt_at: iso(d.lastAttemptAt),
    next_attempt_at: iso(d.nextAttemptAt),
    delivered_at: iso(d.deliveredAt),
    created_at: iso(d.createdAt),
  }
}

const events = z
  .array(z.enum(WEBHOOK_EVENTS))
  .min(1)
  .describe(`Any of: ${WEBHOOK_EVENTS.join(', ')}.`)

export function registerWebhooks(server: McpServer, ctx: Ctx): void {
  defineTool(
    server,
    ctx,
    'webhook_list',
    {
      description:
        'The webhook endpoints: URL, events, on or off (with why, if off), deliveries waiting and failed, and the last success. Check here when a downstream system says it stopped hearing from Kōlea.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => ok((await listWebhookEndpoints(ctx.db)).map(view)),
  )

  defineTool(
    server,
    ctx,
    'webhook_create',
    {
      description: `Adds an https endpoint on a public host for some of: ${WEBHOOK_EVENTS.join(', ')}. Every matching event is POSTed to it, signed (Kolea-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">), and retried with backoff. Returns the signing secret ONCE — hand it to the operator; it cannot be read back. Sensitive: refused unless the operator has turned on sensitive agent changes.`,
      inputSchema: z.object({
        url: z.string().describe('https://… on a public host, port 443 or 8443'),
        events,
        description: z.string().max(200).optional(),
      }),
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ url, events, description }) => {
      if (!(await agentSensitiveAllowed(ctx.db))) return fail(AGENT_SENSITIVE_OFF)
      const result = await createWebhookEndpoint(ctx.db, { url, events, description })
      if (!result.ok) return fail(result.reason, 'Fix the input and call webhook_create again.')
      return ok({ ...view(result.endpoint), secret: result.secret })
    },
  )

  defineTool(
    server,
    ctx,
    'webhook_update',
    {
      description:
        "Changes an endpoint's URL, events, description, or switches it on or off. A new URL is checked again. Switching on clears the failure count. Sensitive: refused unless the operator has turned on sensitive agent changes.",
      inputSchema: z.object({
        id: z.number().int(),
        url: z.string().optional(),
        events: events.optional(),
        description: z.string().max(200).optional(),
        active: z.boolean().optional(),
      }),
      annotations: { idempotentHint: true },
    },
    async ({ id, ...patch }) => {
      if (!(await agentSensitiveAllowed(ctx.db))) return fail(AGENT_SENSITIVE_OFF)
      const result = await updateWebhookEndpoint(ctx.db, id, patch)
      if (!result.ok) return fail(result.reason, 'webhook_list shows the endpoints and their ids.')
      return ok(view(result.endpoint))
    },
  )

  defineTool(
    server,
    ctx,
    'webhook_delete',
    {
      description:
        'Deletes an endpoint and its whole delivery log. Cannot be undone; to pause one, use webhook_update with active: false instead. Echo the URL in confirm_url. Sensitive: refused unless the operator has turned on sensitive agent changes.',
      inputSchema: z.object({
        id: z.number().int(),
        confirm_url: z.string().describe("The endpoint's URL exactly, as webhook_list shows it"),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ id, confirm_url }) => {
      if (!(await agentSensitiveAllowed(ctx.db))) return fail(AGENT_SENSITIVE_OFF)
      const endpoint = await getWebhookEndpoint(ctx.db, id)
      if (!endpoint) return fail(`no webhook endpoint #${id}`, 'webhook_list shows the endpoints and their ids.')
      if (confirm_url !== endpoint.url) return fail(`confirm_url must be exactly "${endpoint.url}".`)
      await deleteWebhookEndpoint(ctx.db, id)
      return ok({ id, deleted: true })
    },
  )

  defineTool(
    server,
    ctx,
    'webhook_deliveries',
    {
      description:
        "An endpoint's recent deliveries, newest first: event, status (pending, delivered, failed), tries, the last status code or error, and when the next try is. A failed delivery can be resent from the admin's Webhooks screen.",
      inputSchema: z.object({
        id: z.number().int().describe('The endpoint id'),
        status: z.enum(['pending', 'delivered', 'failed']).optional(),
        limit: z.number().int().optional().describe('Default 50, max 200'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ id, status, limit }) => {
      if (!(await getWebhookEndpoint(ctx.db, id))) {
        return fail(`no webhook endpoint #${id}`, 'webhook_list shows the endpoints and their ids.')
      }
      const rows = await listWebhookDeliveries(ctx.db, { endpointId: id, status, limit: clampLimit(limit, 50, 200) })
      return ok(rows.map(delivery))
    },
  )
}
