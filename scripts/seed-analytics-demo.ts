/**
 * Local-only: stub data for the analytics screens.
 *
 * The analytics section is unreadable against an empty database — every card
 * renders its empty state and none of the design decisions can be judged. This
 * fills in enough of a world to see it working:
 *
 *   · the 13 Kit sequences from the ConvertKit report, with their engagement
 *     rates carried onto `imported_*` (the same shape the real backfill writes)
 *   · two *live* sequences with real `messages` + `events` history, so the step
 *     waterfall, the retention curve and the Signal score all have something to
 *     draw — and so the live-vs-imported split is visible side by side
 *   · conversions across sequences, broadcasts and direct, spread over a year,
 *     so the contribution split and the mix chart have shape
 *   · a couple of goals for the current periods
 *
 * ## ⚠️ Refuses to run against production, by construction
 *
 * There is no `--remote` flag and no code path that could acquire one. It writes
 * demo subscribers at `demo+N@kolea.test`, all imported sequences land
 * `is_active = 0`, and no mail is ever sent — every row here is inert on
 * arrival (CLAUDE.md, "Imported/backfilled content is inert").
 *
 *   bun scripts/seed-analytics-demo.ts          # write it
 *   bun scripts/seed-analytics-demo.ts --clean  # remove it again
 *   bun scripts/seed-analytics-demo.ts --print  # dump the SQL, write nothing
 */

export {}

const argv = new Set(process.argv.slice(2))
const clean = argv.has('--clean')
const printOnly = argv.has('--print')

const DAY = 86_400_000
const NOW = Date.now()
const q = (s: string) => `'${s.replace(/'/g, "''")}'`
const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

// ───────────────────────────────────────────── the Kit report, as data

interface KitSeq {
  name: string
  emails: number
  days: number
  subscribers: number
  openRate: number
  clickRate: number
  unsubscribed: number
}

/** Transcribed from the Kit sequences report. Rates are percents, over recipients. */
const KIT: KitSeq[] = [
  { name: 'AI Deadlines Personal Followup', emails: 1, days: 1, subscribers: 0, openRate: 82.22, clickRate: 22.22, unsubscribed: 1 },
  { name: 'AI Deadlines Post', emails: 1, days: 2, subscribers: 0, openRate: 100, clickRate: 0, unsubscribed: 0 },
  { name: 'AI Pro Free Signup', emails: 4, days: 5, subscribers: 100, openRate: 69.02, clickRate: 15.6, unsubscribed: 7 },
  { name: 'AI Pro Upgrade', emails: 7, days: 17, subscribers: 341, openRate: 76.21, clickRate: 4.9, unsubscribed: 17 },
  { name: 'Cohort Interest', emails: 6, days: 8, subscribers: 282, openRate: 74.26, clickRate: 12.13, unsubscribed: 16 },
  { name: 'Imposter Post', emails: 2, days: 14, subscribers: 386, openRate: 76.26, clickRate: 17.53, unsubscribed: 80 },
  { name: 'Imposter Second Video Upgrade', emails: 6, days: 6, subscribers: 21, openRate: 68.42, clickRate: 24.29, unsubscribed: 4 },
  { name: 'Little SQL Sequence', emails: 5, days: 5, subscribers: 0, openRate: 0, clickRate: 0, unsubscribed: 0 },
  { name: 'Newsletter Welcome', emails: 5, days: 7, subscribers: 8, openRate: 47.73, clickRate: 6.82, unsubscribed: 0 },
  { name: 'Pivot Application', emails: 1, days: 0, subscribers: 0, openRate: 90.91, clickRate: 0, unsubscribed: 0 },
  { name: 'Post Crap Code', emails: 5, days: 4, subscribers: 0, openRate: 80.95, clickRate: 28.57, unsubscribed: 1 },
  { name: 'SQL Orbit Post', emails: 2, days: 8, subscribers: 61, openRate: 80.43, clickRate: 28.09, unsubscribed: 6 },
  { name: 'Wealth OS Signup', emails: 0, days: 0, subscribers: 0, openRate: 0, clickRate: 0, unsubscribed: 0 },
]

