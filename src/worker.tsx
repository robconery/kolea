import { and, asc, eq, inArray, lte, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { downloadRoutes } from './api/downloads.ts'
import { formsApi } from './api/forms.tsx'
import { mediaRoutes } from './api/media.ts'
import { api } from './api/routes.ts'
import { salesApi } from './api/sales.ts'
import { withActivitySource } from './core/activity.ts'
import { retryDelaySeconds } from './core/backoff.ts'
import { sendBroadcastNow } from './core/broadcasts.ts'
import {
  type AcceptedWrite,
  recordAccepted,
  sendMessages,
  UnrecordedSendError,
} from './core/sending.ts'
import { tickSequences } from './core/sequences.ts'
import { syncStripeCatalog } from './core/stripe-catalog.ts'
import { syncStripe } from './core/stripe.ts'
import { getDb } from './db/index.ts'
import { broadcasts, messages } from './db/schema.ts'
import { handleMcp } from './mcp/server.ts'
import type { Env, SendJob } from './types.ts'
import { admin } from './web/admin.tsx'
import { activityAdmin } from './web/admin-activity.tsx'
import { analytics } from './web/admin-analytics.tsx'
import { analyticsSequences } from './web/admin-analytics-sequences.tsx'
import { audience } from './web/admin-audience.tsx'
import { campaignsAdmin } from './web/admin-campaigns.tsx'
import { conversionsAdmin } from './web/admin-conversions.tsx'
import { purchaseMailAdmin } from './web/admin-purchase-mail.tsx'
import { goalsAdmin } from './web/admin-goals.tsx'
import { help } from './web/admin-help.tsx'
import { mail } from './web/admin-mail.tsx'
import { sequenceTemplatesAdmin } from './web/admin-sequence-templates.tsx'
import { aiAdmin } from './web/admin-ai.ts'
import { store } from './web/admin-store.tsx'
import { tagging } from './web/admin-tags.tsx'
import { siteAdmin } from './web/admin-site.tsx'
import { themesAdmin } from './web/admin-themes.tsx'
import { requireOperator } from './web/auth.ts'
import { isSiteHost, site } from './web/site.tsx'
import { prefs } from './web/prefs.tsx'
import { seed } from './web/seed.tsx'

const app = new Hono<{ Bindings: Env }>()

/**
 * Stamp every activity row with how the request got here.
 *
 * The domain doesn't know or care whether it was called by a browser, an agent
 * or a cron, and threading a `source` argument through thirty signatures to tell
 * it would put a transport concern in every one of them. So it rides in
 * `AsyncLocalStorage`, set once here at the edge and read at the leaf in
 * `core/activity.ts`.
 *
 * The path prefixes are matched longest-first and the default is `web`, so a new
 * admin route needs no change here — only a new *public* surface does.
 */
app.use('*', (c, next) => {
  const path = new URL(c.req.url).pathname
  const source =
    path.startsWith('/mcp/') ? 'mcp'
    : path.startsWith('/f/') ? 'form'
    : path.startsWith('/api/stripe') || path.startsWith('/webhooks/stripe') ? 'stripe'
    : path.startsWith('/api/') || path.startsWith('/hooks/') ? 'api'
    : 'web'
  return withActivitySource(source, next)
})

/** Must match the second entry in `triggers.crons` in wrangler.jsonc exactly. */
const DAILY_CRON = '17 9 * * *'

/**
 * The admin console's robots.txt.
 *
 * `public/robots.txt` would serve this from the assets layer, except that the
 * asset is served on every hostname — including the public site's, where a
 * blanket disallow would de-index the blog. `assets.run_worker_first` lists this
 * path so each host can answer for itself: the site allows crawling
 * (`web/site.tsx`), and the console keeps saying no.
 *
 * Above `requireOperator` on purpose — a crawler has no Access session, and the
 * whole point of the file is that it reaches one.
 */
app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'))

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
// `/d/:token` is public — a form's file, and the link arrives in somebody's
// inbox where there is no Access login. The grant token is the whole
// authorization; uploading is guarded inside. ⚠️ Production needs a Cloudflare
// Access **Bypass** policy for `/d/*`.
app.route('/', downloadRoutes)

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
// Read-only by construction — see the header note in `web/admin-analytics.tsx`.
// The sequence screens come first so `/analytics/sequences/:id` is matched by
// its own router rather than swallowed by anything broader.
app.route('/', activityAdmin)
app.route('/', analyticsSequences)
app.route('/', analytics)
app.route('/', tagging)
// The composer's writing help. JSON-only, operator-only, writes no mail.
app.route('/', aiAdmin)
app.route('/', store)
// The public site's look. Operator-only like everything below `requireOperator`;
// the site itself is a separate app, reached by hostname.
app.route('/', siteAdmin)
app.route('/', themesAdmin)
// Ahead of `mail`, which owns `/sequences/:id` and would read "templates" as an id.
app.route('/', sequenceTemplatesAdmin)
app.route('/', mail)
// Ahead of `campaignsAdmin`, which owns `/sales`, so `/sales/:id/thanks` is
// matched by the router that implements it rather than by anything broader.
app.route('/', purchaseMailAdmin)
app.route('/', campaignsAdmin)
app.route('/', conversionsAdmin)
app.route('/', goalsAdmin)
app.route('/', help)
app.route('/', seed)

export default {
  /**
   * Two apps, one Worker, split by hostname.
   *
   * `SITE_URL`'s host gets the public blog; every other host gets the admin
   * console. The split is here at the door rather than inside the router because
   * the admin app puts `requireOperator` on `*` — mounting public pages into it
   * would mean a reader's request passing through the operator gate and relying
   * on route ordering to survive. Two apps means a public request never enters
   * the guarded router at all, and a new admin route can never accidentally be
   * exposed by being registered above a line.
   *
   * With `SITE_URL` unset (the default) nothing reaches the site app.
   */
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (isSiteHost(request, env)) {
      return withActivitySource('site', () =>
        site.fetch(request, env, ctx as unknown as never),
      )
    }
    return app.fetch(request, env, ctx as unknown as never)
  },

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
        withActivitySource('stripe', async () => {
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
        }),
      )
      return
    }

    ctx.waitUntil(
      withActivitySource('cron', async () => {
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
      }),
    )
  },

  /**
   * Queue consumer. The batch goes to the provider in one request, but each
   * message is still acked or retried individually on its own result, so one bad
   * address never re-sends the other 99 in the batch (SPEC 4.1).
   */
  async queue(batch: MessageBatch<SendJob>, env: Env) {
    return await withActivitySource('queue', () => consumeBatch(batch, env))
  },
}

