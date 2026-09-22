import { and, eq } from 'drizzle-orm'
import { unzipSync } from 'fflate'
import type { Db } from '../../db/index.ts'
import { type Theme, themeFiles, themes } from '../../db/schema.ts'
import { KOLEA_THEME } from '../../themes/kolea.gen.ts'
import { helpers } from './helpers.ts'
import { type Node, parse, type Template, TemplateSyntaxError } from './parser.ts'

/**
 * Themes: where they live, how they load, how one gets installed.
 *
 * A theme is text plus bytes. The text — templates, partials, `package.json`,
 * locale files — goes in D1 (`theme_files`), so a cold isolate loads a whole
 * theme with one query. The bytes — CSS, JS, fonts, images, everything under
 * `assets/` — go in R2 under `themes/<id>/`, and the site streams them back from
 * `/assets/*`.
 *
 * The built-in `kolea` theme is compiled into the bundle (`src/themes/`, built by
 * `scripts/build-theme.ts`) and renders whenever no uploaded theme is active.
 * Deactivating everything is therefore always safe: there is no state in which
 * the site has no theme.
 */

export interface SettingDef {
  key: string
  type: 'select' | 'boolean' | 'color' | 'image' | 'text'
  options: string[]
  default: unknown
  group: string | null
  description: string | null
}

export interface LoadedTheme {
  /** Null for the built-in theme. */
  id: number | null
  name: string
  version: string
  /** Changes whenever the theme does — asset URLs carry it so caches bust on re-upload. */
  stamp: string
  pkg: Record<string, unknown>
  /** Resolved `@custom`: defaults from `package.json`, overridden by saved values. */
  custom: Record<string, unknown>
  postsPerPage: number
  /** A top-level template (`index`, `post`, `default`, `tag-ai`) or null. */
  template(name: string): Template | null
  /** A partial by its name under `partials/` (`post-card`, `icons/avatar`). */
  partial(name: string): Template | null
  hasTemplate(name: string): boolean
  hasPartial(name: string): boolean
  translate(key: string): string
}

// ─────────────────────────────────────────────────────────── loading

const cache = new Map<string, LoadedTheme>()

function remember(key: string, theme: LoadedTheme): LoadedTheme {
  cache.set(key, theme)
  // A handful is plenty — one active theme, plus whatever is being previewed.
  while (cache.size > 4) cache.delete(cache.keys().next().value as string)
  return theme
}

/** The theme the public site renders with right now. */
export async function loadActiveTheme(db: Db): Promise<LoadedTheme> {
  const row = await db
    .select({ id: themes.id, updatedAt: themes.updatedAt })
    .from(themes)
    .where(eq(themes.isActive, true))
    .get()
  if (!row) return builtinTheme()
  return loadThemeById(db, row.id)
}

/** A specific uploaded theme, active or not — the admin preview uses this. */
export async function loadThemeById(db: Db, id: number): Promise<LoadedTheme> {
  const row = await db.select().from(themes).where(eq(themes.id, id)).get()
  if (!row) return builtinTheme()
  const key = `${row.id}:${row.updatedAt.getTime()}`
  const hit = cache.get(key)
  if (hit) return hit

  const files = await db
    .select({ path: themeFiles.path, body: themeFiles.body })
    .from(themeFiles)
    .where(eq(themeFiles.themeId, id))
    .all()
  const map = Object.fromEntries(files.map((f) => [f.path, f.body]))
  return remember(
    key,
    makeTheme({
      id: row.id,
      name: row.name,
      version: row.version,
      stamp: row.updatedAt.getTime().toString(36),
      files: map,
      pkg: row.packageJson,
      settings: row.settings,
    }),
  )
}

export function builtinTheme(): LoadedTheme {
  const key = `builtin:${KOLEA_THEME.hash}`
  const hit = cache.get(key)
  if (hit) return hit
  const pkg = JSON.parse(KOLEA_THEME.files['package.json'] ?? '{}') as Record<string, unknown>
  return remember(
    key,
    makeTheme({
      id: null,
      name: KOLEA_THEME.name,
      version: String(pkg.version ?? '1.0.0'),
      stamp: KOLEA_THEME.hash,
      files: KOLEA_THEME.files,
      pkg,
      settings: {},
    }),
  )
}

interface ThemeSource {
  id: number | null
  name: string
  version: string
  stamp: string
  files: Record<string, string>
  pkg: Record<string, unknown>
  settings: Record<string, unknown>
}

