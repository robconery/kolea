/**
 * Bring the production commerce tables into existence and fill them from local D1.
 *
 * This is the "deliberate act" that `scripts/import-neon-purchases.ts` refuses to
 * be. That script is a local-only Neon→D1 projection and stays that way; this one
 * is the reviewed path that points at production, and it exists as its own file so
 * the `--remote` blast radius is something you read on purpose rather than a flag
 * you fat-finger onto a local backfill.
 *
 * Two steps, in order:
 *
 *   1. `wrangler d1 migrations apply --env production --remote` — production's
 *      `d1_migrations` stopped at 0007 while the Worker that queries `offers`
 *      was already deployed, which is what 500s the dashboard.
 *   2. Copy `offers`, `offer_products` and `purchases` out of the local D1 file
 *      and into production, then rebuild `purchase_stats` from the copied rows.
 *
 * ⚠️ Scope. This writes to exactly four tables, all of them commerce mirrors
 * created by migration 0008 (see TABLES below). It does not read, write, or
 * reference `subscribers`, `messages`, `broadcasts`, `sequences` or anything
 * else, and nothing here can put mail on the wire — no provider is constructed
 * and no queue is touched. The DELETEs are a full refresh of a projection, not
 * a data migration: every row they remove is reinserted from local in the same
 * run.
 *
 * `purchase_stats` is deliberately NOT copied. It is a rollup, and it gets
 * rebuilt in production by the same SQL the Worker uses
 * (`core/purchase-stats-sql.ts`), so the numbers can't drift depending on who
 * computed them.
 *
 *   bun scripts/seed-production-store.ts             # dry run: generate SQL, print summary
 *   bun scripts/seed-production-store.ts --apply     # actually migrate + copy
 *   bun scripts/seed-production-store.ts --apply --skip-migrations
 */

import { Database } from 'bun:sqlite'
import { readdirSync } from 'node:fs'
import { rebuildPurchaseStatsSql } from '../src/core/purchase-stats-sql.ts'

export {}

const OUT_DIR = '.seed-production-store'
const D1_STATE_DIR = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject'
const DATABASE = 'big-mailer'

/** Rows per INSERT, and INSERTs per file. One file is one round trip to D1. */
const CHUNK_ROWS = 200
const PER_FILE = 10

/**
 * The only tables this script may touch. Asserted against the generated SQL
 * before anything is sent, so a careless edit to the emit section fails here
 * rather than in production.
 */
const TABLES = ['offers', 'offer_products', 'purchases', 'purchase_stats'] as const

const argv = new Set(process.argv.slice(2))
const apply = argv.has('--apply')
const skipMigrations = argv.has('--skip-migrations')

// ─────────────────────────────────────────────────────────── local d1

/**
 * Miniflare names each local D1 file by a hash, and this project has more than
 * one of them — an older database that only ever got as far as `subscribers`,
 * and the current one. Picking by "has an `offers` table with rows in it" beats
 * hardcoding a hash that changes the next time the local database is recreated.
 */
function openLocalD1(): Database {
  const candidates = readdirSync(D1_STATE_DIR)
    .filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')
    .map((f) => `${D1_STATE_DIR}/${f}`)

  const matches: string[] = []
  for (const path of candidates) {
    try {
      const db = new Database(path, { readonly: true })
      const row = db.query<{ n: number }, []>('SELECT count(*) AS n FROM offers').get()
      if (row && row.n > 0) matches.push(path)
      else db.close()
    } catch {
      // No `offers` table, or not readable: not the database we want.
    }
  }

  if (matches.length === 0) {
    throw new Error(
      `No local D1 database with a populated \`offers\` table under ${D1_STATE_DIR}.\n` +
        'Run `bun scripts/import-neon-purchases.ts` first — this script copies what that one built.',
    )
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous local D1: ${matches.join(', ')}. Delete the stale one and retry.`)
  }
  return new Database(matches[0]!, { readonly: true })
}

const local = openLocalD1()

type OfferRow = {
  id: number
  slug: string
  title: string
  price_cents: number | null
  active: number
  sort_order: number
}
type OfferProductRow = { offer_id: number; product_sku: string; product_name: string }
type PurchaseRow = {
  id: number
  email: string
  external_id: string
  offer_id: number | null
  offer_slug: string | null
  store: string
  amount_cents: number
  currency: string
  confidence: string
  occurred_at: number
}

const offers = local
  .query<OfferRow, []>(
    'SELECT id, slug, title, price_cents, active, sort_order FROM offers ORDER BY id',
  )
  .all()

const offerProducts = local
  .query<OfferProductRow, []>(
    'SELECT offer_id, product_sku, product_name FROM offer_products ORDER BY offer_id, product_sku',
  )
  .all()

const purchases = local
  .query<PurchaseRow, []>(
    `SELECT id, email, external_id, offer_id, offer_slug, store, amount_cents,
            currency, confidence, occurred_at
     FROM purchases ORDER BY id`,
  )
  .all()

local.close()

// ─────────────────────────────────────────────────────────── sql helpers

const q = (v: string) => `'${v.replace(/'/g, "''")}'`
const nullable = (v: string | null) => (v === null || v === '' ? 'NULL' : q(v))
const numOrNull = (v: number | null) => (v === null ? 'NULL' : Math.round(v))

