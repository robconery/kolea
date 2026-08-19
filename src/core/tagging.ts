import { and, asc, count, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import {
  broadcasts,
  messages,
  sequenceSteps,
  sequences,
  subscriberTags,
  tagRules,
  tags,
} from '../db/schema.ts'
import type { ProviderEvent } from '../providers/types.ts'
import { slugify } from './ids.ts'
import { retagDraftBroadcasts, retagSegments } from './segments.ts'
import { addTags, findOrCreateTag } from './subscribers.ts'

// ───────────────────────────────────────────────── auto-tagging

/**
 * Apply every active tag rule that matches an event.
 *
 * Called from `recordEvent`, so it sits on the open-pixel and click-redirect
 * paths — it must stay cheap and it must never throw at the caller (see the
 * guard there). One indexed lookup gets us out early when no rules exist.
 *
 * Tagging goes through `addTags`, which means a rule can start a `tag_added`
 * sequence: click a link → get tagged → get enrolled. That chain is the feature.
 */
export async function applyTagRules(
  db: Db,
  messageId: number,
  type: ProviderEvent['type'],
  meta: Record<string, unknown> = {},
): Promise<number> {
  // 'failed' is a send outcome, not something a person did — never taggable.
  if (type === 'failed') return 0

  const rules = await db
    .select()
    .from(tagRules)
    .where(and(eq(tagRules.isActive, true), eq(tagRules.event, type)))
    .all()
  if (rules.length === 0) return 0

  const msg = await db
    .select({
      subscriberId: messages.subscriberId,
      broadcastId: messages.broadcastId,
      sequenceStepId: messages.sequenceStepId,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get()
  if (!msg) return 0

  // Only pay for this lookup when a sequence-scoped rule is actually in play.
  let sequenceId: number | null = null
  if (msg.sequenceStepId && rules.some((r) => r.sequenceId !== null)) {
    const step = await db
      .select({ sequenceId: sequenceSteps.sequenceId })
      .from(sequenceSteps)
      .where(eq(sequenceSteps.id, msg.sequenceStepId))
      .get()
    sequenceId = step?.sequenceId ?? null
  }

  const url = typeof meta.url === 'string' ? meta.url.toLowerCase() : ''
  let applied = 0

  for (const r of rules) {
    if (r.broadcastId !== null && r.broadcastId !== msg.broadcastId) continue
    if (r.sequenceId !== null && r.sequenceId !== sequenceId) continue
    if (r.urlContains && !url.includes(r.urlContains.toLowerCase())) continue

    const added = await addTags(db, msg.subscriberId, [r.tagId])
    if (added === 0) continue // already tagged — don't inflate the counter

    await db
      .update(tagRules)
      .set({ appliedCount: sql`${tagRules.appliedCount} + 1`, lastAppliedAt: new Date() })
      .where(eq(tagRules.id, r.id))
    applied++
  }

  return applied
}

/** Rules with their tag and scope names resolved, for the rules table. */
export async function listTagRules(db: Db) {
  return await db
    .select({
      rule: tagRules,
      tagName: tags.name,
      broadcastSubject: broadcasts.subject,
      sequenceName: sequences.name,
    })
    .from(tagRules)
    .innerJoin(tags, eq(tags.id, tagRules.tagId))
    .leftJoin(broadcasts, eq(broadcasts.id, tagRules.broadcastId))
    .leftJoin(sequences, eq(sequences.id, tagRules.sequenceId))
    .orderBy(asc(tagRules.id))
    .all()
}

// ───────────────────────────────────────────────── tag housekeeping

/** How many subscribers carry each tag, keyed by tag id. One query. */
export async function tagCounts(db: Db): Promise<Map<number, number>> {
  const rows = await db
    .select({ tagId: subscriberTags.tagId, n: count() })
    .from(subscriberTags)
    .groupBy(subscriberTags.tagId)
    .all()
  return new Map(rows.map((r) => [r.tagId, r.n]))
}

/**
 * What would break if this tag went away.
 *
 * `sequences.trigger_tag_id` cascades on delete — dropping a tag would take the
 * whole sequence with it. So deletion is refused while anything depends on the
 * tag, rather than being quietly destructive.
 */
export async function tagDependents(db: Db, tagId: number): Promise<string[]> {
  const seqs = await db
    .select({ name: sequences.name })
    .from(sequences)
    .where(eq(sequences.triggerTagId, tagId))
    .all()
  const rules = await db
    .select({ name: tagRules.name })
    .from(tagRules)
    .where(eq(tagRules.tagId, tagId))
    .all()

  return [
    ...seqs.map((s) => `sequence “${s.name}”`),
    ...rules.map((r) => `tag rule “${r.name}”`),
  ]
}

export async function deleteTag(db: Db, tagId: number): Promise<{ ok: boolean; reason?: string }> {
  const blockers = await tagDependents(db, tagId)
  if (blockers.length) {
    return { ok: false, reason: `Still used by ${blockers.join(', ')}.` }
  }
  await db.delete(tags).where(eq(tags.id, tagId))
  return { ok: true }
}

/**
 * Fold one tag into another: move the people, repoint everything that referenced
 * it (sequences, rules, saved segments), then drop the empty tag.
 *
 * You will make `Customer` and `customers` within a week of starting. This is
 * the cleanup that doesn't silently break targeting.
 */
export async function mergeTag(
  db: Db,
  fromId: number,
  intoId: number,
): Promise<{ ok: boolean; moved: number; reason?: string }> {
  if (fromId === intoId) return { ok: false, moved: 0, reason: 'Pick two different tags.' }

  const target = await db.select({ id: tags.id }).from(tags).where(eq(tags.id, intoId)).get()
  if (!target) return { ok: false, moved: 0, reason: 'That tag no longer exists.' }

  const before = await db
    .select({ n: count() })
    .from(subscriberTags)
    .where(eq(subscriberTags.tagId, fromId))
    .get()

  // OR IGNORE, because people carrying both tags already have the target row;
  // the delete then clears whatever the update refused to move.
  await db.run(
    sql`update or ignore subscriber_tags set tag_id = ${intoId} where tag_id = ${fromId}`,
  )
  await db.run(sql`delete from subscriber_tags where tag_id = ${fromId}`)

  await db.update(sequences).set({ triggerTagId: intoId }).where(eq(sequences.triggerTagId, fromId))
  await db.update(tagRules).set({ tagId: intoId }).where(eq(tagRules.tagId, fromId))
  await retagSegments(db, fromId, intoId)
  await retagDraftBroadcasts(db, fromId, intoId)

  await db.delete(tags).where(eq(tags.id, fromId))

  return { ok: true, moved: before?.n ?? 0 }
}

/**
 * The slug moves with the name — it's an identifier for humans, not a key
 * anything else stores. Every reference is by id.
 */
export async function renameTag(
  db: Db,
  tagId: number,
  name: string,
): Promise<{ ok: boolean; reason?: string }> {
  const trimmed = name.trim()
  if (!trimmed) return { ok: false, reason: 'a tag needs a name' }

  const tag = await db.select({ id: tags.id }).from(tags).where(eq(tags.id, tagId)).get()
  if (!tag) return { ok: false, reason: 'no such tag' }

  await db.update(tags).set({ name: trimmed, slug: slugify(trimmed) }).where(eq(tags.id, tagId))
  return { ok: true }
}

// ───────────────────────────────────────────────── tag rule authoring

export type TagRuleEvent = 'delivered' | 'open' | 'click' | 'bounce' | 'complaint'

export interface TagRuleInput {
  name: string
  event: TagRuleEvent
  /** The tag to apply. Created if it doesn't exist yet. */
  tagName: string
  /** At most one of these. Both null means "watch every message". */
  broadcastId?: number | null
  sequenceId?: number | null
  /** Click rules only — a URL filter on any other event matches nothing. */
  urlContains?: string | null
}

export async function createTagRule(
  db: Db,
  input: TagRuleInput,
): Promise<{ ok: boolean; reason?: string; ruleId?: number }> {
  const name = input.name.trim()
  const tagName = input.tagName.trim()
  if (!name || !tagName) return { ok: false, reason: 'a rule needs a name and a tag' }
  if (input.broadcastId && input.sequenceId) {
    return { ok: false, reason: 'scope a rule to a broadcast or a sequence, not both' }
  }

  const url = input.urlContains?.trim()
  const inserted = await db
    .insert(tagRules)
    .values({
      name,
      event: input.event,
      broadcastId: input.broadcastId ?? null,
      sequenceId: input.sequenceId ?? null,
      urlContains: input.event === 'click' && url ? url : null,
      tagId: await findOrCreateTag(db, tagName),
      isActive: true,
      createdAt: new Date(),
    })
    .returning({ id: tagRules.id })

  return { ok: true, ruleId: inserted[0]!.id }
}

export async function setTagRuleActive(
  db: Db,
  ruleId: number,
  isActive: boolean,
): Promise<{ ok: boolean; reason?: string }> {
  const rule = await db.select({ id: tagRules.id }).from(tagRules).where(eq(tagRules.id, ruleId)).get()
  if (!rule) return { ok: false, reason: 'no such rule' }

  await db.update(tagRules).set({ isActive }).where(eq(tagRules.id, ruleId))
  return { ok: true }
}

export async function deleteTagRule(
  db: Db,
  ruleId: number,
): Promise<{ ok: boolean; reason?: string }> {
  const rule = await db.select({ id: tagRules.id }).from(tagRules).where(eq(tagRules.id, ruleId)).get()
  if (!rule) return { ok: false, reason: 'no such rule' }

  await db.delete(tagRules).where(eq(tagRules.id, ruleId))
  return { ok: true }
}
