import type { Db } from '../db/index.ts'
import { getCampaignBySlug } from './campaigns.ts'
import { isValidEmail, normalizeEmail, sha256 } from './ids.ts'
import { recordSale } from './sales.ts'
import { splitCsvLine } from './subscribers.ts'

/**
 * Sales history import (gap.md "Sales history import", Kōlea SPEC 16.6).
 *
 * Past sales from a CSV, booked into `sales` so revenue covers the time before
 * Stripe was connected. The rules, each one load-bearing:
 *
 *   * **Nothing here mails anyone or starts an automation.** No tags, no
 *     `end_sequence`, no purchase mail, no subscribe sequences. A history import
 *     is bookkeeping; a 2019 buyer getting a 2026 thank-you is the bug.
 *   * **A buyer who is not on the list stays off it.** They are created
 *     `pending` (the same rule as every other sale, `upsertBuyer` in
 *     `sales.ts`), which no segment and no broadcast can reach. An existing
 *     subscriber's status is never touched, so `unsubscribed` stays put.
 *   * **No inferred attribution.** Only a campaign named on the row gets the
 *     credit; the buyer's last touch is never consulted, because that touch is
 *     newer than the sale. An unknown campaign refuses the row rather than
 *     booking it uncredited, so a typo is fixed and re-uploaded, not lost.
 *   * **Money never passes through a float.** "12.34" is split as a string.
 *   * **Re-uploading is a no-op.** Idempotent on `external_id`; a row without
 *     one is keyed by its fingerprint (its values plus which repeat of them it
 *     is in the file), so two identical purchases in one file stay two sales
 *     and the same file twice stays two, not four.
 *   * **Nothing is dropped silently.** Every line gets a report row, including
 *     the ones past the per-upload cap.
 */

/**
 * Lines one upload books. `recordSale` costs up to ~8 D1 queries a row, and a
 * Worker invocation gets 1,000 — so a bigger history goes up in several files.
 * Re-uploading a file that was cut off books only what is new.
 */
export const SALE_IMPORT_ROW_LIMIT = 100

/** Bytes one upload may carry. A hundred rows of sales is nowhere near this. */
export const SALE_IMPORT_MAX_BYTES = 1_000_000

/** Currencies with no minor unit: "500" yen is 500, never 50000. */
const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv',
  'xaf', 'xof', 'xpf',
])

export type SaleImportOutcome = 'created' | 'duplicate' | 'invalid'

export interface SaleImportLine {
  /** 1-based data line number, header excluded. */
  line: number
  email: string
  outcome: SaleImportOutcome
  /** Why a line was refused. */
  reason?: string
  saleId?: number
}

export interface SaleImportReport {
  created: number
  duplicate: number
  invalid: number
  lines: SaleImportLine[]
  /** Set when the file as a whole was refused (no header, too big). */
  error?: string
}

/**
 * "12.34" → 1234, "1,299.00" → 129900, "$5" → 500. Integer arithmetic on the
 * digits, never `Number("12.34") * 100` (which is 1233.9999…). `null` for
 * anything that is not a plain non-negative amount in that currency's units.
 */
export function parseAmountCents(raw: string, currency: string): number | null {
  const cleaned = raw.trim().replace(/^[$€£¥]/, '').replace(/,/g, '')
  const zeroDecimal = ZERO_DECIMAL.has(currency)
  const match = zeroDecimal ? /^(\d+)$/.exec(cleaned) : /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned)
  if (!match) return null
  const whole = match[1]!
  if (whole.length > 12) return null
  if (zeroDecimal) return Number.parseInt(whole, 10)
  const fraction = (match[2] ?? '').padEnd(2, '0')
  return Number.parseInt(whole, 10) * 100 + Number.parseInt(fraction, 10)
}

/** `2021-03-04` (midnight UTC) or a full ISO timestamp. Not in the future. */
export function parseSaleDate(raw: string, now = Date.now()): Date | null {
  const s = raw.trim()
  if (!/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) return null
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s.replace(' ', 'T'))
  if (!Number.isFinite(ms) || ms > now) return null
  return new Date(ms)
}

interface Parsed {
  line: number
  email: string
  amountCents: number
  currency: string
  occurredAt: Date
  product: string | null
  externalId: string | null
  campaignSlug: string | null
}

const REQUIRED = ['email', 'amount', 'currency', 'date'] as const

