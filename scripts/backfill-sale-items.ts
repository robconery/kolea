/**
 * Repair: give backfilled sales their line items, so they can be classified.
 *
 * ## The gap this fills
 *
 * `syncStripe()` reads `/charges` and records each one as a sale. A charge does
 * not carry what was bought — no price, no product — so sales recorded that way
 * land with an empty `sale_items`, and both of the specific conversion kinds
 * have nothing to match on:
 *
 *   price_interval  needs `sale_items → stripe_prices.interval`
 *   offer_in        needs `sale_items → stripe_products.metadata.sku → offers.slug`
 *
 * Without line items every sale falls through to the `any_sale` catch-all, which
 * silently books a $269 yearly subscription and a $4,000 cohort seat as the same
 * undifferentiated "purchase". The numbers still add up, which is what makes it
 * dangerous — the totals look right while every goal below the top line is wrong.
 *
 * The webhook path does not have this problem: a `checkout.session.completed` or
 * `invoice.paid` event carries its lines, and `recordConversion` is handed them
 * live. This is only for sales that arrived through the charge-list sync.
 *
 * ## Why invoices, and not every charge
 *
 * Line items are read from **paid invoices**, not from checkout sessions. That
 * covers every subscription renewal and every invoiced sale — which is to say,
 * everything that could possibly be a yearly subscription or a cohort seat.
 * One-off charges outside the invoice flow are left with no items on purpose:
 * they classify as `purchase`, which is what they are, and fetching a checkout
 * session for each of them would be a few hundred API calls to confirm an answer
 * already known.
 *
 * ## Linking an invoice back to its charge
 *
 * On API version 2025-08-27 (Basil) neither `charge.invoice` nor
 * `invoice.charge` exists. The surviving path is
 * `invoice.payments[].payment.payment_intent`, joined to `charge.payment_intent`.
 * Both sides come out of list calls that are already being made, so the join
 * costs nothing extra.
 *
 * Idempotent: `sale_items_sale_price_key` is UNIQUE on (sale_id, stripe_price_id)
 * and every insert is `on conflict do nothing`.
 *
 *   bun scripts/backfill-sale-items.ts --local
 *   bun scripts/backfill-sale-items.ts --remote --dry-run
 *   bun scripts/backfill-sale-items.ts --remote --since 2026-01-01
 */

export {}

const argv = process.argv.slice(2)
const has = (f: string) => argv.includes(f)
const valueOf = (f: string) => {
  const i = argv.indexOf(f)
  return i === -1 ? null : (argv[i + 1] ?? null)
}

const remote = has('--remote')
const dryRun = has('--dry-run')
if (!remote && !has('--local')) {
  console.error('Pass --local or --remote.')
  process.exit(1)
}

const sinceArg = valueOf('--since') ?? '2026-01-01'
const SINCE = Math.floor(new Date(`${sinceArg}T00:00:00Z`).getTime() / 1000)
if (!Number.isFinite(SINCE)) {
  console.error(`Bad --since: ${sinceArg}`)
  process.exit(1)
}

// ─────────────────────────────────────────────────────────── stripe

const STRIPE_VERSION = '2025-08-27.basil'

