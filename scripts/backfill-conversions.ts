/**
 * Backfill: give every paid sale a conversion row.
 *
 * The webhook books a conversion for anything that lands from now on. This walks
 * the sales that were already on the books when the table was created, applies
 * exactly the same rules, and reports what it did.
 *
 * The rules, in one place (`src/core/conversions.ts` is the long form):
 *
 *   kind      the first matching row in `conversion_kinds`, walked lowest
 *             priority first. First match wins, which is what stops one sale
 *             counting as two things and doubling revenue. Run
 *             `seed-conversion-kinds.ts` before this, or nothing will match.
 *   offer     `sale_items → stripe_products.metadata.sku → offers.slug`. Null for
 *             a membership, which genuinely is not an offer.
 *   path      last click inside its window: 7 days for a broadcast, 30 for a
 *             sequence. No click in window means `direct`, and that is an honest
 *             answer rather than a gap.
 *   refunds   ignored. A sale is a sale; the refund stays on `sales.status`.
 *
 * Idempotent: `conversions_sale_key` is UNIQUE on `sale_id`, and every insert is
 * `on conflict do nothing`. Re-running picks up only what is new, and never
 * touches a row a human has corrected.
 *
 *   bun scripts/backfill-conversions.ts --local
 *   bun scripts/backfill-conversions.ts --remote --dry-run   # print the plan only
 *   bun scripts/backfill-conversions.ts --remote
 */

export {}

const argv = new Set(process.argv.slice(2))
const remote = argv.has('--remote')
const dryRun = argv.has('--dry-run')
if (!remote && !argv.has('--local')) {
  console.error('Pass --local or --remote.')
  process.exit(1)
}

const DAY_MS = 86_400_000
const WINDOW_DAYS = { broadcast: 7, sequence: 30 }

// ─────────────────────────────────────────────────────────── wrangler

