/**
 * One-off: load a Kit (ConvertKit) CSV export into D1.
 *
 * Not the `importCsv()` path — that one runs inside a Worker, and 13k rows at
 * ~5 queries each blows straight past D1's 1,000-queries-per-invocation cap.
 * This generates flat SQL offline and feeds it to `wrangler d1 execute --file`
 * in chunks instead.
 *
 * Subscriber and tag ids are assigned explicitly here (continuing from the
 * table's current max) so that subscriber_tags can reference them without a
 * lookup per row. That is only safe because we skip any email already present.
 *
 *   bun scripts/import-kit.ts --local            # generate + apply to local D1
 *   bun scripts/import-kit.ts --remote           # generate + apply to production
 *   bun scripts/import-kit.ts --remote --dry-run # generate only, print summary
 */

export {}

const CSV_PATH = 'data/kit-export.csv'
const OUT_DIR = '.import-kit'
const CHUNK_ROWS = 400
const SOURCE = 'kit-import'

const argv = new Set(process.argv.slice(2))
const remote = argv.has('--remote')
const dryRun = argv.has('--dry-run')
if (!remote && !argv.has('--local')) {
  console.error('Pass --local or --remote.')
  process.exit(1)
}

// ─────────────────────────────────────────────────────────── csv

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

/**
 * Kit packs tags into one comma-separated cell — and two of Rob's tag names
 * contain a comma themselves ("Imported May 5th, 2026 at 12:07 PM"), so a
 * plain split shreds them. Anything that looks like the tail of a date gets
 * glued back onto the fragment before it.
 */
const DATE_TAIL = /^\d{4} at \d{1,2}:\d{2} [AP]M$/

function splitTags(cell: string): string[] {
  const out: string[] = []
  for (const raw of cell.split(',')) {
    const part = raw.trim()
    if (!part) continue
    if (DATE_TAIL.test(part) && out.length) out[out.length - 1] += `, ${part}`
    else out.push(part)
  }
  // "Imported <date>" is Kit's own bookkeeping, not a segment. Dropped.
  return out.filter((t) => !/^Imported /i.test(t))
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}

const ALPHABET = 'abcdefghijkmnopqrstuvwxyz0123456789'
function randomToken(length = 32): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]!
  return out
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Columns carried through to `subscribers.attributes` rather than dropped. */
const ATTR_COLS = [
  'city',
  'state',
  'country',
  'referrer',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'indy_count',
  'indy_total',
  'last_purchase_date',
  'sub_renewal_date',
]

const q = (v: string) => `'${v.replace(/'/g, "''")}'`
const nullable = (v: string | null) => (v === null ? 'NULL' : q(v))

// ─────────────────────────────────────────────────────────── read

const rows = parseCsv(await Bun.file(CSV_PATH).text())
const header = rows[0]!.map((h) => h.trim().toLowerCase())
const col = (name: string) => header.indexOf(name)
const iEmail = col('email')
const iName = col('first_name')
const iCreated = col('created_at')
const iStatus = col('status')
const iTags = col('tags')
if (iEmail === -1) throw new Error('no email column')

interface Person {
  email: string
  name: string | null
  createdAt: number
  status: string
  attributes: Record<string, string>
  tags: string[]
}

const people: Person[] = []
const seen = new Set<string>()
const skipped = { invalid: 0, dupeInFile: 0, nonActive: 0, alreadyInDb: 0 }

for (const row of rows.slice(1)) {
  if (row.length < header.length) continue
  const email = (row[iEmail] ?? '').trim().toLowerCase()
  if (!EMAIL_RE.test(email)) {
    skipped.invalid++
    continue
  }
  if (seen.has(email)) {
    skipped.dupeInFile++
    continue
  }
  seen.add(email)

  const status = (row[iStatus] ?? 'active').trim().toLowerCase()
  if (status !== 'active') {
    skipped.nonActive++
    continue
  }

  // Kit stamps "2024-02-27 22:32:19 UTC"; Date wants the T and the Z.
  const rawDate = (row[iCreated] ?? '').trim()
  const parsed = Date.parse(rawDate.replace(' ', 'T').replace(' UTC', 'Z'))
  const createdAt = Number.isFinite(parsed) ? parsed : Date.now()

  const attributes: Record<string, string> = {}
  for (const name of ATTR_COLS) {
    const idx = col(name)
    const value = idx >= 0 ? (row[idx] ?? '').trim() : ''
    if (value) attributes[name] = value
  }

  const name = (row[iName] ?? '').trim()
  people.push({
    email,
    name: name || null,
    createdAt,
    status: 'active',
    attributes,
    tags: iTags >= 0 ? splitTags(row[iTags] ?? '') : [],
  })
}

