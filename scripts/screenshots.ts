/**
 * Re-shoot the screenshots in `docs/img/` from a local dev instance.
 *
 *   bun run screenshots                      # all of them
 *   bun run screenshots dashboard composer   # only the ones named
 *
 * It starts its own `wrangler dev` on port 8790 with its own database under
 * `.wrangler/screenshots-state`, so it never touches the data behind your
 * ordinary `bun run dev`. The database is rebuilt from nothing on every run:
 * the app's own demo seed, `seed-analytics-demo.ts`, and then the fictional
 * operator below (Mara Quinn, "Field Notes"). Every number in a picture is
 * made up.
 *
 * ## ⚠️ Local only, by construction
 *
 * There is no flag that points this at another host. It talks to
 * `localhost:8790`, which it started itself, with `EMAIL_PROVIDER=console`.
 * Nothing here can send mail or reach a deployed install.
 *
 * Needs the Chromium that Playwright downloads: `bunx playwright install chromium`.
 * The pages load their fonts from Google Fonts, so it needs the network too.
 */

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { type Browser, type Page, chromium } from 'playwright-core'

const PORT = 8790
const BASE = `http://localhost:${PORT}`
const SITE = `http://site.localhost:${PORT}`
const STATE = '.wrangler/screenshots-state'
const OUT = 'docs/img'

/** One viewport for every shot, so they line up in a grid. */
const VIEWPORT = { width: 1440, height: 900 }
/** A 2x shot over this is taken again at 1x: a README should load fast. */
const MAX_BYTES = 400_000

const OPERATOR = { name: 'Mara Quinn', email: 'mara@fieldnotes.example', site: 'Field Notes' }
const TAGLINE = 'Short essays on running a small software business.'

const DAY = 86_400_000
const NOW = Date.now()
const q = (s: string) => `'${s.replace(/'/g, "''")}'`
const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

// ─────────────────────────────────────────────────────────── the fiction

const FIRST = ['Nadia', 'Tomas', 'Priya', 'Owen', 'Lucia', 'Kofi', 'Hana', 'Marek', 'Ines', 'Jonah', 'Amara', 'Felix', 'Sunita', 'Pavel', 'Greta', 'Diego', 'Yuki', 'Rania', 'Elias', 'Noor']
const LAST = ['Okafor', 'Lindqvist', 'Marsh', 'Tanaka', 'Baptiste', 'Novak', 'Rahman', 'Castillo', 'Whitlock', 'Ferreira', 'Kowalski', 'Adeyemi', 'Sorensen', 'Haddad', 'Brandt', 'Ito', 'Mbeki', 'Vance', 'Petrov']
const DOMAINS = ['example.com', 'example.org', 'example.net']

/** Sent broadcasts that are also posts on the public site. Subjects come from `seed-analytics-demo.ts`. */
const POSTS: [subject: string, excerpt: string][] = [
  ['Two seats left, and then I close it', 'The workshop starts on Monday. Here is who it is for, who it is not for, and why I cap it at twelve.'],
  ['The one email I should have sent first', 'I wrote four launch emails before I wrote the one that said what the thing was. Do not do that.'],
  ['Your database is not the bottleneck', 'Most slow apps are slow in the same three places, and none of them is the query you are staring at.'],
  ['Six weeks with an agent in the loop', 'What I let it do, what I took back, and the one job I would not hand over again.'],
  ['A quieter way to ship on Fridays', 'Small changes, a short checklist, and a rule about who gets paged. It is not brave. It is boring on purpose.'],
  ['I was wrong about test coverage', 'I used to chase the number. Now I chase the three paths that take money, and leave the rest alone.'],
]