/** The two that get real, live history — one that sells, one that welcomes. */
interface LiveSeq {
  slug: string
  name: string
  trigger: 'subscribe' | 'manual'
  /** subject, delay days, and the share of step one's recipients that get it. */
  steps: { subject: string; delay: number; keep: number }[]
  /** People put through it. */
  people: number
  /** Per-step engagement, as shares of that step's recipients. */
  openRate: number
  clickRate: number
}

const LIVE: LiveSeq[] = [
  {
    slug: 'demo-welcome',
    name: 'Kōlea Welcome',
    trigger: 'subscribe',
    steps: [
      { subject: 'You made it — here is where to start', delay: 0, keep: 1 },
      { subject: 'The one thing most people get wrong', delay: 2, keep: 0.97 },
      { subject: 'A short story about a 22-year-old codebase', delay: 3, keep: 0.93 },
      { subject: 'What I would do with your first week', delay: 4, keep: 0.9 },
      { subject: 'Anything I can help with?', delay: 5, keep: 0.88 },
    ],
    people: 240,
    openRate: 0.58,
    clickRate: 0.14,
  },
  {
    slug: 'demo-cohort',
    name: 'Cohort Onboarding',
    trigger: 'manual',
    steps: [
      { subject: 'Your seat is held — read this first', delay: 0, keep: 1 },
      { subject: 'The pre-work, and why it is short', delay: 2, keep: 0.95 },
      { subject: 'What week one actually looks like', delay: 3, keep: 0.79 },
      { subject: 'Two seats left at this price', delay: 4, keep: 0.62 },
      { subject: 'Last call before the doors close', delay: 3, keep: 0.58 },
      { subject: 'Doors are closed — what happens now', delay: 2, keep: 0.55 },
    ],
    people: 180,
    openRate: 0.66,
    clickRate: 0.21,
  },
]

/**
 * Broadcasts, so the one-off screens and the broadcast channel are not empty.
 *
 * Most land as Kit-era imports — totals only, no `messages` rows — which is
 * exactly the shape the real history has. The last two are `live: true`: they
 * get per-recipient rows against the demo people, which is what makes a
 * conversion attachable to a broadcast at all.
 */
interface DemoBroadcast {
  subject: string
  daysAgo: number
  recipients: number
  openRate: number
  clickRate: number
  unsubscribed: number
  live?: boolean
}

const BROADCASTS: DemoBroadcast[] = [
  { subject: 'The three-line rule I keep breaking', daysAgo: 300, recipients: 13480, openRate: 0.512, clickRate: 0.021, unsubscribed: 61 },
  { subject: 'What a 22-year-old codebase taught me', daysAgo: 268, recipients: 13590, openRate: 0.534, clickRate: 0.033, unsubscribed: 44 },
  { subject: 'Nobody reads the docs. Write them anyway.', daysAgo: 231, recipients: 13702, openRate: 0.497, clickRate: 0.015, unsubscribed: 72 },
  { subject: 'I was wrong about test coverage', daysAgo: 197, recipients: 13760, openRate: 0.556, clickRate: 0.048, unsubscribed: 39 },
  { subject: 'The cohort opens on Monday', daysAgo: 164, recipients: 13811, openRate: 0.521, clickRate: 0.066, unsubscribed: 88 },
  { subject: 'A quieter way to ship on Fridays', daysAgo: 131, recipients: 13884, openRate: 0.508, clickRate: 0.019, unsubscribed: 47 },
  { subject: 'Six weeks with an agent in the loop', daysAgo: 96, recipients: 13940, openRate: 0.543, clickRate: 0.041, unsubscribed: 52 },
  { subject: 'Your database is not the bottleneck', daysAgo: 62, recipients: 14002, openRate: 0.518, clickRate: 0.027, unsubscribed: 58 },
  { subject: 'The one email I should have sent first', daysAgo: 34, recipients: 340, openRate: 0.61, clickRate: 0.09, unsubscribed: 3, live: true },
  { subject: 'Two seats left, and then I close it', daysAgo: 9, recipients: 340, openRate: 0.64, clickRate: 0.13, unsubscribed: 5, live: true },
]

