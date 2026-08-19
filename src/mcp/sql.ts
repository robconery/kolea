/**
 * The `db_query` escape hatch.
 *
 * A fixed set of stats tools can only answer the questions somebody thought of.
 * Read-only SQL answers the rest — but it is arbitrary text from a model, so it
 * gets parsed rather than pattern-matched: comments and string literals are
 * stripped first, and only then is the remainder checked. Matching keywords
 * against the raw text is how `select 'delete from'` becomes a refusal and
 * `/*x*​/delete` becomes a deleted table.
 */

const MAX_ROWS = 500

/** Statements that read. Anything else is refused by omission, not by blocklist. */
const ALLOWED_START = /^(select|with)\b/i

/**
 * Blocked even though they can appear inside a SELECT. `pragma` reconfigures
 * the connection, `attach` reaches other databases, and the rest write.
 */
const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint)\b/i

/**
 * Remove comments and string/identifier literals, replacing each with a space.
 *
 * The result is not runnable SQL — it exists only so the checks below look at
 * code rather than at data. SQLite escapes a quote by doubling it, which falls
 * out of this loop naturally: the closing quote ends the literal and the next
 * one immediately opens another.
 */
function strip(sql: string): string {
  let out = ''
  let i = 0

  while (i < sql.length) {
    const ch = sql[i]!
    const next = sql[i + 1]

    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
      out += ' '
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      out += ' '
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < sql.length && sql[i] !== quote) i++
      i++
      out += ' '
      continue
    }
    if (ch === '[') {
      while (i < sql.length && sql[i] !== ']') i++
      i++
      out += ' '
      continue
    }

    out += ch
    i++
  }

  return out
}

export type SqlCheck = { ok: true; sql: string } | { ok: false; reason: string }

/**
 * Validate a query and return the version to actually run — same text, with a
 * `LIMIT` bolted on when the caller didn't set one.
 */
export function checkQuery(raw: string): SqlCheck {
  const sql = raw.trim().replace(/;\s*$/, '')
  if (!sql) return { ok: false, reason: 'empty query' }

  const code = strip(sql)

  if (code.includes(';')) {
    return { ok: false, reason: 'one statement per call — found a `;` between statements' }
  }
  if (!ALLOWED_START.test(sql.trimStart())) {
    return { ok: false, reason: 'db_query runs SELECT and WITH statements only' }
  }

  const forbidden = code.match(FORBIDDEN)
  if (forbidden) {
    return {
      ok: false,
      reason: `db_query is read-only and \`${forbidden[0].toLowerCase()}\` is not allowed`,
    }
  }

  // A LIMIT inside a subquery is not the outer limit, so only a trailing one
  // counts as the caller having set it.
  const hasOuterLimit = /\blimit\b[^)]*$/i.test(code)
  return { ok: true, sql: hasOuterLimit ? sql : `${sql} limit ${MAX_ROWS}` }
}

export { MAX_ROWS }
