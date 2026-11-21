import { sql } from 'drizzle-orm'
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

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

/**
 * Per-message merge values, resolved at queue time (see `messages.extras`).
 *
 * A value is either one string used on both surfaces, or a `{ html, text }` pair
 * when the two genuinely differ. A list of download links is the case that
 * forces the pair: `<ul><li><a…` is right in the HTML part and unreadable in the
 * plaintext one, and substituting the same string into both is how transactional
 * mail ends up showing markup to anyone reading in plaintext.
 */
export type MergeExtra = string | { html: string; text: string }
export type MergeExtras = Record<string, MergeExtra>

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
    // Custom field values, keyed by `custom_fields.key` and typed by it. Only
    // `core/fields.ts` writes here, and only keys a definition names.
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

// ─────────────────────────────────────────────────────────── custom fields

/**
 * The types a custom field can hold. Each decides how a value is stored inside
 * `subscribers.attributes` and how a segment compares it: text as trimmed text,
 * numbers as JSON numbers, dates as `YYYY-MM-DD` text (which sorts correctly as
 * text, so `>` means "after"), booleans as JSON `true`/`false`. See
 * `core/fields.ts`, the one place that casts.
 */
export const FIELD_TYPES = ['text', 'number', 'date', 'boolean'] as const
export type FieldType = (typeof FIELD_TYPES)[number]

/**
 * A named, typed field a subscriber can carry (Kōlea SPEC 7.2).
 *
 * ⚠️ This table holds the *definitions* only. Values stay where they always
 * were, in `subscribers.attributes`, keyed by `key`. A values table was the
 * other choice, and it would cost a join per condition in every segment count
 * and a row per person per field on import — against D1's 1,000-query cap and
 * single-threaded writes, for no rule it makes enforceable that this doesn't.
 * The definition is what makes the blob trustworthy: nothing writes a key into
 * `attributes` unless a row here names it (`castFieldValues` refuses unknown
 * keys), and a segment's json path is only ever built from a key that passed
 * `FIELD_KEY` — see `core/segments.ts`.
 *
 * `key` never changes after creation. Segment rules and merge tags (`{{plan}}`)
 * refer to it, and a rename that rewrote it would silently turn a stored rule
 * into one that matches nobody — or, for `is not set`, everybody. Renaming
 * changes `label`. Deleting is refused while a saved segment or an unsent
 * broadcast still asks about the key, for the same reason.
 */
export const customFields = sqliteTable(
  'custom_fields',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** `^[a-z][a-z0-9_]{0,62}$`. Doubles as the merge tag and the CSV header. */
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: text('type', { enum: FIELD_TYPES }).notNull().default('text'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [uniqueIndex('custom_fields_key_key').on(t.key)],
)

export type CustomField = typeof customFields.$inferSelect

/** Comparisons a segment can make against a custom field (Kōlea SPEC 7.5). */
export const FIELD_OPS = [
  'equals',
  'not_equals',
  'contains',
  'greater_than',
  'less_than',
  'is_set',
  'is_not_set',
] as const
export type FieldOp = (typeof FIELD_OPS)[number]

/**
 * One custom-field test inside a segment rule.
 *
 * `type` is copied in from the definition when the rule is saved, never taken
 * from input, so a stored rule is self-contained: a broadcast's frozen copy
 * still compiles the same way even if the field is later deleted. `value` is
 * already cast — a number for number fields, `YYYY-MM-DD` for dates, a boolean
 * for booleans, text for text and for every `contains`. Absent for `is_set` /
 * `is_not_set`.
 */
export interface FieldCondition {
  key: string
  type: FieldType
  op: FieldOp
  value?: string | number | boolean
}

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

  /**
   * Custom-field tests, all of which must hold (AND). Validated against
   * `custom_fields` on save by `checkConditions`; compiled into the same WHERE
   * as everything above by `ruleFilters`, which fails closed (matches nobody)
   * on anything it cannot compile safely.
   */
  conditions?: FieldCondition[]
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
    /**
     * ⭐ The audience, frozen at dispatch (SPEC 3.5). The highest subscriber id
     * the segment matched at the `scheduled → sending` transition; every later
     * page of the cursored walk stops at it. Without it, the cursor walks into
     * people who joined *during* the send, and a broadcast keeps finding new
     * readers for as long as it takes to finish.
     *
     * An id bound is enough on its own because `subscribers.id` is
     * AUTOINCREMENT — SQLite never reuses one, so nobody created after the
     * freeze can land at or below it. Only *who existed* is frozen: the rule is
     * still evaluated live on each page, under the bound, exactly as kolea-pro
     * does it, so a person tagged into the segment mid-send who already
     * existed below the bound is reached, and anyone who left (status, tag,
     * suppression) is not. Consent is re-checked again at the provider call.
     *
     * Null means not yet frozen: a draft, a scheduled send, an imported
     * archive row, or a send that was already in flight when this column
     * arrived (frozen at its next page — the closest thing to "at dispatch"
     * left for it). 0 means the audience was empty.
     */
    audienceUpperId: integer('audience_upper_id'),
    createdAt: ts('created_at').notNull(),

    // ── Imported engagement totals (Kit history).
    //
    // Broadcasts imported from Kit have no `messages` rows and never will —
    // nothing was sent from here, so there is no per-recipient history to
    // reconstruct. Without these, every send before the cutover reads as a
    // zero, and the dashboard's whole premise ("is my writing landing?")
    // has one data point.
    //
    // `importedRecipients` is the flag: non-null means "trust this row, not
    // the events table". `broadcastStats()` picks one source or the other and
    // never blends them — a half-imported, half-live figure is a lie with a
    // decimal point on it.
    //
    // Deliberately NOT stored: a delivered count. Kit reports one and Resend's
    // webhook coverage is partial, so the two would not mean the same thing.
    // Rates here are always over `recipients - bounced`.
    importedRecipients: integer('imported_recipients'),
    importedOpened: integer('imported_opened'),
    importedClicked: integer('imported_clicked'),
    importedUnsubscribed: integer('imported_unsubscribed'),
    /** Provenance, so an imported figure can always be labelled as one in the UI. */
    importedFrom: text('imported_from'),
    /** The other tool's own id for this mail (a Kit broadcast id, a Ghost post id).
        Set by the background importers (`core/importers/`) so a second run of the
        same import finds it and copies nothing twice. Null for everything written
        here, and for the one-off Kit archive, which predates it — the importer
        also matches on subject + sent_at for exactly that reason. */
    importedSourceId: text('imported_source_id'),

    // ── Published to the web (the public site at `SITE_URL`).
    //
    // A post IS a broadcast that opted in. One write becomes one send and one
    // page; a separate `posts` table would mean authoring the same piece twice,
    // which is the exact thing this project exists to avoid.
    //
    // `publishedAt` is the only gate the public site reads — null means the
    // broadcast is mail and nothing else. It defaults to null for every existing
    // row, which matters: the imported Kit archive is hundreds of `sent`
    // broadcasts, and publishing is a per-post, deliberate act, never a backfill.
    //
    // Deliberately NOT `status: 'published'`. Publishing is orthogonal to the
    // send lifecycle — a sent broadcast can go up months later, come down, and
    // go back up, and none of that may disturb the row the send path reads.
    publishedAt: ts('published_at'),
    /**
     * Publish this one to the web when it goes out. Default ON: a broadcast is a
     * post, and the mail carries a "read this online" link that has to resolve
     * the moment it lands.
     *
     * Read exactly once, at the `scheduled → sending` transition in
     * `dispatchBroadcastPage`. That is deliberate — it means an import, a
     * backfill, or any other path that writes `status` directly can never
     * publish anything, and turning this off before sending is the way to mail
     * something (a sales push, a one-segment note) without putting it on a
     * public URL.
     */
    publishOnSend: integer('publish_on_send', { mode: 'boolean' }).notNull().default(true),
    /** Shown in the front page's "Start here", newest first. Web only; mail never reads it. */
    featured: integer('featured', { mode: 'boolean' }).notNull().default(false),
    /**
     * Who may read this post on the web (Kōlea SPEC 15.11.4): `public` (anyone),
     * `members` (a reader signed in on the site) or `premium` (a member with a
     * live `member_subscriptions` row). Web only — the send path never reads it:
     * a broadcast still goes to its segment, in full, whatever this says.
     *
     * A gated level changes what publishing derives (`core/posts.ts`): the
     * excerpt and the featured image are never taken from a gated body, and
     * `search_text` holds the subject and hand-written excerpt only, so no list,
     * feed, search hit or og tag can carry the body out. What a reader actually
     * sees is one pure decision in `core/member-access.ts`.
     */
    accessLevel: text('access_level', { enum: ['public', 'members', 'premium'] })
      .notNull()
      .default('public'),
    /** URL identity. Unique across published and unpublished alike, so taking a
        post down never frees its slug for something else to claim. */
    slug: text('slug'),
    /** Card copy and the meta description. Derived from the body on publish when
        the operator doesn't write one. */
    excerpt: text('excerpt'),
    /** Card art and the og:image. Either a `/media/...` URL from our own uploader
        or a hotlinked `images.unsplash.com` one — absolute either way, because it
        also has to resolve inside email. */
    featureImage: text('feature_image'),
    /** Photographer's name, when the image came from Unsplash. Stored rather than
        looked up: the credit has to render on the page years later, offline from
        the API, and a credit that can fail to load is not a credit. */
    featureImageCredit: text('feature_image_credit'),
    /** Their profile link, carrying the referral parameters Unsplash requires. */
    featureImageCreditUrl: text('feature_image_credit_url'),
    /** The body flattened to plain text, written on publish. Search reads this
        and never the document JSON: `LIKE` over a JSON blob matches attribute
        names and hex colours as happily as it matches prose. */
    searchText: text('search_text'),

    // ── Revised after sending.
    //
    // A sent broadcast can have its subject and body corrected — a typo, a dead
    // link — so the web page and anyone coming back to it read the fixed copy.
    // Nobody is mailed again: the send path only ever claims `scheduled` or
    // `sending`, and revising never writes `status`.
    //
    // What that must not do is rewrite what the archive says went out
    // (invariant 9). So the first revision copies the as-mailed subject and body
    // here, once, and later revisions leave them alone. Null means "never
    // revised": the live columns above are exactly what was sent.
    originalSubject: text('original_subject'),
    originalBodyJson: text('original_body_json', { mode: 'json' }).$type<DocNode | null>(),
    originalBodyMd: text('original_body_md'),
    /** The latest revision. Non-null exactly when the `original*` columns are set. */
    revisedAt: ts('revised_at'),
  },
  (t) => [
    index('broadcasts_status_scheduled_idx').on(t.status, t.scheduledAt),
    // SQLite treats NULLs as distinct in a unique index, so every unpublished
    // broadcast keeps a null slug without colliding with the others.
    uniqueIndex('broadcasts_slug_key').on(t.slug),
    // One local row per mail in the other tool. NULLs are distinct, so every
    // broadcast written here (source id null) is untouched by this.
    uniqueIndex('broadcasts_imported_source_key').on(t.importedFrom, t.importedSourceId),
    // The public index page's only query: newest published first.
    index('broadcasts_published_at_idx').on(t.publishedAt),
  ],
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
    // nullable-fk: "when this sequence ends, add them to that one". Null means
    // the series simply ends. Read at ONE moment only — when the tick sends the
    // last step — and never swept afterwards: pointing an old sequence at a new
    // one must not enroll everybody who ever finished it.
    // ⚠️ `set null` is the intent, but this column arrived by ALTER TABLE and
    // SQLite cannot attach an ON DELETE action that way — the live column is
    // NO ACTION. `deleteSequence` clears these pointers itself for that reason.
    nextSequenceId: integer('next_sequence_id').references((): AnySQLiteColumn => sequences.id, {
      onDelete: 'set null',
    }),
    /**
     * The send-time window (Kōlea SPEC 12.1.2): minutes after local midnight in
     * the operator's time zone (`site_settings.time_zone`), start inclusive, end
     * exclusive. A start after the end wraps past midnight (22:00–06:00).
     *
     * Both null means no window — a due step goes at the next minutely tick,
     * which is how every sequence behaved before this existed. Both set or both
     * null, never one, and never equal: `core/send-window.ts` checks that on
     * every write, since SQLite cannot be told after the fact.
     *
     * A due step outside the window is not skipped: the tick moves the
     * enrollment's `next_run_at` to the window's next opening and sends it then.
     */
    sendWindowStart: integer('send_window_start'),
    sendWindowEnd: integer('send_window_end'),
    createdAt: ts('created_at').notNull(),

    // ── Imported engagement totals (Kit history). Same contract as
    // `broadcasts.imported*`: non-null `importedSubscribers` means "trust this
    // row, not the events table", and the two sources are never blended.
    //
    // ⚠️ Kit reports sequence engagement as RATES, not counts — its report has
    // an open rate and a click rate and no denominators anywhere. So rates are
    // what gets stored, rather than counts reconstructed by multiplying by a
    // subscriber figure that means something else entirely (Kit's
    // "Subscribers" is who is in the sequence *now*, not who was ever mailed).
    //
    // Both rates are over people reached, which is how Kit computes them —
    // NOT click-to-open. `core/analytics.ts` derives the click-to-open figure
    // the Signal score wants by dividing one by the other, and says so.
    importedSubscribers: integer('imported_subscribers'),
    /** 0–1. Kit's "open rate", over recipients. */
    importedOpenRate: real('imported_open_rate'),
    /** 0–1. Kit's "click rate", over recipients — not over openers. */
    importedClickRate: real('imported_click_rate'),
    /** A count, not a rate. Kit reports this one as an integer. */
    importedUnsubscribed: integer('imported_unsubscribed'),
    /** Provenance, so an imported figure can always be labelled as one. */
    importedFrom: text('imported_from'),
    /** The other tool's id for this sequence. Same contract as
        `broadcasts.importedSourceId`. */
    importedSourceId: text('imported_source_id'),
  },
  (t) => [
    uniqueIndex('sequences_slug_key').on(t.slug),
    uniqueIndex('sequences_imported_source_key').on(t.importedFrom, t.importedSourceId),
  ],
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

