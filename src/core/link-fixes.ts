import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { type LinkFix, events, linkFixes, messages } from '../db/schema.ts'
import { getBroadcast, reviseSentBroadcast } from './broadcasts.ts'
import { fixedLinkProblem, linksIn, replaceLink } from './link-safety.ts'

/**
 * ⭐ Fixing a link in mail that has already gone out.
 *
 * A delivered copy cannot be edited, but every tracked link in it passes
 * through `/t/click/:id?u=<url>` on its way out (`api/tracking.ts`). A fix is a
 * `link_fixes` row the click route reads: clicks on the old link go to the new
 * one. The stored body is rewritten too, so the web page and any later send
 * (a resumed cancel) carry the corrected link and never need the redirect.
 *
 * What it cannot reach, said plainly so nobody promises it: a link that was not
 * tracked (click tracking off, an unsubscribe or download link, plain-text mail
 * read without clicking through), and copies forwarded as text.
 */

export interface BroadcastLink {
  url: string
  /** People (messages) who clicked it. Counted from `events.meta.url`, the link as mailed. */
  clicks: number
  /** Present in the body as it stands now, and so on the web page. */
  inBody: boolean
  fix: Pick<LinkFix, 'id' | 'toUrl'> | null
}

/**
 * Where a click on `url` in this message should go instead, or null to go
 * where the link says.
 *
 * One query, both halves indexed: the message by its primary key, then the fix
 * by the unique `(broadcast_id, from_url)` index. Sequence and transactional
 * mail has no broadcast, so it joins to nothing. Throws only if the database
 * does, and the click route treats that as "no fix".
 */
export async function fixedDestination(db: Db, messageId: number, url: string): Promise<string | null> {
  const row = await db
    .select({ to: linkFixes.toUrl })
    .from(messages)
    .innerJoin(linkFixes, and(eq(linkFixes.broadcastId, messages.broadcastId), eq(linkFixes.fromUrl, url)))
    .where(eq(messages.id, messageId))
    .get()
  return row?.to ?? null
}

export async function listLinkFixes(db: Db, broadcastId: number): Promise<LinkFix[]> {
  return await db
    .select()
    .from(linkFixes)
    .where(eq(linkFixes.broadcastId, broadcastId))
    .orderBy(asc(linkFixes.id))
    .all()
}

/**
 * Every link that can be fixed for one broadcast, with its clicks.
 *
 * The links people actually have come first: the as-mailed copy when the
 * broadcast was corrected since, the body otherwise. Then links in the current
 * body that were not in the mail, then anything clicked that is in neither (a
 * link edited away by hand in the composer still lives in delivered copies).
 *
 * Two queries: the fixes, and one grouped count of click events over this
 * broadcast's messages (the `messages_broadcast_status_idx` and
 * `events_message_type_idx` indexes).
 */
export async function broadcastLinks(db: Db, broadcastId: number): Promise<BroadcastLink[] | null> {
  const b = await getBroadcast(db, broadcastId)
  if (!b) return null

  const urlOf = sql<string | null>`json_extract(${events.meta}, '$.url')`
  const clicked = await db
    .select({ url: urlOf, n: sql<number>`count(distinct ${events.messageId})` })
    .from(events)
    .innerJoin(messages, eq(events.messageId, messages.id))
    .where(and(eq(messages.broadcastId, broadcastId), eq(events.type, 'click')))
    .groupBy(urlOf)
    .all()
  const clicks = new Map(clicked.filter((r) => r.url).map((r) => [r.url!, Number(r.n)]))
  const fixes = new Map((await listLinkFixes(db, broadcastId)).map((f) => [f.fromUrl, f]))

  const current = linksIn({ json: b.bodyJson, md: b.bodyMd })
  const mailed = b.revisedAt ? linksIn({ json: b.originalBodyJson, md: b.originalBodyMd }) : current
  const inBody = new Set(current)
  const ordered = [...new Set([...mailed, ...current, ...clicks.keys(), ...fixes.keys()])]

  return ordered.map((url) => {
    const fix = fixes.get(url)
    return {
      url,
      clicks: clicks.get(url) ?? 0,
      inBody: inBody.has(url),
      fix: fix ? { id: fix.id, toUrl: fix.toUrl } : null,
    }
  })
}

export type FixResult =
  | { ok: true; fromUrl: string; toUrl: string; rewritten: number }
  | { ok: false; reason: string }

