import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// Conventions (see `sqlite-dev` skill): snake_case column names under camelCase
// TS keys, plural tables, `id` surrogate key, NOT NULL FKs with explicit onDelete,
// text+CHECK enums, epoch-ms timestamps set by the app. Keeps this portable to
// Postgres — D1 is SQLite, so the rules apply unchanged.

const ts = (name: string) => integer(name, { mode: 'timestamp_ms' })

/**
 * ProseMirror/TipTap document JSON. Structural only — the email renderer walks
 * this by hand (see `core/render-doc.ts`), because TipTap's own HTML serializer
 * needs a DOM and there isn't one in a Worker.
 */
export interface DocNode {
  type?: string
  attrs?: Record<string, unknown>
  content?: DocNode[]
  marks?: { type: string; attrs?: Record<string, unknown> }[]
  text?: string
}

// ─────────────────────────────────────────────────────────── subscribers

export const subscribers = sqliteTable(
  'subscribers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    email: text('email').notNull(),
    name: text('name'),
    // `unsubscribed` means OFF BROADCASTS ONLY — it never implies leaving sequences.
    // Scoped consent lives in `sequence_optouts`; global consent in `suppressions`.
    status: text('status', {
      enum: ['pending', 'active', 'unsubscribed', 'bounced', 'complained'],
    })
      .notNull()
      .default('active'),
    attributes: text('attributes', { mode: 'json' })
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    source: text('source'),
    unsubToken: text('unsub_token').notNull(),
    createdAt: ts('created_at').notNull(),
    confirmedAt: ts('confirmed_at'),
    unsubscribedAt: ts('unsubscribed_at'),
  },
  (t) => [
    uniqueIndex('subscribers_email_key').on(t.email),
    uniqueIndex('subscribers_unsub_token_key').on(t.unsubToken),
    index('subscribers_status_idx').on(t.status),
    // The audience list orders by this on every page load, over 13k+ rows.
    index('subscribers_created_at_idx').on(t.createdAt),
  ],
)

// ─────────────────────────────────────────────────────────── tags

export const tags = sqliteTable(
  'tags',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [uniqueIndex('tags_slug_key').on(t.slug)],
)

