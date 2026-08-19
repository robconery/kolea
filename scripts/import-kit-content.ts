export {}

/**
 * One-off: pull broadcasts and sequences out of Kit's v4 API into D1.
 *
 * NOTHING IMPORTED HERE CAN SEND. Broadcasts land as `status: 'sent'` with
 * `sent_at` already set, and the minutely tick (worker.tsx) only ever claims
 * `sending` or `scheduled`-and-due. Sequences land as `is_active: 0` with
 * `trigger: 'manual'`, and every enrollment path in core/sequences.ts gates on
 * `isActive`. No enrollments are written, so there is nothing for a tick to
 * advance. Like the subscriber import, this writes flat SQL rather than calling
 * into core/, so `enrollOnSubscribe` never runs at all.
 *
 *   bun scripts/import-kit-content.ts --local --dry-run
 *   bun scripts/import-kit-content.ts --local
 *   bun scripts/import-kit-content.ts --remote
 */

import TurndownService from 'turndown'

const OUT_DIR = '.import-kit-content'
const API = 'https://api.kit.com/v4'

const argv = new Set(process.argv.slice(2))
const remote = argv.has('--remote')
const dryRun = argv.has('--dry-run')
if (!remote && !argv.has('--local')) {
  console.error('Pass --local or --remote.')
  process.exit(1)
}

