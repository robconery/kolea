/**
 * Mirror the Neon storefront into the local D1 commerce tables.
 *
 * Neon is the source of truth. This rebuilds `offers`, `offer_products`,
 * `purchases` and `purchase_stats` from it wholesale — it is a projection, so a
 * full refresh is both correct and simpler than reconciling deltas. Roughly 31k
 * orders across ~21k buyers.
 *
 * ⚠️ LOCAL ONLY, on purpose. There is no `--remote` and no `--env production`
 * anywhere in this file. Pointing a full-refresh rebuild at the production
 * database is a deliberate act that deserves its own reviewed script, not a flag
 * on this one.
 *
 * Reads Neon through `psql --csv` rather than a driver: this is an offline
 * backfill run on a laptop, and it does not justify adding a Postgres client to
 * a Worker project's dependency tree. The eventual scheduled sync inside the
 * Worker is a different mechanism (`@neondatabase/serverless` over HTTP).
 *
 *   bun scripts/import-neon-purchases.ts --dry-run   # generate SQL, print summary
 *   bun scripts/import-neon-purchases.ts             # generate + apply to local D1
 */

import { rebuildPurchaseStatsSql } from '../src/core/purchase-stats-sql.ts'

export {}

const OUT_DIR = '.import-neon'
const CHUNK_ROWS = 400
const PER_FILE = 25

const argv = new Set(process.argv.slice(2))
const dryRun = argv.has('--dry-run')
if (argv.has('--remote') || argv.has('--env')) {
  console.error('This script is local-only by design. See the header comment.')
  process.exit(1)
}

// ─────────────────────────────────────────────────────────── neon

/** `.dev.vars` is dotenv-ish, and the URL may be quoted. */
async function neonUrl(): Promise<string> {
  const raw = await Bun.file('.dev.vars').text()
  const line = raw.split('\n').find((l) => l.trim().startsWith('NEON_URL='))
  if (!line) throw new Error('NEON_URL is not in .dev.vars')
  return line
    .slice(line.indexOf('=') + 1)
    .trim()
    .replace(/^['"]|['"]$/g, '')
}

const NEON_URL = await neonUrl()

/** Full-file CSV reader: quoted cells may contain commas and newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"'
          i++
        } else quoted = false
      } else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cur)
      cur = ''
    } else if (ch === '\n') {
      row.push(cur)
      rows.push(row)
      row = []
      cur = ''
    } else if (ch !== '\r') cur += ch
  }
  if (cur !== '' || row.length) {
    row.push(cur)
    rows.push(row)
  }
  return rows
}

/** Run one SELECT against Neon and return it as objects keyed by column name. */
function pg(sql: string): Record<string, string>[] {
  const proc = Bun.spawnSync(['psql', NEON_URL, '--csv', '--no-psqlrc', '-c', sql], {
    stderr: 'pipe',
    stdout: 'pipe',
  })
  if (proc.exitCode !== 0) {
    throw new Error(`psql failed: ${new TextDecoder().decode(proc.stderr)}`)
  }
  const rows = parseCsv(new TextDecoder().decode(proc.stdout).trimEnd())
  const header = rows[0]
  if (!header) return []
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])))
}

// ─────────────────────────────────────────────────────────── sql helpers