/**
 * A configured way OUT of a sequence: "when they get this tag, stop mailing them
 * this series" — and optionally "then put them in that one".
 *
 * Tags are the only exit kind on purpose. A purchase already lands as tags on
 * the sale, a link click already lands as a tag through `tag_rules`, so one
 * mechanism covers "they bought", "they clicked" and "I tagged them by hand".
 *
 * ⚠️ An exit is NOT an opt-out. It cancels the enrollment and writes no
 * `sequence_optouts` row — that row means "this person chose to leave", and
 * being tagged is not that choice. The automatic exits (opt-out, unsubscribe
 * from everything, bounce, complaint) are not rows here; they are invariants
 * and cannot be configured away.
 */
export const sequenceExits = sqliteTable(
  'sequence_exits',
  {
    sequenceId: integer('sequence_id')
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    // nullable-fk: null means "they just leave". Otherwise where they go next.
    thenSequenceId: integer('then_sequence_id').references(() => sequences.id, {
      onDelete: 'set null',
    }),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sequenceId, t.tagId] }),
    // The hot path is `addTags` asking "does anything exit on this tag?".
    index('sequence_exits_tag_idx').on(t.tagId),
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

/** One mail in a template. Same meaning as the `sequence_steps` columns it becomes. */
export interface TemplateStepDoc {
  /** Days after the PREVIOUS step. */
  delayDays: number
  /** Two or three words naming the mail's job. */
  label: string
  /** What this mail is for. Shown on the picker only, never sent. */
  purpose: string
  subject: string
  bodyMd: string
}

/**
 * A reusable sequence *shape*: how many mails, how far apart, what each is for.
 *
 * ⭐ A template is copied into `sequences` + `sequence_steps` once and never
 * referenced again — there is deliberately no FK from `sequences` back to here.
 * Editing or deleting a template must never touch a sequence already made from
 * it (invariant 9), and the cheapest way to guarantee that is for the link not
 * to exist.
 *
 * Steps are one JSON document rather than a child table for the same reason:
 * nothing ever queries a template step on its own, a template is always read
 * and written whole, and `sequence_steps` is where a step becomes relational.
 *
 * `[[ double brackets ]]` inside `subject` / `bodyMd` mark scaffolding the
 * operator must rewrite; `setSequenceActive` refuses while any survive.
 */
export const sequenceTemplates = sqliteTable(
  'sequence_templates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // Set once at creation and never rewritten on rename: it is the URL, and it
    // is how "restore the starters" knows which of them are already here.
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    family: text('family', { enum: ['funnel', 'launch', 'welcome', 'sale', 'customer'] })
      .notNull()
      .default('funnel'),
    /** Who the shape comes from. Credit, not endorsement. */
    source: text('source').notNull().default(''),
    tagline: text('tagline').notNull().default(''),
    /** Plain text, paragraphs split on blank lines. */
    description: text('description').notNull().default(''),
    bestFor: text('best_for', { mode: 'json' }).notNull().$type<string[]>().default([]),
    needs: text('needs', { mode: 'json' }).notNull().$type<string[]>().default([]),
    suggestedTrigger: text('suggested_trigger', { enum: ['subscribe', 'tag_added', 'manual'] })
      .notNull()
      .default('manual'),
    triggerHint: text('trigger_hint').notNull().default(''),
    /** Prefills for the sequence. `defaultDescription` is subscriber-facing. */
    defaultName: text('default_name').notNull().default(''),
    defaultDescription: text('default_description').notNull().default(''),
    steps: text('steps', { mode: 'json' }).notNull().$type<TemplateStepDoc[]>().default([]),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [uniqueIndex('sequence_templates_slug_key').on(t.slug)],
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

    // ── The lead magnet, and the reply that carries it. Both live here, on the
    // form, because that is what they are: this form hands over this file with
    // this email. There is no separate library to visit first.
    //
    // The reply is deliberately NOT step 1 of a sequence. A sequence step waits
    // for the minutely tick, is silently swallowed while `is_active` is 0, and is
    // refused for anyone holding a `sequence_optouts` row for that series — three
    // ways for somebody who just asked for a file to never get it. This goes out
    // inside the submit request, under the transactional consent rule.
    // `sequence_id` above still handles whatever nurture follows.
    //
    /** R2 key in the DOWNLOADS bucket. Null = this form hands over no file. */
    downloadKey: text('download_key'),
    /** What the browser saves it as, sent in `Content-Disposition`. */
    downloadFilename: text('download_filename'),
    downloadContentType: text('download_content_type'),
    downloadBytes: integer('download_bytes'),
    downloadUploadedAt: ts('download_uploaded_at'),
    /**
     * The direct link: `/d/<this>` serves the file to whoever holds the URL, no
     * signup and no grant. It exists so the operator can hand the file to
     * somebody themselves. Minted with the first upload and kept across a
     * replace, so a link already sent starts serving the new file. Null = no file.
     */
    downloadShareToken: text('download_share_token'),
    // A shared link can't say *who*, so a count on the form is all there is to
    // keep — and it is kept, because a download that isn't a row never happened.
    downloadShareCount: integer('download_share_count').notNull().default(0),
    downloadShareLastAt: ts('download_share_last_at'),
    /** No subject means no reply is sent. That check is the whole on/off switch. */
    deliverySubject: text('delivery_subject'),
    deliveryBodyJson: text('delivery_body_json', { mode: 'json' }).$type<DocNode | null>(),
    deliveryBodyMd: text('delivery_body_md'),
    successMessage: text('success_message').notNull().default("You're subscribed. Thanks!"),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    /**
     * ⭐ Double opt-in. On, a submit creates (or leaves) the person as they are,
     * sends one confirmation mail, and does NOTHING else that can start mail: no
     * tags, no sequence, no reply, no campaign touch. All of that waits for the
     * click on the link in `form_confirmations`, so a stranger typing somebody
     * else's address into a public form can cause one throttled confirmation
     * and nothing more.
     *
     * The column defaults to 0 so every form that existed before this shipped
     * keeps behaving exactly as it did on the sites it is already embedded in.
     * `createForm` defaults new forms to on, which is Kōlea's default.
     */
    doubleOptIn: integer('double_opt_in', { mode: 'boolean' }).notNull().default(false),
    // Observable in D1, because Workers logs are gone in a week.
    submitCount: integer('submit_count').notNull().default(0),
    lastSubmittedAt: ts('last_submitted_at'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('forms_slug_key').on(t.slug),
    // `/d/:token` looks a form up by this. Null for every form without a file,
    // which SQLite's unique index allows any number of.
    uniqueIndex('forms_download_share_token_key').on(t.downloadShareToken),
  ],
)

/**
 * How often a form was *shown*, one row per form per UTC day.
 *
 * A counter rather than a row per view, deliberately. The view pixel sits on
 * every page a form is embedded in, so a row per render would make this the
 * busiest table in the database for the least interesting fact in it — and D1
 * writes are single-threaded. Nobody needs to know which second a form was
 * rendered; they need views over submits, by day.
 *
 * `day` is `YYYY-MM-DD` text rather than an epoch so the upsert key is exact and
 * the charts group without date arithmetic. Cascade, because views of a form
 * that no longer exists answer no question.
 *
 * Starts at zero on the day the pixel shipped. Submits predate it, so any rate
 * must count submits only from a form's first recorded view (see
 * `formViewStats`), or every old form reads as converting at 400%.
 */
export const formViews = sqliteTable(
  'form_views',
  {
    formId: integer('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    day: text('day').notNull(),
    views: integer('views').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.formId, t.day] })],
)

/**
 * One person's link to one form's file: `/d/:token`.
 *
 * Per-person rather than one shared URL, because "who actually opened the
 * toolkit" is the most useful thing a lead magnet tells you, and a single link
 * cannot answer it. (The form's own `download_share_token` is the one shared
 * URL, for the operator to hand out; it is never what a reply carries.) The
 * pair is unique, so re-submitting the form hands back the
 * same link instead of minting a second one — the email can be re-sent and every
 * copy of it still works.
 */
export const downloadGrants = sqliteTable(
  'download_grants',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    formId: integer('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    subscriberId: integer('subscriber_id')
      .notNull()
      .references(() => subscribers.id, { onDelete: 'cascade' }),
    /** The unguessable half of the URL. Nothing else authenticates a download. */
    token: text('token').notNull(),
    // Observable in D1, because Workers logs are gone in a week.
    downloadCount: integer('download_count').notNull().default(0),
    lastDownloadedAt: ts('last_downloaded_at'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('download_grants_token_key').on(t.token),
    uniqueIndex('download_grants_person_key').on(t.formId, t.subscriberId),
    index('download_grants_subscriber_idx').on(t.subscriberId),
  ],
)

/**
 * ⭐ One open request to confirm a double opt-in signup: the link in the
 * confirmation mail is `/f/<slug>/confirm/<token>`.
 *
 * A row rather than an HMAC of (form, person), for the same reasons as
 * `subscribers.unsub_token`: it needs no key in the Worker, it can expire, and
 * it is the record of *when* somebody asked and *when* they confirmed — the
 * consent provenance a signup is worth keeping.
 *
 * A re-submit while one is still open reuses it (same token, so every copy of
 * the mail works) rather than minting another. Once confirmed or expired it is
 * history, and a later submit opens a new row, so the old `confirmed_at` is
 * never rewritten. How many mails a row may cause is not stored here: it is
 * counted from `messages` (kind `confirmation`), which already records every one.
 *
 * Cascade on both sides: a confirmation for a deleted form or person answers
 * no question, and the mail it caused is kept in `messages` anyway.
 */
export const formConfirmations = sqliteTable(
  'form_confirmations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    formId: integer('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    subscriberId: integer('subscriber_id')
      .notNull()
      .references(() => subscribers.id, { onDelete: 'cascade' }),
    /** The unguessable half of the URL. Nothing else authenticates the click. */
    token: text('token').notNull(),
    status: text('status', { enum: ['pending', 'confirmed'] })
      .notNull()
      .default('pending'),
    createdAt: ts('created_at').notNull(),
    /** Seven days, as Kōlea. After it the link shows "expired" and changes nothing. */
    expiresAt: ts('expires_at').notNull(),
    confirmedAt: ts('confirmed_at'),
  },
  (t) => [
    uniqueIndex('form_confirmations_token_key').on(t.token),
    // "Is there already an open one for this person on this form?" — every submit.
    index('form_confirmations_person_idx').on(t.formId, t.subscriberId),
    index('form_confirmations_subscriber_idx').on(t.subscriberId),
  ],
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

/**
 * ⭐ What somebody is told after they buy — one template per offer.
 *
 * Keyed by `offer_slug`, which is the **sku on the Stripe product**
 * (`stripe_products.metadata.sku`), not `offers.id`. That is the only key the
 * two catalogs already agree on: a sale arrives as line items carrying a Stripe
 * product, and the sku is what maps it to the thing Rob sells. Keying on
 * `offers.id` would mean a join through a mirror that is allowed to disagree
 * (see the `offers` vs `stripe_products` note above).
 *
 * The fallback template is the literal slug `'*'` rather than a NULL, so a plain
 * UNIQUE index enforces "exactly one default". SQLite treats NULLs as *distinct*
 * in a unique index, so a nullable column would happily accept five defaults and
 * pick one at random — the same trap `attributions.source_id` documents.
 *
 * This is deliberately shaped like a form's delivery reply, not like a sequence
 * step: it goes out on a deliberate act under the transactional consent rule,
 * with the body snapshotted onto the message so editing the template afterwards
 * cannot rewrite what already went out (invariant 9).
 *
 * `discord_invite_url` is the whole "role rule" for now. A Discord invite can be
 * configured to grant a role on join, so one invite per offer expresses the
 * mapping without a second table. When roles need to outgrow that, they get
 * their own table — not a JSON blob here.
 */
export const purchaseTemplates = sqliteTable(
  'purchase_templates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** A `stripe_products.metadata.sku`, or `'*'` for the fallback. */
    offerSlug: text('offer_slug').notNull(),
    /** What the operator calls this template. Never shown to a buyer. */
    name: text('name').notNull(),
    subject: text('subject').notNull(),
    bodyJson: text('body_json', { mode: 'json' }).$type<DocNode | null>(),
    bodyMd: text('body_md'),
    /** Merged as `{{discord_url}}`. Null means this offer has no Discord. */
    discordInviteUrl: text('discord_invite_url'),
    /**
     * Off switch. An inactive template is never selected — and because selection
     * falls back to `'*'`, deactivating one quietly reverts that offer to the
     * generic mail rather than sending nothing.
     */
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at'),
  },
  (t) => [uniqueIndex('purchase_templates_offer_slug_key').on(t.offerSlug)],
)