async function d1(command: string): Promise<unknown[]> {
  const args = ['d1', 'execute', 'big-mailer', '--json', '--command', command]
  args.push(remote ? '--remote' : '--local')
  if (remote) args.push('--env', 'production')

  // `bunx wrangler`, not bare `wrangler`: a stale global install talks to the
  // local D1 state with an older miniflare and fails on `_cf_ALARM`. The pinned
  // version in this project is the only one that matches the state on disk.
  const proc = Bun.spawn(['bunx', 'wrangler', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  if ((await proc.exited) !== 0) {
    console.error(err)
    throw new Error('wrangler d1 execute failed')
  }
  const start = out.indexOf('[')
  const parsed = JSON.parse(out.slice(start === -1 ? 0 : start)) as { results: unknown[] }[]
  return parsed[0]?.results ?? []
}

const sqlStr = (v: string | null) => (v === null ? 'null' : `'${v.replace(/'/g, "''")}'`)

// ─────────────────────────────────────────────────────────── gather

interface SaleRow {
  id: number
  subscriber_id: number
  campaign_id: number | null
  amount_cents: number
  currency: string
  status: string
  occurred_at: number
}

// Sales with no conversion yet. A sale that already has one is left completely
// alone — that is what makes a human's correction durable across re-runs.
const salesRows = (await d1(`
  select s.id, s.subscriber_id, s.campaign_id, s.amount_cents, s.currency, s.status, s.occurred_at
  from sales s
  left join conversions c on c.sale_id = s.id
  where c.id is null
  order by s.occurred_at
`)) as SaleRow[]

interface KindRow {
  id: number
  slug: string
  label: string
  rule_type: string
  rule_value: string | null
  priority: number
}

// The match order. Same walk `core/conversions.ts` does at ingest — if these two
// ever disagree, a backfilled sale and a live one land in different buckets.
const kinds = (await d1(
  'select id, slug, label, rule_type, rule_value, priority from conversion_kinds ' +
    'where is_active = 1 order by priority, id',
)) as KindRow[]

if (kinds.length === 0) {
  console.error('No active conversion kinds. Run scripts/seed-conversion-kinds.ts first.')
  process.exit(1)
}

if (salesRows.length === 0) {
  console.log('Nothing to backfill — every sale already has a conversion.')
  process.exit(0)
}

const ids = salesRows.map((s) => s.id).join(',')

// Every interval each sale billed on, for `price_interval` rules.
const intervalsBySale = new Map<number, Set<string>>()
for (const row of (await d1(`
  select distinct si.sale_id as id, p.interval as interval
  from sale_items si
  join stripe_prices p on p.id = si.stripe_price_id
  where si.sale_id in (${ids})
`)) as { id: number; interval: string }[]) {
  const key = Number(row.id)
  if (!intervalsBySale.has(key)) intervalsBySale.set(key, new Set())
  intervalsBySale.get(key)?.add(row.interval)
}

// offer: via the sku spine, which is account-agnostic on purpose.
const offerBySale = new Map<number, { id: number; slug: string }>()
for (const row of (await d1(`
  select si.sale_id as sale_id, o.id as offer_id, o.slug as slug
  from sale_items si
  join stripe_products sp on sp.id = si.stripe_product_id
  join offers o on o.slug = json_extract(sp.metadata, '$.sku')
  where si.sale_id in (${ids})
  group by si.sale_id
`)) as { sale_id: number; offer_id: number; slug: string }[]) {
  offerBySale.set(Number(row.sale_id), { id: Number(row.offer_id), slug: row.slug })
}

// path: every click by any of these buyers, newest first. Pulled in one query
// rather than one per sale — D1 allows 1,000 queries per invocation, and this
// script would otherwise blow through that on a few hundred sales.
const subIds = [...new Set(salesRows.map((s) => s.subscriber_id))].join(',')
const clicks = (await d1(`
  select m.subscriber_id, m.id as message_id, m.broadcast_id, ss.sequence_id,
         e.occurred_at,
         b.campaign_id as broadcast_campaign,
         sq.campaign_id as sequence_campaign
  from events e
  join messages m on m.id = e.message_id
  left join broadcasts b on b.id = m.broadcast_id
  left join sequence_steps ss on ss.id = m.sequence_step_id
  left join sequences sq on sq.id = ss.sequence_id
  where e.type = 'click' and m.subscriber_id in (${subIds})
  order by e.occurred_at desc
`)) as {
  subscriber_id: number
  message_id: number
  broadcast_id: number | null
  sequence_id: number | null
  occurred_at: number
  broadcast_campaign: number | null
  sequence_campaign: number | null
}[]

const clicksBySubscriber = new Map<number, typeof clicks>()
for (const c of clicks) {
  const key = Number(c.subscriber_id)
  clicksBySubscriber.set(key, [...(clicksBySubscriber.get(key) ?? []), c])
}

// ─────────────────────────────────────────────────────────── plan

const statements: string[] = []
const byKind = new Map<string, number>()
let unmatched = 0
const tally = { withOffer: 0, lastTouch: 0, explicit: 0, direct: 0 }
const now = Date.now()

for (const sale of salesRows) {
  const offer = offerBySale.get(Number(sale.id)) ?? null
  const intervals = intervalsBySale.get(Number(sale.id)) ?? new Set<string>()

  // First match wins — see the header. `null` means every kind was ruled out,
  // which is reported rather than defaulted to something plausible.
  let kind: KindRow | null = null
  for (const k of kinds) {
    if (k.rule_type === 'price_interval' && k.rule_value && intervals.has(k.rule_value)) {
      kind = k
      break
    }
    if (k.rule_type === 'offer_in' && k.rule_value && offer) {
      const wanted = k.rule_value.split(',').map((x) => x.trim())
      if (wanted.includes(offer.slug)) {
        kind = k
        break
      }
    }
    if (k.rule_type === 'any_sale') {
      kind = k
      break
    }
  }
  if (!kind) {
    unmatched++
    continue
  }

  let messageId: number | null = null
  let sourceKind = 'direct'
  let sourceId = 0
  let campaignId = sale.campaign_id
  let attributedBy = campaignId ? 'explicit' : 'none'
  let lag: number | null = null

  for (const c of clicksBySubscriber.get(Number(sale.subscriber_id)) ?? []) {
    if (c.occurred_at > sale.occurred_at) continue
    const ageDays = (sale.occurred_at - c.occurred_at) / DAY_MS

    if (c.broadcast_id && ageDays <= WINDOW_DAYS.broadcast) {
      messageId = Number(c.message_id)
      sourceKind = 'broadcast'
      sourceId = Number(c.broadcast_id)
      if (!campaignId) {
        campaignId = c.broadcast_campaign
        attributedBy = 'last_touch'
      }
      lag = Math.round((sale.occurred_at - c.occurred_at) / 1000)
      break
    }
    if (c.sequence_id && ageDays <= WINDOW_DAYS.sequence) {
      messageId = Number(c.message_id)
      sourceKind = 'sequence'
      sourceId = Number(c.sequence_id)
      if (!campaignId) {
        campaignId = c.sequence_campaign
        attributedBy = 'last_touch'
      }
      lag = Math.round((sale.occurred_at - c.occurred_at) / 1000)
      break
    }
  }

  byKind.set(kind.slug, (byKind.get(kind.slug) ?? 0) + 1)
  if (offer) tally.withOffer++
  if (attributedBy === 'last_touch') tally.lastTouch++
  else if (attributedBy === 'explicit') tally.explicit++
  else tally.direct++

  statements.push(
    'insert or ignore into conversions ' +
      '(subscriber_id, kind_id, kind_slug, sale_id, value_cents, currency, message_id, ' +
      'source_kind, source_id, campaign_id, offer_id, offer_slug, attributed_by, ' +
      'touch_lag_seconds, occurred_at, created_at) values (' +
      [
        sale.subscriber_id,
        kind.id,
        sqlStr(kind.slug),
        sale.id,
        sale.amount_cents,
        sqlStr(sale.currency),
        messageId ?? 'null',
        sqlStr(sourceKind),
        sourceId,
        campaignId ?? 'null',
        offer?.id ?? 'null',
        offer ? sqlStr(offer.slug) : 'null',
        sqlStr(attributedBy),
        lag ?? 'null',
        sale.occurred_at,
        now,
      ].join(', ') +
      ');',
  )
}

// ─────────────────────────────────────────────────────────── report

console.log(`\n${salesRows.length} sale(s) without a conversion:\n`)
for (const k of kinds) {
  console.log(`  ${k.slug.padEnd(22)} ${byKind.get(k.slug) ?? 0}`)
}
if (unmatched) console.log(`  ${'(no kind matched)'.padEnd(22)} ${unmatched} — skipped`)
console.log(`  ${'resolved to an offer'.padEnd(22)} ${tally.withOffer}`)
console.log('')
console.log(`  attributed explicit  ${tally.explicit}`)
console.log(`  attributed last-touch ${tally.lastTouch}`)
console.log(`  direct (no click in window) ${tally.direct}`)

if (dryRun) {
  console.log('\n--dry-run: nothing written.')
  process.exit(0)
}

// One statement per execute would be one D1 query each. Batched into chunks well
// under the 1,000-per-invocation cap.
const CHUNK = 40
for (let i = 0; i < statements.length; i += CHUNK) {
  await d1(statements.slice(i, i + CHUNK).join(' '))
  console.log(`  wrote ${Math.min(i + CHUNK, statements.length)}/${statements.length}`)
}

// ── prove nothing was invented or lost
const check = (await d1(`
  select
    (select count(*) from conversions) conversions,
    (select coalesce(sum(value_cents), 0) from conversions) conv_cents,
    (select count(*) from sales) all_sales,
    (select coalesce(sum(amount_cents), 0) from sales) all_cents
`)) as {
  conversions: number
  conv_cents: number
  all_sales: number
  all_cents: number
}[]

const c = check[0]!
console.log('\nreconcile:')
console.log(`  conversions            ${c.conversions}`)
console.log(`  sales                  ${c.all_sales}`)
console.log(`  converted value        $${(c.conv_cents / 100).toFixed(2)}`)
console.log(`  sales value            $${(c.all_cents / 100).toFixed(2)}`)
if (c.conv_cents !== c.all_cents) {
  console.log('\n  ⚠️  totals differ. Expected only if some sales matched no kind')
  console.log('      (reported above) — otherwise something is wrong, not rounding.')
}