/** The draft the composer shot opens on. TipTap JSON, the shape `broadcasts.body_json` holds. */
const DRAFT_SUBJECT = 'The week I stopped watching open rates'
const text = (t: string, mark?: string) => ({ type: 'text', text: t, ...(mark ? { marks: [{ type: mark }] } : {}) })
const para = (...content: unknown[]) => ({ type: 'paragraph', content })
const DRAFT_DOC = {
  type: 'doc',
  content: [
    para(text('Hi '), { type: 'mergeTag', attrs: { field: 'first_name' } }, text(',')),
    para(
      text('For two years I opened my stats page before I opened my editor. Last month I stopped, and the newsletter got '),
      text('better', 'italic'),
      text('. This is what changed.'),
    ),
    { type: 'heading', attrs: { level: 2 }, content: [text('What an open actually tells you')] },
    para(
      text('Not much. A phone fetches the picture before anybody reads a word, so half of what I was counting was a mail app being polite. '),
      text('Replies and clicks are people.', 'bold'),
      text(' Opens are weather.'),
    ),
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [para(text('I write the piece first and pick the subject line last.'))] },
        { type: 'listItem', content: [para(text('I look at who clicked, once, two days after it goes out.'))] },
        { type: 'listItem', content: [para(text('I ask one question at the end, and I answer every reply.'))] },
      ],
    },
    { type: 'blockquote', content: [para(text('If nobody would miss it, do not send it.'))] },
    para(text('The spring workshop opens next week. If you want the short version of all this in a room with eleven other people, that is where it is.')),
    { type: 'emailButton', attrs: { href: 'https://example.com/workshop', background: '#1f6f5c', align: 'left' }, content: [text('See the workshop')] },
    para(text('Mara')),
  ],
}

// ─────────────────────────────────────────────────────────── plumbing

async function sh(cmd: string[], quiet = true): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: quiet ? 'ignore' : 'inherit', stderr: 'inherit' })
  const code = await proc.exited
  if (code !== 0) throw new Error(`${cmd.join(' ')} exited ${code}`)
}