async function readKey(): Promise<string> {
  const text = await Bun.file('.dev.vars').text()
  const line = text.split('\n').find((l) => l.startsWith('STRIPE_SECRET_KEY='))
  const key = line?.slice('STRIPE_SECRET_KEY='.length).trim().replace(/^['"]|['"]$/g, '')
  if (!key) {
    console.error('No STRIPE_SECRET_KEY in .dev.vars')
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
  const url = `https://api.stripe.com/v1/${path}${qs.size ? `?${qs}` : ''}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${KEY}`, 'Stripe-Version': STRIPE_VERSION },
  })
  if (!res.ok) throw new Error(`Stripe ${path}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

interface StripeList<T> {
  data: T[]
  has_more: boolean
}

async function stripeAll<T extends { id: string }>(
  path: string,
  params: Record<string, string | number | string[]> = {},
): Promise<T[]> {
  const out: T[] = []
  let startingAfter: string | undefined
  for (;;) {
    const page = await stripe<StripeList<T>>(path, {
      ...params,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
    out.push(...page.data)
    if (!page.has_more || !page.data.length) return out
    startingAfter = page.data[page.data.length - 1]!.id
  }
}

// ─────────────────────────────────────────────────────────── wrangler

async function d1(command: string): Promise<Record<string, unknown>[]> {
  const args = ['d1', 'execute', 'big-mailer', '--json', '--command', command]
  args.push(remote ? '--remote' : '--local')
  if (remote) args.push('--env', 'production')

  // `bunx wrangler`, never bare `wrangler` — a stale global install talks to a
  // different D1 and the writes land where nothing is looking.
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

// ─────────────────────────────────────────────────────────── run

interface Charge {
  id: string
  payment_intent: string | null
}
interface InvoiceLine {
  description: string | null
  amount: number
  quantity: number | null
  pricing?: { price_details?: { price?: string; product?: string } | null } | null
}
interface Invoice {
  id: string
  lines: { data: InvoiceLine[] }
  payments?: { data: { payment?: { payment_intent?: string } | null }[] } | null
}

console.log(`Reading Stripe from ${sinceArg}…`)

const charges = await stripeAll<Charge>('charges', { 'created[gte]': SINCE })
const chargeByIntent = new Map<string, string>()
for (const c of charges) if (c.payment_intent) chargeByIntent.set(c.payment_intent, c.id)

const invoices = await stripeAll<Invoice>('invoices', {
  'created[gte]': SINCE,
  status: 'paid',
  'expand[]': ['data.payments', 'data.lines.data'],
})

console.log(`  ${charges.length} charges · ${invoices.length} paid invoices`)

// Sales are keyed by the Stripe charge id in `external_id`.
const saleRows = await d1(
  `select id, external_id from sales where external_id is not null and occurred_at >= ${SINCE * 1000}`,
)
const saleByCharge = new Map<string, number>()
for (const r of saleRows) saleByCharge.set(String(r.external_id), Number(r.id))
console.log(`  ${saleByCharge.size} sales on the books with a charge id`)

const inserts: string[] = []
const now = Date.now()
let unlinked = 0
let noSale = 0
let noPrice = 0

for (const inv of invoices) {
  const intents = (inv.payments?.data ?? [])
    .map((p) => p.payment?.payment_intent)
    .filter((x): x is string => !!x)
  const chargeId = intents.map((i) => chargeByIntent.get(i)).find(Boolean)
  if (!chargeId) {
    unlinked++
    continue
  }
  const saleId = saleByCharge.get(chargeId)
  if (!saleId) {
    noSale++
    continue
  }

  for (const line of inv.lines.data) {
    const price = line.pricing?.price_details?.price ?? null
    const product = line.pricing?.price_details?.product ?? null
    // A line with no price cannot drive either rule, and the unique index is on
    // (sale_id, price) — writing it would add noise and guard nothing.
    if (!price) {
      noPrice++
      continue
    }
    inserts.push(
      `insert into sale_items (sale_id, stripe_product_id, stripe_price_id, description, quantity, amount_cents, created_at) ` +
        `values (${saleId}, ${product ? q(product) : 'NULL'}, ${q(price)}, ` +
        `${q(line.description ?? '')}, ${line.quantity ?? 1}, ${line.amount ?? 0}, ${now}) ` +
        `on conflict do nothing;`,
    )
  }
}

console.log(
  `\n${inserts.length} line item(s) to write · ${unlinked} invoice(s) with no matching charge · ` +
    `${noSale} with no sale on the books · ${noPrice} line(s) with no price`,
)

if (dryRun) {
  console.log('\n--dry-run: nothing written.')
  for (const line of inserts.slice(0, 5)) console.log(`  ${line}`)
  if (inserts.length > 5) console.log(`  … and ${inserts.length - 5} more`)
  process.exit(0)
}

// Batched: one wrangler invocation per chunk keeps the command line sane and
// each D1 request well inside its statement budget.
const CHUNK = 50
for (let i = 0; i < inserts.length; i += CHUNK) {
  await d1(inserts.slice(i, i + CHUNK).join('\n'))
  console.log(`  wrote ${Math.min(i + CHUNK, inserts.length)}/${inserts.length}`)
}

const after = await d1('select count(*) as n from sale_items')
console.log(`\nsale_items now: ${after[0]?.n ?? '?'}`)
console.log('Next: bun scripts/backfill-conversions.ts --remote --dry-run')
