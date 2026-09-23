/**
 * Onboarding: from a fresh clone to a live install, driven by `/onboard`.
 *
 * Every API call and every file write the onboarding skill makes lives here, so
 * the skill interviews and this does. Each command is idempotent: it finds what
 * already exists by name before creating anything, so a half-finished run is
 * resumed by running the same commands again.
 *
 *   bun scripts/onboard.ts status            what's done, what's next
 *   bun scripts/onboard.ts set KEY=value     record an answer   (.onboard/state.json)
 *   bun scripts/onboard.ts secret KEY=value  record a secret    (.onboard/secrets.env, 0600)
 *   bun scripts/onboard.ts local             .dev.vars + local migrations
 *   bun scripts/onboard.ts verify            what the Cloudflare token can do
 *   bun scripts/onboard.ts zones             the domains on the account
 *   bun scripts/onboard.ts preflight         zone exists, hostnames are free
 *   bun scripts/onboard.ts provision         D1, R2 ×2, Queues ×2
 *   bun scripts/onboard.ts access            Access: 1 Allow app, 8 Bypass apps
 *   bun scripts/onboard.ts render            wrangler.template.jsonc → wrangler.jsonc
 *   bun scripts/onboard.ts resend-domain     add the domain, write its DNS into Cloudflare
 *   bun scripts/onboard.ts resend-status     is the domain verified yet
 *   bun scripts/onboard.ts resend-webhook    bounces + complaints → /webhooks/resend
 *   bun scripts/onboard.ts migrate           remote migrations         (production)
 *   bun scripts/onboard.ts deploy            typecheck, build, deploy  (production)
 *   bun scripts/onboard.ts secrets           push secrets              (production)
 *   bun scripts/onboard.ts seed              profile, signup form, first admin key
 *   bun scripts/onboard.ts check             is Access in front of the right things
 *
 * ⚠️ Nothing in here sends email. Onboarding never does; the first test send is
 * the operator's, from the admin, to themselves.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

// ─────────────────────────────────────────────────────────── files

const DIR = '.onboard'
const STATE = `${DIR}/state.json`
const SECRETS = `${DIR}/secrets.env`
const TEMPLATE = 'wrangler.template.jsonc'
const WRANGLER = 'wrangler.jsonc'

/**
 * The upstream install's database. A clone still carrying it in wrangler.jsonc
 * hasn't been onboarded yet; an account that can actually *open* it is the
 * upstream production install, and nothing here may write over that.
 */
const UPSTREAM_D1 = '1828a8a7-4b54-48ca-afae-58bd845edc2d'

const DB_NAME = 'kolea'
/** wrangler addresses the database by binding, so no command depends on its name. */
const DB_BINDING = 'DB'
const BUCKETS = ['kolea-media', 'kolea-downloads']
const QUEUES = ['kolea-send', 'kolea-dlq']

/** Paths that must open for everyone. Each one carries its own auth, or is public by design. */
const BYPASS: [path: string, why: string][] = [
  ['t', 'Tracking: open pixels and click redirects'],
  ['f', 'Forms: signup posts from anywhere'],
  ['p', 'Preferences: the reader’s preference center'],
  ['d', 'Downloads: the grant token is the auth'],
  ['media', 'Media: images embedded in sent mail'],
  ['api', 'API: bearer-key authenticated inside'],
  ['webhooks', 'Webhooks: signature-verified inside'],
  ['mcp', 'MCP: path secret + admin key inside'],
]

/** What the Worker reads as secrets. The Cloudflare token is deliberately not on this list. */
const WORKER_SECRETS = [
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'MCP_PATH_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'UNSPLASH_ACCESS_KEY',
  'OPENROUTER_KEY',
]

const GENERATED_HEADER = `// 🐦 Kōlea: rendered by \`bun scripts/onboard.ts render\` from ${TEMPLATE}
// and your answers in ${STATE}. Edit freely: it's yours now. Re-running render
// overwrites it, so change the answer (\`onboard.ts set KEY=value\`) or the
// template if you want an edit to survive that.
`

const SOCIAL_KEYS =['website', 'github', 'linkedin', 'x', 'mastodon', 'bluesky', 'youtube']

type State = Record<string, string>

function readState(): State {
  return existsSync(STATE) ? (JSON.parse(readFileSync(STATE, 'utf8')) as State) : {}
}

function writeState(s: State): void {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(STATE, `${JSON.stringify(s, null, 2)}\n`)
}