/** Run SQL against the screenshot database. Returns rows for a single statement. */
async function d1(sqlText: string): Promise<Record<string, unknown>[]> {
  const file = `${STATE}/screenshots.sql`
  await Bun.write(file, sqlText)
  const proc = Bun.spawn(
    ['bunx', 'wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', STATE, '--json', '--file', file],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  if ((await proc.exited) !== 0) throw new Error(`wrangler d1 execute failed:\n${err || out}`)
  try {
    const start = out.indexOf('[')
    const parsed = JSON.parse(out.slice(start === -1 ? 0 : start)) as { results?: Record<string, unknown>[] }[]
    return parsed.at(-1)?.results ?? []
  } catch {
    // A file of many statements prints a summary, not rows. Nobody reads it.
    return []
  }
}

async function post(path: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', redirect: 'manual' })
  if (res.status >= 400) throw new Error(`${path} answered ${res.status}: ${await res.text()}`)
}

async function serverUp(): Promise<boolean> {
  try {
    return (await fetch(`${BASE}/`, { redirect: 'manual' })).status < 500
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────────────────── the data

/** Everything that turns the stock demo data into Mara Quinn's list. */
function fictionSql(): string {
  const sql: string[] = []

  // The operator and the site's masthead.
  sql.push(
    `INSERT OR REPLACE INTO site_settings (id, title, tagline, author_name, short_bio, social_links, profile, updated_at) VALUES ` +
      `(1, ${q(OPERATOR.site)}, ${q(TAGLINE)}, ${q(OPERATOR.name)}, ` +
      `${q('Mara Quinn writes about building and selling small software. She runs a workshop twice a year.')}, '[]', ` +
      `${q(JSON.stringify({ lede: '', what_i_do: [], links: [], social: {} }))}, ${NOW});`,
  )

  // The demo markers come off: this database is thrown away, nothing needs to find them again.
  sql.push(
    `UPDATE broadcasts SET subject = substr(subject, 8) WHERE subject LIKE '[demo] %';`,
    `UPDATE messages SET subject = substr(subject, 8) WHERE subject LIKE '[demo] %';`,
    `UPDATE goals SET name = substr(name, 8) WHERE name LIKE '[demo] %';`,
    `UPDATE sequences SET name = 'Welcome to Field Notes', description = 'Five notes for new readers, over two weeks.' WHERE slug = 'demo-welcome';`,
    `UPDATE sequences SET name = 'Workshop onboarding', description = 'What to do before the first session.' WHERE slug = 'demo-cohort';`,
    `UPDATE sequences SET description = 'Imported with its figures. No content.' WHERE slug LIKE 'demo-kit-%';`,
    `UPDATE sequence_steps SET body_md = 'Hi {{first_name}},' || char(10) || char(10) || 'A short note, as promised.' || char(10) || char(10) || 'Mara' WHERE body_md = 'Demo body.';`,
  )

  // People with names. 20 first names by 19 last names never repeats inside 380.
  for (let i = 0; i < 380; i++) {
    const first = FIRST[i % FIRST.length]!
    const last = LAST[i % LAST.length]!
    const email = `${first}.${last}@${DOMAINS[i % DOMAINS.length]}`.toLowerCase()
    const source = ['form:newsletter', 'form:newsletter', 'import', 'api'][i % 4]!
    sql.push(
      `UPDATE subscribers SET name = ${q(`${first} ${last}`)}, email = ${q(email)}, source = ${q(source)} ` +
        `WHERE email = ${q(`demo+${i}@kolea.test`)};`,
    )
  }
  sql.push(
    `UPDATE messages SET to_email = (SELECT email FROM subscribers s WHERE s.id = messages.subscriber_id) ` +
      `WHERE to_email LIKE 'demo+%@kolea.test';`,
    `UPDATE subscribers SET source = 'form:newsletter' WHERE source = 'seed';`,
  )

  // Posts: sent broadcasts that are also up on the public site.
  for (const [subject, excerpt] of POSTS) {
    const body = `${excerpt}\n\nI have been running this list for six years, and most of what I know about it I learned by getting it wrong in front of people.\n\nMara`
    sql.push(
      `UPDATE broadcasts SET published_at = sent_at, slug = ${q(slugify(subject))}, excerpt = ${q(excerpt)}, ` +
        `body_md = ${q(body)}, search_text = ${q(`${subject} ${excerpt}`.toLowerCase())} WHERE subject = ${q(subject)};`,
    )
  }
  // The app's own seeded send is a note about the tool itself. It stays in the
  // admin and comes off the site, where it would sit oddly among Mara's essays.
  sql.push(`UPDATE broadcasts SET published_at = NULL WHERE subject = 'What I learned rewriting my mailer';`)

  // The draft the composer opens on.
  sql.push(
    `INSERT INTO broadcasts (subject, excerpt, body_json, body_md, segment, status, created_at) VALUES ` +
      `(${q(DRAFT_SUBJECT)}, ${q('Opens are weather. Replies and clicks are people.')}, ` +
      `${q(JSON.stringify(DRAFT_DOC))}, '', '{}', 'draft', ${NOW});`,
  )

  // Readers on the site: thirty days of page views, with a lift after each send.
  const referrers: (string | null)[] = [null, null, 'www.google.com', 'news.ycombinator.com', 'bsky.app', 'duckduckgo.com', 'lobste.rs', null]
  const rows: string[] = []
  let n = 0
  for (let ago = 29; ago >= 0; ago--) {
    const lift = ago === 9 ? 190 : ago === 8 ? 90 : ago === 7 ? 40 : 0
    const views = 34 + ((ago * 7) % 23) + lift
    const dayStart = NOW - ago * DAY
    const day = new Date(dayStart).toISOString().slice(0, 10)
    for (let v = 0; v < views; v++) {
      n++
      const post = POSTS[(v + ago) % (lift ? 2 : POSTS.length)]!
      const home = v % 5 === 0
      const path = home ? '/' : `/${slugify(post[0])}`
      const host = lift && v % 3 !== 0 ? null : referrers[(v + ago) % referrers.length]
      const source = lift && v % 3 !== 0 ? 'newsletter' : null
      rows.push(
        `(${q(`shot-${n}`)}, ${q(day)}, ${dayStart - (v % 20) * 1_800_000}, ${q(path)}, ` +
          `${home ? 'NULL' : `(SELECT id FROM broadcasts WHERE slug = ${q(slugify(post[0]))})`}, ` +
          `${host ? q(`https://${host}/`) : 'NULL'}, ${host ? q(host) : 'NULL'}, ${source ? q(source) : 'NULL'}, ` +
          `${q(['US', 'GB', 'DE', 'CA', 'NL', 'AU'][v % 6]!)}, ${q(`v${v % Math.ceil(views * 0.72)}`)}, ${35 + ((v * 37) % 190)})`,
      )
    }
  }
  for (let i = 0; i < rows.length; i += 40) {
    sql.push(
      `INSERT INTO page_views (view_key, day, occurred_at, path, broadcast_id, referrer, referrer_host, source, country, visitor, seconds) VALUES ` +
        `${rows.slice(i, i + 40).join(', ')};`,
    )
  }

  return sql.join('\n')
}

async function buildData(): Promise<void> {
  await post('/dev/reset')
  await post('/dev/seed')
  await sh(['bun', 'scripts/seed-conversion-kinds.ts', '--local', '--persist-to', STATE])
  await sh(['bun', 'scripts/seed-analytics-demo.ts', '--persist-to', STATE])
  await d1(fictionSql())
}

// ─────────────────────────────────────────────────────────── the shots

interface Shot {
  name: string
  /** What the picture is of, for the log. */
  what: string
  url: () => Promise<string>
  /** Anything the page needs before the shutter: a scroll, a wait. */
  before?: (page: Page) => Promise<void>
}

const one = async (sqlText: string, column: string): Promise<string> => {
  const row = (await d1(sqlText))[0]
  if (!row || row[column] == null) throw new Error(`Nothing came back for: ${sqlText}`)
  return String(row[column])
}

/** Scroll until a heading sits `above` pixels from the top of the window. */
const scrollToHeading = (heading: string, above: number) => async (page: Page) => {
  // A string, not a function: this file is typechecked without the DOM library.
  await page.evaluate(`(() => {
    const el = [...document.querySelectorAll('h1,h2,h3')].find((h) => h.textContent.trim() === ${JSON.stringify(heading)})
    if (el) window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - ${above}))
  })()`)
}

const SHOTS: Shot[] = [
  { name: 'dashboard', what: 'the dashboard: readers on the site against mail going out', url: async () => `${BASE}/` },
  {
    name: 'composer',
    what: 'the composer, on a written draft',
    url: async () => `${BASE}/broadcasts/${await one(`SELECT id FROM broadcasts WHERE subject = ${q(DRAFT_SUBJECT)}`, 'id')}`,
  },
  {
    name: 'sequence',
    what: 'a sequence and its steps',
    url: async () => `${BASE}/sequences/${await one(`SELECT id FROM sequences WHERE slug = 'demo-welcome'`, 'id')}`,
    before: scrollToHeading('Steps', 60),
  },
  { name: 'analytics', what: 'analytics: the two scores and what feeds them', url: async () => `${BASE}/analytics` },
  {
    name: 'sequence-report',
    what: 'one sequence, step by step',
    url: async () => `${BASE}/analytics/sequences/${await one(`SELECT id FROM sequences WHERE slug = 'demo-cohort'`, 'id')}`,
    before: scrollToHeading('Where people fall out', 250),
  },
  {
    name: 'subscriber',
    what: 'one subscriber: consent by scope, tags, history',
    url: async () => `${BASE}/subscribers/${await one(`SELECT id FROM subscribers WHERE email = 'alan@example.com'`, 'id')}`,
  },
  {
    name: 'preferences',
    what: "the reader's preference centre",
    url: async () => `${BASE}/p/${await one(`SELECT unsub_token FROM subscribers WHERE email = 'katherine@example.com'`, 'unsub_token')}`,
  },
  { name: 'site', what: 'the public site', url: async () => `${SITE}/` },
]

/** Hide what only exists in local development. */
const LOCAL_ONLY_CSS = 'form[action^="/dev/"]{display:none!important}'

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({ content: LOCAL_ONLY_CSS })
  // A string, not a function: this file is typechecked without the DOM library.
  await page.evaluate('document.fonts.ready')
  // Charts draw themselves in after load; give them time to finish.
  await page.waitForTimeout(1500)
}

async function shoot(browser: Browser, shot: Shot, url: string, scale: number): Promise<number> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: scale, colorScheme: 'light' })
  const page = await context.newPage()
  await page.goto(url, { waitUntil: 'networkidle' })
  await settle(page)
  if (shot.before) {
    await shot.before(page)
    await page.waitForTimeout(300)
  }
  const path = `${OUT}/${shot.name}.png`
  await page.screenshot({ path })
  await context.close()
  return statSync(path).size
}