/**
 * ⭐ Point one link of a sent broadcast somewhere else. Never sends anything.
 *
 * Three writes, in an order that keeps a failure harmless:
 *   1. The body: every copy of the old link becomes the new one, through
 *      `reviseSentBroadcast`, so the as-mailed copy is kept the first time and
 *      a published post is refreshed. If that refuses (mail still queued), no
 *      redirect is written either, and the operator is told why.
 *   2. The redirect: `(broadcast, old) → new`, replacing any earlier fix.
 *   3. Chains: a link fixed before to the old one now goes to the new one too,
 *      so a second correction reaches readers of the very first copies. A fix
 *      that would now point at itself is removed.
 *
 * Fixing a link that already has a fix re-points it: the body holds the earlier
 * correction by then, so that is what gets replaced.
 */
export async function fixBroadcastLink(
  db: Db,
  broadcastId: number,
  fromRaw: string,
  toRaw: string,
): Promise<FixResult> {
  const b = await getBroadcast(db, broadcastId)
  if (!b) return { ok: false, reason: 'No such broadcast.' }
  // A draft is fixed by editing it. While it is going out, the body is still
  // what the queue mails, and `reviseSentBroadcast` would refuse it anyway.
  if (b.status !== 'sent' && b.status !== 'cancelled') {
    return { ok: false, reason: `This broadcast is ${b.status}. Links can be fixed once it has been sent.` }
  }

  const fromUrl = fromRaw.trim()
  const toUrl = toRaw.trim()
  const problem = fixedLinkProblem(toUrl)
  if (problem) return { ok: false, reason: problem }
  if (fromUrl === toUrl) return { ok: false, reason: 'The corrected link is the same as the old one.' }

  const links = (await broadcastLinks(db, broadcastId))!
  const link = links.find((l) => l.url === fromUrl)
  // Only a link that is in the mail (or was clicked from it) can be redirected:
  // anything else is a row no click will ever read.
  if (!link) return { ok: false, reason: 'That link is not in this broadcast.' }

  const replace = [fromUrl, ...(link.fix ? [link.fix.toUrl] : [])]
  let body = { json: b.bodyJson, md: b.bodyMd }
  let rewritten = 0
  for (const old of replace) {
    const swapped = replaceLink(body, old, toUrl)
    body = { json: swapped.json, md: swapped.md }
    rewritten += swapped.replaced
  }
  if (rewritten > 0) {
    const revised = await reviseSentBroadcast(db, broadcastId, {
      subject: b.subject,
      bodyJson: body.json,
      bodyMd: body.md,
    })
    if (!revised.ok) return { ok: false, reason: `Not fixed: ${revised.reason}.` }
  }

  await db
    .insert(linkFixes)
    .values({ broadcastId, fromUrl, toUrl, createdAt: new Date() })
    .onConflictDoUpdate({ target: [linkFixes.broadcastId, linkFixes.fromUrl], set: { toUrl, createdAt: new Date() } })
  await db
    .update(linkFixes)
    .set({ toUrl })
    .where(and(eq(linkFixes.broadcastId, broadcastId), inArray(linkFixes.toUrl, replace)))
  await db
    .delete(linkFixes)
    .where(and(eq(linkFixes.broadcastId, broadcastId), sql`${linkFixes.fromUrl} = ${linkFixes.toUrl}`))

  return { ok: true, fromUrl, toUrl, rewritten }
}

/**
 * Stop redirecting one link. Clicks from delivered copies go where the link
 * says again. The body keeps the corrected link: putting the broken one back on
 * the web page is never what removing a fix is for, and an edit in the
 * composer can change it to anything.
 */
export async function removeLinkFix(
  db: Db,
  broadcastId: number,
  fixId: number,
): Promise<{ ok: true; fix: LinkFix } | { ok: false; reason: string }> {
  const removed = await db
    .delete(linkFixes)
    .where(and(eq(linkFixes.id, fixId), eq(linkFixes.broadcastId, broadcastId)))
    .returning()
  const fix = removed[0]
  return fix ? { ok: true, fix } : { ok: false, reason: 'That fix is already gone.' }
}

/** `removeLinkFix` by the link it redirects, for callers that know the URL and not the row (MCP). */
export async function removeLinkFixFor(
  db: Db,
  broadcastId: number,
  fromUrl: string,
): Promise<{ ok: true; fix: LinkFix } | { ok: false; reason: string }> {
  const row = await db
    .select({ id: linkFixes.id })
    .from(linkFixes)
    .where(and(eq(linkFixes.broadcastId, broadcastId), eq(linkFixes.fromUrl, fromUrl.trim())))
    .get()
  if (!row) return { ok: false, reason: 'That link has no fix.' }
  return await removeLinkFix(db, broadcastId, row.id)
}
