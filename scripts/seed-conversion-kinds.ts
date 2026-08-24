/**
 * Seed the three conversion kinds Rob described, idempotently.
 *
 * Kinds are data, not an enum — so they have to start somewhere, and a fresh
 * `conversion_kinds` table means `classifyKind` matches nothing and no sale ever
 * becomes a conversion. This puts the floor in.
 *
 * ⚠️ **Priority order is the whole design.** Kinds are walked lowest-first and
 * the FIRST match wins, which is what keeps one sale from being counted as two
 * things and doubling revenue. So the catch-all sits at 100, behind everything.
 *
 * Everything here is editable afterwards at `/goals` — including `cohort`, whose
 * offer list is a starting guess (The Pivot is a 4-week intensive, which is a
 * cohort by any reading; add the others as you run them).
 *
 *   bun scripts/seed-conversion-kinds.ts --local
 *   bun scripts/seed-conversion-kinds.ts --remote
 */

export {}

const argv = new Set(process.argv.slice(2))
const remote = argv.has('--remote')
if (!remote && !argv.has('--local')) {
  console.error('Pass --local or --remote.')
  process.exit(1)
}

interface Kind {
  slug: string
  label: string
  ruleType: 'price_interval' | 'offer_in' | 'any_sale' | 'manual'
  ruleValue: string | null
  priority: number
  why: string
}

const KINDS: Kind[] = [
  {
    slug: 'subscription_yearly',
    label: 'Yearly subscription',
    ruleType: 'price_interval',
    ruleValue: 'year',
    priority: 10,
    why: 'most specific — a yearly sub is also a sale, so it must claim the sale first',
  },
  {
    slug: 'cohort',
    label: 'Joined a cohort',
    ruleType: 'offer_in',
    ruleValue: 'ai-pivot',
    priority: 20,
    why: 'a cohort is just a specific offer; edit the list at /goals',
  },
  {
    slug: 'purchase',
    label: 'Bought something',
    ruleType: 'any_sale',
    ruleValue: null,
    priority: 100,
    why: 'the catch-all — must go last or it swallows everything above it',
  },
]

async function d1(command: string): Promise<unknown[]> {
  const args = ['d1', 'execute', 'big-mailer', '--json', '--command', command]
  args.push(remote ? '--remote' : '--local')
  if (remote) args.push('--env', 'production')

  // `bunx wrangler`, not bare `wrangler` — a stale global install fails against
  // the local D1 state on `_cf_ALARM`.
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

const q = (v: string | null) => (v === null ? 'null' : `'${v.replace(/'/g, "''")}'`)
const now = Date.now()

// `insert or ignore` on the unique slug: re-running never clobbers an edit Rob
// made in the admin, which is the whole point of the kinds being editable.
const values = KINDS.map(
  (k) =>
    `(${q(k.slug)}, ${q(k.label)}, ${q(k.ruleType)}, ${q(k.ruleValue)}, ${k.priority}, 1, ${now})`,
).join(', ')

await d1(
  'insert or ignore into conversion_kinds ' +
    '(slug, label, rule_type, rule_value, priority, is_active, created_at) values ' +
    values,
)

const rows = (await d1(
  'select slug, label, rule_type, rule_value, priority, is_active from conversion_kinds order by priority, id',
)) as {
  slug: string
  label: string
  rule_type: string
  rule_value: string | null
  priority: number
  is_active: number
}[]

console.log('\nconversion kinds, in match order:\n')
for (const r of rows) {
  const rule = r.rule_value ? `${r.rule_type} = ${r.rule_value}` : r.rule_type
  console.log(
    `  ${String(r.priority).padStart(4)}  ${r.slug.padEnd(22)} ${rule.padEnd(28)}` +
      `${r.is_active ? '' : ' (disabled)'}`,
  )
}
console.log('\nFirst match wins. Edit any of it at /goals.')