function makeTheme(src: ThemeSource): LoadedTheme {
  const parsed = new Map<string, Template | null>()
  const load = (path: string): Template | null => {
    if (parsed.has(path)) return parsed.get(path) ?? null
    const body = src.files[path]
    // Validated at install, so this only throws for the built-in theme during
    // development — and loudly is right for that.
    const t = body === undefined ? null : parse(body)
    parsed.set(path, t)
    return t
  }

  const config = (src.pkg.config ?? {}) as Record<string, unknown>
  const custom: Record<string, unknown> = {}
  for (const def of customSettings(src.pkg)) {
    custom[def.key] = Object.hasOwn(src.settings, def.key) ? src.settings[def.key] : def.default
  }

  let strings: Record<string, string> | null = null
  const translate = (key: string): string => {
    if (strings === null) {
      try {
        strings = JSON.parse(src.files['locales/en.json'] ?? '{}') as Record<string, string>
      } catch {
        strings = {}
      }
    }
    const hit = strings[key]
    return typeof hit === 'string' && hit ? hit : key
  }

  return {
    id: src.id,
    name: src.name,
    version: src.version,
    stamp: src.stamp,
    pkg: src.pkg,
    custom,
    postsPerPage: Math.min(Math.max(Number(config.posts_per_page) || 12, 1), 50),
    template: (name) => load(`${name}.hbs`),
    partial: (name) => load(`partials/${name}.hbs`),
    hasTemplate: (name) => Object.hasOwn(src.files, `${name}.hbs`),
    hasPartial: (name) => Object.hasOwn(src.files, `partials/${name}.hbs`),
    translate,
  }
}

/** `config.custom` from a theme's `package.json`, as a list the admin can render. */
export function customSettings(pkg: Record<string, unknown>): SettingDef[] {
  const config = (pkg.config ?? {}) as Record<string, unknown>
  const defs = (config.custom ?? {}) as Record<string, Record<string, unknown>>
  const out: SettingDef[] = []
  for (const [key, def] of Object.entries(defs)) {
    if (!def || typeof def !== 'object') continue
    const type = String(def.type ?? 'text') as SettingDef['type']
    const known = ['select', 'boolean', 'color', 'image', 'text'].includes(type) ? type : 'text'
    out.push({
      key,
      type: known,
      options: Array.isArray(def.options) ? def.options.map(String) : [],
      default: def.default ?? (known === 'boolean' ? false : null),
      group: def.group ? String(def.group) : null,
      description: def.description ? String(def.description) : null,
    })
  }
  return out
}

// ─────────────────────────────────────────────────────────── assets

const TYPES: Record<string, string> = {
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  txt: 'text/plain; charset=utf-8',
}

export function contentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return TYPES[ext] ?? 'application/octet-stream'
}

/** Where an uploaded theme's asset lives in R2. */
function assetKey(themeId: number, path: string): string {
  return `themes/${themeId}/${path}`
}

/**
 * A theme asset as a response, or null. `path` is relative to `assets/` and
 * has already been through `safePath` — callers pass what came off the URL.
 */
export async function readThemeAsset(
  theme: LoadedTheme,
  bucket: R2Bucket | undefined,
  path: string,
): Promise<Response | null> {
  const clean = safePath(`assets/${path}`)
  if (!clean) return null
  const headers = {
    'Content-Type': contentType(clean),
    // Asset URLs carry `?v=<stamp>`, so a long cache is safe: a new upload is a
    // new URL.
    'Cache-Control': 'public, max-age=31536000, immutable',
  }
  if (theme.id === null) {
    const body = KOLEA_THEME.files[clean]
    return body === undefined ? null : new Response(body, { headers })
  }
  if (!bucket) return null
  const obj = await bucket.get(assetKey(theme.id, clean))
  if (!obj) return null
  return new Response(obj.body, { headers })
}

// ─────────────────────────────────────────────────────────── install

/** Theme zips from the wild are small; these are generous ceilings, not targets. */
const MAX_ZIP_BYTES = 25 * 1024 * 1024
const MAX_TOTAL_BYTES = 60 * 1024 * 1024
const MAX_FILES = 1500

export class ThemeInstallError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message)
    this.name = 'ThemeInstallError'
  }
}

/**
 * Normalise a path from a zip or a URL, or reject it. No absolute paths, no
 * `..`, no backslashes, no hidden files — a zip entry named `../../x` must never
 * become an R2 key or a D1 row outside its theme.
 */