/**
 * ⭐ A stored transactional mail: the receipt, the password reset, the "your
 * export is ready" note another app sends through `POST /api/send` by naming
 * `template: "<slug>"` and filling `{{variables}}`, instead of shipping the whole
 * subject and body on every call (Kōlea SPEC 13.1).
 *
 * Not a purchase template and not a sequence template. Purchase mail is keyed by
 * offer sku and sent by the operator on a sale; a sequence template is a recipe
 * for building a sequence. This one is keyed by a slug a *caller* hard-codes.
 *
 * `slug` is set once, from the name (or given at create), and never follows a
 * rename: another application's code has it baked in, and a rename that moved it
 * would break that app's mail without either side noticing until a customer
 * asked where their receipt went.
 *
 * The body is the composer's json/markdown pair, read the way every other body
 * is (json wins). It is **copied onto the message, variables already filled,
 * when a request is accepted** — so editing or deleting a template never
 * rewrites what already went out (invariant 9). Deleting one is therefore
 * allowed; the messages it produced keep their snapshot and `template_slug`.
 *
 * `is_active` is the off switch: a request naming an inactive template is
 * refused (422) rather than sent, and the caller is told so. Never silently
 * dropped — the refusal is the caller's to see and retry.
 */
export const transactionalTemplates = sqliteTable(
  'transactional_templates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** What `POST /api/send` names. Lowercase, dashes; set once, never renamed. */
    slug: text('slug').notNull(),
    /** What the operator calls it. Never shown to a recipient. */
    name: text('name').notNull(),
    /** May carry `{{variables}}`; filled as plain text at accept time. */
    subject: text('subject').notNull(),
    bodyJson: text('body_json', { mode: 'json' }).$type<DocNode | null>(),
    bodyMd: text('body_md'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at'),
  },
  (t) => [uniqueIndex('transactional_templates_slug_key').on(t.slug)],
)

export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    subscriberId: integer('subscriber_id')
      .notNull()
      .references(() => subscribers.id, { onDelete: 'cascade' }),
    // `confirmation` is a double opt-in confirmation (see `form_confirmations`):
    // system mail with no footer and no tracking, like `transactional`, but
    // blocked by ANY suppression rather than only a bounce or complaint. Nobody
    // who asked for nothing at all gets mail because a stranger typed their address.
    kind: text('kind', {
      enum: ['broadcast', 'sequence', 'transactional', 'form', 'confirmation'],
    }).notNull(),
    // nullable-fk: exactly one source per `kind`; transactional has none.
    broadcastId: integer('broadcast_id').references(() => broadcasts.id, { onDelete: 'cascade' }),
    /**
     * ⭐ A preview copy of a broadcast: the one "send it to me" mail, rendered from
     * this broadcast exactly as a real send would be. It stands in for
     * `broadcast_id`, which stays null on a preview, on purpose.
     *
     * Every count of a broadcast's recipients, opens and clicks reads
     * `broadcast_id` (analytics, signal, pulse, campaigns, conversions…), and a
     * Kit-era broadcast only shows its imported totals while it has *no* message
     * rows at all. So a preview that set `broadcast_id` would add the operator to
     * the audience, and previewing an imported broadcast would replace 13,000
     * recipients with 1. Kept off `broadcast_id`, a preview can't touch a number.
     * It also keeps a cancelled broadcast from swallowing its own preview.
     *
     * No foreign key, deliberately: SQLite can only add one by ALTER without
     * `on delete`, and that would make every previewed broadcast undeletable. A
     * preview pointing at a deleted broadcast is history; the sender treats it
     * as a missing source and never sends it.
     */
    previewBroadcastId: integer('preview_broadcast_id'),
    sequenceStepId: integer('sequence_step_id').references(() => sequenceSteps.id, {
      onDelete: 'cascade',
    }),
    // `set null`, not cascade: deleting a form must not erase the record of the
    // mail it already sent. Only used to find the recipient's download grant at
    // render time — the body itself is snapshotted below.
    formId: integer('form_id').references(() => forms.id, { onDelete: 'set null' }),
    // `set null`, not cascade: deleting a sale must not erase the record of the
    // mail it caused. Set on purchase mail so "did I already thank them for this
    // order?" is one indexed lookup rather than a guess at a time window.
    saleId: integer('sale_id').references(() => sales.id, { onDelete: 'set null' }),
    toEmail: text('to_email').notNull(),
    subject: text('subject').notNull(),
    // Transactional and form-delivery mail only — broadcast and sequence bodies
    // live on their source row so editing the source can't rewrite history for
    // already-sent mail. A form's delivery mail is a *template* the operator
    // keeps editing, so it goes the other way: the body is copied here at queue
    // time and what went out stays what went out (invariant 9).
    bodyMd: text('body_md'),
    bodyJson: text('body_json', { mode: 'json' }).$type<DocNode | null>(),
    /**
     * Per-message merge values the body cannot carry, resolved when the message
     * was queued and frozen here — `{{offer_name}}`, `{{downloads}}`,
     * `{{discord_url}}` and friends.
     *
     * Stored rather than recomputed at send time for two reasons. It is the only
     * record of what a buyer was actually handed (invariant 7: a download link
     * that expired is still a question somebody asks next quarter), and
     * recomputing would let an edit to the catalog silently change what a sent
     * mail claims to contain (invariant 9).
     *
     * Not to be confused with a form's `{{link}}`, which stays a live lookup
     * against `download_grants` because that token never expires.
     */
    extras: text('extras', { mode: 'json' }).$type<MergeExtras | null>(),
    /**
     * The transactional template a `POST /api/send` named, when it named one.
     * A slug, not a foreign key, on purpose: deleting the template must leave
     * the record of which template produced this mail (invariant 7), and the
     * body itself is already snapshotted above, so nothing here is read back.
     */
    templateSlug: text('template_slug'),
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
    // "Has this sale already been thanked?" — asked before every purchase send.
    index('messages_sale_idx').on(t.saleId),
    index('messages_status_idx').on(t.status),
    // "How much mail went out from this template?" — asked before a delete.
    // Partial, because all but a sliver of messages name no template.
    index('messages_template_slug_idx')
      .on(t.templateSlug)
      .where(sql`template_slug is not null`),
    // The event log (`core/event-log.ts`) walks recent mail newest-first to find
    // failures, holds and single sends, and stops at a page. Without this every
    // Logs page would scan the whole table, which is every mail ever sent.
    index('messages_created_idx').on(t.createdAt),
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
    // `unsubscribe` is the one type that is not a provider webhook: it is written
    // by the preference centre when a reader acts on a consent choice, against the
    // message that brought them there. That makes "what did this send cost me?"
    // the same query shape as opens and clicks, instead of a guess at a time window.
    type: text('type', {
      enum: ['delivered', 'open', 'click', 'bounce', 'complaint', 'failed', 'unsubscribe'],
    }).notNull(),
    occurredAt: ts('occurred_at').notNull(),
    meta: text('meta', { mode: 'json' }).notNull().$type<Record<string, unknown>>().default({}),
    // Idempotency for replayed provider webhooks (SPEC 5.3).
    dedupeKey: text('dedupe_key'),
    /**
     * ⭐ A machine fetched this, not a reader: Apple Mail Privacy Protection,
     * an image prefetcher, a corporate link scanner (Kōlea SPEC 11.2). Decided
     * once, at the pixel, by `core/machine-opens.ts`; the reason and the user
     * agent ride in `meta`.
     *
     * A column, not a meta key, because every reader count in the app filters on
     * it — `json_extract` in twenty WHERE clauses is twenty chances to forget one.
     * The row is still written: "how much of my open rate is Apple?" is a fair
     * question, and dropping the hit would make it unanswerable.
     *
     * Only ever true for `open`. A click is a person deciding to go somewhere and
     * stays untouched; provider events (webhooks) carry no request to judge, and
     * history imported before this column existed defaults to false — it is what
     * the counts always said.
     */
    machine: integer('machine', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    index('events_message_type_idx').on(t.messageId, t.type),
    // The activity pulse: "what got opened this week". Without it every
    // windowed engagement query walks the whole table, which grows ~20k a month.
    index('events_occurred_idx').on(t.occurredAt),
    uniqueIndex('events_dedupe_key').on(t.dedupeKey).where(sql`dedupe_key is not null`),
  ],
)

// ─────────────────────────────────────────────────────────── activities

/**
 * ⭐ The story of a person, as told by us.
 *
 * Deliberately a SECOND log beside `events`, not an extension of it. The
 * difference is who is speaking:
 *
 *   `events`     — what the PROVIDER told us about a MESSAGE. Foreign truth,
 *                  webhook-shaped, replayable, `message_id NOT NULL`.
 *   `activities` — what KŌLEA did or observed about a PERSON. Our own truth,
 *                  written at the point of decision in `core/`.
 *
 * Making `events.message_id` nullable to fit both in one table was the obvious
 * shortcut and the wrong one: it weakens the only FK that makes "what did this
 * send cost me?" answerable, and mixes two things with different retention,
 * different idempotency and different trust.
 *
 * ⭐ The rule for what belongs here: **log the transitions that state tables
 * overwrite.** `sequence_enrollments.next_step_id` moves on every tick and
 * `.status` flips `active` → `completed`; both facts are destroyed in place, so
 * both are logged. A sequence step being *sent* is NOT logged — `messages` already
 * records every send with `sent_at`, and two places to count the same mail is two
 * places to get it wrong. The feed joins `messages` for the mail and `activities`
 * for the person.
 */
export const activities = sqliteTable(
  'activities',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    subscriberId: integer('subscriber_id')
      .notNull()
      .references(() => subscribers.id, { onDelete: 'cascade' }),
    type: text('type', {
      enum: [
        // arrival
        'subscribed',
        'pending_added',
        'promoted',
        'imported',
        'form_submitted',
        // consent — every one of these is a change to what we may send
        'unsubscribed',
        'resubscribed',
        'unsubscribed_all',
        'suppressed',
        'unsuppressed',
        'bounced',
        'complained',
        // sequences
        'sequence_enrolled',
        'sequence_advanced',
        'sequence_completed',
        'sequence_cancelled',
        'sequence_opted_out',
        'sequence_rejoined',
        // labels
        'tagged',
        'untagged',
        // attribution + money
        'touched',
        'purchased',
        'refunded',
      ],
    }).notNull(),
    occurredAt: ts('occurred_at').notNull(),
    /** nullable-fk: most activity has no campaign, and deleting one must not
        delete the history of what happened under it. */
    campaignId: integer('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    /** nullable-fk: the other axis worth grouping by. Set null for the same reason. */
    sequenceId: integer('sequence_id').references(() => sequences.id, { onDelete: 'set null' }),
    /**
     * HOW the write happened, not what it did. This is the column that keeps a
     * 13.7k-row backfill from reading as the best signup day in the list's
     * history: everything historical lands as `import`, and every growth chart
     * excludes it. Without this the log is actively misleading on day one.
     */
    source: text('source', {
      enum: ['web', 'site', 'form', 'api', 'mcp', 'cron', 'queue', 'stripe', 'import', 'system'],
    })
      .notNull()
      .default('system'),
    /** form_id, step_id, tag_id, amount_cents, reason — everything that is not a
        group-by target. Deliberately not FKs: a deleted form must not erase the
        history of how somebody arrived (same call as `attributions.source_id`). */
    meta: text('meta', { mode: 'json' }).notNull().$type<Record<string, unknown>>().default({}),
    /** Idempotency, same trick as `events.dedupe_key`. A replayed Stripe webhook
        or a double-tapped preference link must leave one row, not two. */
    dedupeKey: text('dedupe_key'),
  },
  (t) => [
    // The per-person timeline: "everything about this human, newest first".
    index('activities_subscriber_idx').on(t.subscriberId, t.occurredAt),
    // The feed and every health chart: "what happened on the list this week",
    // filtered by type. Leading with `occurred_at` because the feed is always
    // time-ordered and the type filter is a refinement of it.
    index('activities_occurred_idx').on(t.occurredAt),
    index('activities_type_idx').on(t.type, t.occurredAt),
    // Sequence funnels group by (sequence, type) over the whole table.
    index('activities_sequence_idx').on(t.sequenceId, t.type),
    uniqueIndex('activities_dedupe_key').on(t.dedupeKey).where(sql`dedupe_key is not null`),
  ],
)