// The key lives in .dev.vars (gitignored), same as every other secret here.
const key =
  process.env.KIT_API_KEY ??
  (await Bun.file('.dev.vars')
    .text()
    .then((t) =>
      t
        .match(/^KIT_API_KEY=(.*)$/m)?.[1]
        ?.trim()
        .replace(/^["']|["']$/g, ''),
    )
    .catch(() => undefined))
if (!key) {
  console.error('No KIT_API_KEY in env or .dev.vars.')
  process.exit(1)
}

// ─────────────────────────────────────────────────────────── kit api

async function kit(path: string): Promise<any> {
  const res = await fetch(`${API}${path}`, { headers: { 'X-Kit-Api-Key': key! } })
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`)
  return res.json()
}

/** Kit paginates with an opaque cursor; every list endpoint uses the same shape. */
async function kitAll(path: string, collection: string): Promise<any[]> {
  const out: any[] = []
  let cursor: string | undefined
  for (;;) {
    const sep = path.includes('?') ? '&' : '?'
    const page = await kit(`${path}${sep}per_page=500${cursor ? `&after=${cursor}` : ''}`)
    out.push(...(page[collection] ?? []))
    if (!page.pagination?.has_next_page) return out
    cursor = page.pagination.end_cursor
  }
}

// ─────────────────────────────────────────────────────────── html → markdown

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})
// Kit wraps every email in layout tables plus <style> blocks for its own client
// hacks. None of that is content, and turndown would otherwise emit the CSS as
// literal text.
turndown.remove(['style', 'script'])

/** Zero-width and non-breaking padding Kit sprinkles between blocks. */
const INVISIBLES = /[​-‍﻿ ]/g

function htmlToMd(html: string): string {
  return turndown
    .turndown(html ?? '')
    .replace(INVISIBLES, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}

const q = (v: string) => `'${v.replace(/'/g, "''")}'`
const nullable = (v: string | null) => (v === null ? 'NULL' : q(v))
const ms = (iso: string | null | undefined, fallback: number) => {
  const t = Date.parse(iso ?? '')
  return Number.isFinite(t) ? t : fallback
}

// ─────────────────────────────────────────────────────────── d1

function d1(command: string): any[] {
  const args = ['wrangler', 'd1', 'execute', 'big-mailer', '--json', '--command', command]
  if (remote) args.push('--env', 'production', '--remote')
  else args.push('--local')
  const proc = Bun.spawnSync(['npx', ...args], { stderr: 'pipe' })
  if (proc.exitCode !== 0) throw new Error(new TextDecoder().decode(proc.stderr))
  const text = new TextDecoder().decode(proc.stdout)
  return JSON.parse(text.slice(text.indexOf('[')))[0].results
}

// ─────────────────────────────────────────────────────────── fetch

console.log('Fetching from Kit…')
const kitBroadcasts = await kitAll('/broadcasts', 'broadcasts')
const kitSequences = await kitAll('/sequences', 'sequences')

const kitSteps = new Map<number, any[]>()
for (const s of kitSequences) {
  const emails = await kitAll(`/sequences/${s.id}/emails?include_content=true`, 'emails')
  kitSteps.set(s.id, emails.sort((a, b) => a.position - b.position))
}
console.log(
  `  ${kitBroadcasts.length} broadcasts, ${kitSequences.length} sequences, ` +
    `${[...kitSteps.values()].flat().length} sequence emails`,
)

// ─────────────────────────────────────────────────────────── current state

console.log(`Reading current ${remote ? 'production' : 'local'} state…`)
// No column holds Kit's id, so a re-run identifies a broadcast the only way it
// can: same subject, same send time.
const haveBroadcast = new Set(
  d1('select subject, coalesce(sent_at,0) as sent_at from broadcasts').map(
    (r) => `${r.subject} ${r.sent_at}`,
  ),
)
const haveSequence = new Set(d1('select slug from sequences').map((r) => r.slug as string))
let nextBroadcastId = d1('select coalesce(max(id),0) as m from broadcasts')[0].m as number
let nextSequenceId = d1('select coalesce(max(id),0) as m from sequences')[0].m as number
let nextStepId = d1('select coalesce(max(id),0) as m from sequence_steps')[0].m as number

// ─────────────────────────────────────────────────────────── map

const statements: string[] = []
const notes: string[] = []
const skipped = { broadcasts: 0, sequences: 0, emptyBody: 0 }

// Kit statuses → ours. `completed` is the only one that ever sent; everything
// else is content that was never on the wire, so it imports as a draft. Neither
// is reachable by the scheduler.
const STATUS: Record<string, 'sent' | 'draft'> = {
  completed: 'sent',
  draft: 'draft',
}

for (const b of kitBroadcasts) {
  const createdAt = ms(b.created_at, Date.now())
  const status = STATUS[b.status] ?? 'draft'
  const sentAt = status === 'sent' ? ms(b.send_at ?? b.published_at, createdAt) : null

  if (haveBroadcast.has(`${b.subject} ${sentAt ?? 0}`)) {
    skipped.broadcasts++
    continue
  }

  const md = htmlToMd(b.content ?? '')
  if (!md) {
    skipped.emptyBody++
    notes.push(`empty body after conversion: broadcast ${b.id} "${b.subject}"`)
  }

  const id = ++nextBroadcastId
  statements.push(
    `INSERT INTO broadcasts (id, subject, body_json, body_md, segment, status, scheduled_at, started_at, sent_at, cursor_subscriber_id, created_at) VALUES (` +
      `${id}, ${q(b.subject ?? '(no subject)')}, NULL, ${q(md)}, '{}', ${q(status)}, NULL, NULL, ` +
      `${sentAt === null ? 'NULL' : sentAt}, 0, ${createdAt});`,
  )
}

const usedSlugs = new Set(haveSequence)

for (const s of kitSequences) {
  const slug = slugify(s.name ?? `sequence-${s.id}`)
  if (usedSlugs.has(slug)) {
    skipped.sequences++
    continue
  }
  usedSlugs.add(slug)

  const createdAt = ms(s.created_at, Date.now())
  const seqId = ++nextSequenceId

  // trigger is ALWAYS 'manual' and is_active ALWAYS 0. Kit keeps the real
  // trigger in its visual-automation system, which this API does not expose —
  // and guessing one would risk enrolling (and mailing) live subscribers.
  statements.push(
    `INSERT INTO sequences (id, slug, name, description, trigger, trigger_tag_id, campaign_id, is_active, created_at) VALUES (` +
      `${seqId}, ${q(slug)}, ${q(s.name ?? slug)}, ${nullable(`Imported from Kit (sequence ${s.id}).`)}, ` +
      `'manual', NULL, NULL, 0, ${createdAt});`,
  )

  const emails = kitSteps.get(s.id) ?? []
  emails.forEach((e, i) => {
    const position = i + 1 // Kit counts from 0; sequence_steps counts from 1.

    // Our schema only has whole days. Kit can express hours, so anything
    // sub-day rounds up to 1 rather than silently collapsing to "immediately".
    let delayDays: number
    const value = Number(e.delay_value ?? 0)
    if (e.delay_unit === 'hours') {
      delayDays = value === 0 ? 0 : Math.max(1, Math.ceil(value / 24))
      if (value % 24 !== 0) {
        notes.push(`rounded delay: "${s.name}" step ${position} — ${value}h → ${delayDays}d`)
      }
    } else if (e.delay_unit === 'weeks') delayDays = value * 7
    else delayDays = value

    const md = htmlToMd(e.content ?? '')
    if (!md) {
      skipped.emptyBody++
      notes.push(`empty body after conversion: "${s.name}" step ${position}`)
    }
    if (e.published === false) {
      notes.push(`unpublished in Kit (imported anyway): "${s.name}" step ${position}`)
    }

    statements.push(
      `INSERT INTO sequence_steps (id, sequence_id, position, delay_days, subject, body_json, body_md) VALUES (` +
        `${++nextStepId}, ${seqId}, ${position}, ${delayDays}, ${q(e.subject ?? '(no subject)')}, NULL, ${q(md)});`,
    )
  })
}

// ─────────────────────────────────────────────────────────── emit

await Bun.$`rm -rf ${OUT_DIR}`.quiet()
await Bun.$`mkdir -p ${OUT_DIR}`.quiet()
const files: string[] = []
const PER_FILE = 20
for (let i = 0; i < statements.length; i += PER_FILE) {
  const path = `${OUT_DIR}/${String(files.length).padStart(4, '0')}.sql`
  await Bun.write(path, statements.slice(i, i + PER_FILE).join('\n') + '\n')
  files.push(path)
}

console.log(`
  broadcasts     ${kitBroadcasts.length} from Kit, ${skipped.broadcasts} already present
  sequences      ${kitSequences.length} from Kit, ${skipped.sequences} already present
  SQL            ${statements.length} statements across ${files.length} files in ${OUT_DIR}/
  all broadcasts import as sent/draft · all sequences as manual + inactive`)

if (notes.length) {
  console.log(`\n  notes (${notes.length}):`)
  for (const n of notes) console.log(`    - ${n}`)
}

if (dryRun) {
  console.log('\n--dry-run: nothing applied.')
  process.exit(0)
}

// ─────────────────────────────────────────────────────────── apply

for (const [n, path] of files.entries()) {
  const args = ['wrangler', 'd1', 'execute', 'big-mailer', '--file', path, '--yes']
  if (remote) args.push('--env', 'production', '--remote')
  else args.push('--local')
  process.stdout.write(`  [${n + 1}/${files.length}] ${path} … `)
  const proc = Bun.spawnSync(['npx', ...args], { stderr: 'pipe', stdout: 'pipe' })
  if (proc.exitCode !== 0) {
    console.log('FAILED')
    console.error(new TextDecoder().decode(proc.stderr))
    process.exit(1)
  }
  console.log('ok')
}

console.log('\nDone.')
