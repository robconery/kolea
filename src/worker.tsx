import { and, asc, eq, inArray, lte, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { downloadRoutes } from './api/downloads.ts'
import { formsApi } from './api/forms.tsx'
import { mediaRoutes } from './api/media.ts'
import { oauthApi } from './api/oauth.ts'
import { api } from './api/routes.ts'
import { apiV1 } from './api/v1/index.ts'
import { tracking } from './api/tracking.ts'
import { salesApi } from './api/sales.ts'
import { withActivitySource } from './core/activity.ts'
import { advanceTakes } from './core/ai/takes.ts'
import { retryDelaySeconds } from './core/backoff.ts'
import { CRON_PAGES, QUERIES_PER_PAGE, sendBroadcastNow } from './core/broadcasts.ts'
import { checkDueDomains } from './core/domains.ts'
import { advanceImports } from './core/importers/runs.ts'
import {
  type AcceptedWrite,
  recordAccepted,
  sendMessages,
  UnrecordedSendError,
} from './core/sending.ts'
import { recordTickFailure, tickSequences } from './core/sequences.ts'
import { isTrackingHost } from './core/tracking-host.ts'
import { syncStripeCatalog } from './core/stripe-catalog.ts'
import { syncStripe } from './core/stripe.ts'
import { DELIVERY_PAGE, DELIVERY_PASS_OVERHEAD, QUERIES_PER_DELIVERY, deliverDueWebhooks } from './core/webhooks.ts'
import { QueryBudget } from './core/query-budget.ts'
import { OUTCOME_UNKNOWN } from './providers/types.ts'
import { getDb } from './db/index.ts'
import { broadcasts, messages } from './db/schema.ts'
import { handleMcp, handleOAuthMcp } from './mcp/server.ts'
import type { Env, SendJob } from './types.ts'
import { admin } from './web/admin.tsx'
import { activityAdmin } from './web/admin-activity.tsx'
import { logsAdmin } from './web/admin-logs.tsx'
import { analytics } from './web/admin-analytics.tsx'
import { connectAdmin } from './web/admin-connect.tsx'
import { analyticsSequences } from './web/admin-analytics-sequences.tsx'
import { audience } from './web/admin-audience.tsx'
import { cleanupAdmin } from './web/admin-cleanup.tsx'
import { campaignsAdmin } from './web/admin-campaigns.tsx'
import { launchesAdmin } from './web/admin-launches.tsx'
import { domainsAdmin } from './web/admin-domains.tsx'
import { onboardingAdmin } from './web/admin-onboarding.tsx'
import { conversionsAdmin } from './web/admin-conversions.tsx'
import { fieldsAdmin } from './web/admin-fields.tsx'
import { membersAdmin } from './web/admin-members.tsx'
import { purchaseMailAdmin } from './web/admin-purchase-mail.tsx'
import { transactionalAdmin } from './web/admin-transactional.tsx'
import { saleImportAdmin } from './web/admin-sale-import.tsx'
import { testimonialsAdmin } from './web/admin-testimonials.tsx'
import { testimonialForm } from './web/testimonial-form.tsx'
import { goalsAdmin } from './web/admin-goals.tsx'
import { help } from './web/admin-help.tsx'
import { importsAdmin } from './web/admin-imports.tsx'
import { mail } from './web/admin-mail.tsx'
import { mediaAdmin } from './web/admin-media.tsx'
import { sequenceTemplatesAdmin } from './web/admin-sequence-templates.tsx'
import { aiAdmin } from './web/admin-ai.ts'
import { aiSettingsAdmin } from './web/admin-ai-settings.tsx'
import { councilAdmin } from './web/admin-council.tsx'
import { ghostwriterAdmin } from './web/admin-ghostwriter.tsx'
import { agentsAdmin } from './web/admin-agents.tsx'
import { store } from './web/admin-store.tsx'
import { tagging } from './web/admin-tags.tsx'
import { siteAdmin } from './web/admin-site.tsx'
import { themesAdmin } from './web/admin-themes.tsx'
import { undeliveredAdmin } from './web/admin-undelivered.tsx'
import { webhooksAdmin } from './web/admin-webhooks.tsx'
import { auditWrites } from './web/audit.ts'
import { topicsAdmin } from './web/admin-topics.tsx'
import { requireOperator } from './web/auth.ts'
import { requireRole } from './web/roles.ts'
import { sameOriginWrites } from './web/same-origin.ts'
import { teamAdmin } from './web/admin-team.tsx'
import { isSiteHost, site } from './web/site.tsx'
import { prefs } from './web/prefs.tsx'
import { seed } from './web/seed.tsx'

const app = new Hono<{ Bindings: Env }>()

/**
 * The whole of what a tracking host (`TRACKING_HOST`) serves: the pixel and the
 * click redirect, and a 404 for every other path. Its own app, not a branch of
 * the console's, for the same reason the public site is: the console puts
 * `requireOperator` on `*`, and a host with no Access in front of it must never
 * enter that router at all.
 */
const trackingHost = new Hono<{ Bindings: Env }>()
trackingHost.route('/', tracking)
trackingHost.notFound((c) => c.text('Not found', 404))

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
    path === '/mcp' || path.startsWith('/mcp/') ? 'mcp'
    : path.startsWith('/f/') ? 'form'
    : path.startsWith('/api/stripe') || path.startsWith('/webhooks/stripe') ? 'stripe'
    : path.startsWith('/api/') || path.startsWith('/hooks/') ? 'api'
    : 'web'
  return withActivitySource(source, next)
})