// Global kill switch. Keyed by ADDRESS, not subscriber: bounced and transactional
// addresses may have no subscriber row at all.
//
// `pruned` is what a list clean-up leaves behind for a deleted person who had
// left the newsletter (`subscribers.status = 'unsubscribed'`). Their row is
// gone, so without this a re-import would bring them back `active` and the next
// broadcast would reach somebody who said no (Kōlea SPEC 1.6, 8.3.4). A deleted
// bounced or complained person keeps `hard_bounce` / `complaint` instead, so
// transactional mail stays blocked for them too. Text enum, no CHECK: adding a
// value needs no migration.
export const suppressions = sqliteTable(
  'suppressions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    email: text('email').notNull(),
    reason: text('reason', {
      enum: ['unsubscribed_all', 'hard_bounce', 'complaint', 'manual', 'pruned'],
    }).notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [uniqueIndex('suppressions_email_key').on(t.email)],
)

/**
 * ⭐ A list clean-up: groups of people picked for deletion, the exact people
 * they held when the operator planned it, and how far the delete has got.
 *
 * The record of a destructive act, so it is a row and not a log line: the
 * people are gone afterwards and this is the only trace of how many, from
 * which groups, and when (Kōlea's `subscribers.pruned` audit entry).
 *
 * `subscriber_ids` is a snapshot taken at plan time, so the backup CSV and the
 * delete cover exactly the same people. The delete still re-checks every id
 * against the group rules as it goes (a person who opened a mail, bought
 * something or has mail queued since the plan is skipped, never deleted), and
 * `skipped` counts them. It pages through the snapshot with `position` because
 * D1 allows 1,000 queries per invocation; a big clean-up finishes over several
 * presses of Continue, and `status` stays `running` until it does.
 *
 * Ids rather than addresses: the snapshot should not outlive the people as a
 * list of email addresses. Once the run is done the ids point at nothing.
 */