/** Parse and book a CSV of past sales. See the module comment for the rules. */
export async function importSales(db: Db, csv: string): Promise<SaleImportReport> {
  const report: SaleImportReport = { created: 0, duplicate: 0, invalid: 0, lines: [] }
  if (csv.length > SALE_IMPORT_MAX_BYTES) {
    return { ...report, error: 'That file is larger than 1 MB.' }
  }

  const rows = csv.replace(/^﻿/, '').split(/\r?\n/)
  const header = splitCsvLine(rows[0] ?? '').map((h) => h.trim().toLowerCase())
  const missing = REQUIRED.filter((name) => !header.includes(name))
  if (missing.length) {
    return { ...report, error: `The header row needs ${REQUIRED.join(', ')} (missing ${missing.join(', ')}).` }
  }
  const col = (cells: string[], name: string) => {
    const i = header.indexOf(name)
    return i >= 0 ? (cells[i] ?? '').trim() : ''
  }

  const refuse = (line: number, email: string, reason: string) => {
    report.invalid++
    report.lines.push({ line, email, outcome: 'invalid', reason })
  }

  const parsed: Parsed[] = []
  let line = 0
  for (const raw of rows.slice(1)) {
    if (!raw.trim()) continue
    line++
    const cells = splitCsvLine(raw)
    const email = normalizeEmail(col(cells, 'email'))
    if (line > SALE_IMPORT_ROW_LIMIT) {
      refuse(line, email, `Past the ${SALE_IMPORT_ROW_LIMIT}-line limit for one upload. Upload it in another file.`)
      continue
    }
    if (!isValidEmail(email)) {
      refuse(line, email, 'The email address is not valid.')
      continue
    }
    const currency = col(cells, 'currency').toLowerCase()
    if (!/^[a-z]{3}$/.test(currency)) {
      refuse(line, email, 'The currency must be a three-letter code like USD.')
      continue
    }
    const amountCents = parseAmountCents(col(cells, 'amount'), currency)
    if (amountCents === null) {
      refuse(line, email, `The amount "${col(cells, 'amount')}" is not a plain amount like 12.34.`)
      continue
    }
    const occurredAt = parseSaleDate(col(cells, 'date'))
    if (!occurredAt) {
      refuse(line, email, 'The date must be YYYY-MM-DD (or an ISO timestamp) and not in the future.')
      continue
    }
    parsed.push({
      line,
      email,
      amountCents,
      currency,
      occurredAt,
      product: col(cells, 'product').slice(0, 300) || null,
      externalId: col(cells, 'external_id').slice(0, 200) || null,
      campaignSlug: col(cells, 'campaign') || null,
    })
  }

  // Fingerprints for rows with no external id: values + which repeat they are.
  const seen = new Map<string, number>()
  const campaignsBySlug = new Map<string, boolean>()

  for (const row of parsed) {
    let externalId = row.externalId
    if (!externalId) {
      const values = [row.email, row.amountCents, row.currency, row.occurredAt.getTime(), row.product ?? ''].join('\u0000')
      const nth = (seen.get(values) ?? 0) + 1
      seen.set(values, nth)
      externalId = `import:${(await sha256(`${values}\u0000${nth}`)).slice(0, 40)}`
    }

    if (row.campaignSlug) {
      if (!campaignsBySlug.has(row.campaignSlug)) {
        campaignsBySlug.set(row.campaignSlug, Boolean(await getCampaignBySlug(db, row.campaignSlug)))
      }
      if (!campaignsBySlug.get(row.campaignSlug)) {
        refuse(row.line, row.email, `There is no campaign "${row.campaignSlug}".`)
        continue
      }
    }

    // ⚠️ No tagNames, no endSequenceSlug: those are the two inputs on a sale that
    // can put mail in an inbox, and an import never passes them.
    const result = await recordSale(db, {
      email: row.email,
      amountCents: row.amountCents,
      currency: row.currency,
      product: row.product,
      externalId,
      campaignSlug: row.campaignSlug,
      occurredAt: row.occurredAt,
      attribution: 'explicit',
      buyerSource: 'sale-import',
      meta: { source: 'import' },
    })

    if (result.status === 'recorded') {
      report.created++
      report.lines.push({ line: row.line, email: row.email, outcome: 'created', saleId: result.saleId })
    } else if (result.status === 'duplicate' || result.status === 'refunded') {
      report.duplicate++
      report.lines.push({ line: row.line, email: row.email, outcome: 'duplicate', saleId: result.saleId })
    } else {
      refuse(row.line, row.email, result.status === 'invalid_email' ? 'The email address is not valid.' : 'The amount is not valid.')
    }
  }

  report.lines.sort((a, b) => a.line - b.line)
  return report
}