// ─────────────────────────────────────────────────────────── emit

const now = Date.now()
const statements: string[] = []

// Full refresh of the projection. Children before parents: `purchases.offer_id`
// and `offer_products.offer_id` both point at `offers`.
statements.push('DELETE FROM purchase_stats;')
statements.push('DELETE FROM purchases;')
statements.push('DELETE FROM offer_products;')
statements.push('DELETE FROM offers;')

for (const o of offers) {
  statements.push(
    'INSERT INTO offers (id, slug, title, price_cents, active, sort_order, synced_at) VALUES ' +
      `(${o.id}, ${q(o.slug)}, ${q(o.title)}, ${numOrNull(o.price_cents)}, ` +
      `${o.active ? 1 : 0}, ${o.sort_order}, ${now});`,
  )
}

for (let i = 0; i < offerProducts.length; i += CHUNK_ROWS) {
  const values = offerProducts
    .slice(i, i + CHUNK_ROWS)
    .map((r) => `(${r.offer_id}, ${q(r.product_sku)}, ${q(r.product_name)})`)
    .join(',\n  ')
  statements.push(
    `INSERT INTO offer_products (offer_id, product_sku, product_name) VALUES\n  ${values};`,
  )
}

// `id` is carried over rather than left to AUTOINCREMENT, so a row means the
// same thing in both databases and a re-run is diffable against local.
for (let i = 0; i < purchases.length; i += CHUNK_ROWS) {
  const values = purchases
    .slice(i, i + CHUNK_ROWS)
    .map(
      (r) =>
        `(${r.id}, ${q(r.email)}, ${q(r.external_id)}, ${numOrNull(r.offer_id)}, ` +
        `${nullable(r.offer_slug)}, ${q(r.store)}, ${Math.round(r.amount_cents)}, ` +
        `${q(r.currency)}, ${q(r.confidence)}, ${Math.round(r.occurred_at)}, ${now})`,
    )
    .join(',\n  ')
  statements.push(
    'INSERT INTO purchases (id, email, external_id, offer_id, offer_slug, store, ' +
      `amount_cents, currency, confidence, occurred_at, synced_at) VALUES\n  ${values};`,
  )
}

// The rollup, rebuilt in production by the same SQL the Worker runs.
statements.push(...rebuildPurchaseStatsSql(now))

// ─────────────────────────────────────────────────────────── scope assertion

/**
 * Fail before the network, not after. Every statement must name one of the four
 * commerce tables — if an edit ever introduces a write to `subscribers`, this is
 * where the run stops.
 */
const allowed = TABLES.join('|')
const scopeRe = new RegExp(`^(?:DELETE FROM|INSERT INTO)\\s+(?:${allowed})\\b`, 'i')
for (const [n, s] of statements.entries()) {
  const head = s.trimStart()
  if (!scopeRe.test(head)) {
    console.error(`Statement ${n} is outside the allowed tables (${TABLES.join(', ')}):`)
    console.error(`  ${head.slice(0, 200)}`)
    process.exit(1)
  }
}

await Bun.$`rm -rf ${OUT_DIR}`.quiet()
await Bun.$`mkdir -p ${OUT_DIR}`.quiet()
const files: string[] = []
for (let i = 0; i < statements.length; i += PER_FILE) {
  const path = `${OUT_DIR}/${String(files.length).padStart(4, '0')}.sql`
  await Bun.write(path, `${statements.slice(i, i + PER_FILE).join('\n')}\n`)
  files.push(path)
}

