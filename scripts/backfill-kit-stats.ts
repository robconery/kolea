/**
 * One-off: carry Kit's per-broadcast engagement totals onto the imported
 * broadcast rows.
 *
 * Broadcasts imported from Kit have no `messages` rows and never will — nothing
 * was sent from here, so there is no per-recipient history to reconstruct. These
 * totals are all that survives, and without them the dashboard's Signal score has
 * exactly one data point.
 *
 * The numbers below are transcribed from the Kit broadcast report. They are
 * `imported_*` columns, kept apart from anything live, so no query can ever
 * accidentally blend a Kit total with a Resend event count.
 *
 * Matching is by subject line, normalized for the punctuation Kit's UI prettifies
 * (curly quotes, ellipsis characters). Anything that fails to match, or matches
 * more than one broadcast, is reported and skipped — never guessed at.
 *
 *   bun scripts/backfill-kit-stats.ts --local
 *   bun scripts/backfill-kit-stats.ts --remote
 *   bun scripts/backfill-kit-stats.ts --remote --dry-run   # print the plan only
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

interface KitRow {
  subject: string
  /** Kit's "Recipients" — already net of bounces, which is why we carry no bounce count. */
  recipients: number
  opened: number
  clicked: number
  unsubscribed: number
}

const KIT: KitRow[] = [
  { subject: 'Opus 5 is changing the possibilities here', recipients: 13808, opened: 7208, clicked: 207, unsubscribed: 48 },
  { subject: 'Transform Books into Power Tools', recipients: 13871, opened: 7272, clicked: 272, unsubscribed: 61 },
  { subject: 'Throwing Claude at a 22 year old project', recipients: 13945, opened: 7511, clicked: 490, unsubscribed: 45 },
  { subject: 'Big Codebases, New Challenges', recipients: 13871, opened: 7091, clicked: 274, unsubscribed: 42 },
  { subject: 'Throw Fable at your notes while you can', recipients: 13917, opened: 7322, clicked: 239, unsubscribed: 45 },
  { subject: 'Is it possible to squeeze good code from a cheap model?', recipients: 14013, opened: 7249, clicked: 116, unsubscribed: 72 },
  { subject: 'Claude Code Session Weirdness', recipients: 14067, opened: 7360, clicked: 328, unsubscribed: 56 },
  { subject: 'Jon Skeet is joining me tomorrow, hope you are too!', recipients: 14144, opened: 7024, clicked: 379, unsubscribed: 85 },
  { subject: 'Your Skill Repo Awaits', recipients: 14196, opened: 7668, clicked: 917, unsubscribed: 56 },
  { subject: "Discover AI's Impact on Coding Interviews", recipients: 14236, opened: 7291, clicked: 430, unsubscribed: 37 },
  { subject: 'Claude has some weird opinions', recipients: 14070, opened: 7794, clicked: 209, unsubscribed: 52 },
  { subject: "It's kinda quiet around here... a bit too quiet", recipients: 13899, opened: 7562, clicked: 221, unsubscribed: 69 },
  { subject: 'I think I found a solution to crap code', recipients: 13943, opened: 7683, clicked: 695, unsubscribed: 67 },
  { subject: 'Discovering the Sweet Spot in AI Orchestration', recipients: 14438, opened: 7726, clicked: 572, unsubscribed: 52 },
]

// ─────────────────────────────────────────────────────────── wrangler

async function d1(command: string): Promise<unknown[]> {
  const args = ['wrangler', 'd1', 'execute', 'big-mailer', '--json', '--command', command]
  args.push(remote ? '--remote' : '--local')
  if (remote) args.push('--env', 'production')

  const proc = Bun.spawn(['wrangler', ...args.slice(1)], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  if ((await proc.exited) !== 0) {
    console.error(err)
    throw new Error('wrangler d1 execute failed')
  }
  // Wrangler prints a banner before the JSON payload.
  const start = out.indexOf('[')
  const parsed = JSON.parse(out.slice(start === -1 ? 0 : start)) as { results: unknown[] }[]
  return parsed[0]?.results ?? []
}

/** Kit's UI prettifies punctuation; the imported subject kept the original. */
const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()


// ─────────────────────────────────────────────────────────── run

const existing = (await d1(
  "select id, subject from broadcasts where status = 'sent' order by sent_at desc",
)) as { id: number; subject: string }[]

const bySubject = new Map<string, { id: number; subject: string }[]>()
for (const row of existing) {
  const key = normalize(row.subject)
  bySubject.set(key, [...(bySubject.get(key) ?? []), row])
}

const updates: string[] = []
const skipped: string[] = []

for (const row of KIT) {
  const hits = bySubject.get(normalize(row.subject)) ?? []
  if (hits.length !== 1) {
    skipped.push(`${hits.length === 0 ? 'no match' : `${hits.length} matches`}: ${row.subject}`)
    continue
  }
  const id = hits[0]!.id
  updates.push(
    `update broadcasts set imported_recipients = ${row.recipients}, ` +
      `imported_opened = ${row.opened}, imported_clicked = ${row.clicked}, ` +
      `imported_unsubscribed = ${row.unsubscribed}, imported_from = 'kit' ` +
      `where id = ${id};`,
  )
  console.log(
    `  #${String(id).padStart(3)}  ${row.recipients.toLocaleString()} sent, ` +
      `${((row.opened / row.recipients) * 100).toFixed(1)}% open, ` +
      `${((row.clicked / row.opened) * 100).toFixed(2)}% CTOR  —  ${row.subject}`,
  )
}

// Which sent broadcasts still have no numbers at all, live or imported? Silence
// here would read as "everything's covered" when most of the archive isn't.
const stillBare = (await d1(`
  select b.id, b.subject
  from broadcasts b
  where b.status = 'sent'
    and b.imported_recipients is null
    and not exists (select 1 from messages m where m.broadcast_id = b.id)
  order by b.sent_at desc
`)) as { id: number; subject: string }[]

const covered = new Set(updates.map((u) => Number(/where id = (\d+)/.exec(u)?.[1])))
const remaining = stillBare.filter((b) => !covered.has(b.id))

console.log(`\n${updates.length} broadcast(s) to update.`)
if (skipped.length > 0) {
  console.log(`\n⚠️  ${skipped.length} row(s) skipped — matched nothing, or more than one:`)
  for (const s of skipped) console.log(`   ${s}`)
}
if (remaining.length > 0) {
  console.log(`\n📭 ${remaining.length} sent broadcast(s) will still have no engagement data:`)
  for (const b of remaining) console.log(`   #${b.id} ${b.subject}`)
}

if (dryRun) {
  console.log('\n--dry-run: nothing written.')
  process.exit(0)
}
if (updates.length === 0) process.exit(0)

// Small enough to go in one statement batch; these are 14 single-row updates by
// primary key, nowhere near D1's limits.
await d1(updates.join('\n'))
console.log(`\n✅ Wrote ${updates.length} row(s) to ${remote ? 'production' : 'local'} D1.`)