const PEOPLE = 380

// ───────────────────────────────────────────────────────────── the SQL

const sql: string[] = []

/** Everything this script has ever written, and nothing else. */
const WIPE = [
  `DELETE FROM conversions WHERE subscriber_id IN (SELECT id FROM subscribers WHERE email LIKE 'demo+%@kolea.test');`,
  `DELETE FROM subscribers WHERE email LIKE 'demo+%@kolea.test';`,
  `DELETE FROM sequences WHERE slug LIKE 'demo-%';`,
  // `messages` cascades off the broadcast, and `events` cascades off those.
  `DELETE FROM broadcasts WHERE subject LIKE '[demo]%';`,
  `DELETE FROM goals WHERE name LIKE '[demo]%';`,
]

if (clean) {
  sql.push(...WIPE)
} else {
  sql.push(...WIPE)

  // ── people. Spread over 14 months so growth has a shape, with a realistic
  //    slice unsubscribed. Deterministic: id arithmetic, no randomness, so a
  //    re-run produces byte-identical data and diffs stay readable.
  for (let i = 0; i < PEOPLE; i++) {
    const created = NOW - Math.round((i / PEOPLE) * 420) * DAY - (i % 24) * 3_600_000
    const gone = i % 37 === 0
    sql.push(
      `INSERT INTO subscribers (email, name, status, attributes, source, unsub_token, created_at, confirmed_at, unsubscribed_at) VALUES (` +
        `${q(`demo+${i}@kolea.test`)}, ${q(`Demo Person ${i}`)}, ${q(gone ? 'unsubscribed' : 'active')}, '{}', ${q('demo-seed')}, ` +
        `${q(`demo-token-${i}`)}, ${created}, ${created}, ${gone ? created + 40 * DAY : 'NULL'});`,
    )
  }

  // ── the Kit sequences: content-free placeholders carrying the engagement
  //    rates. `is_active = 0` and `trigger = 'manual'`, so no enrollment path
  //    can reach them (core/sequences.ts gates every one of them on isActive).
  for (const k of KIT) {
    const slug = `demo-kit-${slugify(k.name)}`
    // If the real Kit import already brought this sequence in, leave it alone
    // and just attach the figures — a second copy of every sequence is how a
    // leaderboard becomes unreadable, and how somebody edits the wrong one.
    sql.push(
      `INSERT INTO sequences (slug, name, description, trigger, is_active, created_at, ` +
        `imported_subscribers, imported_open_rate, imported_click_rate, imported_unsubscribed, imported_from) ` +
        `SELECT ${q(slug)}, ${q(k.name)}, ${q('Imported from Kit — figures only, no content.')}, ${q('manual')}, 0, ${NOW - 400 * DAY}, ` +
        `${k.subscribers}, ${(k.openRate / 100).toFixed(6)}, ${(k.clickRate / 100).toFixed(6)}, ${k.unsubscribed}, ${q('kit')} ` +
        `WHERE NOT EXISTS (SELECT 1 FROM sequences WHERE lower(name) = lower(${q(k.name)}));`,
    )
    // The figures go on whichever row now carries the name — the pre-existing
    // one if there was one, otherwise the placeholder just written.
    sql.push(
      `UPDATE sequences SET imported_subscribers = ${k.subscribers}, ` +
        `imported_open_rate = ${(k.openRate / 100).toFixed(6)}, ` +
        `imported_click_rate = ${(k.clickRate / 100).toFixed(6)}, ` +
        `imported_unsubscribed = ${k.unsubscribed}, imported_from = ${q('kit')} ` +
        `WHERE lower(name) = lower(${q(k.name)});`,
    )
    // Steps carry the shape Kit reported ("a 5 day sequence with 4 emails") so
    // the length reads correctly. Bodies are a single line saying what they are:
    // an empty body that could one day be sent is worse than an honest one.
    // Gaps are distributed so they add up to Kit's figure exactly rather than
    // being floored away — "5 emails over 4 days" must still read "over 4 days".
    const gaps = Math.max(0, k.emails - 1)
    for (let i = 0; i < k.emails; i++) {
      const upto = (n: number) => (gaps ? Math.round((k.days * n) / gaps) : 0)
      const delay = i === 0 ? 0 : upto(i) - upto(i - 1)
      sql.push(
        `INSERT INTO sequence_steps (sequence_id, position, delay_days, subject, body_json, body_md) ` +
          `SELECT id, ${i + 1}, ${delay}, ${q(`${k.name} — email ${i + 1}`)}, NULL, ` +
          `${q('Content was not imported from Kit. Figures only.')} FROM sequences WHERE slug = ${q(slug)};`,
      )
    }
  }

  // ── the live pair.
  for (const s of LIVE) {
    sql.push(
      `INSERT INTO sequences (slug, name, description, trigger, is_active, created_at) VALUES (` +
        `${q(s.slug)}, ${q(s.name)}, ${q('Demo data — local only.')}, ${q(s.trigger)}, 1, ${NOW - 300 * DAY});`,
    )
    s.steps.forEach((step, i) => {
      sql.push(
        `INSERT INTO sequence_steps (sequence_id, position, delay_days, subject, body_json, body_md) ` +
          `SELECT id, ${i + 1}, ${step.delay}, ${q(step.subject)}, NULL, ${q('Demo body.')} ` +
          `FROM sequences WHERE slug = ${q(s.slug)};`,
      )
    })

    // Enrollments: the first `people` demo subscribers, entered on a spread of
    // dates so the intake chart has months in it.
    sql.push(
      `INSERT INTO sequence_enrollments (sequence_id, subscriber_id, next_step_id, status, next_run_at, enrolled_at) ` +
        `SELECT (SELECT id FROM sequences WHERE slug = ${q(s.slug)}), sub.id, NULL, ` +
        `CASE WHEN sub.id % 9 = 0 THEN 'active' WHEN sub.id % 23 = 0 THEN 'cancelled' ELSE 'completed' END, NULL, ` +
        `${NOW - 240 * DAY} + (sub.id % 210) * ${DAY} ` +
        `FROM (SELECT id FROM subscribers WHERE email LIKE 'demo+%@kolea.test' ORDER BY id LIMIT ${s.people}) sub;`,
    )

    // Messages, one step at a time. `keep` decides who is still in it, by a
    // stable modulus rather than a random draw — the retention curve must look
    // the same on every re-seed or the screenshots are not comparable.
    s.steps.forEach((step, i) => {
      const keepMod = Math.max(1, Math.round(step.keep * 100))
      const dayOffset = s.steps.slice(0, i + 1).reduce((n, x) => n + x.delay, 0)
      sql.push(
        `INSERT INTO messages (subscriber_id, kind, sequence_step_id, to_email, subject, status, created_at, sent_at) ` +
          `SELECT e.subscriber_id, 'sequence', st.id, sub.email, st.subject, 'sent', ` +
          `e.enrolled_at + ${dayOffset * DAY}, e.enrolled_at + ${dayOffset * DAY} ` +
          `FROM sequence_enrollments e ` +
          `JOIN sequences s ON s.id = e.sequence_id AND s.slug = ${q(s.slug)} ` +
          `JOIN sequence_steps st ON st.sequence_id = s.id AND st.position = ${i + 1} ` +
          `JOIN subscribers sub ON sub.id = e.subscriber_id ` +
          `WHERE e.subscriber_id % 100 < ${keepMod} ` +
          // Anything scheduled past today has not happened yet — a sequence that
          // mails into the future is exactly the bug this screen would surface.
          `AND e.enrolled_at + ${dayOffset * DAY} < ${NOW};`,
      )
    })

    const openMod = Math.round(s.openRate * 100)
    const clickMod = Math.round(s.clickRate * 100)
    sql.push(
      `INSERT INTO events (message_id, type, occurred_at, meta, dedupe_key) ` +
        `SELECT m.id, 'open', m.sent_at + 5400000, '{}', 'demo-open-' || m.id ` +
        `FROM messages m JOIN sequence_steps st ON st.id = m.sequence_step_id ` +
        `JOIN sequences s ON s.id = st.sequence_id AND s.slug = ${q(s.slug)} ` +
        `WHERE m.id % 100 < ${openMod};`,
    )
    sql.push(
      `INSERT INTO events (message_id, type, occurred_at, meta, dedupe_key) ` +
        `SELECT m.id, 'click', m.sent_at + 7200000, '{}', 'demo-click-' || m.id ` +
        `FROM messages m JOIN sequence_steps st ON st.id = m.sequence_step_id ` +
        `JOIN sequences s ON s.id = st.sequence_id AND s.slug = ${q(s.slug)} ` +
        // Clicks only ever come from opens — an event log where somebody clicked
        // mail they never opened would make every click-to-open figure a lie.
        `WHERE m.id % 100 < ${clickMod};`,
    )
    sql.push(
      `INSERT INTO events (message_id, type, occurred_at, meta, dedupe_key) ` +
        `SELECT m.id, 'unsubscribe', m.sent_at + 9000000, '{}', 'demo-unsub-' || m.id ` +
        `FROM messages m JOIN sequence_steps st ON st.id = m.sequence_step_id ` +
        `JOIN sequences s ON s.id = st.sequence_id AND s.slug = ${q(s.slug)} ` +
        `WHERE m.id % 149 = 3;`,
    )
    sql.push(
      `INSERT INTO events (message_id, type, occurred_at, meta, dedupe_key) ` +
        `SELECT m.id, 'bounce', m.sent_at + 600000, '{}', 'demo-bounce-' || m.id ` +
        `FROM messages m JOIN sequence_steps st ON st.id = m.sequence_step_id ` +
        `JOIN sequences s ON s.id = st.sequence_id AND s.slug = ${q(s.slug)} ` +
        `WHERE m.id % 311 = 7;`,
    )
  }

  // ── broadcasts.
  BROADCASTS.forEach((b, bi) => {
    const sentAt = NOW - b.daysAgo * DAY
    const subject = `[demo] ${b.subject}`
    if (b.live) {
      // A live send: real `messages` rows against the demo people only, so the
      // funnel and the last-touch attribution have something to hang on. It
      // lands `status = 'sent'` with `sent_at` set, which the minutely tick
      // will never claim — inert on arrival, like every other import.
      sql.push(
        `INSERT INTO broadcasts (subject, body_json, body_md, segment, status, sent_at, started_at, cursor_subscriber_id, created_at) ` +
          `VALUES (${q(subject)}, NULL, ${q('Demo body.')}, '{}', 'sent', ${sentAt}, ${sentAt}, 0, ${sentAt});`,
      )
      sql.push(
        `INSERT INTO messages (subscriber_id, kind, broadcast_id, to_email, subject, status, created_at, sent_at) ` +
          `SELECT sub.id, 'broadcast', b.id, sub.email, b.subject, 'sent', ${sentAt}, ${sentAt} ` +
          `FROM subscribers sub, (SELECT id, subject FROM broadcasts WHERE subject = ${q(subject)}) b ` +
          `WHERE sub.email LIKE 'demo+%@kolea.test' AND sub.status = 'active';`,
      )
      for (const [type, mod, offset] of [
        ['open', Math.round(b.openRate * 100), 5_400_000],
        ['click', Math.round(b.clickRate * 100), 7_200_000],
      ] as const) {
        sql.push(
          `INSERT INTO events (message_id, type, occurred_at, meta, dedupe_key) ` +
            `SELECT m.id, ${q(type)}, m.sent_at + ${offset}, '{}', ${q(`demo-b${bi}-${type}-`)} || m.id ` +
            `FROM messages m JOIN broadcasts b ON b.id = m.broadcast_id AND b.subject = ${q(subject)} ` +
            `WHERE m.id % 100 < ${mod};`,
        )
      }
      sql.push(
        `INSERT INTO events (message_id, type, occurred_at, meta, dedupe_key) ` +
          `SELECT m.id, 'unsubscribe', m.sent_at + 9000000, '{}', ${q(`demo-b${bi}-unsub-`)} || m.id ` +
          `FROM messages m JOIN broadcasts b ON b.id = m.broadcast_id AND b.subject = ${q(subject)} ` +
          `WHERE m.id % 97 = 5;`,
      )
      // Conversions off the clicks, so the broadcast channel is not a flat zero
      // on the contribution screen.
      sql.push(
        `INSERT INTO conversions (subscriber_id, kind_id, kind_slug, sale_id, value_cents, currency, ` +
          `message_id, source_kind, source_id, campaign_id, offer_id, offer_slug, attributed_by, ` +
          `touch_lag_seconds, occurred_at, created_at) ` +
          `SELECT m.subscriber_id, k.id, k.slug, NULL, 7900, 'usd', m.id, 'broadcast', b.id, NULL, NULL, NULL, ` +
          `'last_touch', 3600, m.sent_at + 10800000, m.sent_at + 10800000 ` +
          `FROM messages m ` +
          `JOIN broadcasts b ON b.id = m.broadcast_id AND b.subject = ${q(subject)} ` +
          `JOIN events e ON e.message_id = m.id AND e.type = 'click' ` +
          `JOIN (SELECT id, slug FROM conversion_kinds WHERE is_active = 1 ORDER BY priority LIMIT 1) k ` +
          `WHERE m.id % 3 = 0;`,
      )
      return
    }

    // Kit-era: totals only, on the same `imported_*` columns the real backfill
    // writes. `imported_recipients` is the flag that says "trust this row".
    sql.push(
      `INSERT INTO broadcasts (subject, body_json, body_md, segment, status, sent_at, started_at, cursor_subscriber_id, created_at, ` +
        `imported_recipients, imported_opened, imported_clicked, imported_unsubscribed, imported_from) VALUES (` +
        `${q(subject)}, NULL, ${q('Imported from Kit — figures only, no content.')}, '{}', 'sent', ${sentAt}, ${sentAt}, 0, ${sentAt}, ` +
        `${b.recipients}, ${Math.round(b.recipients * b.openRate)}, ${Math.round(b.recipients * b.clickRate)}, ${b.unsubscribed}, ${q('kit')});`,
    )
  })

  // ── conversions. A kind is required (`kind_slug` is NOT NULL), so this uses
  //    whichever kinds already exist — run `seed-conversion-kinds.ts` first if
  //    the table is empty and this block will simply write nothing.
  const seqPrices = [4900, 9900, 19900]
  LIVE.forEach((s, si) => {
    sql.push(
      `INSERT INTO conversions (subscriber_id, kind_id, kind_slug, sale_id, value_cents, currency, ` +
        `message_id, source_kind, source_id, campaign_id, offer_id, offer_slug, attributed_by, ` +
        `touch_lag_seconds, occurred_at, created_at) ` +
        `SELECT m.subscriber_id, k.id, k.slug, NULL, ${seqPrices[si % seqPrices.length]}, 'usd', ` +
        `m.id, 'sequence', s.id, NULL, NULL, NULL, 'last_touch', 5400, ` +
        `m.sent_at + 10800000, m.sent_at + 10800000 ` +
        `FROM messages m ` +
        `JOIN sequence_steps st ON st.id = m.sequence_step_id ` +
        `JOIN sequences s ON s.id = st.sequence_id AND s.slug = ${q(s.slug)} ` +
        `JOIN events e ON e.message_id = m.id AND e.type = 'click' ` +
        `JOIN (SELECT id, slug FROM conversion_kinds WHERE is_active = 1 ORDER BY priority LIMIT 1) k ` +
        `WHERE m.id % ${si === 0 ? 11 : 5} = 0;`,
    )
  })

  // Broadcast-credited and direct conversions, so the split is never a single
  // colour. Spread across the last 12 months by subscriber id.
  sql.push(
    `INSERT INTO conversions (subscriber_id, kind_id, kind_slug, sale_id, value_cents, currency, ` +
      `message_id, source_kind, source_id, campaign_id, offer_id, offer_slug, attributed_by, ` +
      `touch_lag_seconds, occurred_at, created_at) ` +
      `SELECT sub.id, k.id, k.slug, NULL, 2900, 'usd', NULL, 'direct', 0, NULL, NULL, NULL, 'none', NULL, ` +
      `${NOW - 330 * DAY} + (sub.id % 330) * ${DAY}, ${NOW - 330 * DAY} + (sub.id % 330) * ${DAY} ` +
      `FROM (SELECT id FROM subscribers WHERE email LIKE 'demo+%@kolea.test') sub ` +
      `JOIN (SELECT id, slug FROM conversion_kinds WHERE is_active = 1 ORDER BY priority LIMIT 1) k ` +
      `WHERE sub.id % 13 = 4;`,
  )

  // ── two goals, if none exist for the current periods. Named `[demo]` so
  //    `--clean` can find them again.
  const year = new Date(NOW).getUTCFullYear()
  const quarter = Math.floor(new Date(NOW).getUTCMonth() / 3) + 1
  sql.push(
    `INSERT INTO goals (name, kind_id, period_type, period_year, period_index, target_count, target_cents, campaign_id, created_at) ` +
      `VALUES (${q('[demo] Conversions this quarter')}, NULL, 'quarter', ${year}, ${quarter}, 60, NULL, NULL, ${NOW});`,
    `INSERT INTO goals (name, kind_id, period_type, period_year, period_index, target_count, target_cents, campaign_id, created_at) ` +
      `VALUES (${q('[demo] Revenue this year')}, NULL, 'year', ${year}, 0, NULL, 4000000, NULL, ${NOW});`,
  )
}

// ───────────────────────────────────────────────────────────── execute

const text = sql.join('\n')

if (printOnly) {
  console.log(text)
  process.exit(0)
}

// Written under `.wrangler/`, which is already git-ignored — a several-hundred
// line generated SQL file has no business showing up in `git status`.
const file = `${process.cwd()}/.wrangler/seed-analytics-demo.sql`
await Bun.write(file, text)

// `bunx wrangler`, never bare `wrangler`: a stale global install talks to a
// different local D1 and the rows land where nothing is looking for them.
const proc = Bun.spawn(
  ['bunx', 'wrangler', 'd1', 'execute', 'big-mailer', '--local', '--file', file],
  { stdout: 'inherit', stderr: 'inherit' },
)
const code = await proc.exited
if (code !== 0) {
  console.error('\nwrangler d1 execute failed.')
  process.exit(code)
}

console.log(
  clean
    ? '\nDemo analytics data removed.'
    : `\nSeeded ${PEOPLE} demo people, ${KIT.length} Kit sequences, ${LIVE.length} live sequences with history, ` +
        `${BROADCASTS.length} broadcasts, and 2 goals.` +
        '\nOpen /analytics.',
)