/**
 * The share cards, from one small local page (`scripts/social-preview.html`):
 * the GitHub social preview, and the public site's default share card.
 */
async function socialPreview(browser: Browser): Promise<void> {
  const cards = [
    { path: `${OUT}/social-preview.png`, query: '', width: 1280, height: 640, what: 'the GitHub social preview (upload it in the repo settings)' },
    { path: 'public/img/social.jpeg', query: '?card=site', width: 1200, height: 630, what: "the public site's default share card" },
  ]
  for (const card of cards) {
    const context = await browser.newContext({ viewport: { width: card.width, height: card.height }, deviceScaleFactor: 1 })
    const page = await context.newPage()
    await page.goto(`file://${process.cwd()}/scripts/social-preview.html${card.query}`, { waitUntil: 'networkidle' })
    await page.evaluate('document.fonts.ready')
    await page.screenshot(card.path.endsWith('.jpeg') ? { path: card.path, type: 'jpeg', quality: 88 } : { path: card.path })
    await context.close()
    console.log(
      `✅ ${card.path.padEnd(28)} ${card.width}x${card.height}  ` +
        `${String(Math.round(statSync(card.path).size / 1024)).padStart(3)} KB  ${card.what}`,
    )
  }
}

// ─────────────────────────────────────────────────────────── main

