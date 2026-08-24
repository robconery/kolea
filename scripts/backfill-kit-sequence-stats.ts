/**
 * One-off: carry Kit's per-sequence engagement totals onto the imported
 * sequence rows.
 *
 * The sibling of `backfill-kit-stats.ts`, which does the same job for
 * broadcasts. Sequences imported from Kit (see `import-kit-content.ts`) have no
 * `messages` rows and never will — nothing was sent from here — so these totals
 * are all that survives, and without them every pre-cutover sequence reads as a
 * dead one on the analytics screens.
 *
 * ## ⚠️ Kit reports sequence engagement as RATES
 *
 * Its report carries an open rate and a click rate and no denominators
 * anywhere. So rates are what gets stored (`imported_open_rate`,
 * `imported_click_rate`), and `core/analytics.ts` reconstructs counts against
 * the people who actually passed through the sequence here. `Subscribers` in
 * Kit's UI is who is enrolled *right now*, which is a different question again —
 * it lands in `imported_subscribers` and is never used as a denominator.
 *
 * Both rates are over recipients, NOT click-to-open. Do not "fix" one into the
 * other; the analytics module derives click-to-open by division and says so.
 *
 * Matching is by sequence name, case-insensitively. Anything that fails to
 * match, or matches more than one sequence, is reported and skipped — never
 * guessed at.
 *
 *   bun scripts/backfill-kit-sequence-stats.ts --local
 *   bun scripts/backfill-kit-sequence-stats.ts --remote
 *   bun scripts/backfill-kit-sequence-stats.ts --remote --dry-run
 */

export {}

const argv = new Set(process.argv.slice(2))
const remote = argv.has('--remote')
const dryRun = argv.has('--dry-run')
if (!remote && !argv.has('--local')) {
  console.error('Pass --local or --remote.')
  process.exit(1)
}

// ─────────────────────────────────────────────────────────── the numbers

interface KitSeq {
  name: string
  /** Kit's "Subscribers" — who is in the sequence now. Never a denominator. */
  subscribers: number
  /** Percent, as Kit prints it. Over recipients. */
  openRate: number
  /** Percent, as Kit prints it. Over recipients — not over openers. */
  clickRate: number
  unsubscribed: number
}

const KIT: KitSeq[] = [
  { name: 'AI Deadlines Personal Followup', subscribers: 0, openRate: 82.22, clickRate: 22.22, unsubscribed: 1 },
  { name: 'AI Deadlines Post', subscribers: 0, openRate: 100, clickRate: 0, unsubscribed: 0 },
  { name: 'AI Pro Free Signup', subscribers: 100, openRate: 69.02, clickRate: 15.6, unsubscribed: 7 },
  { name: 'AI Pro Upgrade', subscribers: 341, openRate: 76.21, clickRate: 4.9, unsubscribed: 17 },
  { name: 'Cohort Interest', subscribers: 282, openRate: 74.26, clickRate: 12.13, unsubscribed: 16 },
  { name: 'Imposter Post', subscribers: 386, openRate: 76.26, clickRate: 17.53, unsubscribed: 80 },
  { name: 'Imposter Second Video Upgrade', subscribers: 21, openRate: 68.42, clickRate: 24.29, unsubscribed: 4 },
  { name: 'Little SQL Sequence', subscribers: 0, openRate: 0, clickRate: 0, unsubscribed: 0 },
  { name: 'Newsletter Welcome', subscribers: 8, openRate: 47.73, clickRate: 6.82, unsubscribed: 0 },
  { name: 'Pivot Application', subscribers: 0, openRate: 90.91, clickRate: 0, unsubscribed: 0 },
  { name: 'Post Crap Code', subscribers: 0, openRate: 80.95, clickRate: 28.57, unsubscribed: 1 },
  { name: 'SQL Orbit Post', subscribers: 61, openRate: 80.43, clickRate: 28.09, unsubscribed: 6 },
  { name: 'Wealth OS Signup', subscribers: 0, openRate: 0, clickRate: 0, unsubscribed: 0 },
]

// ─────────────────────────────────────────────────────────── wrangler

async function d1(command: string): Promise<Record<string, unknown>[]> {
  const args = ['wrangler', 'd1', 'execute', 'big-mailer', '--json', '--command', command]
  args.push(remote ? '--remote' : '--local')
  if (remote) args.push('--env', 'production')

  // `bunx wrangler`, never bare `wrangler`: a stale global install picks a
  // different local D1 state and the writes land somewhere nobody is looking.
  const proc = Bun.spawn(['bunx', ...args], { stdout: 'pipe', stderr: 'pipe' })
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

const existing = (await d1('select id, name from sequences')) as unknown as {
  id: number
  name: string
}[]

const byName = new Map<string, { id: number; name: string }[]>()
for (const row of existing) {
  const key = row.name.trim().toLowerCase()
  byName.set(key, [...(byName.get(key) ?? []), row])
}

const updates: string[] = []
const missing: string[] = []
const ambiguous: string[] = []

for (const k of KIT) {
  const hits = byName.get(k.name.trim().toLowerCase()) ?? []
  if (hits.length === 0) {
    missing.push(k.name)
    continue
  }
  if (hits.length > 1) {
    ambiguous.push(k.name)
    continue
  }
  const id = hits[0]?.id
  updates.push(
    `UPDATE sequences SET imported_subscribers = ${k.subscribers}, ` +
      `imported_open_rate = ${(k.openRate / 100).toFixed(6)}, ` +
      `imported_click_rate = ${(k.clickRate / 100).toFixed(6)}, ` +
      `imported_unsubscribed = ${k.unsubscribed}, imported_from = ${q('kit')} ` +
      `WHERE id = ${id};`,
  )
}

console.log(`${updates.length} matched · ${missing.length} missing · ${ambiguous.length} ambiguous`)
for (const m of missing) console.log(`  no sequence named: ${m}`)
for (const a of ambiguous) console.log(`  more than one sequence named: ${a}`)

if (dryRun) {
  console.log('\n--dry-run, nothing written.')
  for (const u of updates) console.log(`  ${u}`)
  process.exit(0)
}

if (updates.length) await d1(updates.join('\n'))
console.log(`\nWrote ${updates.length} sequence${updates.length === 1 ? '' : 's'}.`)