/** What a dead-lettered row says. Whatever the last attempt recorded follows it. */
const GAVE_UP = 'gave up after exhausting queue retries'

async function consumeBatch(batch: MessageBatch<SendJob>, env: Env) {
  const db = getDb(env)

  // One roll for the whole batch, so messages that failed together wait the
  // same time and come back as one batch rather than a hundred stragglers.
  const jitter = Math.random()

  const wait = (msg: Message<SendJob>, retryAfterSeconds?: number) =>
    msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts, { retryAfterSeconds, jitter }) })

  // ⭐ Mail the provider already took, whose row is all that is missing. These
  // jobs never send, on either queue: the row is written `sent`, and if it
  // cannot be written yet the job waits and tries again. Even dead-lettered it
  // is still a send that happened, so it is never marked failed.
  const recordJobs = batch.messages.filter((m) => m.body.accepted)
  if (recordJobs.length > 0) {
    try {
      await recordAccepted(
        db,
        recordJobs.flatMap((m) =>
          m.body.accepted ? [{ messageId: m.body.messageId, accepted: m.body.accepted }] : [],
        ),
      )
      for (const msg of recordJobs) msg.ack()
    } catch {
      for (const msg of recordJobs) wait(msg)
    }
  }

  const jobs = batch.messages.filter((m) => !m.body.accepted)
  const [firstJob, ...otherJobs] = jobs
  if (!firstJob) return

  // The dead-letter queue has no send path. Its job is to make a give-up
  // visible as a row — Workers logs are gone in a week, and a message that
  // quietly stopped existing is the worst possible failure for a mailer.
  if (batch.queue.endsWith('-dlq')) {
    const giveUp = (msg: Message<SendJob>) =>
      db
        .update(messages)
        .set({
          status: 'failed',
          // Keep what the last attempt wrote. "Gave up" alone says that it
          // failed; only the provider's or the database's own words say why.
          error: sql`${GAVE_UP} || coalesce(': ' || ${messages.error}, '')`,
        })
        .where(and(eq(messages.id, msg.body.messageId), eq(messages.status, 'queued')))
    try {
      // One round trip for the batch, all of it or none.
      await db.batch([giveUp(firstJob), ...otherJobs.map(giveUp)])
      for (const msg of jobs) msg.ack()
    } catch {
      // Nothing lies beyond this queue, so a give-up that cannot be written
      // right now waits and is tried again. Dropped, the rows would sit
      // `queued` forever and their broadcast would never finish.
      for (const msg of jobs) wait(msg)
    }
    return
  }

  const ids = jobs.map((m) => m.body.messageId)
  try {
    const outcomes = await sendMessages(env, db, ids)
    for (const msg of jobs) {
      const outcome = outcomes.get(msg.body.messageId)
      if (outcome?.status === 'failed' && outcome.retryable) wait(msg, outcome.retryAfterSeconds)
      else msg.ack()
    }
  } catch (err) {
    // If the provider took mail and only the write failed, sending again is the
    // one wrong move. The acceptance goes onto the queue to be written later,
    // and those messages are done; only what was not accepted is retried.
    const handedOver =
      err instanceof UnrecordedSendError
        ? await handOverAccepted(env, err.accepted, retryDelaySeconds(1, { jitter }))
        : new Set<number>()
    await recordAttemptError(
      db,
      ids.filter((id) => !handedOver.has(id)),
      err,
    )
    for (const msg of jobs) {
      if (handedOver.has(msg.body.messageId)) msg.ack()
      else wait(msg)
    }
  }
}