export const subscriberTags = sqliteTable(
  'subscriber_tags',
  {
    subscriberId: integer('subscriber_id')
      .notNull()
      .references(() => subscribers.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    taggedAt: ts('tagged_at').notNull(),
  },
  // Pure junction: compound PK, no surrogate id.
  (t) => [primaryKey({ columns: [t.subscriberId, t.tagId] })],
)

// ─────────────────────────────────────────────────────────── segments

/**
 * A saved audience rule. Deliberately flat — no boolean tree, no nesting.
 * Tags are the facts; a segment is a named question asked of them.
 */
export interface SegmentRule {
  /** How `includeTagIds` combine: 'any' = union (default), 'all' = intersection. */
  match?: 'any' | 'all'
  includeTagIds?: number[]
  excludeTagIds?: number[]
  /** Epoch ms, compared against `subscribers.created_at`. */
  joinedAfter?: number
  joinedBefore?: number

  // ── purchase predicates, resolved against the commerce mirror below.
  // Offer slugs rather than ids: a slug survives a re-sync and reads in a diff,
  // and it is what Rob actually sells — people buy offers, not products.
  /**
   * `true` = has ever bought anything; `false` = has never bought anything.
   *
   * The plain "customers" / "not yet customers" split, and the one predicate
   * that cannot be expressed by listing offers — a rule naming every slug would
   * still silently miss anyone whose order carries no offer_id.
   */
  hasPurchased?: boolean
  /** Bought any/all of these offers, by slug. */
  boughtOffers?: string[]
  /** Bought none of these. The "already owns it, stop pitching" filter. */
  notBoughtOffers?: string[]
  /** How `boughtOffers` combine. Independent of `match`, which governs tags. */
  offerMatch?: 'any' | 'all'
  /** Lifetime spend bounds, in cents. */
  spentAtLeastCents?: number
  spentAtMostCents?: number
  /** Order count floor — 2 is "bought more than once". */
  orderCountAtLeast?: number
  /** Order count ceiling — 1 is "bought exactly once", the classic upsell target. */
  orderCountAtMost?: number
  /** Epoch ms, compared against the most recent purchase. Recency, not join date. */
  purchasedAfter?: number
  purchasedBefore?: number
  /**
   * Ignore reconstructed orders that resolved to nothing when testing spend and
   * count. Off by default so numbers match the storefront; on when the segment
   * is about to make a claim ("you've spent over $500 with me") that had better
   * be true.
   */
  confidentPurchasesOnly?: boolean
}

export const segments = sqliteTable(
  'segments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    rule: text('rule', { mode: 'json' }).notNull().$type<SegmentRule>().default({}),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [uniqueIndex('segments_slug_key').on(t.slug)],
)

/**
 * Auto-tagging: "when this happens, tag them". One flat row per rule, so a rule
 * is readable in a table and needs no DSL. Applied in `core/tagging.ts` off the
 * back of an event — and because it goes through `addTags`, a rule firing can
 * itself start a `tag_added` sequence. That chain is the whole point.
 */
export const tagRules = sqliteTable(
  'tag_rules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    event: text('event', { enum: ['delivered', 'open', 'click', 'bounce', 'complaint'] }).notNull(),
    // nullable-fk: null means "any broadcast" / "any sequence". At most one is set;
    // both null = the rule watches every message.
    broadcastId: integer('broadcast_id').references(() => broadcasts.id, { onDelete: 'cascade' }),
    sequenceId: integer('sequence_id').references(() => sequences.id, { onDelete: 'cascade' }),
    /** Click rules only: case-insensitive substring of the clicked URL. */
    urlContains: text('url_contains'),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    // Observable in D1, because Workers logs are gone in a week.
    appliedCount: integer('applied_count').notNull().default(0),
    lastAppliedAt: ts('last_applied_at'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('tag_rules_active_event_idx').on(t.isActive, t.event)],
)

// ─────────────────────────────────────────────────────────── broadcasts

export const broadcasts = sqliteTable(
  'broadcasts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    subject: text('subject').notNull(),
    // Rich document (TipTap/ProseMirror JSON) is the source of truth when present.
    // `bodyMd` remains the fallback so markdown-authored content keeps rendering —
    // see `renderBody` in core/render.ts for the precedence rule.
    bodyJson: text('body_json', { mode: 'json' }).$type<DocNode | null>(),
    bodyMd: text('body_md').notNull(),
    // The rule this broadcast actually targets, always stored inline. Picking a
    // saved segment COPIES its rule here — editing that segment next month must
    // not rewrite who a sent broadcast went to.
    segment: text('segment', { mode: 'json' }).notNull().$type<SegmentRule>().default({}),
    // nullable-fk: provenance only ("built from: Customers"). Never read at send
    // time — `segment` above is the truth.
    segmentId: integer('segment_id').references(() => segments.id, { onDelete: 'set null' }),
    // nullable-fk: which marketing push this mail belongs to. A click on a
    // campaign-linked broadcast writes an attribution touch (core/campaigns.ts).
    campaignId: integer('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    status: text('status', {
      enum: ['draft', 'scheduled', 'sending', 'sent', 'cancelled'],
    })
      .notNull()
      .default('draft'),
    scheduledAt: ts('scheduled_at'),
    startedAt: ts('started_at'),
    sentAt: ts('sent_at'),
    // Materialization cursor. D1 allows ~1,000 queries per Worker invocation, so a
    // large broadcast writes its `messages` rows across several cron ticks, resuming
    // from the last subscriber id it reached.
    cursorSubscriberId: integer('cursor_subscriber_id').notNull().default(0),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('broadcasts_status_scheduled_idx').on(t.status, t.scheduledAt)],
)

// ─────────────────────────────────────────────────────────── sequences

export const sequences = sqliteTable(
  'sequences',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    // Shown to subscribers in the preference center — so it must read like a
    // thing a person chose to receive, not an internal name.
    description: text('description'),
    trigger: text('trigger', { enum: ['subscribe', 'tag_added', 'manual'] }).notNull(),
    // nullable-fk: only `tag_added` sequences have a trigger tag.
    triggerTagId: integer('trigger_tag_id').references(() => tags.id, { onDelete: 'cascade' }),
    // nullable-fk: see `broadcasts.campaignId`.
    campaignId: integer('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [uniqueIndex('sequences_slug_key').on(t.slug)],
)

export const sequenceSteps = sqliteTable(
  'sequence_steps',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sequenceId: integer('sequence_id')
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    // Days after the previous step. 0 means "as soon as the enrollment reaches
    // this step", which is what the first step of a sequence almost always wants.
    delayDays: integer('delay_days').notNull().default(1),
    subject: text('subject').notNull(),
    bodyJson: text('body_json', { mode: 'json' }).$type<DocNode | null>(),
    bodyMd: text('body_md').notNull(),
  },
  (t) => [uniqueIndex('sequence_steps_order_key').on(t.sequenceId, t.position)],
)