/** Must match the second entry in `triggers.crons` in wrangler.jsonc exactly. */
const DAILY_CRON = '17 9 * * *'
/** A rough upper bound on one import page's D1 queries, for the cron's budget. */
const IMPORT_PAGE_QUERIES = 300

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
// The audit trail for key-authenticated writes: which key, what, and whether
// it was refused. Ahead of the routers so it wraps them (`web/audit.ts`).
app.use('/api/send', auditWrites('key'))
app.use('/api/sales', auditWrites('key'))
// The REST API: every write a key makes, refusals included. GETs pass through.
app.use('/api/v1/*', auditWrites('key'))

app.route('/', prefs)
app.route('/', testimonialForm)
// The pixel and tracked links. Always answered here, on `PUBLIC_URL`'s host, even
// once `TRACKING_HOST` moves new mail elsewhere: every link sent before that
// still names this host, and always will.
app.route('/', tracking)
// The REST API (`/api/v1`). Ahead of `requireOperator`: the bearer key is the
// credential, and `/api/*` already has an Access Bypass. Before `api` so its
// own 404 answers any `/api/v1` path it does not have.
app.route('/', apiV1)
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

// MCP by URL with OAuth (see `core/oauth.ts`): discovery, client registration,
// the token and revocation endpoints, and `/mcp` itself, authenticated by an
// access token. All public — the callers are MCP clients, not browsers with an
// Access session. ⚠️ Each path needs an Access **Bypass**: `/mcp`,
// `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`,
// `/oauth/register`, `/oauth/token`, `/oauth/revoke`. Never `/oauth/authorize` —
// that is the operator's consent page, mounted below the gate in `connectAdmin`.
app.route('/', oauthApi)
app.all('/mcp', (c) =>
  handleOAuthMcp(c.req.raw, c.env, c.executionCtx as unknown as ExecutionContext),
)