/**
 * Keep "the provider took these" on the queue, because the database would not
 * take it. Each becomes a job that only writes its row (`SendJob.accepted`).
 *
 * Returns the ids that made it. Anything that did not is retried as an
 * ordinary send, where the provider's own idempotency key is the last guard
 * against a second copy.
 */
async function handOverAccepted(
  env: Env,
  accepted: AcceptedWrite[],
  delaySeconds: number,
): Promise<Set<number>> {
  const done = new Set<number>()
  if (!env.SEND_QUEUE) return done
  try {
    // Queues takes at most 100 messages per call.
    for (let i = 0; i < accepted.length; i += 100) {
      const chunk = accepted.slice(i, i + 100)
      await env.SEND_QUEUE.sendBatch(
        chunk.map((a) => ({ body: { messageId: a.messageId, accepted: a.accepted } })),
        { delaySeconds },
      )
      for (const a of chunk) done.add(a.messageId)
    }
  } catch {
    /* the queue refused too; whatever is not in `done` goes round again */
  }
  return done
}

/**
 * Write down why a whole batch could not be worked, on the rows still waiting.
 *
 * A provider failure records itself in `sendMessages`. A thrown one (the
 * database refusing a query, a request that never got an answer) used to leave
 * no trace at all, and the dead-letter row that followed could not say what
 * went wrong. Best effort on purpose: the database may be the thing that
 * failed, and the retry matters more than the note.
 */
async function recordAttemptError(db: ReturnType<typeof getDb>, ids: number[], err: unknown) {
  // The database's own words are at the bottom: Drizzle wraps a failed query,
  // and a failed result write is wrapped once more.
  let root = err
  while (root instanceof Error && root.cause instanceof Error) root = root.cause
  const error = `send attempt threw: ${root instanceof Error ? root.message : String(root)}`.slice(0, 500)
  try {
    // D1 caps bound parameters at 100 per query.
    for (let i = 0; i < ids.length; i += 90) {
      await db
        .update(messages)
        .set({ error })
        .where(and(inArray(messages.id, ids.slice(i, i + 90)), eq(messages.status, 'queued')))
    }
  } catch {
    /* still down; the next attempt will say so again */
  }
}