export const sequenceEnrollments = sqliteTable(
  'sequence_enrollments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sequenceId: integer('sequence_id')
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    subscriberId: integer('subscriber_id')
      .notNull()
      .references(() => subscribers.id, { onDelete: 'cascade' }),
    // nullable-fk: null once the sequence is completed.
    nextStepId: integer('next_step_id').references(() => sequenceSteps.id, {
      onDelete: 'set null',
    }),
    status: text('status', { enum: ['active', 'completed', 'cancelled'] })
      .notNull()
      .default('active'),
    nextRunAt: ts('next_run_at'),
    enrolledAt: ts('enrolled_at').notNull(),
  },
  (t) => [
    uniqueIndex('sequence_enrollments_key').on(t.sequenceId, t.subscriberId),
    index('sequence_enrollments_due_idx').on(t.status, t.nextRunAt),
  ],
)

// ⭐ The point of this project. Leaving one sequence writes exactly one row here
// and touches nothing else — the subscriber stays active, stays on the newsletter,
// and stays in every other sequence.
export const sequenceOptouts = sqliteTable(
  'sequence_optouts',
  {
    subscriberId: integer('subscriber_id')
      .notNull()
      .references(() => subscribers.id, { onDelete: 'cascade' }),
    sequenceId: integer('sequence_id')
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    optedOutAt: ts('opted_out_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.subscriberId, t.sequenceId] })],
)

// ─────────────────────────────────────────────────────────── campaigns

/**
 * A named push — a launch, a course sale, a book. Broadcasts, sequences and
 * forms opt into one; sales are credited to one. It is a *label with a ledger*,
 * not a container that owns anything: deleting a campaign must never delete the
 * mail or the money, which is why every reference to it is `set null`.
 */
export const campaigns = sqliteTable(
  'campaigns',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status', { enum: ['active', 'archived'] })
      .notNull()
      .default('active'),
    /** Optional revenue target, in cents. Purely for the progress bar. */
    goalCents: integer('goal_cents'),
    startedAt: ts('started_at'),
    endedAt: ts('ended_at'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [uniqueIndex('campaigns_slug_key').on(t.slug)],
)

/**
 * ⭐ The thing Kit doesn't give you: *how* somebody got here, kept as a ledger
 * rather than a single overwritten column. One row per (person, campaign,
 * source), so first-touch and last-touch are both just an ORDER BY away and you
 * never have to decide the attribution model up front.
 */
export const attributions = sqliteTable(
  'attributions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    subscriberId: integer('subscriber_id')
      .notNull()
      .references(() => subscribers.id, { onDelete: 'cascade' }),
    campaignId: integer('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    sourceKind: text('source_kind', {
      enum: ['form', 'broadcast', 'sequence', 'manual'],
    }).notNull(),
    /** The id of the form/broadcast/sequence. Not a real FK — it points at three
        different tables, and a deleted form must not erase the history of how
        somebody arrived.

        NOT NULL with a 0 sentinel, not nullable, because SQLite (and Postgres)
        treat NULLs as distinct inside a unique index — a nullable column here
        would silently stop `attributions_touch_key` from deduping the `manual`
        touches that carry no source object. */
    sourceId: integer('source_id').notNull().default(0),
    occurredAt: ts('occurred_at').notNull(),
  },
  (t) => [
    // One touch per person per source. Re-submitting the same form five times is
    // one fact, not five — and this is what makes recording a touch idempotent.
    uniqueIndex('attributions_touch_key').on(
      t.subscriberId,
      t.campaignId,
      t.sourceKind,
      t.sourceId,
    ),
    index('attributions_subscriber_idx').on(t.subscriberId, t.occurredAt),
    index('attributions_campaign_idx').on(t.campaignId),
  ],
)

// ─────────────────────────────────────────────────────────── forms

/**
 * A named POST endpoint: `POST /f/:slug` from anywhere on the internet. No
 * JavaScript, no hosted landing page, no embed script — a plain HTML `<form>`
 * on your own site is the whole integration.
 */
export const forms = sqliteTable(
  'forms',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    // nullable-fk: what submitting this form starts. `set null` because pointing
    // a form at a deleted sequence should break the form, not delete it.
    sequenceId: integer('sequence_id').references(() => sequences.id, { onDelete: 'set null' }),
    campaignId: integer('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    /** Where the browser lands after a plain form post. Falls back to a plain page. */
    redirectUrl: text('redirect_url'),
    successMessage: text('success_message').notNull().default("You're subscribed. Thanks!"),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    // Observable in D1, because Workers logs are gone in a week.
    submitCount: integer('submit_count').notNull().default(0),
    lastSubmittedAt: ts('last_submitted_at'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [uniqueIndex('forms_slug_key').on(t.slug)],
)

export const formTags = sqliteTable(
  'form_tags',
  {
    formId: integer('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.formId, t.tagId] })],
)

// ─────────────────────────────────────────────────────────── sales

/**
 * Money, posted in from wherever the checkout lives. Amounts are integer cents —
 * never floats, because 0.1 + 0.2 is not 0.3 and revenue reports are read by a
 * person who will notice.
 */
export const sales = sqliteTable(
  'sales',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    subscriberId: integer('subscriber_id')
      .notNull()
      .references(() => subscribers.id, { onDelete: 'cascade' }),
    // nullable-fk: resolved at ingest from the explicit payload field, else the
    // subscriber's last attribution touch. Frozen once written — re-running
    // attribution later must not silently rewrite last quarter's numbers.
    campaignId: integer('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    product: text('product'),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull().default('usd'),
    status: text('status', { enum: ['paid', 'refunded'] })
      .notNull()
      .default('paid'),
    /** Your checkout's id (Stripe charge, order number). Makes ingest idempotent,
        and lets a later refund find the row it's refunding. */
    externalId: text('external_id'),
    meta: text('meta', { mode: 'json' }).notNull().$type<Record<string, unknown>>().default({}),
    occurredAt: ts('occurred_at').notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('sales_external_id_key').on(t.externalId).where(sql`external_id is not null`),
    index('sales_subscriber_idx').on(t.subscriberId),
    index('sales_campaign_idx').on(t.campaignId, t.status),
    index('sales_occurred_idx').on(t.occurredAt),
  ],
)

// ─────────────────────────────────────────── commerce mirror (from Neon)

/**
 * A read-only projection of the storefront in Neon. **Nothing here is a source
 * of truth** — every row is rebuilt from `orders` / `offers` in Postgres by
 * `scripts/import-neon-purchases.ts`, and a wrong value is fixed there and
 * re-synced, never edited here.
 *
 * Why mirror at all: segment evaluation runs inside the Worker on every
 * broadcast materialization tick, under D1's 1,000-query-per-invocation cap.
 * It cannot reach across to Postgres at send time, so the facts it filters on
 * have to be local, indexed, and already aggregated.
 *
 * ⚠️ `purchases` is NOT `sales`. `sales` is revenue attributed to a campaign
 * this mailer sent — it answers "did that email make money". `purchases` is ten
 * years of storefront history with no attribution at all, and exists only to
 * answer "what does this person own, and what have they spent". Never sum them
 * together.
 */
export const offers = sqliteTable(
  'offers',
  {
    // Mirrors `offers.id` in Neon — assigned there, not here. No autoIncrement:
    // a re-sync must land the same row on the same id or every purchase's
    // `offer_id` silently repoints at a different product.
    id: integer('id').primaryKey(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    priceCents: integer('price_cents'),
    active: integer('active', { mode: 'boolean' }).notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    syncedAt: ts('synced_at').notNull(),
  },
  (t) => [uniqueIndex('offers_slug_key').on(t.slug), index('offers_active_idx').on(t.active)],
)

/**
 * Which products an offer bundles. Two integer columns and ~70 rows, carried
 * purely so the day "don't pitch the video to someone who already owns it
 * inside a bundle" comes up, it's a query and not a migration — `imposter-video`
 * ships inside 11 different offers. Nothing reads this yet by design: offers are
 * the grain people actually buy, products are the lookup sitting next to them.
 */
export const offerProducts = sqliteTable(
  'offer_products',
  {
    offerId: integer('offer_id')
      .notNull()
      .references(() => offers.id, { onDelete: 'cascade' }),
    productSku: text('product_sku').notNull(),
    productName: text('product_name').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.offerId, t.productSku] }),
    index('offer_products_sku_idx').on(t.productSku),
  ],
)

/**
 * One row per storefront order.
 *
 * Keyed by **email, not subscriber_id**. 21,403 people have bought something;
 * 13,766 are on the list. Forcing a NOT NULL `subscriber_id` here would mean
 * fabricating ~8k subscriber rows for people who never asked to hear from us —
 * and at `status: 'active'` those people would receive the next broadcast.
 * Email-keying also means a buyer who subscribes in two years' time arrives
 * with their history already attached, no backfill needed.
 */
export const purchases = sqliteTable(
  'purchases',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Normalized lowercase. The join key to `subscribers.email`. */
    email: text('email').notNull(),
    /** `neon:<orders.uuid>` — makes a re-sync idempotent instead of doubling revenue. */
    externalId: text('external_id').notNull(),
    // nullable-fk: a handful of Stripe orders in Neon carry no offer_id.
    offerId: integer('offer_id').references(() => offers.id, { onDelete: 'set null' }),
    /** Denormalized so the common segment ("bought X") never joins. */
    offerSlug: text('offer_slug'),
    /** Provenance: shopify, thrive, woo, gumroad, stripe, recovered… */
    store: text('store').notNull(),
    amountCents: integer('amount_cents').notNull().default(0),
    currency: text('currency').notNull().default('usd'),
    /**
     * How much to trust this row. Orders reconstructed from old records carry
     * `recovered_orders.confidence` from Neon; everything booked live is 'high'.
     * 1,237 recovered rows resolved to nothing and land as 'none' — spend
     * thresholds should be able to leave those out rather than quietly bank them.
     */
    confidence: text('confidence', { enum: ['high', 'low', 'none'] })
      .notNull()
      .default('high'),
    occurredAt: ts('occurred_at').notNull(),
    syncedAt: ts('synced_at').notNull(),
  },
  (t) => [
    uniqueIndex('purchases_external_id_key').on(t.externalId),
    index('purchases_email_idx').on(t.email),
    index('purchases_offer_slug_idx').on(t.offerSlug),
    index('purchases_occurred_idx').on(t.occurredAt),
  ],
)

/**
 * Per-buyer rollup, recomputed at the end of every sync.
 *
 * Denormalized on purpose: without it, "spent over $100" aggregates 31k rows on
 * every segment count and every page of a broadcast send. With it, it's one
 * indexed lookup. Rebuilt wholesale, never incremented — an incremental counter
 * that drifts is worse than no counter.
 */
export const purchaseStats = sqliteTable(
  'purchase_stats',
  {
    email: text('email').primaryKey(),
    orderCount: integer('order_count').notNull().default(0),
    /** Net of nothing — Neon's `orders` has no refund column to net against. */
    lifetimeCents: integer('lifetime_cents').notNull().default(0),
    /** Same, excluding rows whose `confidence` is not 'high'. */
    confidentCents: integer('confident_cents').notNull().default(0),
    firstAt: ts('first_at'),
    lastAt: ts('last_at'),
    computedAt: ts('computed_at').notNull(),
  },
  (t) => [
    index('purchase_stats_lifetime_idx').on(t.lifetimeCents),
    index('purchase_stats_last_idx').on(t.lastAt),
  ],
)

// ─────────────────────────────────────────────────────────── sending

export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    subscriberId: integer('subscriber_id')
      .notNull()
      .references(() => subscribers.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['broadcast', 'sequence', 'transactional'] }).notNull(),
    // nullable-fk: exactly one source per `kind`; transactional has neither.
    broadcastId: integer('broadcast_id').references(() => broadcasts.id, { onDelete: 'cascade' }),
    sequenceStepId: integer('sequence_step_id').references(() => sequenceSteps.id, {
      onDelete: 'cascade',
    }),
    toEmail: text('to_email').notNull(),
    subject: text('subject').notNull(),
    // Transactional only — broadcast and sequence bodies live on their source row
    // so editing the source can't rewrite history for already-sent mail.
    bodyMd: text('body_md'),
    status: text('status', { enum: ['queued', 'sent', 'failed', 'suppressed'] })
      .notNull()
      .default('queued'),
    // Why this send was blocked, when status = 'suppressed'. Observable, not silent.
    suppressedReason: text('suppressed_reason'),
    provider: text('provider'),
    providerMessageId: text('provider_message_id'),
    idempotencyKey: text('idempotency_key'),
    error: text('error'),
    createdAt: ts('created_at').notNull(),
    sentAt: ts('sent_at'),
  },
  (t) => [
    index('messages_broadcast_idx').on(t.broadcastId),
    index('messages_subscriber_idx').on(t.subscriberId),
    index('messages_status_idx').on(t.status),
    uniqueIndex('messages_idempotency_key')
      .on(t.idempotencyKey)
      .where(sql`idempotency_key is not null`),
  ],
)