const q = (v: string) => `'${v.replace(/'/g, "''")}'`
const nullable = (v: string) => (v === '' ? 'NULL' : q(v))
const num = (v: string, fallback = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

// ─────────────────────────────────────────────────────────── read neon

console.log('Reading Neon…')

const offerRows = pg(`
  select id, slug, title, coalesce(price_cents, 0) as price_cents,
         case when active then 1 else 0 end as active, sort_order
  from offers
  order by id
`)

const offerProductRows = pg(`
  select op.offer_id, p.sku, p.name
  from offer_products op
  join products p on p.id = op.product_id
  order by op.offer_id, p.sku
`)

/**
 * `confidence` comes from `recovered_orders`, which is where the reconstructed
 * history lives — 4,958 of those resolved confidently, 1,237 to nothing at all.
 * Deliberately a scalar subquery with `max()` rather than a join: `order_number`
 * carries no unique constraint over there, and a join that fanned out would
 * silently double a person's lifetime spend. `max()` sorts 'none' above 'low'
 * above 'high', so an ambiguous match lands on the pessimistic answer.
 */
const orderRows = pg(`
  select
    o.id::text                                   as external_id,
    lower(trim(o.email))                         as email,
    o.store                                      as store,
    coalesce(o.amount_total, 0)                  as amount_cents,
    coalesce(o.currency, 'usd')                  as currency,
    coalesce(o.offer_id::text, '')               as offer_id,
    coalesce(f.slug, '')                         as offer_slug,
    coalesce(
      (select max(r.confidence) from recovered_orders r where r.order_number = o.number),
      'high'
    )                                            as confidence,
    (extract(epoch from o.created_at) * 1000)::bigint as occurred_ms
  from orders o
  left join offers f on f.id = o.offer_id
  order by o.created_at
`)

const CONFIDENCE = new Set(['high', 'low', 'none'])
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const skipped = { badEmail: 0, badDate: 0 }
const orders = orderRows.filter((r) => {
  if (!EMAIL_RE.test(r.email ?? '')) {
    skipped.badEmail++
    return false
  }
  if (!Number.isFinite(Number(r.occurred_ms))) {
    skipped.badDate++
    return false
  }
  return true
})

// ─────────────────────────────────────────────────────────── emit

const now = Date.now()
const statements: string[] = []

// Full refresh. Children before parents — `purchases.offer_id` points at `offers`.
statements.push('DELETE FROM purchase_stats;')
statements.push('DELETE FROM purchases;')
statements.push('DELETE FROM offer_products;')
statements.push('DELETE FROM offers;')

for (const o of offerRows) {
  statements.push(
    `INSERT INTO offers (id, slug, title, price_cents, active, sort_order, synced_at) VALUES ` +
      `(${num(o.id ?? '')}, ${q(o.slug ?? '')}, ${q(o.title ?? '')}, ${num(o.price_cents ?? '')}, ` +
      `${num(o.active ?? '')}, ${num(o.sort_order ?? '')}, ${now});`,
  )
}

if (offerProductRows.length) {
  const values = offerProductRows
    .map((r) => `(${num(r.offer_id ?? '')}, ${q(r.sku ?? '')}, ${q(r.name ?? '')})`)
    .join(',\n  ')
  statements.push(
    `INSERT INTO offer_products (offer_id, product_sku, product_name) VALUES\n  ${values};`,
  )
}

for (let i = 0; i < orders.length; i += CHUNK_ROWS) {
  const values = orders
    .slice(i, i + CHUNK_ROWS)
    .map((r) => {
      const confidence = CONFIDENCE.has(r.confidence ?? '') ? r.confidence! : 'high'
      return (
        `(${q(r.email ?? '')}, ${q(`neon:${r.external_id}`)}, ` +
        `${r.offer_id ? num(r.offer_id) : 'NULL'}, ${nullable(r.offer_slug ?? '')}, ` +
        `${q(r.store ?? '')}, ${num(r.amount_cents ?? '')}, ${q(r.currency ?? 'usd')}, ` +
        `${q(confidence)}, ${num(r.occurred_ms ?? '')}, ${now})`
      )
    })
    .join(',\n  ')
  statements.push(
    `INSERT INTO purchases (email, external_id, offer_id, offer_slug, store, amount_cents, ` +
      `currency, confidence, occurred_at, synced_at) VALUES\n  ${values};`,
  )
}

// The rollup, rebuilt by the same SQL the Worker uses. Two statements whatever
// the row count, because SQLite does the aggregating.
statements.push(...rebuildPurchaseStatsSql(now))

await Bun.$`rm -rf ${OUT_DIR}`.quiet()
await Bun.$`mkdir -p ${OUT_DIR}`.quiet()
const files: string[] = []
for (let i = 0; i < statements.length; i += PER_FILE) {
  const path = `${OUT_DIR}/${String(files.length).padStart(4, '0')}.sql`
  await Bun.write(path, `${statements.slice(i, i + PER_FILE).join('\n')}\n`)
  files.push(path)
}

const gross = orders.reduce((sum, r) => sum + num(r.amount_cents ?? ''), 0)
const buyers = new Set(orders.map((r) => r.email)).size

console.log(`
  offers            ${offerRows.length}
  offer_products    ${offerProductRows.length}
  orders            ${orders.length}
  buyers            ${buyers}
  gross             $${(gross / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
  skipped           bad email ${skipped.badEmail}, bad date ${skipped.badDate}
  SQL               ${statements.length} statements across ${files.length} files in ${OUT_DIR}/
`)

if (dryRun) {
  console.log('--dry-run: nothing applied.')
  process.exit(0)
}

// ─────────────────────────────────────────────────────────── apply

for (const [n, path] of files.entries()) {
  process.stdout.write(`  [${n + 1}/${files.length}] ${path} … `)
  const proc = Bun.spawnSync(
    ['npx', 'wrangler', 'd1', 'execute', 'big-mailer', '--local', '--file', path, '--yes'],
    { stderr: 'pipe', stdout: 'pipe' },
  )
  if (proc.exitCode !== 0) {
    console.log('FAILED')
    console.error(new TextDecoder().decode(proc.stderr))
    process.exit(1)
  }
  console.log('ok')
}

console.log('\nDone. Local D1 now mirrors the Neon storefront.')
