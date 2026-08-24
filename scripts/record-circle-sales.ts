/**
 * Record the Circle Stripe account's revenue as sales + conversions.
 *
 * ## Why this is a script and not a feature
 *
 * Rob runs a second Stripe account for Circle, and it is deliberately **not**
 * wired into the Worker: no `STRIPE_CIRCLE_SECRET_KEY` in production, no branch
 * in `core/stripe.ts`, nothing in `core/sending.ts` that knows it exists. That
 * is his call, and this script respects it — it reads Circle from a laptop and
 * writes the resulting rows into D1 by hand.
 *
 * The consequence is that Circle money is a **snapshot, not a feed**. Nothing
 * updates it. Re-run this whenever more Circle revenue lands, or the goals go
 * stale. It is idempotent (see below), so re-running is always safe and only
 * picks up what is new.
 *
 * ## The kind mapping, and where it diverges from the rules
 *
 *   Core Access                  → cohort
 *   Premium Access (yearly)      → subscription_yearly
 *   Premium Access (monthly)     → purchase
 *   Turn Yourself Into a Plugin  → purchase
 *
 * ⚠️ **`Core Access` is a $995/year subscription**, so the ordinary rules would
 * classify it `subscription_yearly` — `price_interval` sits at priority 10 and
 * wins before `offer_in` at 20. It is mapped to `cohort` here because Rob says a
 * core membership *is* the cohort, and that is a judgement about the business
 * that the priority table cannot make. The divergence is real and worth knowing:
 * if Circle is ever wired into the Worker, the same sale arriving through the
 * webhook would land in `subscription_yearly` instead, and the two would
 * disagree.
 *
 * ## Consent
 *
 * A buyer with no subscriber row gets one, exactly as `upsertBuyer()` does for
 * every other sale — `status = 'active'`, and **no subscribe sequence is fired**.
 * This script writes the subscriber row directly rather than going through
 * `upsertSubscriber()`, for the reason CLAUDE.md gives: that function calls
 * `enrollOnSubscribe()`, and importing N people into a live sequence mails all N
 * of them. Anyone already on the list is left completely untouched — no status
 * change, ever, and an `unsubscribed` buyer stays unsubscribed (SPEC 1.2).
 *
 * Idempotent twice over: `sales_external_id_key` is UNIQUE on `external_id`
 * (prefixed `circle:` so a Circle charge id can never collide with a Big Machine
 * one), and `conversions_sale_key` is UNIQUE on `sale_id`.
 *
 *   bun scripts/record-circle-sales.ts --dry-run
 *   bun scripts/record-circle-sales.ts --remote
 *   bun scripts/record-circle-sales.ts --local
 */

export {}

const argv = process.argv.slice(2)
const has = (f: string) => argv.includes(f)
const remote = has('--remote')
const dryRun = has('--dry-run')
if (!remote && !has('--local') && !dryRun) {
  console.error('Pass --local, --remote, or --dry-run.')
  process.exit(1)
}

const STRIPE_VERSION = '2025-08-27.basil'

/** Product name → conversion kind slug. See the divergence note in the header. */
const KIND_BY_PRODUCT: Record<string, string> = {
  'Core Access': 'cohort',
  'Premium Access': 'subscription_yearly',
  'Turn Yourself Into a Plugin': 'purchase',
}
/** A monthly plan is not a yearly subscription, whatever the product is called. */
const MONTHLY_FALLBACK_KIND = 'purchase'

// ─────────────────────────────────────────────────────────── stripe