export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    messageId: integer('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    type: text('type', {
      enum: ['delivered', 'open', 'click', 'bounce', 'complaint', 'failed'],
    }).notNull(),
    occurredAt: ts('occurred_at').notNull(),
    meta: text('meta', { mode: 'json' }).notNull().$type<Record<string, unknown>>().default({}),
    // Idempotency for replayed provider webhooks (SPEC 5.3).
    dedupeKey: text('dedupe_key'),
  },
  (t) => [
    index('events_message_type_idx').on(t.messageId, t.type),
    uniqueIndex('events_dedupe_key').on(t.dedupeKey).where(sql`dedupe_key is not null`),
  ],
)

// Global kill switch. Keyed by ADDRESS, not subscriber: bounced and transactional
// addresses may have no subscriber row at all.
export const suppressions = sqliteTable(
  'suppressions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    email: text('email').notNull(),
    reason: text('reason', {
      enum: ['unsubscribed_all', 'hard_bounce', 'complaint', 'manual'],
    }).notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [uniqueIndex('suppressions_email_key').on(t.email)],
)

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    /**
     * `send` reaches the transactional endpoint and nothing else. `admin` also
     * reaches MCP, which can rewrite the whole mailer — so it defaults to the
     * weaker one. A key minted before this column existed stays `send`, which is
     * the safe reading of "we don't know what this was for".
     */
    scope: text('scope', { enum: ['send', 'admin'] })
      .notNull()
      .default('send'),
    createdAt: ts('created_at').notNull(),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [uniqueIndex('api_keys_token_hash_key').on(t.tokenHash)],
)