// ─────────────────────────────────────────────────────────── current db state

function d1(command: string): any[] {
  const args = ['wrangler', 'd1', 'execute', 'big-mailer', '--json', '--command', command]
  if (remote) args.push('--env', 'production', '--remote')
  else args.push('--local')
  const proc = Bun.spawnSync(['npx', ...args], { stderr: 'pipe' })
  if (proc.exitCode !== 0) throw new Error(new TextDecoder().decode(proc.stderr))
  const text = new TextDecoder().decode(proc.stdout)
  const json = JSON.parse(text.slice(text.indexOf('[')))
  return json[0].results
}

console.log(`Reading current ${remote ? 'production' : 'local'} state…`)
const existingEmails = new Set<string>(d1('select email from subscribers').map((r) => r.email))
const existingTags = new Map<string, number>(
  d1('select id, slug from tags').map((r) => [r.slug as string, r.id as number]),
)
const maxIds = d1(
  'select coalesce(max(id),0) as s from subscribers',
)[0].s as number
const maxTagId = d1('select coalesce(max(id),0) as t from tags')[0].t as number

const toImport = people.filter((p) => {
  if (existingEmails.has(p.email)) {
    skipped.alreadyInDb++
    return false
  }
  return true
})

// ─────────────────────────────────────────────────────────── assign ids

const tagIds = new Map(existingTags)
const newTags: { id: number; slug: string; name: string }[] = []
let nextTagId = maxTagId

for (const p of toImport) {
  for (const name of p.tags) {
    const slug = slugify(name)
    if (tagIds.has(slug)) continue
    nextTagId++
    tagIds.set(slug, nextTagId)
    newTags.push({ id: nextTagId, slug, name })
  }
}

let nextId = maxIds
const withIds = toImport.map((p) => ({ ...p, id: ++nextId }))

// ─────────────────────────────────────────────────────────── emit

const now = Date.now()
const statements: string[] = []

for (const t of newTags) {
  statements.push(
    `INSERT INTO tags (id, slug, name, created_at) VALUES (${t.id}, ${q(t.slug)}, ${q(t.name)}, ${now});`,
  )
}

for (let i = 0; i < withIds.length; i += CHUNK_ROWS) {
  const batch = withIds.slice(i, i + CHUNK_ROWS)
  const values = batch
    .map(
      (p) =>
        `(${p.id}, ${q(p.email)}, ${nullable(p.name)}, 'active', ${q(JSON.stringify(p.attributes))}, ${q(SOURCE)}, ${q(randomToken())}, ${p.createdAt})`,
    )
    .join(',\n  ')
  statements.push(
    `INSERT INTO subscribers (id, email, name, status, attributes, source, unsub_token, created_at) VALUES\n  ${values};`,
  )
}

const links: string[] = []
for (const p of withIds) {
  for (const name of p.tags) {
    const tagId = tagIds.get(slugify(name))!
    links.push(`(${p.id}, ${tagId}, ${p.createdAt})`)
  }
}
for (let i = 0; i < links.length; i += CHUNK_ROWS * 4) {
  const batch = links.slice(i, i + CHUNK_ROWS * 4).join(',\n  ')
  statements.push(
    `INSERT INTO subscriber_tags (subscriber_id, tag_id, tagged_at) VALUES\n  ${batch};`,
  )
}

// One file per ~30 statements keeps each wrangler call well inside its limits.
await Bun.$`rm -rf ${OUT_DIR}`.quiet()
await Bun.$`mkdir -p ${OUT_DIR}`.quiet()
const files: string[] = []
const PER_FILE = 30
for (let i = 0; i < statements.length; i += PER_FILE) {
  const path = `${OUT_DIR}/${String(files.length).padStart(4, '0')}.sql`
  await Bun.write(path, statements.slice(i, i + PER_FILE).join('\n') + '\n')
  files.push(path)
}

console.log(`
  CSV rows          ${rows.length - 1}
  importing         ${withIds.length}
  new tags          ${newTags.length}  (${newTags.map((t) => t.name).join(', ')})
  tag links         ${links.length}
  skipped: invalid ${skipped.invalid}, dupe-in-file ${skipped.dupeInFile}, non-active ${skipped.nonActive}, already in db ${skipped.alreadyInDb}
  SQL               ${statements.length} statements across ${files.length} files in ${OUT_DIR}/
`)

if (dryRun) {
  console.log('--dry-run: nothing applied.')
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