async function readKey(): Promise<string> {
  const text = await Bun.file('.dev.vars').text()
  const line = text.split('\n').find((l) => l.startsWith('STRIPE_CIRCLE_SECRET_KEY='))
  const key = line?.slice('STRIPE_CIRCLE_SECRET_KEY='.length).trim().replace(/^['"]|['"]$/g, '')
  if (!key) {
    console.error('No STRIPE_CIRCLE_SECRET_KEY in .dev.vars')
    process.exit(1)
  }
  return key
}
const KEY = await readKey()

async function stripe<T>(path: string, params: Record<string, string | number | string[]> = {}) {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const one of v) qs.append(k, one)
    else qs.append(k, String(v))
  }
  const res = await fetch(`https://api.stripe.com/v1/${path}${qs.size ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${KEY}`, 'Stripe-Version': STRIPE_VERSION },
  })
  if (!res.ok) throw new Error(`Stripe ${path}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

async function stripeAll<T extends { id: string }>(
  path: string,
  params: Record<string, string | number | string[]> = {},
): Promise<T[]> {
  const out: T[] = []
  let after: string | undefined
  for (;;) {
    const page = await stripe<{ data: T[]; has_more: boolean }>(path, {
      ...params,
      limit: 100,
      ...(after ? { starting_after: after } : {}),
    })
    out.push(...page.data)
    if (!page.has_more || !page.data.length) return out
    after = page.data[page.data.length - 1]!.id
  }
}

// ─────────────────────────────────────────────────────────── wrangler

async function d1(command: string): Promise<Record<string, unknown>[]> {
  const args = ['d1', 'execute', 'big-mailer', '--json', '--command', command]
  args.push(remote ? '--remote' : '--local')
  if (remote) args.push('--env', 'production')
  const proc = Bun.spawn(['bunx', 'wrangler', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  if ((await proc.exited) !== 0) {
    console.error(err)
    throw new Error('wrangler d1 execute failed')
  }
  const start = out.indexOf('[')
  const parsed = JSON.parse(out.slice(start === -1 ? 0 : start)) as {
    results: Record<string, unknown>[]
  }[]
  return parsed[0]?.results ?? []
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`

// ─────────────────────────────────────────────────────────── read Circle

interface Charge {
  id: string
  amount: number
  amount_refunded: number
  currency: string
  created: number
  paid: boolean
  status: string
  description: string | null
  payment_intent: string | null
  billing_details?: { email?: string | null; name?: string | null } | null
  receipt_email?: string | null
}
interface Price {
  id: string
  recurring?: { interval?: string } | null
  product: string | { id: string; name: string }
}
interface Invoice {
  id: string
  lines: {
    data: { pricing?: { price_details?: { price?: string; product?: string } | null } | null }[]
  }
  payments?: { data: { payment?: { payment_intent?: string } | null }[] } | null
}

console.log('Reading the Circle account…')
const charges = (await stripeAll<Charge>('charges')).filter(
  (c) => c.paid && c.status === 'succeeded',
)
const prices = await stripeAll<Price>('prices', { 'expand[]': ['data.product'] })
const invoices = await stripeAll<Invoice>('invoices', {
  status: 'paid',
  'expand[]': ['data.payments', 'data.lines.data'],
})

const priceInfo = new Map<string, { product: string; interval: string }>()
for (const p of prices) {
  priceInfo.set(p.id, {
    product: typeof p.product === 'object' ? p.product.name : String(p.product),
    interval: p.recurring?.interval ?? 'one_time',
  })
}

// charge id → the price it billed, via payment intent (see backfill-sale-items.ts
// for why this indirection is necessary on the Basil API version).
const intentToCharge = new Map<string, string>()
for (const c of charges) if (c.payment_intent) intentToCharge.set(c.payment_intent, c.id)
const chargeToPrice = new Map<string, string>()
for (const inv of invoices) {
  const intents = (inv.payments?.data ?? [])
    .map((p) => p.payment?.payment_intent)
    .filter((x): x is string => !!x)
  const charge = intents.map((i) => intentToCharge.get(i)).find(Boolean)
  if (!charge) continue
  const price = inv.lines.data[0]?.pricing?.price_details?.price
  if (price) chargeToPrice.set(charge, price)
}

console.log(`  ${charges.length} paid charges · ${invoices.length} paid invoices`)

// ─────────────────────────────────────────────────────────── plan

const kinds = await d1('select id, slug from conversion_kinds')
const kindId = new Map(kinds.map((k) => [String(k.slug), Number(k.id)]))
for (const slug of new Set([...Object.values(KIND_BY_PRODUCT), MONTHLY_FALLBACK_KIND])) {
  if (!kindId.has(slug)) {
    console.error(`No conversion kind "${slug}" — run seed-conversion-kinds.ts first.`)
    process.exit(1)
  }
}

interface Planned {
  chargeId: string
  external: string
  email: string
  name: string | null
  cents: number
  refunded: boolean
  product: string
  kind: string
  occurred: number
}

const planned: Planned[] = []
const skipped: string[] = []

for (const c of charges) {
  const email = (c.billing_details?.email ?? c.receipt_email ?? '').trim().toLowerCase()
  if (!email) {
    skipped.push(`${c.id}: no email`)
    continue
  }
  const price = chargeToPrice.get(c.id)
  const info = price ? priceInfo.get(price) : undefined
  const product = info?.product ?? (c.description ?? '').trim()
  let kind = KIND_BY_PRODUCT[product]
  if (kind === 'subscription_yearly' && info && info.interval !== 'year') {
    kind = MONTHLY_FALLBACK_KIND
  }
  if (!kind) {
    skipped.push(`${c.id}: unmapped product "${product}"`)
    continue
  }
  planned.push({
    chargeId: c.id,
    external: `circle:${c.id}`,
    email,
    name: c.billing_details?.name ?? null,
    // Gross, like every other conversion here: a sale is a sale, and the refund
    // lives on `sales.status` for accounting (see core/goals.ts).
    cents: c.amount,
    refunded: c.amount_refunded >= c.amount && c.amount > 0,
    product,
    kind,
    occurred: c.created * 1000,
  })
}

const byKind = new Map<string, { n: number; cents: number }>()
for (const p of planned) {
  const cur = byKind.get(p.kind) ?? { n: 0, cents: 0 }
  byKind.set(p.kind, { n: cur.n + 1, cents: cur.cents + p.cents })
}
console.log(`\n${planned.length} charge(s) to record:`)
for (const [k, v] of byKind)
  console.log(`  ${k.padEnd(22)} ${v.n} · $${(v.cents / 100).toLocaleString('en-US')}`)
for (const s of skipped) console.log(`  skipped — ${s}`)

// Which of these are already on the books, and who is not yet a subscriber.
const emails = [...new Set(planned.map((p) => p.email))]
const emailList = emails.map((e) => q(e)).join(',')
const existingSubs = await d1(
  `select id, lower(email) as email, status from subscribers where lower(email) in (${emailList})`,
)
const subByEmail = new Map(existingSubs.map((r) => [String(r.email), Number(r.id)]))
const externals = planned.map((p) => q(p.external)).join(',')
const existingSales = await d1(
  `select id, external_id from sales where external_id in (${externals})`,
)
const saleByExternal = new Map(existingSales.map((r) => [String(r.external_id), Number(r.id)]))

const newPeople = emails.filter((e) => !subByEmail.has(e))
console.log(
  `\n  ${subByEmail.size} buyer(s) already subscribers · ${newPeople.length} new subscriber row(s) will be created`,
)
console.log(`  ${saleByExternal.size} of ${planned.length} sale(s) already recorded`)

if (dryRun) {
  console.log('\n--dry-run: nothing written.')
  for (const p of planned.slice(0, 6))
    console.log(`  ${p.occurred} ${p.email.padEnd(34)} $${(p.cents / 100).toFixed(2).padStart(9)} ${p.kind}`)
  if (planned.length > 6) console.log(`  … and ${planned.length - 6} more`)
  process.exit(0)
}

// ─────────────────────────────────────────────────────────── write

const now = Date.now()
const token = (seed: string) => `circle-${seed.replace(/[^a-zA-Z0-9]/g, '').slice(-24)}-${now.toString(36)}`

// 1. subscribers for buyers who have none. Direct insert, never
//    upsertSubscriber() — see the consent note in the header.
const subInserts = newPeople.map(
  (email) =>
    `insert into subscribers (email, name, status, attributes, source, unsub_token, created_at, confirmed_at) ` +
    `select ${q(email)}, ${q(planned.find((p) => p.email === email)?.name ?? '')}, 'active', '{}', 'circle-stripe', ` +
    `${q(token(email))}, ${now}, ${now} ` +
    `where not exists (select 1 from subscribers where lower(email) = ${q(email)});`,
)
if (subInserts.length) {
  await d1(subInserts.join('\n'))
  console.log(`\nwrote ${subInserts.length} subscriber row(s)`)
}

// 2. sales.
const saleInserts = planned
  .filter((p) => !saleByExternal.has(p.external))
  .map(
    (p) =>
      // `sales` carries no attribution column — the credit lives on
      // `campaign_id` (null here: Circle money is not part of a campaign) and
      // the full path is frozen on the conversion row below.
      `insert into sales (subscriber_id, campaign_id, amount_cents, currency, status, product, external_id, meta, occurred_at, created_at) ` +
      `select s.id, NULL, ${p.cents}, ${q('usd')}, ${q(p.refunded ? 'refunded' : 'paid')}, ${q(p.product)}, ` +
      `${q(p.external)}, ${q(JSON.stringify({ source: 'circle-stripe', charge: p.chargeId }))}, ${p.occurred}, ${now} ` +
      `from subscribers s where lower(s.email) = ${q(p.email)} ` +
      `on conflict do nothing;`,
  )
for (let i = 0; i < saleInserts.length; i += 40) {
  await d1(saleInserts.slice(i, i + 40).join('\n'))
}
console.log(`wrote ${saleInserts.length} sale row(s)`)

// 3. conversions, with the kind decided above rather than by `classifyKind` —
//    the Circle catalog is not mirrored here, so the rules have nothing to read.
const convInserts = planned.map(
  (p) =>
    `insert into conversions (subscriber_id, kind_id, kind_slug, sale_id, value_cents, currency, message_id, ` +
    `source_kind, source_id, campaign_id, offer_id, offer_slug, attributed_by, touch_lag_seconds, occurred_at, created_at) ` +
    `select sa.subscriber_id, ${kindId.get(p.kind)}, ${q(p.kind)}, sa.id, ${p.cents}, 'usd', NULL, ` +
    `'direct', 0, NULL, NULL, NULL, 'explicit', NULL, ${p.occurred}, ${now} ` +
    `from sales sa where sa.external_id = ${q(p.external)} ` +
    `and not exists (select 1 from conversions c where c.sale_id = sa.id);`,
)
for (let i = 0; i < convInserts.length; i += 40) {
  await d1(convInserts.slice(i, i + 40).join('\n'))
}
console.log(`wrote conversions for ${convInserts.length} sale(s)`)

const after = await d1(
  `select count(*) n, coalesce(sum(value_cents),0) cents from conversions ` +
    `where sale_id in (select id from sales where external_id like 'circle:%')`,
)
console.log(
  `\nCircle conversions on the books: ${after[0]?.n ?? '?'} · $${(Number(after[0]?.cents ?? 0) / 100).toLocaleString('en-US')}`,
)