const gross = purchases.reduce((sum, r) => sum + r.amount_cents, 0)
const buyers = new Set(purchases.map((r) => r.email)).size
const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

console.log(`
  offers            ${offers.length}
  offer_products    ${offerProducts.length}
  purchases         ${purchases.length}
  buyers            ${buyers}
  gross             ${money(gross)}
  SQL               ${statements.length} statements across ${files.length} files in ${OUT_DIR}/
`)

if (!apply) {
  console.log('Dry run. Nothing was migrated and nothing was copied. Re-run with --apply.')
  process.exit(0)
}

// ─────────────────────────────────────────────────────────── apply

/**
 * Twenty-odd round trips to a remote database is enough attempts that a
 * transient `fetch failed` is a matter of when, not if — one cost this run a
 * complete restart. A failed `d1 execute --file` leaves the database in its
 * original state (wrangler rolls the file back), so a retry is safe: it is the
 * same file against the same state, not a partial reapplication.
 */
function wrangler(args: string[], label: string, attempts = 4): void {
  for (let attempt = 1; ; attempt++) {
    const proc = Bun.spawnSync(['npx', 'wrangler', ...args], { stderr: 'pipe', stdout: 'pipe' })
    if (proc.exitCode === 0) return

    const out = new TextDecoder().decode(proc.stderr) + new TextDecoder().decode(proc.stdout)
    const transient = /fetch failed|connectivity|ECONNRESET|ETIMEDOUT|socket hang up|503|429/i.test(
      out,
    )
    if (!transient || attempt >= attempts) {
      console.log('FAILED')
      console.error(out)
      throw new Error(`${label} failed`)
    }
    const backoffMs = 2000 * attempt
    process.stdout.write(`transient error, retrying in ${backoffMs / 1000}s … `)
    Bun.sleepSync(backoffMs)
  }
}

if (!skipMigrations) {
  process.stdout.write('Applying pending migrations to production … ')
  // No `--yes` here: unlike `d1 execute`, `migrations apply` does not accept the
  // flag. It skips its own confirmation prompt when stdout is not a TTY, which
  // is exactly the case when Bun.spawnSync pipes it.
  wrangler(
    ['d1', 'migrations', 'apply', DATABASE, '--env', 'production', '--remote'],
    'migrations apply',
  )
  console.log('ok')
}

for (const [n, path] of files.entries()) {
  process.stdout.write(`  [${n + 1}/${files.length}] ${path} … `)
  wrangler(
    ['d1', 'execute', DATABASE, '--env', 'production', '--remote', '--file', path, '--yes'],
    `execute ${path}`,
  )
  console.log('ok')
}

// ─────────────────────────────────────────────────────────── verify

const check = Bun.spawnSync(
  [
    'npx',
    'wrangler',
    'd1',
    'execute',
    DATABASE,
    '--env',
    'production',
    '--remote',
    '--json',
    '--command',
    'SELECT ' +
      TABLES.map((t) => `(SELECT count(*) FROM ${t}) AS ${t}`).join(', ') +
      ', (SELECT sum(lifetime_cents) FROM purchase_stats) AS lifetime_cents',
  ],
  { stderr: 'pipe', stdout: 'pipe' },
)
if (check.exitCode !== 0) {
  console.error(new TextDecoder().decode(check.stderr))
  throw new Error('verification query failed')
}

const parsed = JSON.parse(new TextDecoder().decode(check.stdout))
const counts = parsed?.[0]?.results?.[0] ?? {}
console.log(`
Production now holds:
  offers            ${counts.offers}
  offer_products    ${counts.offer_products}
  purchases         ${counts.purchases}
  purchase_stats    ${counts.purchase_stats}
  lifetime total    ${money(Number(counts.lifetime_cents ?? 0))}
`)

const mismatch =
  Number(counts.offers) !== offers.length ||
  Number(counts.offer_products) !== offerProducts.length ||
  Number(counts.purchases) !== purchases.length ||
  Number(counts.purchase_stats) !== buyers

if (mismatch) {
  console.error('⚠️  Production counts do not match local. Investigate before trusting the dashboard.')
  process.exit(1)
}

console.log('Done. Production mirrors local for the commerce tables.')
