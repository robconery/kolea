import { and, desc, eq, isNotNull } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { broadcasts } from '../../db/schema.ts'
import { docIsEmpty } from '../render-doc.ts'
import { docToPlainText } from './doc-markdown.ts'

/**
 * What the writer sounds like, read from what they have already sent.
 *
 * A style guide says what to avoid; a sample says what to aim for. Handing the
 * model a couple of the operator's own recent emails, and their recent subject
 * lines, is the cheapest way to get a draft that sounds like them rather than
 * like every other model's idea of a newsletter.
 *
 * Only sent broadcasts are read. They went to the whole list already, so
 * nothing here is private, and they are the writer's finished voice rather
 * than a half-written draft.
 */

/** Recent subject lines, newest first. */
export async function recentSubjects(db: Db, limit = 15): Promise<string[]> {
  const rows = await db
    .select({ subject: broadcasts.subject })
    .from(broadcasts)
    .where(and(eq(broadcasts.status, 'sent'), isNotNull(broadcasts.sentAt)))
    .orderBy(desc(broadcasts.sentAt))
    .limit(limit)
    .all()
  return rows.map((r) => r.subject.trim()).filter(Boolean)
}

/** The bodies of the last few sent broadcasts, each cut to about `words` words. */
export async function voiceSamples(db: Db, count = 2, words = 900): Promise<string[]> {
  const rows = await db
    .select({ bodyJson: broadcasts.bodyJson, bodyMd: broadcasts.bodyMd })
    .from(broadcasts)
    .where(and(eq(broadcasts.status, 'sent'), isNotNull(broadcasts.sentAt)))
    .orderBy(desc(broadcasts.sentAt))
    .limit(count)
    .all()
  return rows
    .map((r) => (r.bodyJson && !docIsEmpty(r.bodyJson) ? docToPlainText(r.bodyJson) : r.bodyMd))
    .map((text) => clip(text.trim(), words))
    .filter(Boolean)
}

function clip(text: string, words: number): string {
  const parts = text.split(/(\s+)/)
  let n = 0
  let out = ''
  for (const p of parts) {
    if (/\S/.test(p) && ++n > words) return `${out.trim()} [...]`
    out += p
  }
  return out
}