export function safePath(path: string): string | null {
  if (!path || path.includes('\\') || path.includes('\0')) return null
  if (path.startsWith('/')) return null
  const parts = path.split('/')
  if (parts.some((p) => p === '..' || p === '.' || p === '' || p.startsWith('.'))) return null
  return parts.join('/')
}

const isText = (path: string) =>
  path.endsWith('.hbs') || path === 'package.json' || /^locales\/[\w-]+\.json$/.test(path)

export interface InstallResult {
  theme: Theme
  templates: number
  assets: number
  /** Helpers the theme calls that Kōlea doesn't have. They render nothing. */
  unknownHelpers: string[]
  replaced: boolean
}

/**
 * Install (or replace) a theme from a zip. Refuses — writing nothing — when the
 * zip isn't a theme, is too large, or any template fails to parse: a theme that
 * can't render must never become the one that renders.
 */
export async function installThemeZip(
  db: Db,
  bucket: R2Bucket | undefined,
  zip: Uint8Array,
): Promise<InstallResult> {
  if (zip.byteLength > MAX_ZIP_BYTES) throw new ThemeInstallError('That zip is over 25 MB.')
  if (!bucket) throw new ThemeInstallError('No MEDIA bucket is bound, so theme assets have nowhere to go.')

  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(zip, {
      filter: (f) => !f.name.endsWith('/') && !/(^|\/)(node_modules|__MACOSX|\.git)\//.test(f.name),
    })
  } catch {
    throw new ThemeInstallError('That file is not a readable zip.')
  }

  // GitHub's "Download ZIP" wraps everything in `Repo-main/`. Strip one level
  // of wrapper when that's where package.json is.
  let names = Object.keys(entries)
  const roots = new Set(names.map((n) => n.split('/')[0]))
  if (roots.size === 1 && !names.includes('package.json')) {
    const root = `${[...roots][0]}/`
    if (names.includes(`${root}package.json`)) {
      entries = Object.fromEntries(Object.entries(entries).map(([k, v]) => [k.slice(root.length), v]))
      names = Object.keys(entries)
    }
  }

  if (names.length > MAX_FILES) throw new ThemeInstallError(`That zip holds ${names.length} files; the limit is ${MAX_FILES}.`)
  const total = Object.values(entries).reduce((n, b) => n + b.byteLength, 0)
  if (total > MAX_TOTAL_BYTES) throw new ThemeInstallError('That theme unpacks to more than 60 MB.')

  const decoder = new TextDecoder()
  const text: Record<string, string> = {}
  const assets: [string, Uint8Array][] = []
  for (const [raw, bytes] of Object.entries(entries)) {
    const path = safePath(raw)
    if (!path) continue
    if (isText(path)) text[path] = decoder.decode(bytes)
    else if (path.startsWith('assets/')) assets.push([path, bytes])
    // Everything else (README, gulpfile, lockfiles, source maps' sources) is
    // build tooling, not theme.
  }

  if (!text['package.json']) throw new ThemeInstallError('No package.json at the root of the theme.')
  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(text['package.json']) as Record<string, unknown>
  } catch {
    throw new ThemeInstallError('package.json is not valid JSON.')
  }
  const name = String(pkg.name ?? '').trim()
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
    throw new ThemeInstallError('package.json needs a "name" (letters, numbers, dashes).')
  }
  for (const required of ['index.hbs', 'post.hbs']) {
    if (!text[required]) throw new ThemeInstallError(`A theme needs ${required} at its root.`)
  }

  const errors: string[] = []
  const unknown = new Set<string>()
  for (const [path, body] of Object.entries(text)) {
    if (!path.endsWith('.hbs')) continue
    try {
      collectUnknownHelpers(parse(body).body, unknown)
    } catch (err) {
      errors.push(`${path}: ${err instanceof TemplateSyntaxError ? err.message : String(err)}`)
    }
  }
  if (errors.length) throw new ThemeInstallError('Some templates would not parse.', errors)

  // ── All checks passed. Now write.
  const now = new Date()
  const existing = await db.select().from(themes).where(eq(themes.name, name)).get()
  let theme: Theme
  if (existing) {
    theme = (await db
      .update(themes)
      .set({ version: String(pkg.version ?? '0.0.0'), packageJson: pkg, updatedAt: now })
      .where(eq(themes.id, existing.id))
      .returning()
      .get()) as Theme
    await db.delete(themeFiles).where(eq(themeFiles.themeId, theme.id))
    await clearAssets(bucket, theme.id)
  } else {
    theme = await db
      .insert(themes)
      .values({ name, version: String(pkg.version ?? '0.0.0'), packageJson: pkg, createdAt: now, updatedAt: now })
      .returning()
      .get()
  }

  const rows = Object.entries(text).map(([path, body]) => ({ themeId: theme.id, path, body }))
  // Small chunks: D1 caps bound parameters per statement.
  for (let i = 0; i < rows.length; i += 25) await db.insert(themeFiles).values(rows.slice(i, i + 25))
  for (const [path, bytes] of assets) {
    await bucket.put(assetKey(theme.id, path), bytes, { httpMetadata: { contentType: contentType(path) } })
  }

  return {
    theme,
    templates: Object.keys(text).filter((p) => p.endsWith('.hbs')).length,
    assets: assets.length,
    unknownHelpers: [...unknown].sort(),
    replaced: Boolean(existing),
  }
}