export const listPrunes = sqliteTable(
  'list_prunes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    groups: text('groups', { mode: 'json' }).notNull().$type<string[]>(),
    /** The "no open or click in N days" window for `never_engaged`. */
    inactiveDays: integer('inactive_days').notNull(),
    subscriberIds: text('subscriber_ids', { mode: 'json' }).notNull().$type<number[]>(),
    /** People per group at plan time: what the confirm step names. */
    planned: text('planned', { mode: 'json' }).notNull().$type<Record<string, number>>(),
    total: integer('total').notNull(),
    /** Index into `subscriber_ids` the next page starts at. */
    position: integer('position').notNull().default(0),
    deleted: integer('deleted').notNull().default(0),
    /** People per group actually deleted. */
    deletedByGroup: text('deleted_by_group', { mode: 'json' })
      .notNull()
      .$type<Record<string, number>>()
      .default({}),
    /** In the snapshot but no longer prunable when their page came round. */
    skipped: integer('skipped').notNull().default(0),
    status: text('status', { enum: ['planned', 'running', 'done', 'cancelled'] })
      .notNull()
      .default('planned'),
    backedUpAt: ts('backed_up_at'),
    createdAt: ts('created_at').notNull(),
    confirmedAt: ts('confirmed_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('list_prunes_created_idx').on(t.createdAt)],
)

export type ListPrune = typeof listPrunes.$inferSelect

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
     *
     * `read` is for the REST API to come (Kōlea SPEC 20.1): it reads, and it can
     * neither send nor reach MCP. MCP stays `admin`-only rather than filtering
     * its tools by scope, because one gate at the door is a gate that cannot be
     * forgotten on the 104th tool. Widening the enum is not a migration: SQLite
     * stores it as text and the app is the only writer.
     */
    scope: text('scope', { enum: ['send', 'read', 'admin'] })
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
    // nullable-fk: set instead of `api_key_id` when the caller came in by OAuth
    // (`/mcp`, an app the operator approved). A call carries one or the other,
    // never both — they are two doors into the same tools.
    oauthGrantId: integer('oauth_grant_id').references((): AnySQLiteColumn => oauthGrants.id, {
      onDelete: 'set null',
    }),
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
 * ⭐ What an agent may do that cannot be taken back. One row (`id = 1`), the
 * same single-row shape as `site_settings`; no row reads as both switches off.
 *
 * - `allowSend`: MCP tools may put mail on the wire. Replaces flipping
 *   `MCP_ALLOW_SEND` and redeploying; the var survives only as a hard override
 *   that can force sending off (`core/agents.ts`).
 * - `allowSensitive`: MCP tools may make changes that carry data out or put
 *   mail in front of someone who left (delete, suppression removal, import,
 *   minting keys). An agent reads text strangers wrote, and that text can
 *   steer it (ported from Kōlea's `allow_agent_sensitive`).
 *
 * Both default off. No MCP tool writes this table: the switch exists to stop
 * the agent that holds a key, so only the operator's screen flips it.
 */
export const agentSettings = sqliteTable('agent_settings', {
  id: integer('id').primaryKey(),
  allowSend: integer('allow_send', { mode: 'boolean' }).notNull().default(false),
  allowSensitive: integer('allow_sensitive', { mode: 'boolean' }).notNull().default(false),
  updatedAt: ts('updated_at').notNull(),
})

export type AgentSettings = typeof agentSettings.$inferSelect

/**
 * ⭐ The audit trail for people and keys: every write to the admin console and
 * every call to the key-authenticated API (`/api/send`, `/api/sales`), refusals
 * included. Agents are already recorded, call by call, in `mcp_calls` above; the
 * Logs page reads both, so an agent's change is not written twice.
 *
 * Written by ONE middleware (`web/audit.ts`) around the mutating routes, not by
 * each handler: a trail that depends on every new handler remembering to call
 * it is a trail with holes in it. The outcome is read off the response (2xx/3xx
 * ok, 4xx or a `kind=warn` redirect denied, 5xx error), and a route can mark a
 * refusal explicitly where its response does not show one.
 *
 * Request bodies stay out. `summary` holds a few allowlisted fields (name,
 * subject, status…) so "what did they change" is answerable; tokens, keys and
 * passwords never reach it (see `summarize` in `core/audit.ts`).
 *
 * Not pruned: this is the record of who changed what, and "who sent that?" has
 * to be answerable next quarter. One row per operator click is small.
 */
export const auditEntries = sqliteTable(
  'audit_entries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: ts('at').notNull(),
    /** `agent` is never written here — agents live in `mcp_calls`. */
    actorKind: text('actor_kind', { enum: ['operator', 'key'] }).notNull(),
    /**
     * The Cloudflare Access email for an operator (null if Access passed no
     * email; `dev-bypass` under DEV_AUTH_BYPASS), or the key id as text. Text
     * rather than an FK because an operator is not a row in this database.
     */
    actorId: text('actor_id'),
    /** nullable-fk: set for key actors; a revoked or deleted key keeps its history. */
    apiKeyId: integer('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    /** Method and route pattern, ids replaced: `POST /broadcasts/:id/send`. */
    action: text('action').notNull(),
    /** What it was done to, from the path: `broadcasts/12`. Null for collections. */
    target: text('target'),
    outcome: text('outcome', { enum: ['ok', 'denied', 'error'] }).notNull(),
    /** Why it was refused or failed, one line. Never a stack. */
    detail: text('detail'),
    /** The HTTP status the caller got. 0 when the handler threw. */
    status: integer('status').notNull().default(0),
    summary: text('summary', { mode: 'json' }).notNull().$type<Record<string, string>>().default({}),
  },
  (t) => [
    index('audit_entries_at_idx').on(t.at),
    index('audit_entries_outcome_idx').on(t.outcome, t.at),
  ],
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
    // TS-level enum only (no CHECK), so a new kind needs no migration.
    kind: text('kind', { enum: ['broadcast_send', 'sequence_activate', 'undelivered_send_again'] }).notNull(),
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

// ─────────────────────────────────────────────────────────── MCP by OAuth

/**
 * Adding the mailer to Claude by pasting a URL (MCP authorization spec, OAuth
 * 2.1). The Worker is both the resource server (`/mcp`) and its own
 * authorization server; the operator approving on the consent page — behind
 * Cloudflare Access — *is* the authentication. Rules: `core/oauth.ts`.
 *
 * A client that registered itself (RFC 7591). Public, no secret: anyone on the
 * internet can register one, which is why a client is worth nothing until the
 * operator approves it, and why the consent page shows `redirect_uris` — that
 * is where the code goes.
 */
export const oauthClients = sqliteTable(
  'oauth_clients',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** The opaque public id handed back by registration. Not a secret. */
    clientId: text('client_id').notNull(),
    /** Self-declared, so it is a claim, not an identity. Shown escaped, capped at 100. */
    clientName: text('client_name').notNull(),
    /**
     * The exact URIs a code may be sent to: https, or http to loopback (RFC
     * 8252), never a fragment. Matched exactly — no prefix, no wildcard — since
     * a loose match is how codes get redirected to an attacker.
     */
    redirectUris: text('redirect_uris', { mode: 'json' }).notNull().$type<string[]>(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [uniqueIndex('oauth_clients_client_id_key').on(t.clientId)],
)

/**
 * ⭐ One approval: "this app may use the mailer". The row the operator sees on
 * Connected apps and revokes; every token hangs off it, so revoking here kills
 * the access token in hand *and* the refresh token that would mint the next.
 *
 * `access` defaults to `read`. An agent reads text strangers wrote (names, form
 * answers), and that text can steer it, so changing anything is something the
 * operator ticks on the consent page, never something a client asks its way into.
 * `write` gets exactly what an admin key gets — the send switch, preflight and
 * confirm guards still apply on top.
 *
 * Revoke, don't delete: `mcp_calls.oauth_grant_id` points here, and "what did
 * that app do before I cut it off" has to resolve.
 */
export const oauthGrants = sqliteTable(
  'oauth_grants',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clientId: integer('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    access: text('access', { enum: ['read', 'write'] })
      .notNull()
      .default('read'),
    /** The redirect URI the approval was for — what the operator saw. */
    redirectUri: text('redirect_uri').notNull(),
    /** The Access identity that approved, when Access supplied one. Null under DEV bypass. */
    approvedBy: text('approved_by'),
    createdAt: ts('created_at').notNull(),
    /** Bumped on every MCP call and every refresh. */
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('oauth_grants_client_idx').on(t.clientId)],
)

/**
 * A one-time authorization code. Hash only, two minutes, single use, bound to
 * the client, the exact redirect URI and a PKCE S256 challenge. Redeeming one
 * sets `used_at` (a conditional update, so two racing exchanges cannot both
 * win) and `grant_id`; presenting it again revokes that grant (OAuth 2.1
 * §4.1.3) — a replayed code means somebody else has it too.
 *
 * The grant does not exist until the code is redeemed: an approval nobody
 * exchanged is not a connected app.
 */
export const oauthCodes = sqliteTable(
  'oauth_codes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    codeHash: text('code_hash').notNull(),
    clientId: integer('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    /** base64url(SHA-256(verifier)), 43 chars. `plain` is never accepted. */
    codeChallenge: text('code_challenge').notNull(),
    access: text('access', { enum: ['read', 'write'] }).notNull(),
    approvedBy: text('approved_by'),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    // nullable-fk: null until the code is redeemed and the grant exists.
    grantId: integer('grant_id').references(() => oauthGrants.id, { onDelete: 'cascade' }),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [uniqueIndex('oauth_codes_hash_key').on(t.codeHash)],
)

/**
 * Bearer tokens, hash only. `access` lives an hour and is what `/mcp` accepts;
 * `refresh` lives thirty days and is what the token endpoint accepts. Rotation:
 * a refresh token is good once — using it sets `used_at` and issues a new pair.
 * Presenting a used one again revokes the whole grant (OAuth 2.1 §4.3.1),
 * because only a thief and the rightful client both hold the old one.
 */
export const oauthTokens = sqliteTable(
  'oauth_tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    grantId: integer('grant_id')
      .notNull()
      .references(() => oauthGrants.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['access', 'refresh'] }).notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: ts('expires_at').notNull(),
    /** Refresh tokens only: when it was rotated away. */
    usedAt: ts('used_at'),
    revokedAt: ts('revoked_at'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('oauth_tokens_hash_key').on(t.tokenHash),
    index('oauth_tokens_grant_idx').on(t.grantId),
  ],
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

// ─────────────────────────────────────────────────────────── importers

/** The tools the background importers read from. One adapter each, in `providers/importers/`. */
export const IMPORT_SOURCES = ['kit', 'ghost', 'mailchimp', 'drip'] as const
export type ImportSourceId = (typeof IMPORT_SOURCES)[number]

/** The run's lifecycle. Only `core/importers/runs.ts` `nextImportStatus()` moves it. */
export const IMPORT_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const
export type ImportStatus = (typeof IMPORT_STATUSES)[number]

/** A line for the report: something the run left behind or did on purpose, counted. */
export interface ImportNote {
  key: string
  count: number
  message: string
}

/**
 * One run of an importer from another tool (Kit, Ghost, Mailchimp, Drip).
 *
 * ⭐ The run holds no state in memory. The minutely cron reads this row, asks the
 * source for exactly one page at `(phase, cursor)`, writes that page, and writes
 * the next `(phase, cursor)` back here — so a run survives a deploy, a crash or a
 * week of nobody looking, and resumes on the exact page. A page re-read after a
 * crash between "write rows" and "write cursor" is harmless: every write it
 * makes is idempotent (unique email, `ON CONFLICT DO NOTHING` on tags and
 * suppressions, `imported_source_id` on content).
 *
 * The page is deliberately small. D1 allows 1,000 queries per invocation and the
 * same tick also drives sequences; the cron skips the import step altogether in
 * a minute that has a broadcast to push, because mail outranks migration.
 *
 * `credentials` is the operator's API key for the other tool, as JSON. It is
 * never selected by a screen (see `importRunColumns`), never echoed back, and
 * set to NULL the moment the run reaches any terminal status — a finished
 * import keeps no key to a system we are leaving.
 */
export const importRuns = sqliteTable(
  'import_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    source: text('source', { enum: IMPORT_SOURCES }).notNull(),
    status: text('status', { enum: IMPORT_STATUSES }).notNull().default('queued'),
    /** What the operator typed that is safe to show: a Ghost URL, a Mailchimp list id, a Drip account id. */
    settings: text('settings', { mode: 'json' }).notNull().$type<Record<string, string>>().default({}),
    /** Secret. NULL once the run ends. Never selected for display. */
    credentials: text('credentials'),
    /** The phase being read (`subscribers`, `broadcasts`, …). Null once done. */
    phase: text('phase'),
    /** The source's own cursor within `phase` — Kit's `end_cursor`, a page number,
        an offset. Opaque to everything but that source's adapter. Null = first page. */
    cursor: text('cursor'),
    phasesDone: integer('phases_done').notNull().default(0),
    phasesTotal: integer('phases_total').notNull().default(0),
    pages: integer('pages').notNull().default(0),
    /** New rows: people, broadcasts, sequences. */
    created: integer('created').notNull().default(0),
    /** People already here who matched — gained tags, a name, or a narrower status. */
    updated: integer('updated').notNull().default(0),
    /** Read and deliberately not written: unknown status, suppressed here, drafts, already imported. */
    skipped: integer('skipped').notNull().default(0),
    /** Addresses that cannot be stored. */
    invalid: integer('invalid').notNull().default(0),
    /** The same numbers by entity — tags, taggings, suppressions, sequence_steps… */
    detail: text('detail', { mode: 'json' }).notNull().$type<Record<string, number>>().default({}),
    notes: text('notes', { mode: 'json' }).notNull().$type<ImportNote[]>().default([]),
    /** The most recent failure, readable by a person. Kept after a later page succeeds. */
    lastError: text('last_error'),
    /** Consecutive failed pages. Three in a row and the run fails for good. */
    failures: integer('failures').notNull().default(0),
    /** A lease, so two overlapping cron invocations never read the same page twice. */
    lockedUntil: ts('locked_until'),
    createdAt: ts('created_at').notNull(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [index('import_runs_status_idx').on(t.status, t.createdAt)],
)

export type ImportRun = typeof importRuns.$inferSelect

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
export type TransactionalTemplate = typeof transactionalTemplates.$inferSelect
export type Tag = typeof tags.$inferSelect
export type Segment = typeof segments.$inferSelect
export type TagRule = typeof tagRules.$inferSelect
export type Broadcast = typeof broadcasts.$inferSelect
export type Sequence = typeof sequences.$inferSelect
export type SequenceTemplateRow = typeof sequenceTemplates.$inferSelect
export type SequenceStep = typeof sequenceSteps.$inferSelect
export type SequenceExit = typeof sequenceExits.$inferSelect
export type SequenceEnrollment = typeof sequenceEnrollments.$inferSelect
export type Message = typeof messages.$inferSelect
export type Event = typeof events.$inferSelect
export type Suppression = typeof suppressions.$inferSelect
export type DevOutboxItem = typeof devOutbox.$inferSelect
export type Campaign = typeof campaigns.$inferSelect
export type Attribution = typeof attributions.$inferSelect
export type Form = typeof forms.$inferSelect
export type DownloadGrant = typeof downloadGrants.$inferSelect
export type Sale = typeof sales.$inferSelect
export type ApiKey = typeof apiKeys.$inferSelect
export type McpCall = typeof mcpCalls.$inferSelect
export type AuditEntry = typeof auditEntries.$inferSelect
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

// ──────────────────────────────────────────── store: offers & checkouts

/**
 * What the public site sells. One row per product the operator put on sale.
 *
 * ⚠️ A separate table, not a `for_sale` column on `stripe_products`: the
 * catalog is a mirror Stripe owns and the sync overwrites, and "Rob wants this
 * on the site" is not Stripe's fact to overwrite. Taking a product off sale
 * deletes this row and nothing else — checkouts already started keep their own
 * copy of the price, and sales never point here.
 *
 * The page is `/offers/<slug>`. The slug defaults to the product's
 * `metadata.sku` (the key purchase mail and conversions already agree on) and
 * is the operator's to change. A price that goes inactive in Stripe takes the
 * page down by itself (checked on every view and every Buy), so this row can
 * outlive a price without the site selling something Stripe would refuse.
 */
export const storeOffers = sqliteTable(
  'store_offers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** One listing per product. Cascades: a product gone from the mirror is not
        for sale, and a dangling listing would be a page that cannot sell. */
    productId: text('product_id')
      .notNull()
      .references(() => stripeProducts.id, { onDelete: 'cascade' }),
    /** The one price Buy opens. One-time only: Checkout runs in payment mode,
        and a recurring price is Members/Premium, not the store. */
    priceId: text('price_id')
      .notNull()
      .references(() => stripePrices.id, { onDelete: 'cascade' }),
    /** `/offers/<slug>`. `[a-z0-9-]`, never `return` or `cancel`. */
    slug: text('slug').notNull(),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('store_offers_product_key').on(t.productId),
    uniqueIndex('store_offers_slug_key').on(t.slug),
  ],
)

/**
 * ⭐ Every Checkout a reader starts, written BEFORE Stripe is asked (Kōlea
 * SPEC 16.7.4.1, its `offer_checkouts`).
 *
 * The row is what the webhook trusts. Its `token` rides to Stripe as
 * `metadata.bm_checkout` and `client_reference_id`, and `checkout.session.
 * completed` is matched back to it only when the session id is the one this
 * row opened — a session naming somebody else's token completes nothing.
 *
 * It holds the converting post (the broadcast whose link brought the reader to
 * Buy), because that is a fact only the click knows: by the time the webhook
 * lands, the reader is a charge and an email address. No email is kept here;
 * Stripe collects it, and the sale has it. `ip` exists for the hourly cap.
 */
export const storeCheckouts = sqliteTable(
  'store_checkouts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 40 random characters. In the return URL and in Stripe's metadata. */
    token: text('token').notNull(),
    /** Frozen at Buy. Not an FK to `store_offers`: taking a product off sale
        must not erase the record of a checkout already paid for. */
    stripePriceId: text('stripe_price_id').notNull(),
    stripeProductId: text('stripe_product_id').notNull(),
    offerSlug: text('offer_slug').notNull(),
    /** What Stripe was asked to charge, so the row reads without the catalog. */
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull(),
    // nullable-fk: the post the reader came from, validated at Buy against the
    // published posts. Null for a reader who arrived any other way. `set null`
    // so unpublishing or deleting a post never touches money.
    convertedFromBroadcastId: integer('converted_from_broadcast_id').references(
      () => broadcasts.id,
      { onDelete: 'set null' },
    ),
    // nullable-fk: the buyer, once the sale says who that is. The site has no
    // reader sign-in, so this is never known at Buy.
    subscriberId: integer('subscriber_id').references(() => subscribers.id, {
      onDelete: 'set null',
    }),
    // nullable-fk: set when the webhook books the money.
    saleId: integer('sale_id').references(() => sales.id, { onDelete: 'set null' }),
    /** started → open (Stripe answered) → completed (webhook booked it), or
        failed (Stripe refused to open one; `lastError` says why). */
    status: text('status', { enum: ['started', 'open', 'completed', 'failed'] })
      .notNull()
      .default('started'),
    stripeSessionId: text('stripe_session_id'),
    lastError: text('last_error'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: ts('created_at').notNull(),
    completedAt: ts('completed_at'),
  },
  (t) => [
    uniqueIndex('store_checkouts_token_key').on(t.token),
    index('store_checkouts_ip_idx').on(t.ip, t.createdAt),
    index('store_checkouts_broadcast_idx').on(t.convertedFromBroadcastId),
    index('store_checkouts_sale_idx').on(t.saleId),
  ],
)

export type StoreOffer = typeof storeOffers.$inferSelect
export type StoreCheckout = typeof storeCheckouts.$inferSelect

export type StripeEvent = typeof stripeEvents.$inferSelect
export type StripeProduct = typeof stripeProducts.$inferSelect
export type StripePrice = typeof stripePrices.$inferSelect
export type SaleItem = typeof saleItems.$inferSelect

// ─────────────────────────────────────────────────── conversions & goals

/**
 * ⭐ What counts as a conversion — as data, not an enum.
 *
 * Rob's funnel has more than two ends: bought something, signed up yearly,
 * joined a cohort, and whatever comes next. An enum would make each of those a
 * schema migration, so the *names* live here and only the *detection* stays in
 * code (`classifyKind` in core/conversions.ts).
 *
 * `ruleType` is the small closed set of ways a sale can be recognised:
 *
 *   `price_interval` — `ruleValue` is a Stripe interval ('year'). The only
 *      durable way to spot a subscription: of ~359 live yearly subs, 6 sit on
 *      the product tagged `sku: yearly`, so product and offer both lie here.
 *   `offer_in` — `ruleValue` is a comma-separated list of offer slugs. Cohorts
 *      are just specific offers; The Pivot is one already.
 *   `any_sale` — the catch-all. Whatever fell through is a purchase.
 *   `manual` — never matched automatically. For goals fed by hand or by
 *      something that isn't a Stripe sale at all.
 *
 * `priority` orders the walk, lowest first, and the FIRST match wins. That is
 * what keeps "one row per sale, most specific kind" true: a yearly subscription
 * is also a sale, and matching both would double every revenue sum.
 */
export const conversionKinds = sqliteTable(
  'conversion_kinds',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    slug: text('slug').notNull(),
    label: text('label').notNull(),
    ruleType: text('rule_type', {
      enum: ['price_interval', 'offer_in', 'any_sale', 'manual'],
    })
      .notNull()
      .default('manual'),
    /** Interpreted per `ruleType`. Null for `any_sale` and `manual`. */
    ruleValue: text('rule_value'),
    /** Lowest first, first match wins. Leave gaps so a kind can be slotted between. */
    priority: integer('priority').notNull().default(100),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('conversion_kinds_slug_key').on(t.slug),
    index('conversion_kinds_priority_idx').on(t.priority),
  ],
)

/**
 * ⭐ The bottom of the funnel: sent → opened → clicked → **converted**.
 *
 * `sales` records that money moved. This records that a *goal was reached*, and
 * freezes the path the person took to reach it.
 *
 * ## One row per sale
 *
 * `sale_id` is UNIQUE, which is both the "most specific kind wins" rule and the
 * idempotency guard against Stripe's at-least-once webhook delivery.
 *
 * ## ⚠️ No refund status, on purpose
 *
 * A sale is a sale (Rob's call, and he refunds for all sorts of reasons that say
 * nothing about whether the mail worked). The refund itself is not lost — it
 * lives on `sales.status`, where accounting can find it. A conversion is a
 * marketing fact and simply does not track it.
 *
 * ## The frozen path
 *
 * `message_id` is the grain that makes a funnel joinable — `events` already
 * counts opens and clicks per message, so a conversion carrying a message id
 * puts the last step in the same keyspace as the first four. `campaign_id`,
 * `offer_slug` and `kind_slug` are derived and stored anyway: re-running
 * attribution must never silently rewrite last quarter's numbers.
 */
export const conversions = sqliteTable(
  'conversions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    subscriberId: integer('subscriber_id')
      .notNull()
      .references(() => subscribers.id, { onDelete: 'cascade' }),
    // nullable-fk: `set null` so retiring a kind cannot delete the history that
    // was counted under it — `kindSlug` below is what reports actually read.
    kindId: integer('kind_id').references(() => conversionKinds.id, { onDelete: 'set null' }),
    /** Frozen at conversion time. Renaming a kind must not rewrite the past. */
    kindSlug: text('kind_slug').notNull(),
    // nullable-fk: every conversion has a sale today, but a Discord signup or a
    // webinar registration would not, and `value_cents` already carries the money.
    saleId: integer('sale_id').references(() => sales.id, { onDelete: 'set null' }),
    /** Frozen at conversion time. Never recomputed from the sale. */
    valueCents: integer('value_cents').notNull().default(0),
    currency: text('currency').notNull().default('usd'),

    // ── the attribution path, frozen ───────────────────────────────────────
    // nullable-fk: null when nobody clicked anything inside the window, which is
    // the honest answer for a direct sale.
    messageId: integer('message_id').references(() => messages.id, { onDelete: 'set null' }),
    sourceKind: text('source_kind', {
      enum: ['broadcast', 'sequence', 'form', 'direct'],
    })
      .notNull()
      .default('direct'),
    /** Id of the broadcast/sequence/form. Not a real FK — it points at three
        tables, and a deleted broadcast must not erase how somebody converted.
        0 sentinel rather than NULL, same reasoning as `attributions.source_id`. */
    sourceId: integer('source_id').notNull().default(0),
    // nullable-fk: derived from the message's broadcast/sequence. Most mail is
    // not part of a campaign, and that is not a failure to record.
    campaignId: integer('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    // nullable-fk: resolved via `stripe_products.metadata.sku` → `offers.slug`.
    offerId: integer('offer_id').references(() => offers.id, { onDelete: 'set null' }),
    /** Denormalized and frozen. Null for a membership, which is not an offer. */
    offerSlug: text('offer_slug'),
    /** How the path was decided. `explicit` means a human said so, and no
        automatic pass may overwrite it. */
    attributedBy: text('attributed_by', {
      enum: ['explicit', 'last_touch', 'none'],
    })
      .notNull()
      .default('none'),
    /** Seconds between the click and the conversion. Makes the attribution model
        auditable after the fact instead of a thing you have to trust. */
    touchLagSeconds: integer('touch_lag_seconds'),

    occurredAt: ts('occurred_at').notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('conversions_sale_key').on(t.saleId).where(sql`sale_id is not null`),
    index('conversions_subscriber_idx').on(t.subscriberId),
    index('conversions_message_idx').on(t.messageId),
    index('conversions_campaign_idx').on(t.campaignId),
    index('conversions_offer_idx').on(t.offerSlug),
    // The shape every goal reads: this kind, in this window.
    index('conversions_kind_occurred_idx').on(t.kindSlug, t.occurredAt),
  ],
)

/**
 * ⭐ A target: how many of a kind, over a named period.
 *
 * ## Periods are named, never arbitrary
 *
 * `periodType` + `periodYear` + `periodIndex` — "June 2026", "Q2 2026", "2026".
 * Deliberately NOT a pair of timestamps: a goal running 3 May to 19 July is not
 * comparable to anything, and the whole value of a goal is holding this quarter
 * against the last one. The dates are derived (`core/goals.ts`), so the same
 * label always means the same window.
 *
 * ## Goals overlap on purpose
 *
 * A quarterly goal and a campaign goal both count the same conversion. They are
 * lenses, not buckets — a sale is not "spent" by being counted once. Which also
 * means totals across goals do not sum to anything, and the UI must not imply
 * they do.
 */
export const goals = sqliteTable(
  'goals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    // nullable-fk: null counts EVERY conversion in the window, which is the
    // right shape for "make $40k this quarter, however it arrives".
    kindId: integer('kind_id').references(() => conversionKinds.id, { onDelete: 'cascade' }),
    periodType: text('period_type', { enum: ['month', 'quarter', 'year'] })
      .notNull()
      .default('year'),
    periodYear: integer('period_year').notNull(),
    /** 1–12 for a month, 1–4 for a quarter, ignored for a year. */
    periodIndex: integer('period_index').notNull().default(0),
    /** How many people. Null when the goal is only about money. */
    targetCount: integer('target_count'),
    /** How much money, in cents. Null when the goal is only about headcount. */
    targetCents: integer('target_cents'),
    // nullable-fk: null means "everything in the window", set means "this push".
    campaignId: integer('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('goals_period_idx').on(t.periodYear, t.periodType, t.periodIndex)],
)

export type Conversion = typeof conversions.$inferSelect
export type ConversionKind = typeof conversionKinds.$inferSelect
export type Goal = typeof goals.$inferSelect

/**
 * One row per call to a language model, whoever answered it, successful or not.
 *
 * This is the budget. `core/ai/openrouter.ts` sums `cost_usd` for the current
 * calendar month before every call and refuses once it reaches
 * `AI_MONTHLY_BUDGET_USD`, so the cap holds even if the OpenRouter key has no
 * limit of its own. A row, not a log line: Workers logs are gone in days and a
 * monthly total has to survive the month.
 *
 * Nothing in here is subscriber data. The prompt and the reply are not stored,
 * only what they cost: the draft already lives on its own row.
 */
export const aiCalls = sqliteTable(
  'ai_calls',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** What it was for: an `AiTask` (`subject`, `cleanup`, `sequence-plan`, `sequence-mail`, …). */
    task: text('task').notNull(),
    /** The OpenRouter model id that answered, e.g. `anthropic/claude-sonnet-5`. */
    model: text('model').notNull(),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    /**
     * What the call cost, in US dollars: as OpenRouter reported it, or our
     * estimate when the provider reports no cost (`cost_estimated`). A real, not
     * integer cents: a subject line costs a fraction of a cent, and rounding
     * every call to zero would make the budget a budget for nothing.
     */
    costUsd: real('cost_usd').notNull().default(0),
    ok: integer('ok', { mode: 'boolean' }).notNull(),
    /** Why it failed, when it did. */
    error: text('error'),
    durationMs: integer('duration_ms').notNull().default(0),
    /**
     * Whose endpoint answered: `openrouter` (the install's key or the
     * operator's own), `anthropic`, `openai`, or `fake` locally. The budget sums
     * every row whatever the provider; this is for the settings screen.
     */
    provider: text('provider', { enum: ['openrouter', 'anthropic', 'openai', 'fake'] })
      .notNull()
      .default('openrouter'),
    /**
     * True when `cost_usd` is our estimate (tokens × `core/ai/catalogue.ts`'s
     * list price) rather than a figure the provider reported. Anthropic and
     * OpenAI report tokens, not money. A model with no list price is recorded
     * at 0 with this set, and the settings screen says so.
     */
    costEstimated: integer('cost_estimated', { mode: 'boolean' }).notNull().default(false),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('ai_calls_created_idx').on(t.createdAt)],
)

export type AiCall = typeof aiCalls.$inferSelect

/**
 * Which key pays for the writing helpers, and which model each one uses.
 * Exactly one row (`id = 1`), created on first save. No row means the old
 * behaviour exactly: the install's `OPENROUTER_KEY` pays and every helper uses
 * its default (or its `AI_MODEL_*` variable), so an install that never opens
 * Settings → AI is unchanged.
 *
 * Its own table rather than a column on some general settings row: nothing
 * else reads it, and the agent settings live elsewhere.
 */
export const aiSettings = sqliteTable('ai_settings', {
  id: integer('id').primaryKey(),
  /**
   * `env` is the install's `OPENROUTER_KEY`. The others name a row in
   * `ai_keys`. A payer whose key is missing or unreadable turns the helpers
   * off with a sentence on the settings screen; it never quietly falls back to
   * a different key, because which key pays is the operator's decision.
   */
  payer: text('payer', { enum: ['env', 'openrouter', 'anthropic', 'openai'] }).notNull().default('env'),
  /**
   * Helper task (`subject`, `cleanup`, `sequence-plan`, …) → model id, only
   * for the helpers the operator changed. Checked against the catalogue on
   * write and again on read: a choice the paying key cannot serve falls back
   * to that key's default rather than being sent unchecked.
   */
  models: text('models', { mode: 'json' }).notNull().$type<Record<string, string>>().default({}),
  updatedAt: ts('updated_at').notNull(),
})

export type AiSettings = typeof aiSettings.$inferSelect

/**
 * The operator's own model API keys, one per provider, encrypted at rest.
 *
 * `ciphertext` is AES-GCM under a key derived from `AI_KEY_ENCRYPTION_SECRET`
 * (`core/ai/keys.ts`), with the provider name as associated data so a row
 * cannot be moved to another provider. Without that secret nothing is stored.
 * The key is never shown again: `last4` is all any screen reads.
 */
export const aiKeys = sqliteTable('ai_keys', {
  provider: text('provider', { enum: ['openrouter', 'anthropic', 'openai'] }).primaryKey(),
  /** `v1:<iv base64>:<ciphertext base64>`. */
  ciphertext: text('ciphertext').notNull(),
  last4: text('last4').notNull(),
  createdAt: ts('created_at').notNull(),
})

export type AiKey = typeof aiKeys.$inferSelect

// ─────────────────────────────────────────────────────────── post tags
//
// ⚠️ NOT `tags`. Those are on *people*: they drive segments, tag rules and
// `tag_added` sequence triggers, so a tag there can put mail in someone's inbox.
// These are on *posts* and do exactly one thing — organise the public site.
// Sharing a table would make "tag this post AI" and "enroll everyone tagged AI"
// the same write, which is how a blog change turns into a send.

/**
 * A topic on the public site. Its slug is a URL segment: a post whose primary
 * tag is `ai` lives at `/ai/<post-slug>`, and `/ai` is the tag's archive.
 */
export const postTags = sqliteTable(
  'post_tags',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Gets a shelf of its newest posts on the front page. Off until the operator ticks it. */
    showOnHome: integer('show_on_home', { mode: 'boolean' }).notNull().default(false),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [uniqueIndex('post_tags_slug_key').on(t.slug)],
)

/**
 * Which tags a post carries, in order. Position 0 is the **primary tag** — the
 * one in the URL. Ordered rather than flagged so there is exactly one primary by
 * construction: a boolean `is_primary` column could be true on two rows.
 */
export const broadcastPostTags = sqliteTable(
  'broadcast_post_tags',
  {
    broadcastId: integer('broadcast_id')
      .notNull()
      .references(() => broadcasts.id, { onDelete: 'cascade' }),
    postTagId: integer('post_tag_id')
      .notNull()
      .references(() => postTags.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.broadcastId, t.postTagId] }),
    // The tag archive's query: every post under one tag.
    index('broadcast_post_tags_tag_idx').on(t.postTagId),
  ],
)

export type PostTag = typeof postTags.$inferSelect

// ─────────────────────────────────────────────────────────── themes
//
// The public site renders through a theme: Handlebars-syntax templates run by
// our own interpreter in `core/theme/` (Workers forbid `eval`, which is what
// Handlebars' own compiler emits). The built-in `kolea` theme ships in the
// bundle and is what renders when no row here is active.

/**
 * An uploaded theme. Templates and `package.json` are text and live in
 * `theme_files`, so loading a whole theme is one query. Everything else (CSS,
 * JS, fonts, images) is bytes, and lives in R2 under `themes/<id>/<path>`.
 */
export const themes = sqliteTable(
  'themes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** `package.json` name, e.g. `casper`. Re-uploading the same name replaces it. */
    name: text('name').notNull(),
    version: text('version').notNull().default('0.0.0'),
    /** The parsed `package.json`, kept whole: `config.custom` defines the settings. */
    packageJson: text('package_json', { mode: 'json' })
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    /** The operator's values for `config.custom`. Keys missing here use the default. */
    settings: text('settings', { mode: 'json' })
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    /** At most one row is active; none active means the built-in theme. */
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
    createdAt: ts('created_at').notNull(),
    /** Part of the render cache key, so a re-upload is never served stale. */
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [uniqueIndex('themes_name_key').on(t.name)],
)

/** A template, partial or `package.json` — the text half of a theme. */
export const themeFiles = sqliteTable(
  'theme_files',
  {
    themeId: integer('theme_id')
      .notNull()
      .references(() => themes.id, { onDelete: 'cascade' }),
    /** Relative to the theme root, forward slashes: `partials/post-card.hbs`. */
    path: text('path').notNull(),
    body: text('body').notNull(),
  },
  (t) => [primaryKey({ columns: [t.themeId, t.path] })],
)

export type Theme = typeof themes.$inferSelect

// ─────────────────────────────────────────────────────────── site settings

/** One link in the author's list: GitHub, X, a podcast, anything. */
export interface SocialLink {
  label: string
  url: string
}

/**
 * Who the site is and who writes it. Exactly one row (`id = 1`), created on
 * first save. Every column is nullable on purpose: null means "not set", and
 * the site falls back to the `SITE_*` environment variables, so an install
 * that has never opened the Profile screen renders exactly as it did before.
 */
export const siteSettings = sqliteTable('site_settings', {
  id: integer('id').primaryKey(),
  title: text('title'),
  tagline: text('tagline'),
  logoUrl: text('logo_url'),
  /**
   * Superseded by the keyed `profile.social` (one URL per network), and no
   * longer read or written. Kept rather than dropped to avoid a migration while
   * nothing in production uses it; safe to remove in a later schema change.
   */
  socialLinks: text('social_links', { mode: 'json' }).notNull().$type<SocialLink[]>().default([]),
  authorName: text('author_name'),
  authorPhotoUrl: text('author_photo_url'),
  /** A few sentences, plain text: the front page's About. */
  shortBio: text('short_bio'),
  /** The /about page, authored in the same editor as a post. */
  longBioJson: text('long_bio_json', { mode: 'json' }).$type<DocNode | null>(),
  longBioMd: text('long_bio_md'),
  /**
   * The front page's structured content: the lede, "What I do", notable links.
   * One JSON document validated by `core/site-profile.ts` on every write, so it
   * can grow new sections without a migration and Claude can edit it through
   * MCP without anyone touching a template.
   */
  profile: text('profile', { mode: 'json' }).notNull().$type<Record<string, unknown>>().default({}),
  /**
   * The operator's IANA time zone (`Pacific/Honolulu`). One for the install, as
   * Kōlea keeps one per account: every sequence's send window is read in it.
   * Null means UTC. Validated against the runtime's own zone list on write, so
   * the tick never meets a name `Intl` cannot read.
   */
  timeZone: text('time_zone'),
  updatedAt: ts('updated_at').notNull(),
})

export type SiteSettings = typeof siteSettings.$inferSelect

// ─────────────────────────────────────────────────────────── page views

/**
 * ⭐ One page of the public site, rendered in a real browser.
 *
 * Written by a beacon on the page, never by the route that served it. Crawlers,
 * feed readers and link unfurlers fetch HTML all day, and a server-side counter
 * would report every one of them as a reader. A beacon only fires where the page
 * actually ran, which is as close to "somebody looked at it" as a counter gets
 * without a cookie.
 *
 * `view_key` is minted by the page and is what lets the second beacon (the one
 * that fires when the tab is hidden) find this row again to set `seconds`. It is
 * unique, so a replayed hit is a no-op rather than a second view.
 *
 * `broadcast_id` is the post, when the page is one — a post IS a broadcast (see
 * `core/posts.ts`), which is what lets the dashboard put web reads beside email
 * reads for the same piece. Set null on delete: a deleted post's traffic still
 * happened, and the path says where.
 *
 * `referrer` is whatever the browser sent, which is usually just an origin —
 * `strict-origin-when-cross-origin` is the default everywhere now. `source` is
 * the `ref` / `utm_source` on the landing URL, the only reliable way to name a
 * link you placed yourself.
 *
 * `visitor` is a daily pseudonym: a hash of the day, IP and user agent, never
 * the IP itself. It rotates at midnight UTC, so it can count "people today" and
 * cannot follow anybody from one day to the next. No cookie is ever set.
 *
 * `day` is `YYYY-MM-DD` text for the same reason as `form_views.day`: the charts
 * group on it without date arithmetic.
 */
export const pageViews = sqliteTable(
  'page_views',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    viewKey: text('view_key').notNull(),
    day: text('day').notNull(),
    occurredAt: ts('occurred_at').notNull(),
    path: text('path').notNull(),
    broadcastId: integer('broadcast_id').references((): AnySQLiteColumn => broadcasts.id, {
      onDelete: 'set null',
    }),
    referrer: text('referrer'),
    referrerHost: text('referrer_host'),
    source: text('source'),
    country: text('country'),
    visitor: text('visitor'),
    /** Seconds the tab was visible. Null until the page is left or hidden. */
    seconds: integer('seconds'),
  },
  (t) => [
    uniqueIndex('page_views_view_key').on(t.viewKey),
    index('page_views_day_idx').on(t.day),
    index('page_views_broadcast_idx').on(t.broadcastId),
    index('page_views_occurred_idx').on(t.occurredAt),
  ],
)

export type PageView = typeof pageViews.$inferSelect

// ─────────────────────────────────────────────────────────── sending domains

/**
 * One DNS record the email provider asks for, as the provider said it when the
 * domain was registered (Kōlea SPEC 6.1.2). Stored, not recomputed: the DKIM key
 * is the provider's and only the provider can say what it is.
 *
 * `return_path` is the bounce domain (Resend's `send.<domain>` MX + TXT, the
 * envelope MAIL FROM): mail whose MAIL FROM is not on the sender's domain fails
 * DMARC's SPF alignment. A provider's *receiving* MX and its own tracking CNAME
 * are never stored: the first would take over the domain's incoming mail, the
 * second would track on the provider's host instead of ours.
 */
export interface ProviderDomainRecord {
  purpose: 'dkim' | 'spf' | 'return_path'
  type: 'TXT' | 'CNAME' | 'MX'
  /** Fully qualified. */
  name: string
  value: string
  /** MX only. */
  priority?: number
}

/**
 * What the last check saw at each record's name, keyed by record id (`dkim1`,
 * `spf`, `return_path1`, `dmarc`, `tracking`). `existing` is a DMARC record of
 * the operator's own, which is left alone and counts as fine.
 */
export type DomainRecordStatus = 'unchecked' | 'found' | 'missing' | 'mismatch' | 'existing'

/**
 * ⭐ A domain mail is sent from (Kōlea SPEC 6.1, ported without the hosted parts:
 * no per-account ownership TXT, no provider sub-accounts, no staff verification).
 *
 * `status` moves only through `core/domains.ts` `transition()`:
 * `pending → verified | failed`, `verified → failed`, `failed → verified`.
 * Verified means every required record answers in DNS **and** the provider says
 * it will sign for the domain. A check that cannot reach the provider or DNS
 * changes nothing: an outage is not the operator's fault (6.1.5).
 *
 * `name` is unique and lowercased: one row per domain, single operator. There
 * is no `removed` status — removing a domain deletes the row, because nothing
 * references it (the From address lives in `FROM_EMAIL`, not on a row).
 *
 * `provider` is the `EMAIL_PROVIDER` the records came from. Switching provider
 * makes the stored records stale; the next check re-registers when it differs.
 * `provider_domain_id` is the provider's handle (Resend's domain id), null until
 * registration succeeds — a provider outage at add time still adds the domain,
 * and the next check registers it.
 *
 * `next_check_at` drives the minutely cron: quick backoff while pending, daily
 * once settled, null when automatic polling has given up (the screen's "Check
 * now" still works). `check_attempt` counts the pending polls for that backoff.
 */
export const sendingDomains = sqliteTable(
  'sending_domains',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    status: text('status', { enum: ['pending', 'verified', 'failed'] })
      .notNull()
      .default('pending'),
    provider: text('provider').notNull(),
    providerDomainId: text('provider_domain_id'),
    /** The provider's own verdict at the last check. Null until it has been asked. */
    providerState: text('provider_state', { enum: ['unverified', 'active', 'failed'] }),
    providerRecords: text('provider_records', { mode: 'json' })
      .notNull()
      .$type<ProviderDomainRecord[]>()
      .default([]),
    recordStatuses: text('record_statuses', { mode: 'json' })
      .notNull()
      .$type<Record<string, DomainRecordStatus>>()
      .default({}),
    /** Why the last check or registration could not finish. Cleared on success. */
    lastError: text('last_error'),
    checkAttempt: integer('check_attempt').notNull().default(0),
    lastCheckedAt: ts('last_checked_at'),
    nextCheckAt: ts('next_check_at'),
    verifiedAt: ts('verified_at'),
    failedAt: ts('failed_at'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('sending_domains_name_key').on(t.name),
    index('sending_domains_next_check_idx').on(t.nextCheckAt),
  ],
)

export type SendingDomain = typeof sendingDomains.$inferSelect
// ─────────────────────────────────────────────────────────── testimonials

/**
 * What a reader said about the writing, in their own words (gap.md
 * "Testimonials", Kōlea `Kolea.Testimonials`).
 *
 * Written only by a **known subscriber**, through the personal link a
 * `{{testimonial_link}}` merge tag puts in a marketing mail. The link carries the
 * subscriber's own token, so opening it *is* the proof of address — there is no
 * email field on the form and no confirmation mail (Kōlea's reading: the token
 * confirms). `subscriber_id` is NOT NULL and cascades: forgetting a person
 * forgets what they wrote.
 *
 * Two owners, two decisions, two columns:
 *   * `may_publish` is the **person's** permission, ticked on the form. Never
 *     editable by the operator — the operator cannot approve what the person
 *     did not allow (enforced in `core/testimonials.ts`).
 *   * `status` is the **operator's** moderation: `pending` until decided,
 *     `approved` to show it, `hidden` to take it down without deleting it.
 *
 * The wall shows `status = 'approved' AND may_publish = 1`, and nothing else.
 * `display_name` is what the wall prints; the subscriber's email never leaves
 * the admin.
 */
export const testimonials = sqliteTable(
  'testimonials',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    subscriberId: integer('subscriber_id')
      .notNull()
      .references(() => subscribers.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    /** Plain text as typed. Escaped on every render, never stored as HTML. */
    body: text('body').notNull(),
    mayPublish: integer('may_publish', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: ['pending', 'approved', 'hidden'] })
      .notNull()
      .default('pending'),
    createdAt: ts('created_at').notNull(),
    decidedAt: ts('decided_at'),
  },
  (t) => [
    index('testimonials_status_idx').on(t.status, t.createdAt),
    // The per-subscriber rate limit counts recent rows on this.
    index('testimonials_subscriber_idx').on(t.subscriberId, t.createdAt),
  ],
)