const only = new Set(process.argv.slice(2))
const wanted = SHOTS.filter((s) => only.size === 0 || only.has(s.name))
const unknown = [...only].filter((name) => name !== 'social-preview' && !SHOTS.some((s) => s.name === name))
if (unknown.length) {
  console.error(`No shot called ${unknown.join(', ')}. There are: ${SHOTS.map((s) => s.name).join(', ')}, social-preview`)
  process.exit(1)
}
if (await serverUp()) {
  console.error(`Something is already listening on port ${PORT}. Stop it and run this again.`)
  process.exit(1)
}

console.log('Building the client and a clean database…')
await sh(['bun', 'scripts/onboard.ts', 'local-config'])
await sh(['bun', 'run', 'build:client'])
rmSync(STATE, { recursive: true, force: true })
mkdirSync(STATE, { recursive: true })
mkdirSync(OUT, { recursive: true })
await sh(['bunx', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', STATE])

const server = Bun.spawn(
  [
    'bunx', 'wrangler', 'dev', '--port', String(PORT), '--persist-to', STATE,
    '--var', `PUBLIC_URL:${BASE}`,
    '--var', `SITE_URL:${SITE}`,
    '--var', `FROM_NAME:${OPERATOR.name}`,
    '--var', `FROM_EMAIL:${OPERATOR.email}`,
    '--var', `SITE_TITLE:${OPERATOR.site}`,
    '--var', `SITE_TAGLINE:${TAGLINE}`,
    '--var', `SITE_AUTHOR:${OPERATOR.name}`,
    '--var', 'EMAIL_PROVIDER:console',
  ],
  { stdout: 'ignore', stderr: 'ignore' },
)

let failed = false
try {
  for (let i = 0; !(await serverUp()); i++) {
    if (i > 120) throw new Error('wrangler dev did not come up on port 8790 within a minute.')
    await Bun.sleep(500)
  }
  console.log('Seeding demo data…')
  await buildData()

  const browser = await chromium.launch()
  try {
    for (const shot of wanted) {
      const url = await shot.url()
      let scale = 2
      let bytes = await shoot(browser, shot, url, scale)
      if (bytes > MAX_BYTES) {
        scale = 1
        bytes = await shoot(browser, shot, url, scale)
      }
      console.log(
        `✅ ${`${OUT}/${shot.name}.png`.padEnd(28)} ${VIEWPORT.width * scale}x${VIEWPORT.height * scale}  ` +
          `${String(Math.round(bytes / 1024)).padStart(3)} KB  ${shot.what}`,
      )
    }
    if (only.size === 0 || only.has('social-preview')) await socialPreview(browser)
  } finally {
    await browser.close()
  }
} catch (e) {
  failed = true
  console.error(`❌ ${(e as Error).message}`)
} finally {
  server.kill()
  await server.exited
  if (existsSync(`${STATE}/screenshots.sql`)) rmSync(`${STATE}/screenshots.sql`)
}
process.exit(failed ? 1 : 0)