// ─────────────────────────────────────────────────────────── MCP

/**
 * Every MCP tool call, including the ones that were refused. Workers logs are
 * gone in a week and this is an agent operating the mailer unattended, so the
 * record of what it did has to be a row — "what sent that?" must be answerable
 * next quarter, not next Tuesday.
 */
export const mcpCalls = sqliteTable(
  'mcp_calls',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tool: text('tool').notNull(),
    // nullable-fk: a call rejected before the key resolved has no key to point at.
    apiKeyId: integer('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    args: text('args', { mode: 'json' }).notNull().$type<Record<string, unknown>>().default({}),
    outcome: text('outcome', { enum: ['ok', 'error', 'denied'] }).notNull(),
    /** First line of the failure, when there was one. Not the whole stack. */
    detail: text('detail'),
    durationMs: integer('duration_ms').notNull().default(0),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('mcp_calls_created_idx').on(t.createdAt), index('mcp_calls_tool_idx').on(t.tool)],
)

/**
 * ⭐ The thing standing between a hallucinated tool call and eight thousand
 * people getting mail. A send tool refuses to run without a token minted by the
 * matching preview tool, and the token carries a `digest` of what was actually
 * previewed — so editing the broadcast after previewing invalidates it.
 *
 * In D1 rather than in memory because the Worker is stateless: the preview and
 * the send are two unrelated HTTP requests.
 */