function readSecrets(): State {
  if (!existsSync(SECRETS)) return {}
  const out: State = {}
  for (const line of readFileSync(SECRETS, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

function writeSecrets(s: State): void {
  mkdirSync(DIR, { recursive: true })
  const body = Object.entries(s)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  writeFileSync(SECRETS, `# Kōlea onboarding secrets. Gitignored. Delete when you're done.\n${body}\n`)
  chmodSync(SECRETS, 0o600)
}

/** Parse `KEY=value` args. Values may contain `=`. */
function pairs(args: string[]): [string, string][] {
  return args.map((a) => {
    const i = a.indexOf('=')
    if (i < 1) fail(`Expected KEY=value, got "${a}"`)
    return [a.slice(0, i).trim(), a.slice(i + 1).trim()]
  })
}

// ─────────────────────────────────────────────────────────── output

const ok = (s: string) => console.log(`✅ ${s}`)
const bad = (s: string) => console.log(`❌ ${s}`)
const info = (s: string) => console.log(`   ${s}`)

function fail(msg: string): never {
  console.error(`❌ ${msg}`)
  process.exit(1)
}

function need(s: State, ...keys: string[]): void {
  const missing = keys.filter((k) => !s[k])
  if (missing.length) fail(`Missing ${missing.join(', ')}. Record with: bun scripts/onboard.ts set KEY=value`)
}

// ─────────────────────────────────────────────────────────── cloudflare

const CF = 'https://api.cloudflare.com/client/v4'

interface CfEnvelope<T> {
  success: boolean
  errors: { code: number; message: string }[]
  result: T
  result_info?: { page: number; total_pages: number }
}

function token(): string {
  const t = readSecrets().CLOUDFLARE_API_TOKEN
  if (!t) fail('No Cloudflare token yet. Store it with: bun scripts/onboard.ts secret CLOUDFLARE_API_TOKEN=…')
  return t
}

async function cfRaw<T>(method: string, path: string, body?: unknown): Promise<CfEnvelope<T> & { status: number }> {
  const res = await fetch(`${CF}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({ success: false, errors: [], result: null }))) as CfEnvelope<T>
  return { ...json, status: res.status }
}

async function cf<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await cfRaw<T>(method, path, body)
  if (!r.success) {
    const why = r.errors.map((e) => `${e.code} ${e.message}`).join('; ') || `HTTP ${r.status}`
    throw new Error(`${method} ${path} → ${why}`)
  }
  return r.result
}

/** Every page of a paginated list. */
async function cfAll<T>(path: string): Promise<T[]> {
  const out: T[] = []
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?'
    const r = await cfRaw<T[]>('GET', `${path}${sep}page=${page}&per_page=50`)
    if (!r.success) throw new Error(`GET ${path} → ${r.errors.map((e) => `${e.code} ${e.message}`).join('; ')}`)
    out.push(...(r.result ?? []))
    if (!r.result_info || page >= r.result_info.total_pages) return out
  }
}

function account(s: State): string {
  need(s, 'CLOUDFLARE_ACCOUNT_ID')
  return s.CLOUDFLARE_ACCOUNT_ID as string
}

interface Zone {
  id: string
  name: string
  status: string
}

async function zoneFor(s: State): Promise<Zone> {
  need(s, 'ZONE')
  const zones = await cf<Zone[]>('GET', `/zones?name=${encodeURIComponent(s.ZONE as string)}`)
  const z = zones[0]
  if (!z) fail(`No zone "${s.ZONE}" on this account, or the token can't see it (Zone Resources).`)
  return z
}

/** Does this account own the upstream production database? */
async function isUpstreamAccount(s: State): Promise<boolean> {
  if (!s.CLOUDFLARE_ACCOUNT_ID) return false
  const r = await cfRaw('GET', `/accounts/${s.CLOUDFLARE_ACCOUNT_ID}/d1/database/${UPSTREAM_D1}`)
  return r.success
}

// ─────────────────────────────────────────────────────────── wrangler

/**
 * The environment every wrangler call runs under: the onboarding token and
 * nothing else. A `CLOUDFLARE_API_KEY` left in the shell outranks the token and
 * fails remote D1 calls with 7403, so it's stripped, along with its email.
 */
function wranglerEnv(s: State): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.CLOUDFLARE_API_KEY
  delete env.CLOUDFLARE_EMAIL
  env.CLOUDFLARE_API_TOKEN = token()
  env.CLOUDFLARE_ACCOUNT_ID = account(s)
  return env
}

/**
 * `bunx wrangler`, never bare `wrangler`: a stale global install fails against
 * local D1 state. Output streams straight through so the person sees progress.
 */
async function run(cmd: string[], env?: Record<string, string>, stdin?: string): Promise<void> {
  console.log(`\n$ ${cmd.join(' ')}`)
  const proc = Bun.spawn(cmd, {
    env: env ?? (process.env as Record<string, string>),
    stdin: stdin === undefined ? 'inherit' : new TextEncoder().encode(stdin),
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await proc.exited
  if (code !== 0) fail(`${cmd.slice(0, 3).join(' ')} exited ${code}`)
}

// ─────────────────────────────────────────────────────────── resend

const RESEND = 'https://api.resend.com'

async function resend<T>(method: string, path: string, body?: unknown): Promise<T> {
  const key = readSecrets().RESEND_API_KEY
  if (!key) fail('No Resend key yet. Store it with: bun scripts/onboard.ts secret RESEND_API_KEY=re_…')
  const res = await fetch(`${RESEND}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as T & { message?: string; name?: string }
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? ' (the key needs Full access for this step)' : ''
    throw new Error(`Resend ${method} ${path} → ${res.status} ${json.message ?? json.name ?? ''}${hint}`)
  }
  return json
}

interface ResendRecord {
  record: string
  name: string
  type: string
  value: string
  priority?: number
  ttl?: string
  status?: string
}

interface ResendDomain {
  id: string
  name: string
  status: string
  records?: ResendRecord[]
}

function sendingDomain(s: State): string {
  need(s, 'FROM_EMAIL')
  return (s.FROM_EMAIL as string).split('@')[1]?.toLowerCase() ?? fail('FROM_EMAIL has no domain')
}

async function findResendDomain(name: string): Promise<ResendDomain | undefined> {
  const list = await resend<{ data: ResendDomain[] }>('GET', '/domains')
  return list.data.find((d) => d.name === name)
}

// ─────────────────────────────────────────────────────────── commands

const commands: Record<string, (args: string[]) => Promise<void>> = {
  async status() {
    const s = readState()
    const sec = readSecrets()
    const has = (k: string) => Boolean(s[k])
    const steps: [string, boolean][] = [
      ['Cloudflare token stored', Boolean(sec.CLOUDFLARE_API_TOKEN)],
      ['Account chosen', has('CLOUDFLARE_ACCOUNT_ID')],
      ['Name + from address', has('FROM_NAME') && has('FROM_EMAIL')],
      ['Zone + admin host', has('ZONE') && has('ADMIN_HOST')],
      ['D1 / R2 / Queues provisioned', has('D1_DATABASE_ID') && has('PROVISIONED')],
      ['Cloudflare Access apps', has('CF_ACCESS_AUD') && has('CF_ACCESS_TEAM_DOMAIN')],
      ['wrangler.jsonc rendered', has('RENDERED')],
      ['Resend key stored', Boolean(sec.RESEND_API_KEY)],
      ['Resend domain added', has('RESEND_DOMAIN_ID')],
      ['Resend domain verified', s.RESEND_STATUS === 'verified'],
      ['Resend webhook', Boolean(sec.RESEND_WEBHOOK_SECRET)],
      ['Migrated (remote)', has('MIGRATED')],
      ['Deployed', has('DEPLOYED')],
      ['Secrets pushed', has('SECRETS_PUSHED')],
      ['Seeded (profile, form, admin key)', has('SEEDED')],
      ['Checks passed', has('CHECKED')],
    ]
    const wr = existsSync(WRANGLER) ? readFileSync(WRANGLER, 'utf8') : ''
    if (wr.includes(UPSTREAM_D1)) info('wrangler.jsonc still carries the upstream install’s values (not onboarded yet).')
    for (const [label, done] of steps) console.log(`${done ? '✅' : '⬜'} ${label}`)
    const next = steps.find(([, d]) => !d)
    console.log(next ? `\nNext: ${next[0]}` : '\nAll done. 🐦')
    const answers = Object.keys(s).filter((k) => !/^[A-Z_]+ED$|_ID$|^RESEND_STATUS$/.test(k))
    if (answers.length) info(`Answers on file: ${answers.join(', ')}`)
  },

  async set(args) {
    const s = readState()
    for (const [k, v] of pairs(args)) {
      if (/TOKEN|SECRET|_KEY$/.test(k)) fail(`${k} looks like a secret. Use: bun scripts/onboard.ts secret ${k}=…`)
      if (v === '') delete s[k]
      else s[k] = v
    }
    writeState(s)
    ok(`Saved ${args.map((a) => a.split('=')[0]).join(', ')}`)
  },

  async secret(args) {
    const sec = readSecrets()
    for (const [k, v] of pairs(args)) {
      if (v === '') delete sec[k]
      else sec[k] = v
    }
    writeSecrets(sec)
    ok(`Stored ${args.map((a) => a.split('=')[0]).join(', ')} in ${SECRETS} (never printed)`)
  },

  async local() {
    if (existsSync('.dev.vars')) {
      info('.dev.vars already exists; leaving it alone.')
    } else {
      const secret = randomHex(24)
      writeFileSync(
        '.dev.vars',
        [
          '# Local secrets. Gitignored. See .dev.vars.example for everything you can add.',
          '# EMAIL_PROVIDER stays "console" (from wrangler.jsonc): mail goes to the Outbox, never the wire.',
          `MCP_PATH_SECRET=${secret}`,
          '',
        ].join('\n'),
      )
      ok('Wrote .dev.vars (console mail, MCP on a random local path)')
    }
    await run(['bun', 'run', 'db:migrate'])
    ok('Local database ready. Next: bun run dev → http://localhost:8787 → "Seed demo data"')
  },

  async verify() {
    const t = token()
    const v = await fetch(`${CF}/user/tokens/verify`, { headers: { Authorization: `Bearer ${t}` } })
    const vj = (await v.json()) as CfEnvelope<{ status: string }>
    if (!vj.success || vj.result?.status !== 'active') {
      fail('Cloudflare rejected the token. Copy it again from dash.cloudflare.com/profile/api-tokens (it is shown once).')
    }
    ok('Token is active')

    const accounts = await cf<{ id: string; name: string }[]>('GET', '/accounts')
    if (!accounts.length) fail('The token sees no accounts. Check "Account Resources" on the token.')
    const s = readState()
    if (accounts.length === 1 && !s.CLOUDFLARE_ACCOUNT_ID) {
      s.CLOUDFLARE_ACCOUNT_ID = accounts[0]!.id
      writeState(s)
    }
    for (const a of accounts) console.log(`   ${a.id === s.CLOUDFLARE_ACCOUNT_ID ? '→' : ' '} ${a.name}  ${a.id}`)
    if (!s.CLOUDFLARE_ACCOUNT_ID) {
      console.log('\nMore than one account. Choose with: bun scripts/onboard.ts set CLOUDFLARE_ACCOUNT_ID=<id>')
      return
    }

    const acct = s.CLOUDFLARE_ACCOUNT_ID
    const probes: [string, string, string][] = [
      ['Workers Scripts', `/accounts/${acct}/workers/scripts`, 'Account · Workers Scripts · Edit'],
      ['D1', `/accounts/${acct}/d1/database`, 'Account · D1 · Edit'],
      ['R2', `/accounts/${acct}/r2/buckets`, 'Account · Workers R2 Storage · Edit'],
      ['Queues', `/accounts/${acct}/queues`, 'Account · Queues · Edit'],
      ['Access apps', `/accounts/${acct}/access/apps`, 'Account · Access: Apps and Policies · Edit'],
      ['Zones', '/zones', 'Zone · Zone · Read'],
    ]
    let missing = 0
    for (const [label, path, perm] of probes) {
      const r = await cfRaw('GET', path)
      if (r.success) ok(label)
      else {
        missing++
        bad(`${label}: add "${perm}" to the token (${r.errors[0]?.message ?? `HTTP ${r.status}`})`)
      }
    }

    const org = await cfRaw<{ auth_domain?: string }>('GET', `/accounts/${acct}/access/organizations`)
    if (org.success && org.result?.auth_domain) {
      ok(`Zero Trust team: ${org.result.auth_domain}`)
      s.CF_ACCESS_TEAM_DOMAIN = org.result.auth_domain
      writeState(s)
    } else if (org.status === 403 || org.errors.some((e) => /auth/i.test(e.message))) {
      missing++
      bad('Access organization: add "Account · Access: Organizations, Identity Providers, and Groups · Read"')
    } else {
      missing++
      bad('Zero Trust isn’t set up on this account yet: one.dash.cloudflare.com → pick a team name → Free plan')
    }

    if (await isUpstreamAccount(s)) {
      bad('This account owns the UPSTREAM production database. Onboarding will not write to it.')
      process.exit(1)
    }
    console.log(missing ? `\n${missing} thing(s) to fix, then run verify again.` : '\nThe token can do everything onboarding needs.')
    if (missing) process.exit(1)
  },

  async zones() {
    const zones = await cfAll<Zone>('/zones')
    if (!zones.length) fail('No zones visible. Add the domain to Cloudflare, and to the token’s Zone Resources.')
    for (const z of zones) console.log(`   ${z.name}  (${z.status})`)
  },

  async preflight() {
    const s = readState()
    need(s, 'ZONE', 'ADMIN_HOST')
    const zone = await zoneFor(s)
    if (zone.status !== 'active') bad(`Zone ${zone.name} is "${zone.status}". It must be active (nameservers on Cloudflare).`)
    else ok(`Zone ${zone.name} is active`)

    let clash = false
    for (const host of [s.ADMIN_HOST, s.SITE_HOST].filter(Boolean) as string[]) {
      if (host !== zone.name && !host.endsWith(`.${zone.name}`)) {
        bad(`${host} is not inside ${zone.name}. Both hostnames must be on the chosen zone.`)
        clash = true
        continue
      }
      const recs = await cf<{ type: string; name: string; content: string }[]>(
        'GET',
        `/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}`,
      )
      // A custom domain this Worker already owns is fine; anything else blocks the deploy (100117).
      const foreign = recs.filter((r) => !(r.type === 'AAAA' && r.content === '100::'))
      if (foreign.length) {
        clash = true
        bad(`${host} already has DNS records. Cloudflare won’t attach the Worker until they’re gone:`)
        for (const r of foreign) info(`${r.type.padEnd(6)} ${r.name} → ${r.content}`)
      } else ok(`${host} is free`)
    }
    if (s.ADMIN_HOST && s.ADMIN_HOST === s.SITE_HOST) fail('The admin host and the site host must differ.')
    if (clash) process.exit(1)
  },

  async provision() {
    const s = readState()
    const acct = account(s)

    const dbs = await cfAll<{ uuid: string; name: string }>(`/accounts/${acct}/d1/database?name=${DB_NAME}`)
    let db = dbs.find((d) => d.name === DB_NAME)
    if (db) {
      if (db.uuid === UPSTREAM_D1) fail('That is the upstream production database. Stopping.')
      ok(`D1 ${DB_NAME} already exists (${db.uuid}), reusing it`)
    } else {
      db = await cf<{ uuid: string; name: string }>('POST', `/accounts/${acct}/d1/database`, { name: DB_NAME })
      ok(`Created D1 ${DB_NAME} (${db.uuid})`)
    }
    s.D1_DATABASE_ID = db.uuid

    const buckets = await cf<{ buckets: { name: string }[] }>('GET', `/accounts/${acct}/r2/buckets`)
    for (const name of BUCKETS) {
      if (buckets.buckets.some((b) => b.name === name)) ok(`R2 ${name} already exists`)
      else {
        await cf('POST', `/accounts/${acct}/r2/buckets`, { name })
        ok(`Created R2 ${name}`)
      }
    }

    const queues = await cfAll<{ queue_name: string }>(`/accounts/${acct}/queues`)
    for (const name of QUEUES) {
      if (queues.some((q) => q.queue_name === name)) ok(`Queue ${name} already exists`)
      else {
        const r = await cfRaw('POST', `/accounts/${acct}/queues`, { queue_name: name })
        if (!r.success) {
          const why = r.errors.map((e) => e.message).join('; ')
          fail(`Couldn’t create queue ${name}: ${why}\n   The free plan’s Queues quota (10k operations a day) can’t carry a real list; Kōlea needs Workers Paid ($5/mo): Workers & Pages → Plans.`)
        }
        ok(`Created queue ${name}`)
      }
    }

    s.PROVISIONED = new Date().toISOString()
    writeState(s)
  },

  async access() {
    const s = readState()
    need(s, 'ADMIN_HOST', 'OPERATOR_EMAIL', 'CF_ACCESS_TEAM_DOMAIN')
    const acct = account(s)
    const host = s.ADMIN_HOST as string

    interface App {
      id: string
      name: string
      domain: string
      aud: string
    }
    const apps = await cfAll<App>(`/accounts/${acct}/access/apps`)
    const byDomain = (d: string) => apps.find((a) => a.domain === d)

    // Bypass first: until they exist, an Allow on the whole host would send
    // every pixel, unsubscribe and signup to a login screen.
    for (const [path, why] of BYPASS) {
      const domain = `${host}/${path}/*`
      if (byDomain(domain)) {
        ok(`Bypass ${domain} already exists`)
        continue
      }
      await cf('POST', `/accounts/${acct}/access/apps`, {
        name: `Kōlea · ${why.split(':')[0]}`,
        type: 'self_hosted',
        domain,
        session_duration: '24h',
        app_launcher_visible: false,
        policies: [{ name: 'Everyone', decision: 'bypass', precedence: 1, include: [{ everyone: {} }] }],
      })
      ok(`Bypass ${domain}  (${why})`)
    }

    let admin = byDomain(host)
    if (admin) ok(`Allow ${host} already exists`)
    else {
      admin = await cf<App>('POST', `/accounts/${acct}/access/apps`, {
        name: 'Kōlea · Admin console',
        type: 'self_hosted',
        domain: host,
        session_duration: '24h',
        app_launcher_visible: true,
        policies: [
          {
            name: 'Operator',
            decision: 'allow',
            precedence: 1,
            include: [{ email: { email: s.OPERATOR_EMAIL } }],
          },
        ],
      })
      ok(`Allow ${host} for ${s.OPERATOR_EMAIL}`)
    }
    if (!admin.aud) fail('Access returned no AUD tag for the admin app.')
    s.CF_ACCESS_AUD = admin.aud
    writeState(s)
    info(`Team ${s.CF_ACCESS_TEAM_DOMAIN}, AUD ${admin.aud.slice(0, 12)}…`)
  },

  async render() {
    const s = readState()
    need(s, 'D1_DATABASE_ID', 'ADMIN_HOST', 'FROM_EMAIL', 'FROM_NAME', 'CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD')
    if (s.D1_DATABASE_ID === UPSTREAM_D1 || (await isUpstreamAccount(s))) {
      fail('This is the upstream production install. render will not overwrite its wrangler.jsonc.')
    }
    // Mail goes on the wire only once Resend has verified the domain. Until then
    // "console" keeps the deploy harmless: everything lands in the Outbox.
    const provider = s.RESEND_STATUS === 'verified' ? 'resend' : 'console'
    const values: State = {
      ...s,
      EMAIL_PROVIDER: provider,
      SITE_TITLE: s.SITE_TITLE ?? s.FROM_NAME ?? '',
      SITE_TAGLINE: s.SITE_TAGLINE ?? '',
    }
    // The template's header explains the template language, placeholders and
    // all; the rendered file gets its own header instead.
    const tpl = readFileSync(TEMPLATE, 'utf8')
    const body = renderTemplate(tpl.slice(tpl.search(/^\{/m)), values)
    const out = `${GENERATED_HEADER}${body}`
    const unfilled = out.match(/\{\{[#/]?[A-Za-z_ ]+\}\}/g)
    if (unfilled) fail(`Template left unfilled: ${[...new Set(unfilled)].join(', ')}`)
    writeFileSync(WRANGLER, out)
    s.RENDERED = new Date().toISOString()
    writeState(s)
    ok(`Wrote ${WRANGLER} (EMAIL_PROVIDER=${provider}${provider === 'console' ? ', until Resend verifies the domain' : ''})`)
  },

  async 'resend-domain'() {
    const s = readState()
    const name = sendingDomain(s)
    let domain = await findResendDomain(name)
    if (domain) ok(`Resend already has ${name}`)
    else {
      domain = await resend<ResendDomain>('POST', '/domains', { name })
      ok(`Added ${name} to Resend`)
    }
    // The list endpoint omits records; the single-domain read has them.
    const full = await resend<ResendDomain>('GET', `/domains/${domain.id}`)
    s.RESEND_DOMAIN_ID = full.id
    s.RESEND_STATUS = full.status
    writeState(s)

    // The DNS goes into the zone that holds the sending domain, which is usually
    // but not necessarily the one the Worker lives on.
    const zones = await cfAll<Zone>('/zones')
    const zone = zones
      .filter((z) => name === z.name || name.endsWith(`.${z.name}`))
      .sort((a, b) => b.name.length - a.name.length)[0]
    if (!zone) {
      bad(`${name} isn’t a zone this token can edit. Add these records wherever its DNS lives:`)
      for (const r of full.records ?? []) info(`${r.type} ${r.name} → ${r.value}`)
      return
    }

    const fqdn = (n: string) => (n === '@' || n === '' ? name : n.endsWith(name) ? n : `${n}.${name}`)
    for (const r of full.records ?? []) {
      const recName = fqdn(r.name)
      const existing = await cf<{ type: string; content: string }[]>(
        'GET',
        `/zones/${zone.id}/dns_records?type=${r.type}&name=${encodeURIComponent(recName)}`,
      )
      const same = existing.some((e) => e.content.replace(/^"|"$/g, '') === r.value)
      if (same) {
        ok(`${r.type} ${recName} already set`)
        continue
      }
      // An SPF TXT on the same name is merged by hand, never overwritten: two SPF
      // records is a permerror, and silently replacing one breaks their other mail.
      if (r.type === 'TXT' && r.value.startsWith('v=spf1') && existing.some((e) => e.content.includes('v=spf1'))) {
        bad(`${recName} already has an SPF record. Merge Resend’s include into it by hand: ${r.value}`)
        continue
      }
      await cf('POST', `/zones/${zone.id}/dns_records`, {
        type: r.type,
        name: recName,
        content: r.value,
        ttl: 1,
        ...(r.type === 'MX' ? { priority: r.priority ?? 10 } : {}),
        comment: 'Kōlea / Resend',
      })
      ok(`${r.type} ${recName}`)
    }

    const dmarcName = `_dmarc.${zone.name}`
    const dmarc = await cf<unknown[]>('GET', `/zones/${zone.id}/dns_records?type=TXT&name=${dmarcName}`)
    if (dmarc.length) ok(`DMARC already published on ${zone.name}`)
    else {
      await cf('POST', `/zones/${zone.id}/dns_records`, {
        type: 'TXT',
        name: dmarcName,
        content: `v=DMARC1; p=none; rua=mailto:${s.FROM_EMAIL}`,
        ttl: 1,
        comment: 'Kōlea: monitoring mode. Tighten to p=quarantine once reports are clean.',
      })
      ok(`DMARC (p=none, reports to ${s.FROM_EMAIL})`)
    }

    await resend('POST', `/domains/${full.id}/verify`)
    ok('Asked Resend to verify. It usually takes a few minutes: bun scripts/onboard.ts resend-status')
  },

  async 'resend-status'() {
    const s = readState()
    need(s, 'RESEND_DOMAIN_ID')
    const d = await resend<ResendDomain>('GET', `/domains/${s.RESEND_DOMAIN_ID}`)
    s.RESEND_STATUS = d.status
    writeState(s)
    if (d.status === 'verified') ok(`${d.name} is verified. Run render again to switch EMAIL_PROVIDER to resend.`)
    else {
      info(`${d.name}: ${d.status}`)
      for (const r of d.records ?? []) info(`${r.status === 'verified' ? '✅' : '⏳'} ${r.type} ${r.name}`)
    }
  },

  async 'resend-webhook'() {
    const s = readState()
    need(s, 'ADMIN_HOST')
    const endpoint = `https://${s.ADMIN_HOST}/webhooks/resend`
    const sec = readSecrets()
    const list = await resend<{ data: { id: string; endpoint: string }[] }>('GET', '/webhooks')
    const existing = list.data.find((w) => w.endpoint === endpoint)
    if (existing && sec.RESEND_WEBHOOK_SECRET) {
      ok(`Webhook → ${endpoint} already exists, secret on file`)
      return
    }
    if (existing) {
      // The signing secret is only readable on the webhook itself; fetch it rather than make a second one.
      const one = await resend<{ signing_secret?: string }>('GET', `/webhooks/${existing.id}`)
      if (!one.signing_secret) fail('Resend didn’t return the signing secret. Copy it from resend.com/webhooks.')
      writeSecrets({ ...sec, RESEND_WEBHOOK_SECRET: one.signing_secret })
      ok(`Webhook → ${endpoint} already existed; stored its signing secret`)
      return
    }
    const created = await resend<{ id: string; signing_secret?: string }>('POST', '/webhooks', {
      endpoint,
      events: ['email.delivered', 'email.bounced', 'email.complained'],
    })
    if (!created.signing_secret) fail('Webhook created, but no signing secret came back. Copy it from resend.com/webhooks.')
    writeSecrets({ ...sec, RESEND_WEBHOOK_SECRET: created.signing_secret })
    ok(`Webhook → ${endpoint} (delivered, bounced, complained); signing secret stored`)
  },

  async migrate() {
    const s = readState()
    guardRendered(s)
    await run(['bunx', 'wrangler', 'd1', 'migrations', 'apply', DB_BINDING, '--remote', '--env', 'production'], wranglerEnv(s), 'y\n')
    s.MIGRATED = new Date().toISOString()
    writeState(s)
    ok('Remote database migrated')
  },

  async deploy() {
    const s = readState()
    guardRendered(s)
    await run(['bun', 'run', 'typecheck'])
    // `bun run deploy` hard-codes --env production. Never call wrangler deploy bare.
    await run(['bun', 'run', 'deploy'], wranglerEnv(s))
    s.DEPLOYED = new Date().toISOString()
    writeState(s)
    ok('Deployed')
  },

  async secrets() {
    const s = readState()
    guardRendered(s)
    const sec = readSecrets()
    if (!sec.MCP_PATH_SECRET) {
      sec.MCP_PATH_SECRET = randomHex(24)
      writeSecrets(sec)
    }
    const payload: State = {}
    for (const k of WORKER_SECRETS) if (sec[k]) payload[k] = sec[k] as string
    const file = `${DIR}/bulk.json`
    writeFileSync(file, JSON.stringify(payload), { mode: 0o600 })
    try {
      await run(['bunx', 'wrangler', 'secret', 'bulk', file, '--env', 'production'], wranglerEnv(s))
    } finally {
      rmSync(file, { force: true })
    }
    s.SECRETS_PUSHED = new Date().toISOString()
    writeState(s)
    ok(`Pushed ${Object.keys(payload).join(', ')}`)
  },

  async seed(args) {
    const s = readState()
    guardRendered(s)
    need(s, 'ADMIN_HOST', 'FROM_NAME')
    // One admin key per install unless asked: re-running seed to fix the profile
    // shouldn't leave a trail of live admin keys nobody wrote down.
    const mintKey = !s.SEEDED || args.includes('--new-key')
    const now = Date.now()
    const q = (v: string | undefined | null) => (v ? `'${v.replace(/'/g, "''")}'` : 'null')

    const social: Record<string, string> = {}
    for (const k of SOCIAL_KEYS) {
      const v = s[`SOCIAL_${k.toUpperCase()}`]
      if (v) social[k] = v
    }
    const profile = { lede: '', what_i_do: [], links: [], social }

    const tokenPlain = randomHex(18)
    const hash = new Bun.CryptoHasher('sha256').update(tokenPlain).digest('hex')

    // `insert or ignore` on the fixed id and the unique slug: re-running seed never
    // overwrites a profile or form the operator has since edited.
    const sql = [
      `insert or ignore into site_settings (id, title, tagline, author_name, short_bio, social_links, profile, updated_at)
       values (1, ${q(s.SITE_TITLE ?? s.FROM_NAME)}, ${q(s.SITE_TAGLINE)}, ${q(s.FROM_NAME)}, ${q(s.SHORT_BIO)},
               '[]', ${q(JSON.stringify(profile))}, ${now});`,
      `insert or ignore into forms (slug, name, created_at) values ('newsletter', 'Newsletter', ${now});`,
      mintKey
        ? `insert into api_keys (name, token_hash, scope, created_at) values ('Onboarding admin', '${hash}', 'admin', ${now});`
        : '',
    ].join('\n')
    const file = `${DIR}/seed.sql`
    writeFileSync(file, sql)
    try {
      await run(['bunx', 'wrangler', 'd1', 'execute', DB_BINDING, '--remote', '--env', 'production', '--file', file], wranglerEnv(s))
    } finally {
      rmSync(file, { force: true })
    }

    s.SEEDED = new Date().toISOString()
    writeState(s)
    if (!mintKey) {
      ok('Profile and "newsletter" signup form (existing rows left as they were). No new key: pass --new-key for one.')
      return
    }

    ok('Profile, "newsletter" signup form, and an admin API key')
    console.log(`\n🔑 Admin API key (shown once, only its hash is stored in the database):\n\n   ${tokenPlain}\n`)
    console.log('🤖 Drive Kōlea from Claude Code:\n')
    console.log(
      `   claude mcp add --transport http --scope local \\\n     --header "Authorization: Bearer ${tokenPlain}" \\\n     kolea "https://${s.ADMIN_HOST}/mcp/${readSecrets().MCP_PATH_SECRET ?? '<MCP_PATH_SECRET>'}"\n`,
    )
  },

  async check() {
    const s = readState()
    need(s, 'ADMIN_HOST')
    const host = s.ADMIN_HOST as string
    let failed = 0
    const get = (url: string) => fetch(url, { redirect: 'manual' })
    const toLogin = (r: Response) =>
      r.status >= 300 && r.status < 400 && /cloudflareaccess\.com/.test(r.headers.get('location') ?? '')

    try {
      const admin = await get(`https://${host}/`)
      if (toLogin(admin) || admin.status === 401 || admin.status === 403) ok(`${host} asks for a login`)
      else {
        failed++
        bad(`${host} answered ${admin.status} WITHOUT a login. Access isn’t in front of it. Do not use it until this passes.`)
      }

      const prefs = await get(`https://${host}/p/onboarding-check`)
      if (toLogin(prefs)) {
        failed++
        bad('/p/ redirects to a login: the Preferences bypass is missing. Re-run access.')
      } else ok(`/p/ is public (${prefs.status})`)

      const pixel = await get(`https://${host}/t/open/0.gif`)
      if (toLogin(pixel)) {
        failed++
        bad('/t/ redirects to a login: the Tracking bypass is missing. Re-run access.')
      } else ok(`/t/ is public (${pixel.status})`)

      if (s.SITE_HOST) {
        const site = await get(`https://${s.SITE_HOST}/`)
        if (toLogin(site)) {
          failed++
          bad(`${s.SITE_HOST} redirects to a login: it’s inside an Access app. Scope the Allow app to ${host} exactly.`)
        } else ok(`${s.SITE_HOST} is public (${site.status})`)
      }
    } catch (e) {
      fail(`Couldn’t reach ${host}: ${(e as Error).message}. A new custom domain can take a minute or two for its certificate; try again shortly.`)
    }

    if (failed) process.exit(1)
    s.CHECKED = new Date().toISOString()
    writeState(s)
  },
}

// ─────────────────────────────────────────────────────────── helpers

function randomHex(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('hex')
}

/** Refuse to touch production until wrangler.jsonc is this person's, not upstream's. */
function guardRendered(s: State): void {
  const wr = readFileSync(WRANGLER, 'utf8')
  if (wr.includes(UPSTREAM_D1) || !s.RENDERED) fail('wrangler.jsonc hasn’t been rendered for your account yet. Run render first.')
}

/** `{{KEY}}` and `{{#if KEY}} … {{/if}}` — the whole template language. */
export function renderTemplate(tpl: string, values: State): string {
  const blocks = tpl.replace(/\{\{#if ([A-Z_]+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key: string, inner: string) =>
    values[key] ? inner : '',
  )
  return blocks.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) => {
    const v = values[key]
    return v === undefined ? whole : JSON.stringify(v).slice(1, -1)
  })
}

// ─────────────────────────────────────────────────────────── main

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2)
  const fn = cmd ? commands[cmd] : undefined
  if (!fn) {
    console.log(`Usage: bun scripts/onboard.ts <${Object.keys(commands).join(' | ')}>`)
    process.exit(cmd ? 1 : 0)
  }
  fn(rest).catch((e: unknown) => fail((e as Error).message))
}
