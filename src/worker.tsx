import { and, asc, eq, lte, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { downloadRoutes } from './api/downloads.ts'
import { formsApi } from './api/forms.tsx'
import { mediaRoutes } from './api/media.ts'
import { oauthApi } from './api/oauth.ts'
import { api } from './api/routes.ts'
import { tracking } from './api/tracking.ts'
import { salesApi } from './api/sales.ts'
import { withActivitySource } from './core/activity.ts'
import { sendBroadcastNow } from './core/broadcasts.ts'
import { checkDueDomains } from './core/domains.ts'
import { advanceImports } from './core/importers/runs.ts'
import { sendMessages } from './core/sending.ts'
import { tickSequences } from './core/sequences.ts'
import { isTrackingHost } from './core/tracking-host.ts'
import { syncStripeCatalog } from './core/stripe-catalog.ts'
import { syncStripe } from './core/stripe.ts'
import { deliverDueWebhooks } from './core/webhooks.ts'
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

app.route('/', prefs)
app.route('/', testimonialForm)
// The pixel and tracked links. Always answered here, on `PUBLIC_URL`'s host, even
// once `TRACKING_HOST` moves new mail elsewhere: every link sent before that
// still names this host, and always will.
app.route('/', tracking)
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
app.route('/', store)
// The public site's look. Operator-only like everything below `requireOperator`;
// the site itself is a separate app, reached by hostname.
app.route('/', siteAdmin)
app.route('/', themesAdmin)
// Sending domains: operator config, nothing public.
app.route('/', domainsAdmin)
// First-run checklist (Kōlea SPEC 21.4). Links out to the screens above; sends nothing.
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
        await tickSequences(env, db, now)

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

        // One overdue sending-domain check, after the mail: it is a few DNS
        // lookups and never throws, so it can neither delay nor break a send.
        await checkDueDomains(env, db)
        // Outbound webhooks: one page of due deliveries, last, so mail always
        // gets the D1 budget first. Caught on its own — a receiver that is down
        // must never be able to stop the tick that sends mail. The rows stay
        // pending and the next minute tries again.
        try {
          await deliverDueWebhooks(env, db)
        } catch {
          /* recorded on the delivery rows */
        }
        // One page of a background import (Kit, Ghost, Mailchimp, Drip), but
        // only in a minute with no broadcast to push: a send page spends most
        // of the 1,000-query budget, and mail outranks migration. The import
        // just resumes from its cursor next minute. A failure is already a
        // row on `import_runs`, so it must not take the tick down with it.
        if (due.length === 0) {
          try {
            await advanceImports(env, db)
          } catch {
            /* recorded on import_runs where it could be; retried next tick */
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

async function consumeBatch(batch: MessageBatch<SendJob>, env: Env) {
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
}