export const preflightTokens = sqliteTable(
  'preflight_tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tokenHash: text('token_hash').notNull(),
    kind: text('kind', { enum: ['broadcast_send', 'sequence_activate'] }).notNull(),
    targetId: integer('target_id').notNull(),
    /** Hash of the previewed subject + body + audience rule. */
    digest: text('digest').notNull(),
    recipientCount: integer('recipient_count').notNull().default(0),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [uniqueIndex('preflight_tokens_hash_key').on(t.tokenHash)],
)

/**
 * One row per external-data pull (currently Stripe). The cursor makes the next
 * run incremental; the counts make a silent no-op distinguishable from a silent
 * failure, which a nightly job otherwise never is.
 */
export const syncRuns = sqliteTable(
  'sync_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: ['stripe', 'stripe_catalog'] }).notNull(),
    trigger: text('trigger', { enum: ['cron', 'mcp', 'preview', 'webhook'] }).notNull(),
    status: text('status', { enum: ['running', 'ok', 'partial', 'failed'] })
      .notNull()
      .default('running'),
    chargesSeen: integer('charges_seen').notNull().default(0),
    salesRecorded: integer('sales_recorded').notNull().default(0),
    refundsApplied: integer('refunds_applied').notNull().default(0),
    duplicates: integer('duplicates').notNull().default(0),
    /** Charges we could not turn into a sale — no email, bad amount, no campaign. */
    unattributed: integer('unattributed').notNull().default(0),
    notes: text('notes', { mode: 'json' }).notNull().$type<string[]>().default([]),
    /** Stripe `created` (epoch seconds) of the newest charge this run reached. */
    cursor: integer('cursor'),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('sync_runs_kind_started_idx').on(t.kind, t.startedAt)],
)