// Who: the Access JWT, verified, and the person's row on the team
// (`core/team.ts`). Somebody Access let in who is not on the team stops here.
app.use('*', requireOperator)
// Cross-site form posts are refused before anything else sees them.
app.use('*', sameOriginWrites)
// Every console write, refusals included, attributed to the Access identity
// `requireOperator` just verified, with their role. After the gate on purpose:
// a request Access turned away never reached the app, and recording those would
// let anyone on the internet fill this table. Before `requireRole`, so a write
// refused for the role is in the trail too.
app.use('*', auditWrites('operator'))
// What: the route table in `web/roles.ts`. Every router below is behind it;
// anything it does not list needs an admin.
app.use('*', requireRole)
// The OAuth consent page and Connected apps. Behind the gate on purpose: the
// operator approving here is the authentication for everything above. Admin
// and up (an agent gets the console's powers).
app.route('/', connectAdmin)
app.route('/', teamAdmin)
app.route('/', admin)
// Before `audience`, whose `/subscribers/:id` would claim `/subscribers/clean-up`.
app.route('/', cleanupAdmin)
app.route('/', audience)
// Ahead of nothing in particular: `/imports` is its own prefix.
app.route('/', importsAdmin)
// Read-only by construction — see the header note in `web/admin-analytics.tsx`.
// The sequence screens come first so `/analytics/sequences/:id` is matched by
// its own router rather than swallowed by anything broader.
app.route('/', activityAdmin)
// Read-only like Activity: the event log, over the tables the facts live in.
app.route('/', logsAdmin)
app.route('/', analyticsSequences)
app.route('/', analytics)
app.route('/', tagging)
app.route('/', fieldsAdmin)
// The composer's writing help. JSON-only, operator-only, writes no mail.
app.route('/', aiAdmin)
app.route('/', aiSettingsAdmin)
// The reader council's review desk. Advisory: reads drafts, never changes or sends them.
app.route('/', councilAdmin)
app.route('/', ghostwriterAdmin)
app.route('/', store)
// The public site's look. Operator-only like everything below `requireOperator`;
// the site itself is a separate app, reached by hostname.
app.route('/', siteAdmin)
app.route('/', themesAdmin)
// Sending domains: operator config, nothing public.
app.route('/', domainsAdmin)
// First-run checklist. Links out to the screens above; sends nothing.
app.route('/', onboardingAdmin)
app.route('/', mediaAdmin)
app.route('/', topicsAdmin)
// Ahead of `mail`, which owns `/sequences/:id` and would read "templates" as an id.
app.route('/', sequenceTemplatesAdmin)
app.route('/', mail)
app.route('/', undeliveredAdmin)
// Ahead of `campaignsAdmin`, which owns `/sales`, so `/sales/:id/thanks` is
// matched by the router that implements it rather than by anything broader.
app.route('/', purchaseMailAdmin)
app.route('/', transactionalAdmin)
app.route('/', saleImportAdmin)
app.route('/', testimonialsAdmin)
app.route('/', campaignsAdmin)
// Launch Studio: seven screens that build a campaign and a paused sequence and
// hand off to the screens above for anything that sends.
app.route('/', launchesAdmin)
app.route('/', conversionsAdmin)
app.route('/', membersAdmin)
app.route('/', goalsAdmin)
// API keys and the agent switches. `/settings/agents`, beside `admin`'s `/settings`.
app.route('/', agentsAdmin)
// Outbound webhooks: endpoints, the delivery log, redeliver.
app.route('/', webhooksAdmin)
app.route('/', help)
app.route('/', seed)

