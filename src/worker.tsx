import { and, asc, eq, lte, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { formsApi } from './api/forms.tsx'
import { mediaRoutes } from './api/media.ts'
import { api } from './api/routes.ts'
import { salesApi } from './api/sales.ts'
import { sendBroadcastNow } from './core/broadcasts.ts'
import { sendMessages } from './core/sending.ts'
import { tickSequences } from './core/sequences.ts'
import { syncStripeCatalog } from './core/stripe-catalog.ts'
import { syncStripe } from './core/stripe.ts'
import { getDb } from './db/index.ts'
import { broadcasts, messages } from './db/schema.ts'
import { handleMcp } from './mcp/server.ts'
import type { Env, SendJob } from './types.ts'
import { admin } from './web/admin.tsx'
import { audience } from './web/admin-audience.tsx'
import { campaignsAdmin } from './web/admin-campaigns.tsx'
import { help } from './web/admin-help.tsx'
import { mail } from './web/admin-mail.tsx'
import { store } from './web/admin-store.tsx'
import { tagging } from './web/admin-tags.tsx'
import { requireOperator } from './web/auth.ts'
import { prefs } from './web/prefs.tsx'
import { seed } from './web/seed.tsx'

const app = new Hono<{ Bindings: Env }>()

/** Must match the second entry in `triggers.crons` in wrangler.jsonc exactly. */
const DAILY_CRON = '17 9 * * *'

// Public: preference center, tracking, webhooks, transactional API, signup.
// Everything else is operator-only (SPEC 8.2).
app.route('/', prefs)
app.route('/', api)
// Signup forms: posted to from other people's websites, so public by definition.
app.route('/', formsApi)
// Bearer-authenticated inside — your checkout posts here, not a browser.
app.route('/', salesApi)
// Serving media is public (the URLs go into email); uploading is guarded inside.
app.route('/', mediaRoutes)

// MCP carries its own credential (path secret + admin-scoped bearer key), so it
// sits ahead of the Cloudflare Access gate — an agent has no browser to do an
// Access login in. See `mcp/server.ts` for the three checks it does instead.
app.all('/mcp/:secret', (c) =>
  // Hono types `executionCtx` from its own ambient Workers types, which differ
  // by a field from @cloudflare/workers-types. Same object at runtime.
  handleMcp(c.req.raw, c.env, c.executionCtx as unknown as ExecutionContext, c.req.param('secret')),
)

app.use('*', requireOperator)
app.route('/', admin)
app.route('/', audience)
app.route('/', tagging)
app.route('/', store)
app.route('/', mail)
app.route('/', campaignsAdmin)
app.route('/', help)
app.route('/', seed)

export default {
  fetch: app.fetch,

  /**
   * Two schedules on one handler.
   *
   * The minutely tick advances sequences and pushes scheduled broadcasts along;
   * the daily one reconciles Stripe. Everything here is resumable and idempotent,
   * so a missed or doubled tick is harmless.
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (controller.cron === DAILY_CRON) {
      ctx.waitUntil(
        (async () => {
          if (!env.STRIPE_SECRET_KEY) return
          const db = getDb(env)

          // A thrown sync must not take the invocation down — both of these
          // already recorded the failure as a `sync_runs` row, which is where
          // anyone would look for it. Independently caught, so a catalog outage
          // cannot stop the reconcile that books money.
          try {
            await syncStripe(env, db, { trigger: 'cron' })
          } catch {
            /* recorded in sync_runs */
          }

          // The catalog is small and changes rarely, but a thank-you mail cannot
          // find a download link for a product the mirror has never seen. The
          // `product.*` webhooks keep it current in between.
          try {
            await syncStripeCatalog(env, db, { trigger: 'cron' })
          } catch {
            /* recorded in sync_runs */
          }
        })(),
      )
      return
    }

    ctx.waitUntil(
      (async () => {
        const db = getDb(env)
        await tickSequences(env, db)

        // One broadcast per tick, several pages deep. Taking five at a time and
        // one page each meant the D1 query budget bought 400 recipients a minute;
        // spending it all on the oldest live send clears ~8,000 instead. There is
        // one operator, so broadcasts queue up behind each other anyway.
        const due = await db
          .select({ id: broadcasts.id })
          .from(broadcasts)
          .where(
            or(
              eq(broadcasts.status, 'sending'),
              and(eq(broadcasts.status, 'scheduled'), lte(broadcasts.scheduledAt, new Date())),
            ),
          )
          .orderBy(asc(broadcasts.scheduledAt))
          .limit(1)
          .all()

        for (const b of due) await sendBroadcastNow(env, db, b.id)
      })(),
    )
  },

  /**
   * Queue consumer. The batch goes to the provider in one request, but each
   * message is still acked or retried individually on its own result, so one bad
   * address never re-sends the other 99 in the batch (SPEC 4.1).
   */
  async queue(batch: MessageBatch<SendJob>, env: Env) {
    const db = getDb(env)

    // The dead-letter queue has no send path. Its job is to make a give-up
    // visible as a row — Workers logs are gone in a week, and a message that
    // quietly stopped existing is the worst possible failure for a mailer.
    if (batch.queue.endsWith('-dlq')) {
      for (const msg of batch.messages) {
        await db
          .update(messages)
          .set({ status: 'failed', error: 'gave up after exhausting queue retries' })
          .where(and(eq(messages.id, msg.body.messageId), eq(messages.status, 'queued')))
        msg.ack()
      }
      return
    }

    try {
      const outcomes = await sendMessages(
        env,
        db,
        batch.messages.map((m) => m.body.messageId),
      )
      for (const msg of batch.messages) {
        const outcome = outcomes.get(msg.body.messageId)
        if (outcome?.status === 'failed' && outcome.retryable) msg.retry()
        else msg.ack()
      }
    } catch {
      batch.retryAll()
    }
  },
}