// Local-development only: the `console` provider writes fully rendered mail here
// instead of sending it, so the Outbox screen can show exactly what would have gone
// out. Kept out of `messages` so the real send record stays clean.
export const devOutbox = sqliteTable(
  'dev_outbox',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    messageId: integer('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    toEmail: text('to_email').notNull(),
    fromEmail: text('from_email').notNull(),
    subject: text('subject').notNull(),
    html: text('html').notNull(),
    text: text('text').notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('dev_outbox_created_idx').on(t.createdAt)],
)

// Uploaded media. R2 holds the bytes; this row is the catalogue so the library
// can list images without paging the bucket, and so an orphan sweep is possible.
export const media = sqliteTable(
  'media',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    key: text('key').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    bytes: integer('bytes').notNull(),
    width: integer('width'),
    height: integer('height'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [uniqueIndex('media_key_key').on(t.key), index('media_created_idx').on(t.createdAt)],
)

export type Media = typeof media.$inferSelect
export type Subscriber = typeof subscribers.$inferSelect
export type Tag = typeof tags.$inferSelect
export type Segment = typeof segments.$inferSelect
export type TagRule = typeof tagRules.$inferSelect
export type Broadcast = typeof broadcasts.$inferSelect
export type Sequence = typeof sequences.$inferSelect
export type SequenceStep = typeof sequenceSteps.$inferSelect
export type SequenceEnrollment = typeof sequenceEnrollments.$inferSelect
export type Message = typeof messages.$inferSelect
export type Event = typeof events.$inferSelect
export type Suppression = typeof suppressions.$inferSelect
export type DevOutboxItem = typeof devOutbox.$inferSelect
export type Campaign = typeof campaigns.$inferSelect
export type Attribution = typeof attributions.$inferSelect
export type Form = typeof forms.$inferSelect
export type Sale = typeof sales.$inferSelect
export type ApiKey = typeof apiKeys.$inferSelect
export type McpCall = typeof mcpCalls.$inferSelect
export type PreflightToken = typeof preflightTokens.$inferSelect
export type SyncRun = typeof syncRuns.$inferSelect
export type Offer = typeof offers.$inferSelect
export type OfferProduct = typeof offerProducts.$inferSelect
export type Purchase = typeof purchases.$inferSelect
export type PurchaseStats = typeof purchaseStats.$inferSelect

// ──────────────────────────────────────────── stripe: events & catalog

/**
 * Every webhook Stripe has handed us, one row per event id.
 *
 * Two jobs, and both of them matter more than they look. Stripe delivers
 * at-least-once and retries a failing endpoint for three days, so the primary
 * key *is* the idempotency guard — a redelivered `evt_…` is recognised and
 * dropped before it can touch money. And Workers logs are gone in a week, so
 * this table is the only place a 3am webhook that failed to parse will still
 * exist tomorrow (CLAUDE.md: anything observable is a row, not a log line).
 *
 * `status: 'ignored'` is a first-class outcome, not a failure — we subscribe to
 * more event types than we act on, and a silently discarded event is
 * indistinguishable from a lost one.
 */
export const stripeEvents = sqliteTable(
  'stripe_events',
  {
    /** Stripe's `evt_…`. Natural key on purpose — this is the dedupe. */
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    status: text('status', { enum: ['received', 'processed', 'ignored', 'failed'] })
      .notNull()
      .default('received'),
    /** What we did with it, in a sentence. Read by a human, not by code. */
    note: text('note'),
    /** The object the event carried, e.g. `ch_…` — makes tracing one order easy. */
    objectId: text('object_id'),
    /** nullable-fk: set once an event actually became money. */
    saleId: integer('sale_id').references(() => sales.id, { onDelete: 'set null' }),
    receivedAt: ts('received_at').notNull(),
    processedAt: ts('processed_at'),
  },
  (t) => [
    index('stripe_events_type_idx').on(t.type, t.receivedAt),
    index('stripe_events_status_idx').on(t.status),
    index('stripe_events_object_idx').on(t.objectId),
  ],
)

/**
 * A mirror of the Stripe product catalog.
 *
 * ⚠️ Deliberately NOT `offers`. That table mirrors Neon and is owned by the
 * storefront import; pointing a second sync at it would give one table two
 * owners and no way to tell which one was last right. These are Stripe's own
 * products, keyed by Stripe's own ids, and the two catalogs are allowed to
 * disagree — reconciling them is a question for a human, not a UNIQUE index.
 *
 * `metadata` is stored whole rather than picked apart into columns: it is where
 * the download file locations live, the keys are Rob's to change in the Stripe
 * dashboard, and a schema migration is a bad reason not to rename a metadata key.
 */
export const stripeProducts = sqliteTable(
  'stripe_products',
  {
    /** Stripe's `prod_…`. */
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    /** `prod.default_price`, if one is set. Not an FK — Stripe may report a
        price we have not synced yet, and a dangling reference is better than a
        failed catalog sync. */
    defaultPriceId: text('default_price_id'),
    /** Stripe's product metadata, verbatim. Download URLs live in here. */
    metadata: text('metadata', { mode: 'json' })
      .notNull()
      .$type<Record<string, string>>()
      .default({}),
    /** Stripe `updated` (epoch seconds), so a sync can skip untouched rows. */
    stripeUpdated: integer('stripe_updated'),
    syncedAt: ts('synced_at').notNull(),
  },
  (t) => [index('stripe_products_active_idx').on(t.active)],
)

/** Prices attached to a product. One product, many prices — one-off and recurring. */
export const stripePrices = sqliteTable(
  'stripe_prices',
  {
    /** Stripe's `price_…`. */
    id: text('id').primaryKey(),
    productId: text('product_id')
      .notNull()
      .references(() => stripeProducts.id, { onDelete: 'cascade' }),
    nickname: text('nickname'),
    /** Null for tiered or metered prices, which have no single amount. */
    unitAmount: integer('unit_amount'),
    currency: text('currency').notNull().default('usd'),
    /** 'one_time', or the billing interval for a recurring price. */
    interval: text('interval', { enum: ['one_time', 'day', 'week', 'month', 'year'] })
      .notNull()
      .default('one_time'),
    intervalCount: integer('interval_count').notNull().default(1),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    metadata: text('metadata', { mode: 'json' })
      .notNull()
      .$type<Record<string, string>>()
      .default({}),
    syncedAt: ts('synced_at').notNull(),
  },
  (t) => [
    index('stripe_prices_product_idx').on(t.productId),
    index('stripe_prices_active_idx').on(t.active),
  ],
)

/**
 * What was actually in an order.
 *
 * `sales` records that money moved; this records what it moved *for*. Split out
 * rather than widening `sales` because one charge can carry several products —
 * a bundle, or a subscription invoice with a proration line — and "which
 * products does this person own" is the question the thank-you mail needs
 * answered.
 *
 * The product id is a plain column, not an FK: a line item can name a product
 * the catalog sync has not reached yet, and a webhook that fails because the
 * catalog is stale would be a webhook that loses an order.
 */
export const saleItems = sqliteTable(
  'sale_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    saleId: integer('sale_id')
      .notNull()
      .references(() => sales.id, { onDelete: 'cascade' }),
    /** Stripe `prod_…`, when the line item resolved to one. */
    stripeProductId: text('stripe_product_id'),
    /** Stripe `price_…`, when the line item resolved to one. */
    stripePriceId: text('stripe_price_id'),
    /** Whatever Stripe called it at the time. Frozen — renaming the product in
        Stripe must not rewrite what last year's receipt said. */
    description: text('description').notNull(),
    quantity: integer('quantity').notNull().default(1),
    amountCents: integer('amount_cents').notNull().default(0),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    // One line per price per sale. Makes re-processing a redelivered checkout
    // session idempotent without having to diff the whole basket.
    uniqueIndex('sale_items_sale_price_key')
      .on(t.saleId, t.stripePriceId)
      .where(sql`stripe_price_id is not null`),
    index('sale_items_sale_idx').on(t.saleId),
    index('sale_items_product_idx').on(t.stripeProductId),
  ],
)

export type StripeEvent = typeof stripeEvents.$inferSelect
export type StripeProduct = typeof stripeProducts.$inferSelect
export type StripePrice = typeof stripePrices.$inferSelect
export type SaleItem = typeof saleItems.$inferSelect