export type Testimonial = typeof testimonials.$inferSelect
// ─────────────────────────────────────────────────────────── outbound webhooks

/**
 * The events an endpoint can subscribe to. Kōlea's five (SPEC 20.2) plus
 * `complained`: here a spam complaint is its own status and its own consent
 * fact, distinct from a hard bounce, and a receiver mirroring the list needs to
 * hear about both.
 */
export const WEBHOOK_EVENTS = [
  'subscribed',
  'unsubscribed',
  'bounced',
  'complained',
  'purchased',
  'published',
] as const
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

/**
 * Where the operator wants facts POSTed. See `core/webhooks.ts`.
 *
 * `secret` is stored in the clear, unlike `api_keys.token_hash`: a key is
 * something we *check*, so a hash is enough, but a signing secret is something
 * we must *use* on every delivery, so it has to be readable. It is shown to the
 * operator exactly once, at creation; every screen and tool after that shows
 * `secret_prefix` only, which is not enough to sign with.
 *
 * `events` is a JSON array rather than a junction table: six possible values,
 * read whole on every emit, never queried by element. Emit loads every active
 * endpoint (there are a handful) and filters in the Worker.
 */
export const webhookEndpoints = sqliteTable(
  'webhook_endpoints',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** https only, public host. `checkWebhookUrl` runs on save AND before every POST. */
    url: text('url').notNull(),
    description: text('description').notNull().default(''),
    events: text('events', { mode: 'json' }).notNull().$type<WebhookEvent[]>(),
    secret: text('secret').notNull(),
    secretPrefix: text('secret_prefix').notNull(),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    /**
     * Why it is off, in words — "switched off" by hand, or switched off after N
     * failed deliveries in a row. An endpoint that went quiet with no reason on
     * it is a mystery; with one, it is a to-do.
     */
    disabledReason: text('disabled_reason'),
    disabledAt: ts('disabled_at'),
    /** Deliveries that used every attempt, in a row. A success resets it. */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastDeliveredAt: ts('last_delivered_at'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
)

/**
 * One fact to one endpoint, and the whole delivery log (SPEC 20.2).
 *
 * ⭐ Emitting writes this row and nothing else — no HTTP on the consent or send
 * path. The minutely cron claims due rows and POSTs them, so the row IS the
 * queue: it survives a restart, it is visible, and a `failed` one carries a
 * "Redeliver" button rather than vanishing (CLAUDE.md: anything observable is
 * a row).
 *
 * `payload` is frozen at emit time so every attempt — and a redelivery a week
 * later — sends the same bytes about the same moment, not today's version of
 * the person. `event_id` is shared by every endpoint's copy of one fact, so a
 * receiver can dedupe on it.
 *
 * `dedupe_key` + the partial unique index make a replayed provider webhook or
 * a re-run of the same fact land once per endpoint. Null means "each call is
 * its own fact" (unsubscribing twice is two things a person did).
 */
export const webhookDeliveries = sqliteTable(
  'webhook_deliveries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    endpointId: integer('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    event: text('event', { enum: WEBHOOK_EVENTS }).notNull(),
    eventId: text('event_id').notNull(),
    payload: text('payload', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
    occurredAt: ts('occurred_at').notNull(),
    dedupeKey: text('dedupe_key'),
    status: text('status', { enum: ['pending', 'delivered', 'failed'] })
      .notNull()
      .default('pending'),
    /** Tries in the current round. Redeliver starts a new round at 0. */
    attempts: integer('attempts').notNull().default(0),
    /**
     * When the cron may next try it. Null once delivered or failed. Also the
     * claim: a pass pushes it forward before POSTing, so two overlapping ticks
     * cannot both send the same row.
     */
    nextAttemptAt: ts('next_attempt_at'),
    lastAttemptAt: ts('last_attempt_at'),
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),
    /** First 1,000 characters of what the receiver said. Enough to debug, not a store. */
    lastResponse: text('last_response'),
    deliveredAt: ts('delivered_at'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    // The cron's claim: "pending and due, oldest first".
    index('webhook_deliveries_due_idx').on(t.status, t.nextAttemptAt),
    // The delivery log, per endpoint, newest first.
    index('webhook_deliveries_endpoint_idx').on(t.endpointId, t.createdAt),
    uniqueIndex('webhook_deliveries_dedupe_key')
      .on(t.endpointId, t.dedupeKey)
      .where(sql`dedupe_key is not null`),
  ],
)

export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect

// ─────────────────────────────────────────────────────────── members & premium

/**
 * ⭐ Members and Premium (Kōlea SPEC 15.11, 16.7). A **member** is a subscriber
 * who has signed in on the public site. There is no second person record: the
 * member IS the `subscribers` row, so one person has one consent state however
 * they arrived. Nothing in this cluster writes `subscribers.status`, a
 * suppression or an opt-out — signing in, signing out and paying are not
 * consent (SPEC 15.11.3). An unsubscribed reader can still sign in and read
 * what they are entitled to; the newsletter and their access are separate facts.
 */

/**
 * One request for a sign-in link, kept as history (SPEC 15.11.2: a request,
 * a link and a session are rows). Only requests for an address that IS a
 * subscriber get a row — the sign-in page never creates a subscriber and answers
 * the same whether or not the address is known.
 *
 * `token_hash` is the SHA-256 of the token in the mailed link; the token itself
 * is never stored, not here and not on the `messages` row (whose body carries a
 * `{{sign_in_link}}` merge tag resolved only in memory at send time). It is set
 * only while the link is live: a link whose mail was blocked, throttled or
 * failed carries none, so it can never be used. Nullable + UNIQUE is fine:
 * SQLite treats NULLs as distinct.
 *
 * Status: `sent` (the link is out, valid until `expires_at`, single use),
 * `used`, `blocked` (the transactional consent check refused: hard bounce or
 * complaint; `blocked_reason` says which), `throttled` (five links an hour per
 * address — recorded, never mailed), `failed` (the provider refused; the reader
 * asks again). `requested` exists only between the insert and the send.
 */
export const memberSignInLinks = sqliteTable(
  'member_sign_in_links',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    subscriberId: integer('subscriber_id')
      .notNull()
      .references(() => subscribers.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['requested', 'sent', 'used', 'blocked', 'throttled', 'failed'] })
      .notNull()
      .default('requested'),
    tokenHash: text('token_hash'),
    expiresAt: ts('expires_at'),
    // nullable-fk: the system mail that carried it. `set null` so pruning old
    // messages never erases who asked to sign in.
    messageId: integer('message_id').references(() => messages.id, { onDelete: 'set null' }),
    // nullable-fk: the post the reader was on, so the link lands them back on it.
    returnPostId: integer('return_post_id').references(() => broadcasts.id, { onDelete: 'set null' }),
    blockedReason: text('blocked_reason'),
    requestedIp: text('requested_ip'),
    requestedUserAgent: text('requested_user_agent'),
    createdAt: ts('created_at').notNull(),
    usedAt: ts('used_at'),
  },
  (t) => [
    uniqueIndex('member_sign_in_links_token_key').on(t.tokenHash),
    // "How many links has this address had this hour?" before every send.
    index('member_sign_in_links_subscriber_idx').on(t.subscriberId, t.createdAt),
    // The per-IP limit, counted with premium checkouts (SPEC 16.7.2.1).
    index('member_sign_in_links_ip_idx').on(t.requestedIp, t.createdAt),
  ],
)

