/**
 * One-off: put the existing broadcast archive on the public site.
 *
 * ⚠️ There is deliberately no bulk publish in `core/posts.ts`, in the admin, or
 * in MCP — publishing is one decision per post, and the reason is that an
 * imported archive is hundreds of `sent` rows that a single keystroke would put
 * on public URLs. This script exists because Rob asked for exactly that, once,
 * for his own archive. It is not a feature; it is the same kind of deliberate
 * offline tool as `import-kit.ts`, and it lives here rather than in `core/` so
 * that nothing reachable from the running app can do it.
 *
 * It sends nothing. It writes `published_at`, `slug`, `excerpt`, `search_text`
 * and `feature_image` and touches nothing else — not `status`, not the segment,
 * not the send cursor.
 *
 *   bun scripts/publish-archive.ts --local
 *   bun scripts/publish-archive.ts --remote --dry-run   # print the plan only
 *   bun scripts/publish-archive.ts --remote
 *
 * Idempotent: a broadcast that already has a `published_at` is left alone, so a
 * re-run picks up only what is new. Reversing it is `--unpublish`, which clears
 * the date and keeps every slug, so the same URLs come back if you publish again.
 */

import { slugify } from '../src/core/ids.ts'
import { excerptFrom, firstImageFrom, postPlainText } from '../src/core/render-web.ts'

export {}

const OUT_DIR = '.publish-archive'
const CHUNK = 20

const argv = new Set(process.argv.slice(2))
const remote = argv.has('--remote')
const dryRun = argv.has('--dry-run')
const unpublish = argv.has('--unpublish')
if (!remote && !argv.has('--local')) {
  console.error('Pass --local or --remote.')
  process.exit(1)
}

const q = (v: string) => `'${v.replace(/'/g, "''")}'`
const qOrNull = (v: string | null) => (v === null || v === '' ? 'null' : q(v))

function d1(command: string): any[] {
  const args = ['wrangler', 'd1', 'execute', 'big-mailer', '--json', '--command', command]
  if (remote) args.push('--env', 'production', '--remote')
  else args.push('--local')
  // `bunx`, never a bare `wrangler`: a stale global one fails on `_cf_ALARM`
  // against the local D1 state.
  const proc = Bun.spawnSync(['bunx', ...args], { stderr: 'pipe' })
  if (proc.exitCode !== 0) throw new Error(new TextDecoder().decode(proc.stderr))
  const text = new TextDecoder().decode(proc.stdout)
  return JSON.parse(text.slice(text.indexOf('[')))[0].results
}

// ─────────────────────────────────────────────────────────── read

console.log(`Reading ${remote ? 'production' : 'local'}…`)

const rows = d1(`
  select id, subject, slug, excerpt, feature_image, search_text,
         published_at, sent_at, body_json, body_md
  from broadcasts
  where status = 'sent'
  order by sent_at asc
`)

if (unpublish) {
  const live = rows.filter((r) => r.published_at !== null)
  console.log(`${live.length} published post(s) to take down.`)
  if (!dryRun && live.length > 0) {
    apply([`update broadcasts set published_at = null where id in (${live.map((r) => r.id).join(',')});`])
  }
  console.log(dryRun ? '--dry-run: nothing applied.' : 'Done. Slugs kept.')
  process.exit(0)
}

// Slugs must be unique across every broadcast, published or not — an
// unpublished post keeps its slug so re-publishing restores the same URL.
const taken = new Set<string>(
  d1('select slug from broadcasts where slug is not null').map((r) => r.slug as string),
)

// ─────────────────────────────────────────────────────────── plan

interface Plan {
  id: number
  subject: string
  slug: string
  excerpt: string
  featureImage: string | null
  searchText: string
  publishedAt: number
}

const plans: Plan[] = []
const skipped: { id: number; subject: string; why: string }[] = []

for (const r of rows) {
  if (r.published_at !== null) {
    skipped.push({ id: r.id, subject: r.subject, why: 'already published' })
    continue
  }

  const body = {
    json: r.body_json ? JSON.parse(r.body_json) : null,
    md: (r.body_md as string) ?? '',
  }
  const text = postPlainText(body)

  if (!text.trim()) {
    skipped.push({ id: r.id, subject: r.subject, why: 'empty body' })
    continue
  }

  // Same rule as `uniqueSlug()` in core/posts.ts, resolved against the whole set
  // in one pass instead of a query per candidate. The UNIQUE index is the real
  // guard either way.
  let slug = r.slug ?? (slugify(r.subject) || `post-${r.id}`)
  if (!r.slug) {
    let n = 1
    const base = slug
    while (taken.has(slug)) slug = `${base}-${++n}`
  }
  taken.add(slug)

  plans.push({
    id: r.id,
    subject: r.subject,
    slug,
    excerpt: r.excerpt ?? excerptFrom(text),
    featureImage: r.feature_image ?? firstImageFrom(body),
    searchText: text,
    // The day it landed in inboxes is the day it was published.
    publishedAt: (r.sent_at as number) ?? Date.now(),
  })
}

console.log(`\n${plans.length} to publish, ${skipped.length} skipped.\n`)
for (const p of plans) {
  const date = new Date(p.publishedAt).toISOString().slice(0, 10)
  const art = p.featureImage ? '🖼 ' : '   '
  console.log(`  ${String(p.id).padStart(3)}  ${date}  ${art}/${p.slug}`)
}
for (const s of skipped) {
  console.log(`  ${String(s.id).padStart(3)}  —           skipped: ${s.why} · ${s.subject.slice(0, 40)}`)
}

if (dryRun) {
  console.log('\n--dry-run: nothing applied.')
  process.exit(0)
}
if (plans.length === 0) process.exit(0)

// ─────────────────────────────────────────────────────────── apply

const statements = plans.map(
  (p) => `update broadcasts set
    published_at = ${p.publishedAt},
    slug = ${q(p.slug)},
    excerpt = ${qOrNull(p.excerpt)},
    feature_image = ${qOrNull(p.featureImage)},
    search_text = ${qOrNull(p.searchText)}
  where id = ${p.id} and status = 'sent';`,
)

apply(statements)
console.log(`\nPublished ${plans.length}.`)

function apply(statements: string[]): void {
  Bun.spawnSync(['mkdir', '-p', OUT_DIR])
  const files: string[] = []
  for (let i = 0; i < statements.length; i += CHUNK) {
    const path = `${OUT_DIR}/${String(i / CHUNK).padStart(3, '0')}.sql`
    Bun.write(path, statements.slice(i, i + CHUNK).join('\n'))
    files.push(path)
  }

  for (const [n, path] of files.entries()) {
    const args = ['wrangler', 'd1', 'execute', 'big-mailer', '--file', path, '--yes']
    if (remote) args.push('--env', 'production', '--remote')
    else args.push('--local')
    process.stdout.write(`  [${n + 1}/${files.length}] applying … `)
    const proc = Bun.spawnSync(['bunx', ...args], { stderr: 'pipe', stdout: 'pipe' })
    if (proc.exitCode !== 0) {
      console.log('FAILED')
      console.error(new TextDecoder().decode(proc.stderr))
      process.exit(1)
    }
    console.log('ok')
  }
}