async function clearAssets(bucket: R2Bucket, themeId: number): Promise<void> {
  const prefix = `themes/${themeId}/`
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix, cursor })
    const keys = page.objects.map((o) => o.key).filter((k) => k.startsWith(prefix))
    if (keys.length) await bucket.delete(keys)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
}

/**
 * Helper calls Handlebars would reject as "missing helper": a name with
 * arguments, or a block, that isn't one of ours and isn't plain data.
 */
function collectUnknownHelpers(nodes: Node[], out: Set<string>): void {
  const check = (head: { type: string; parts?: string[]; data?: boolean; depth?: number }, hasArgs: boolean) => {
    if (head.type !== 'path' || head.data || head.depth || head.parts?.length !== 1) return
    const name = head.parts[0] as string
    if (hasArgs && !Object.hasOwn(helpers, name)) out.add(name)
  }
  for (const node of nodes) {
    if (node.type === 'mustache') {
      check(node.call.head, node.call.params.length > 0 || Object.keys(node.call.hash).length > 0)
    } else if (node.type === 'block') {
      check(node.call.head, node.call.params.length > 0 || Object.keys(node.call.hash).length > 0)
      collectUnknownHelpers(node.program, out)
      if (node.inverse) collectUnknownHelpers(node.inverse, out)
    } else if (node.type === 'partial' && node.fallback) {
      collectUnknownHelpers(node.fallback, out)
    }
  }
}

// ─────────────────────────────────────────────────────────── admin

export async function listThemes(db: Db): Promise<Theme[]> {
  return db.select().from(themes).orderBy(themes.name).all()
}

/** Make one theme live, or pass null to go back to the built-in theme. */
export async function activateTheme(db: Db, id: number | null): Promise<void> {
  await db.update(themes).set({ isActive: false }).where(eq(themes.isActive, true))
  if (id !== null) await db.update(themes).set({ isActive: true }).where(eq(themes.id, id))
}

export async function deleteTheme(db: Db, bucket: R2Bucket | undefined, id: number): Promise<void> {
  // Deleting the live theme drops the site back to the built-in one — the row
  // is gone, so `loadActiveTheme` finds nothing active. Never a blank site.
  await db.delete(themes).where(eq(themes.id, id))
  if (bucket) await clearAssets(bucket, id)
}

/**
 * Save `@custom` values. Only keys the theme declares are kept, and only
 * values its declaration allows — a select stays within its options.
 */
export async function saveThemeSettings(db: Db, id: number, input: Record<string, string | null>): Promise<void> {
  const row = await db.select().from(themes).where(eq(themes.id, id)).get()
  if (!row) return
  const values: Record<string, unknown> = {}
  for (const def of customSettings(row.packageJson)) {
    const raw = input[def.key]
    switch (def.type) {
      case 'boolean':
        values[def.key] = raw === 'on' || raw === 'true'
        break
      case 'select':
        if (raw && def.options.includes(raw)) values[def.key] = raw
        break
      case 'color':
        if (raw && /^#[0-9a-f]{3,8}$/i.test(raw)) values[def.key] = raw
        break
      default:
        if (raw !== undefined && raw !== null) values[def.key] = raw.trim() || null
    }
  }
  await db
    .update(themes)
    .set({ settings: values, updatedAt: new Date() })
    .where(and(eq(themes.id, id)))
}