export default {
  /**
   * Three apps, one Worker, split by hostname.
   *
   * `TRACKING_HOST`'s host gets only the tracking routes; `SITE_URL`'s host gets
   * the public blog; every other host gets the admin console. The split is here
   * at the door rather than inside the router because the admin app puts `requireOperator` on `*` — mounting public pages into it
   * would mean a reader's request passing through the operator gate and relying
   * on route ordering to survive. Two apps means a public request never enters
   * the guarded router at all, and a new admin route can never accidentally be
   * exposed by being registered above a line.
   *
   * With `SITE_URL` unset (the default) nothing reaches the site app.
   */
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // First, because it is the narrowest: a tracking host answers two routes and
    // nothing else. `trackingHosts()` refuses SITE_URL's and PUBLIC_URL's hosts,
    // so this can never take either app's traffic.
    if (isTrackingHost(request, env)) {
      return withActivitySource('web', () =>
        trackingHost.fetch(request, env, ctx as unknown as never),
      )
    }
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
        // The minute the cron was meant for, so a late start still reads each
        // sequence's send window for that minute.
        const now = Number.isFinite(controller.scheduledTime) ? new Date(controller.scheduledTime) : new Date()

        // ⭐ One budget for the whole invocation (`core/query-budget.ts`). D1
        // counts every statement below against the same 1,000, so the jobs
        // share it in priority order instead of each sizing itself as if it
        // ran alone:
        //   1. a due broadcast reserves CRON_PAGES pages (≈690 queries) first;
        //   2. the sequence tick takes what fits of the rest (all of it on a
        //      quiet minute, ~27 enrollments beside a broadcast);
        //   3. webhook deliveries take what is left, often nothing in a send
        //      minute. Every job resumes next minute, so less is always safe.
        const budget = new QueryBudget()

        // One broadcast per tick, several pages deep. Taking five at a time and
        // one page each meant the D1 query budget bought 400 recipients a minute;
        // spending it on the oldest live send clears ~6,000 instead. There is
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
        const pages = due.length > 0 ? CRON_PAGES : 0
        budget.spend(pages * QUERIES_PER_PAGE)

        // Caught on its own: a tick that throws (a bad row, a D1 hiccup) must
        // not take the broadcast, the domain check, the webhooks and the
        // imports down with it. The failure is a `sync_runs` row the Logs show
        // under Sequences; the tick is idempotent and retries next minute.
        try {
          await tickSequences(env, db, now, { budget })
        } catch (err) {
          try {
            await recordTickFailure(db, err, now)
          } catch {
            /* D1 itself is down; nothing more can be written this minute */
          }
        }

        // Caught like the tick: a page the database refused must not take the
        // domain check, the webhooks and the imports down with it. Nothing is
        // lost by stopping, because a page moves the cursor only once its rows
        // are on the queue, so next minute starts the same page again.
        for (const b of due) {
          try {
            await sendBroadcastNow(env, db, b.id, pages)
          } catch {
            /* resumed from the cursor next minute */
          }
        }

        // One overdue sending-domain check, after the mail: it is a few DNS
        // lookups and never throws, so it can neither delay nor break a send.
        await checkDueDomains(env, db)
        // Outbound webhooks: what the budget has left, last, so mail always
        // gets D1 first. Caught on its own — a receiver that is down must
        // never be able to stop the tick that sends mail. The rows stay
        // pending and the next minute tries again.
        try {
          await deliverDueWebhooks(env, db, {
            limit: budget.fits(QUERIES_PER_DELIVERY, DELIVERY_PAGE, DELIVERY_PASS_OVERHEAD),
          })
        } catch {
          /* recorded on the delivery rows */
        }
        // One page of a background import (Kit, Ghost, Mailchimp, Drip), but
        // only in a minute with no broadcast to push: a send page spends most
        // of the 1,000-query budget, and mail outranks migration. The import
        // just resumes from its cursor next minute. A failure is already a
        // row on `import_runs`, so it must not take the tick down with it.
        // A page costs a few hundred queries at most, so a minute whose drip
        // already spent most of the budget skips it too.
        if (due.length === 0 && budget.remaining >= IMPORT_PAGE_QUERIES) {
          try {
            await advanceImports(env, db)
          } catch {
            /* recorded on import_runs where it could be; retried next tick */
          }
        }
        // Ghostwriter takes: a few model calls for the oldest take still
        // writing, last of all. It touches no mail and few rows, and its
        // progress is the take's own rows, so a failure here just leaves the
        // lease to expire and the next minute carries on. Like imports, only in
        // a minute with no broadcast page: a send spends most of the D1 budget,
        // and a take that hits the cap after its model calls loses paid output.
        if (due.length === 0) {
          try {
            await advanceTakes(env, db)
          } catch {
            /* the take's lease expires; next tick resumes it */
          }
        }
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
          //
          // ⭐ A row the provider was asked for, with no answer ever recorded,
          // may have gone. It says so first (`outcome unknown`), so no bulk
          // "send again" ever picks it up and the operator checks the provider.
          error: sql`case when ${messages.providerCalledAt} is not null then ${`${OUTCOME_UNKNOWN}: the provider was asked and no answer was recorded; `} else '' end || ${GAVE_UP} || coalesce(': ' || ${messages.error}, '')`,
          claimedAt: null,
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
        // The claim goes with the note: these rows are coming back on the
        // queue's retry, and a claim still held would turn that retry away
        // until the lease ran out.
        .set({ error, claimedAt: null })
        .where(and(inArray(messages.id, ids.slice(i, i + 90)), eq(messages.status, 'queued')))
    }
  } catch {
    /* still down; the next attempt will say so again */
  }
}