/**
 * A signed-in reader. The cookie holds an opaque token plus an HMAC of it under
 * `MEMBER_SESSION_SECRET`; this row holds only the token's SHA-256, so a leaked
 * database signs nobody in and a session is revocable by stamping `revoked_at`.
 * Sixty days, no sliding renewal. `last_seen_at` is refreshed at most daily —
 * a write per page view would be a write per reader per click.
 */
export const memberSessions = sqliteTable(
  'member_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    subscriberId: integer('subscriber_id')
      .notNull()
      .references(() => subscribers.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    // nullable-fk: the link it was opened with.
    signInLinkId: integer('sign_in_link_id').references(() => memberSignInLinks.id, {
      onDelete: 'set null',
    }),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: ts('created_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    uniqueIndex('member_sessions_token_key').on(t.tokenHash),
    index('member_sessions_subscriber_idx').on(t.subscriberId),
  ],
)

/**
 * The one Premium level's two prices (SPEC 16.7.1), as Stripe price ids picked
 * from the synced catalog on the Members screen. Exactly one row (`id = 1`),
 * created on first save. Plain text, not FKs to `stripe_prices`, like
 * `stripe_products.default_price_id`: a catalog resync must never be blocked by,
 * or silently null, the price readers are paying. Validated on save instead.
 * A null price is a plan that is not on sale.
 */
export const premiumSettings = sqliteTable('premium_settings', {
  id: integer('id').primaryKey(),
  monthlyPriceId: text('monthly_price_id'),
  yearlyPriceId: text('yearly_price_id'),
  updatedAt: ts('updated_at').notNull(),
})

/**
 * Every Stripe Checkout a reader starts, written BEFORE the session is created
 * (SPEC 16.7.2.1). `token` is the session's `metadata.kolea_checkout` and
 * `client_reference_id`; the webhook applies what this row says, so a session
 * naming an unknown token, or a different Stripe session than the row's,
 * grants nothing. No email is stored: Stripe collects it.
 *
 * `converted_from_post_id` is the post whose call to action they pressed — the
 * "which post converted them" the Members screen answers.
 *
 * Status: `open` → `completed` (a subscription was recorded), `duplicate` (they
 * already held a live one; the second Stripe subscription is kept here for the
 * operator to cancel and refund — "Paid twice"), `expired`, `failed` (a delayed
 * payment failed), `ignored` (the session did not match this row).
 */
export const premiumCheckouts = sqliteTable(
  'premium_checkouts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    token: text('token').notNull(),
    interval: text('interval', { enum: ['month', 'year'] }).notNull(),
    stripePriceId: text('stripe_price_id').notNull(),
    // nullable-fk: the signed-in member who pressed Upgrade, if any.
    subscriberId: integer('subscriber_id').references(() => subscribers.id, { onDelete: 'set null' }),
    convertedFromPostId: integer('converted_from_post_id').references(() => broadcasts.id, {
      onDelete: 'set null',
    }),
    stripeSessionId: text('stripe_session_id'),
    status: text('status', { enum: ['open', 'completed', 'duplicate', 'expired', 'failed', 'ignored'] })
      .notNull()
      .default('open'),
    note: text('note'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    stripeCustomerId: text('stripe_customer_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: ts('created_at').notNull(),
    completedAt: ts('completed_at'),
  },
  (t) => [
    uniqueIndex('premium_checkouts_token_key').on(t.token),
    uniqueIndex('premium_checkouts_session_key').on(t.stripeSessionId),
    index('premium_checkouts_ip_idx').on(t.ip, t.createdAt),
    index('premium_checkouts_status_idx').on(t.status),
  ],
)

/**
 * A Premium subscription (SPEC 15.11.4, 16.7.3). A member is premium while they
 * hold a row in status `active`. Status moves only through the transition table
 * in `core/premium-lifecycle.ts`: `active ↔ past_due`, `active → canceled`,
 * `past_due → canceled`; `canceled` is final, and a returning subscriber gets a
 * new row. The partial unique index keeps at most one non-canceled row per
 * subscriber, so two completed checkouts can never make two live subscriptions.
 *
 * Granted ONLY by the signature-verified `checkout.session.completed` (or its
 * `async_payment_succeeded`), never by the return page. `stripe_event_at` is the
 * `created` time of the newest Stripe event applied: Stripe does not promise
 * order, and an older event must change nothing.
 *
 * Money (`amount_cents`, `currency`) is what the price was at signup, frozen
 * like a sale's campaign. Each paid invoice is a `sales` row of its own, booked
 * by the ordinary webhook path.
 */
export const memberSubscriptions = sqliteTable(
  'member_subscriptions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    subscriberId: integer('subscriber_id')
      .notNull()
      .references(() => subscribers.id, { onDelete: 'cascade' }),
    // nullable-fk: the checkout that created it.
    checkoutId: integer('checkout_id').references(() => premiumCheckouts.id, { onDelete: 'set null' }),
    status: text('status', { enum: ['active', 'past_due', 'canceled'] }).notNull(),
    interval: text('interval', { enum: ['month', 'year'] }).notNull(),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull(),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id').notNull(),
    stripePriceId: text('stripe_price_id').notNull(),
    convertedFromPostId: integer('converted_from_post_id').references(() => broadcasts.id, {
      onDelete: 'set null',
    }),
    currentPeriodEndAt: ts('current_period_end_at'),
    cancelAtPeriodEnd: integer('cancel_at_period_end', { mode: 'boolean' }).notNull().default(false),
    cancelReason: text('cancel_reason'),
    statusChangedAt: ts('status_changed_at').notNull(),
    /** Kept when they recover, so "who was ever late" stays answerable. */
    pastDueAt: ts('past_due_at'),
    canceledAt: ts('canceled_at'),
    stripeEventAt: ts('stripe_event_at'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('member_subscriptions_stripe_key').on(t.stripeSubscriptionId),
    uniqueIndex('member_subscriptions_live_key')
      .on(t.subscriberId)
      .where(sql`status <> 'canceled'`),
    index('member_subscriptions_status_idx').on(t.status),
  ],
)

export type MemberSubscription = typeof memberSubscriptions.$inferSelect
export type PremiumCheckout = typeof premiumCheckouts.$inferSelect

// ─────────────────────────────────────────────────────────── onboarding

/**
 * The first-run checklist's steps, in the order the checklist asks them (Kōlea
 * SPEC 21.4, ported without the hosted steps: no account, email verification,
 * AI key or pitch). Kept here, beside the table that names them, so the enum on
 * the column and the order on the screen cannot drift apart.
 */
export const ONBOARDING_STEPS = ['sender', 'domain', 'site', 'audience', 'welcome', 'broadcast'] as const
export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]

/**
 * ⭐ What the operator said about an onboarding step that the data cannot say.
 *
 * Progress is *derived*, not stored: a step is done because a domain verified,
 * a form exists, a subscribe sequence exists (`core/onboarding.ts`). This table
 * only holds the two things no other row can: a "later" (`skipped`) and an
 * explicit no (`declined`, the public site only, the way Kōlea allows it). There
 * is deliberately no `done` outcome: a step marked done by hand while the real
 * state disagrees would tick a box over a domain that does not send.
 *
 * Facts win over this row. A domain added after its step was skipped shows as
 * waiting, not skipped, without anyone deleting the row. One row per step (the
 * step is the key); a later decision replaces the earlier one, and "undo" deletes it.
 */
export const onboardingSteps = sqliteTable('onboarding_steps', {
  step: text('step', { enum: ONBOARDING_STEPS }).primaryKey(),
  outcome: text('outcome', { enum: ['skipped', 'declined'] }).notNull(),
  decidedAt: ts('decided_at').notNull(),
})

export type OnboardingStepRow = typeof onboardingSteps.$inferSelect

/**
 * The checklist itself. Exactly one row (`id = 1`), created the first time the
 * operator dismisses it; no row means "never dismissed", so a fresh install shows
 * the checklist without a seed step. `dismissed_at` null after a row exists means
 * the operator brought it back. Dismissing hides it from the dashboard only: the
 * `/onboarding` page always answers, and nothing about a step changes.
 */
export const onboarding = sqliteTable('onboarding', {
  id: integer('id').primaryKey(),
  dismissedAt: ts('dismissed_at'),
  updatedAt: ts('updated_at').notNull(),
})
