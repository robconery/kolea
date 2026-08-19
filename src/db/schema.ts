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
    kind: text('kind', { enum: ['stripe'] }).notNull(),
    trigger: text('trigger', { enum: ['cron', 'mcp', 'preview'] }).notNull(),
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
