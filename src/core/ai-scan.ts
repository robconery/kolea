import type { DocNode } from '../db/schema.ts'
import type { Env } from '../types.ts'

/**
 * The AI-text scan — a score for the writer, before the mail goes anywhere.
 *
 * This is coaching, not enforcement. Nothing is ever blocked on the number: a
 * scan that fails, times out or isn't configured leaves the Save exactly as it
 * was. The point is to show somebody, while they can still do something about
 * it, how their draft reads to a machine trained to smell a machine.
 *
 * Nothing is stored. A score describes a draft at one moment and is stale the
 * next keystroke, so it lives in the browser beside the text it was taken from.
 *
 * ⚠️ The draft's prose leaves the building: it is posted to the detector. That
 * is the whole cost of the feature, and why it is keyless-until-configured —
 * with no `PANGRAM_API_KEY` nothing here ever makes a request.
 *
 * Pangram is the detector because it was the one that kept both numbers that
 * matter low in independent testing: missed AI text, and — more important for
 * a coaching tool — human writing wrongly flagged. A detector that cries wolf
 * teaches people to ignore the dial. The vendor is confined to `detect()`
 * below; everything else speaks `ScanResult`.
 */

const API = 'https://text.external-api.pangram.com'

/**
 * Below this a detector is guessing, and a confident-looking dial over a guess
 * is worse than no dial.
 */
export const MIN_WORDS = 50

/** How long we'll wait for the detector before giving the writer their Save back. */
const DEADLINE_MS = 25_000
const POLL_MS = 700

export type ScanBand = 'human' | 'mixed' | 'ai'

export interface ScanResult {
  /** 0–100. The share of the prose that reads as machine-written or machine-assisted. */
  score: number
  band: ScanBand
  /** The detector's own one-line reading of the text. */
  headline: string
  /** Fractions of the text, 0–1. They sum to ~1. */
  ai: number
  assisted: number
  human: number
  words: number
}

export type ScanOutcome = { ok: true; result: ScanResult } | { ok: false; reason: string }

export function aiScanConfigured(env: Env): boolean {
  return Boolean(env.PANGRAM_API_KEY)
}

export async function scanDoc(env: Env, doc: DocNode | null, md = ''): Promise<ScanOutcome> {
  if (!env.PANGRAM_API_KEY) {
    return { ok: false, reason: 'The AI scan is not set up. Set the PANGRAM_API_KEY secret to turn it on.' }
  }

  const text = doc ? scanText(doc) : md.trim()
  const words = text ? text.split(/\s+/).length : 0
  if (words < MIN_WORDS) {
    return { ok: false, reason: `Too short to judge. Write at least ${MIN_WORDS} words, then scan.` }
  }

  try {
    const d = await detect(env.PANGRAM_API_KEY, text)
    // Assisted prose counts in full. The reader cannot tell "written by" from
    // "polished by", and neither can the unsubscribe link.
    const score = Math.round(Math.min(1, Math.max(0, d.ai + d.assisted)) * 100)
    return { ok: true, result: { ...d, score, band: bandFor(score), words } }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'The scan failed.' }
  }
}

export function bandFor(score: number): ScanBand {
  if (score < 20) return 'human'
  if (score < 60) return 'mixed'
  return 'ai'
}

/**
 * The prose a reader would actually read, one block per line.
 *
 * Not `postPlainText`: that one flattens to a single line for search and keeps
 * code. A detector wants paragraphs, and a code block is not writing — a
 * listing scores as whatever it scores and drags the number with it. Buttons,
 * images and merge tags are furniture, not prose, and are left out too.
 */
export function scanText(node: DocNode): string {
  return walk(node)
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

const SKIP = new Set(['codeBlock', 'emailButton', 'image', 'youtube', 'mergeTag', 'horizontalRule'])
const BLOCKS = new Set([
  'paragraph',
  'heading',
  'listItem',
  'taskItem',
  'blockquote',
  'tableCell',
  'tableHeader',
  'detailsSummary',
])

function walk(node: DocNode): string {
  const type = node.type ?? ''
  if (SKIP.has(type)) return ''
  if (type === 'text') return node.text ?? ''
  if (type === 'hardBreak') return ' '
  const inner = (node.content ?? []).map(walk).join('')
  return BLOCKS.has(type) ? `${inner}\n` : inner
}

/* ───────────────────────────────────────────────────────────── the detector */

interface Detection {
  headline: string
  ai: number
  assisted: number
  human: number
}

interface PangramTask {
  task_id?: string
  stage?: string
  headline?: string
  fraction_ai?: number
  fraction_ai_assisted?: number
  fraction_human?: number
}

/**
 * Pangram's inference API is asynchronous: post the text, get a task, poll it.
 * A newsletter comes back in a few seconds.
 */
async function detect(key: string, text: string): Promise<Detection> {
  const headers = { 'content-type': 'application/json', 'x-api-key': key }
  const deadline = Date.now() + DEADLINE_MS

  const created = await fetch(`${API}/task`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text, model: 'default', public_dashboard_link: false }),
  })
  if (created.status === 401 || created.status === 403) {
    throw new Error('The detector refused the API key. Check PANGRAM_API_KEY.')
  }
  if (!created.ok) throw new Error(`The detector answered ${created.status}. Try again in a moment.`)
  const { task_id: taskId } = (await created.json()) as PangramTask
  if (!taskId) throw new Error('The detector did not start a scan.')

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    const res = await fetch(`${API}/task/${encodeURIComponent(taskId)}`, { headers })
    if (!res.ok) throw new Error(`The detector answered ${res.status}. Try again in a moment.`)
    const task = (await res.json()) as PangramTask

    if (task.stage === 'STAGE_FAILED') throw new Error('The detector could not read this text.')
    if (task.stage === 'STAGE_SUCCESS') {
      return {
        headline: task.headline ?? '',
        ai: task.fraction_ai ?? 0,
        assisted: task.fraction_ai_assisted ?? 0,
        human: task.fraction_human ?? 0,
      }
    }
  }
  throw new Error('The scan took too long. Your draft is fine — try again in a moment.')
}
