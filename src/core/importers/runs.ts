/**
 * Importer runs: start one, advance it a page at a time from the minutely
 * cron, cancel it, read it back. The lifecycle lives here and only here.
 *
 * A run holds no state in memory. Each `advanceImports()` call reads the run's
 * row, asks the adapter for exactly one page at `(phase, cursor)`, hands that
 * page to `writer.ts`, and writes the next `(phase, cursor)` and the counts
 * back. The Worker can be redeployed between any two pages.
 *
 * The operator's API key is stored on the run row only, read only by
 * `advanceImports()`, never selected for a screen (`importRunColumns`), and
 * cleared the moment the run reaches a terminal status — completed, failed or
 * cancelled alike.
 */
import { and, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { type ImportNote, type ImportRun, type ImportSourceId, type ImportStatus, importRuns } from '../../db/schema.ts'
import { importHttp, importSources } from '../../providers/importers/index.ts'
import { type ImportSource, type SourceConnection, SourceError } from '../../providers/importers/types.ts'
import type { Env } from '../../types.ts'
import { foldNotes, writePage } from './writer.ts'

export type ImportEvent = 'page' | 'finish' | 'fail' | 'cancel'

const ACTIVE: ImportStatus[] = ['queued', 'running']

/**
 * The only way a run's status moves. Null means "not from here": a finished,
 * failed or cancelled run never comes back.
 */
export function nextImportStatus(from: ImportStatus, event: ImportEvent): ImportStatus | null {
  if (!ACTIVE.includes(from)) return null
  switch (event) {
    case 'page':
      return 'running'
    case 'finish':
      return 'completed'
    case 'fail':
      return 'failed'
    case 'cancel':
      return 'cancelled'
  }
}

export const isTerminal = (s: ImportStatus) => !ACTIVE.includes(s)

/** Three failed pages in a row and the run stops for good, saying why. */
const MAX_FAILURES = 3
/** Longer than any one page should take; a crashed invocation frees the run after this. */
const LEASE_MS = 5 * 60 * 1000

/** Every column but `credentials`. Anything that leaves this module selects these. */
export const importRunColumns = {
  id: importRuns.id,
  source: importRuns.source,
  status: importRuns.status,
  settings: importRuns.settings,
  phase: importRuns.phase,
  cursor: importRuns.cursor,
  phasesDone: importRuns.phasesDone,
  phasesTotal: importRuns.phasesTotal,
  pages: importRuns.pages,
  created: importRuns.created,
  updated: importRuns.updated,
  skipped: importRuns.skipped,
  invalid: importRuns.invalid,
  detail: importRuns.detail,
  notes: importRuns.notes,
  lastError: importRuns.lastError,
  failures: importRuns.failures,
  createdAt: importRuns.createdAt,
  startedAt: importRuns.startedAt,
  finishedAt: importRuns.finishedAt,
}

export type ImportRunView = Omit<ImportRun, 'credentials' | 'lockedUntil' | 'updatedAt'>

export interface SourceInfo {
  id: ImportSourceId
  label: string
  fields: ImportSource['fields']
}

export function importSourceList(): SourceInfo[] {
  return Object.values(importSources).map(({ id, label, fields }) => ({ id, label, fields }))
}

function sourceFor(id: string): ImportSource | null {
  return (importSources as Record<string, ImportSource>)[id] ?? null
}

export async function listImports(db: Db, limit = 20): Promise<ImportRunView[]> {
  return await db.select(importRunColumns).from(importRuns).orderBy(desc(importRuns.id)).limit(limit)
}

export async function getImport(db: Db, id: number): Promise<ImportRunView | null> {
  return (await db.select(importRunColumns).from(importRuns).where(eq(importRuns.id, id)).get()) ?? null
}

export type StartResult = { ok: true; id: number } | { ok: false; error: string }

/**
 * Check what the operator typed, prove the key works with one request, and
 * queue the run. Nothing is read or written beyond that one request until the
 * cron picks it up. One run at a time: two imports interleaving pages would
 * make both reports unreadable.
 */
export async function startImport(
  env: Env,
  db: Db,
  sourceId: string,
  params: Record<string, string>,
  now = Date.now(),
): Promise<StartResult> {
  const source = sourceFor(sourceId)
  if (!source) return { ok: false, error: 'Pick a tool to import from.' }

  const running = await db
    .select({ id: importRuns.id })
    .from(importRuns)
    .where(inArray(importRuns.status, ACTIVE))
    .get()
  if (running) return { ok: false, error: `Import #${running.id} is still running. Let it finish or cancel it first.` }

  try {
    const prepared = source.prepare(params)
    await source.verify({ ...prepared, http: importHttp(env.IMPORT_HTTP) })
    const phases = source.phases(prepared)
    const row = await db
      .insert(importRuns)
      .values({
        source: source.id,
        status: 'queued',
        settings: prepared.settings,
        credentials: JSON.stringify(prepared.credentials),
        phase: phases[0] ?? null,
        cursor: null,
        phasesTotal: phases.length,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      })
      .returning({ id: importRuns.id })
      .get()
    return { ok: true, id: row.id }
  } catch (err) {
    if (err instanceof SourceError) return { ok: false, error: err.message }
    throw err
  }
}

export type CancelResult = { ok: true } | { ok: false; error: string }

/** Stops a run between pages and drops its key. Rows already written stay. */
export async function cancelImport(db: Db, id: number, now = Date.now()): Promise<CancelResult> {
  const run = await getImport(db, id)
  if (!run) return { ok: false, error: 'No such import.' }
  if (!nextImportStatus(run.status, 'cancel')) return { ok: false, error: `Import #${id} is already ${run.status}.` }
  await db
    .update(importRuns)
    .set({
      status: 'cancelled',
      credentials: null,
      lockedUntil: null,
      finishedAt: new Date(now),
      updatedAt: new Date(now),
    })
    .where(and(eq(importRuns.id, id), inArray(importRuns.status, ACTIVE)))
  return { ok: true }
}

export type AdvanceOutcome = 'idle' | 'busy' | 'page' | 'completed' | 'failed' | 'retrying'

/**
 * Read one page of the oldest active run and write it. Called once per minutely
 * cron tick (worker.tsx), never more: a page is sized to leave the tick's D1
 * query budget for sequences.
 */
export async function advanceImports(env: Env, db: Db, now = Date.now()): Promise<AdvanceOutcome> {
  const candidate = await db
    .select({ id: importRuns.id })
    .from(importRuns)
    .where(inArray(importRuns.status, ACTIVE))
    .orderBy(importRuns.id)
    .get()
  if (!candidate) return 'idle'

  // The lease: an overlapping invocation finds it held and leaves the run alone.
  const claimed = await db
    .update(importRuns)
    .set({ lockedUntil: new Date(now + LEASE_MS) })
    .where(
      and(
        eq(importRuns.id, candidate.id),
        inArray(importRuns.status, ACTIVE),
        or(isNull(importRuns.lockedUntil), lt(importRuns.lockedUntil, new Date(now))),
      ),
    )
    .returning()
    .get()
  if (!claimed) return 'busy'
  const run = claimed

  const source = sourceFor(run.source)
  const phases = source ? source.phases({ settings: run.settings }) : []
  if (!source || !run.credentials || !run.phase || !phases.includes(run.phase)) {
    await finish(db, run, 'fail', now, { lastError: 'This import lost its key or its place and cannot resume. Start a new one.' })
    return 'failed'
  }

  const conn: SourceConnection = {
    settings: run.settings,
    credentials: JSON.parse(run.credentials) as Record<string, string>,
    http: importHttp(env.IMPORT_HTTP),
  }

  let page: Awaited<ReturnType<typeof writePage>>
  let next: string | null
  try {
    const fetched = await source.fetchPage(conn, run.phase, run.cursor)
    next = fetched.next
    page = await writePage(db, { runId: run.id, source: run.source, label: source.label, now }, fetched.records)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const failures = run.failures + 1
    if ((err instanceof SourceError && err.permanent) || failures >= MAX_FAILURES) {
      await finish(db, run, 'fail', now, { lastError: message, failures })
      return 'failed'
    }
    await db
      .update(importRuns)
      .set({ lastError: message, failures, lockedUntil: null, updatedAt: new Date(now) })
      .where(eq(importRuns.id, run.id))
    return 'retrying'
  }

  // Where the next page starts: further into this phase, or the top of the next.
  let phase: string | null = run.phase
  let cursor: string | null = next
  let phasesDone = run.phasesDone
  if (next === null) {
    phasesDone++
    phase = phases[phases.indexOf(run.phase) + 1] ?? null
    cursor = null
  }

  const detail = { ...run.detail }
  for (const [k, v] of Object.entries(page.detail)) detail[k] = (detail[k] ?? 0) + v
  const notes: ImportNote[] = foldNotes([...run.notes, ...page.notes])
  const progress = {
    phase,
    cursor,
    phasesDone,
    pages: run.pages + 1,
    created: run.created + page.created,
    updated: run.updated + page.updated,
    skipped: run.skipped + page.skipped,
    invalid: run.invalid + page.invalid,
    detail,
    notes,
    failures: 0,
    startedAt: run.startedAt ?? new Date(now),
  }

  if (phase === null) {
    await finish(db, run, 'finish', now, progress)
    return 'completed'
  }
  await db
    .update(importRuns)
    .set({ ...progress, status: nextImportStatus(run.status, 'page')!, lockedUntil: null, updatedAt: new Date(now) })
    // A cancel that landed mid-page wins: the rows are written, the run stays stopped.
    .where(and(eq(importRuns.id, run.id), inArray(importRuns.status, ACTIVE)))
  return 'page'
}

async function finish(
  db: Db,
  run: ImportRun,
  event: 'finish' | 'fail',
  now: number,
  changes: Partial<typeof importRuns.$inferInsert>,
): Promise<void> {
  const status = nextImportStatus(run.status, event)
  if (!status) return
  await db
    .update(importRuns)
    .set({
      ...changes,
      status,
      credentials: null,
      lockedUntil: null,
      finishedAt: new Date(now),
      updatedAt: new Date(now),
      startedAt: changes.startedAt ?? run.startedAt ?? new Date(now),
    })
    .where(and(eq(importRuns.id, run.id), inArray(importRuns.status, ACTIVE)))
}

/** For the screen: how far along, 0–100, by phases done. */
export function importPercent(run: Pick<ImportRunView, 'status' | 'phasesDone' | 'phasesTotal'>): number {
  if (run.status === 'completed') return 100
  return run.phasesTotal > 0 ? Math.floor((run.phasesDone * 100) / run.phasesTotal) : 0
}
