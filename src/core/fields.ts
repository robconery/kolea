/**
 * Custom fields: named, typed values a subscriber carries.
 *
 * Definitions live in `custom_fields`; values live in `subscribers.attributes`,
 * keyed by the definition's `key` (see the schema comment for why not a values
 * table). This module is the only thing that writes values, and every write is
 * cast against a definition first, so the blob only ever holds keys a row names
 * and values of the type that row says.
 *
 * The casting rules are pure and live at the top; the database work is below.
 */
import { asc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import {
  type CustomField,
  FIELD_OPS,
  FIELD_TYPES,
  type FieldCondition,
  type FieldOp,
  type FieldType,
  type SegmentRule,
  broadcasts,
  customFields,
  segments,
  subscribers,
} from '../db/schema.ts'

export { FIELD_OPS, FIELD_TYPES }
export type { CustomField, FieldCondition, FieldOp, FieldType }

/** A key is the merge tag, the CSV header and the JSON path. Nothing else gets in. */
export const FIELD_KEY = /^[a-z][a-z0-9_]{0,62}$/

/**
 * Keys a field may not take, because something already answers to them: the
 * built-in merge tags, the per-message extras (`{{link}}`, `{{downloads}}`…),
 * the CSV columns import reads itself, and the fields a form post carries.
 * A field called `email` would be a merge tag that can never resolve to it.
 */
export const RESERVED_FIELD_KEYS: ReadonlySet<string> = new Set([
  'email',
  'name',
  'first_name',
  'tags',
  'status',
  'source',
  'link',
  'downloads',
  'offer_name',
  'account_url',
  'discord_url',
  'preference_url',
  'unsubscribe_url',
])

/** Longest text value kept. A field is a fact about a person, not a document. */
const MAX_TEXT = 1000

export type FieldValue = string | number | boolean

/** Which operators make sense for which type. The type is the definition's, never input's. */
const OPS_BY_TYPE: Record<FieldType, readonly FieldOp[]> = {
  text: ['equals', 'not_equals', 'contains', 'is_set', 'is_not_set'],
  number: ['equals', 'not_equals', 'greater_than', 'less_than', 'is_set', 'is_not_set'],
  date: ['equals', 'not_equals', 'greater_than', 'less_than', 'is_set', 'is_not_set'],
  boolean: ['equals', 'is_set', 'is_not_set'],
}

export function opsFor(type: FieldType): readonly FieldOp[] {
  return OPS_BY_TYPE[type]
}

export function takesValue(op: FieldOp): boolean {
  return op !== 'is_set' && op !== 'is_not_set'
}

/** How an operator reads, for a given type. "after" for a date, "over" for a number. */
export function opLabel(op: FieldOp, type?: FieldType): string {
  switch (op) {
    case 'equals':
      return 'is'
    case 'not_equals':
      return 'is not'
    case 'contains':
      return 'contains'
    case 'greater_than':
      return type === 'date' ? 'is after' : type === 'number' ? 'is over' : 'is after / over'
    case 'less_than':
      return type === 'date' ? 'is before' : type === 'number' ? 'is under' : 'is before / under'
    case 'is_set':
      return 'is set'
    case 'is_not_set':
      return 'is not set'
  }
}

/** `"Signup Plan"` → `signup_plan`. Also how a CSV header finds its field. */
export function keyFor(label: string): string {
  const key = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 63)
  return /^[a-z]/.test(key) ? key : `f_${key}`.slice(0, 63)
}

export type CastResult = { ok: true; value: FieldValue | null } | { ok: false; error: string }

/**
 * One raw value cast to `type`. `null` means blank — the caller decides whether
 * blank removes the value (the subscriber screen) or leaves it alone (an import).
 */
export function castFieldValue(type: FieldType, raw: unknown): CastResult {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (type === 'number' && typeof raw === 'number') {
    return Number.isFinite(raw) ? { ok: true, value: raw } : { ok: false, error: 'is not a number' }
  }
  if (type === 'boolean' && typeof raw === 'boolean') return { ok: true, value: raw }
  if (typeof raw === 'object') return { ok: false, error: 'is not a single value' }

  const text = String(raw).trim()
  if (text === '') return { ok: true, value: null }

  switch (type) {
    case 'text':
      return text.length <= MAX_TEXT
        ? { ok: true, value: text }
        : { ok: false, error: `is longer than ${MAX_TEXT} characters` }
    case 'number': {
      // `Number('')` is 0 and `Number('0x10')` is 16; neither is what anybody typed.
      if (!/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) {
        return { ok: false, error: 'is not a number' }
      }
      const n = Number(text)
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: 'is not a number' }
    }
    case 'boolean': {
      const t = text.toLowerCase()
      if (['true', 'yes', 'y', '1', 'on'].includes(t)) return { ok: true, value: true }
      if (['false', 'no', 'n', '0', 'off'].includes(t)) return { ok: true, value: false }
      return { ok: false, error: 'is not yes or no' }
    }
    case 'date': {
      const day = text.slice(0, 10)
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
      if (!m) return { ok: false, error: 'is not a date (YYYY-MM-DD)' }
      const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
      // `Date` happily rolls 2026-02-31 into March. A date that moved is not a date.
      if (d.toISOString().slice(0, 10) !== day) {
        return { ok: false, error: 'is not a date (YYYY-MM-DD)' }
      }
      return { ok: true, value: day }
    }
  }
}

/** key → value to write, or `null` to remove it. */
export type FieldChanges = Record<string, FieldValue | null>

export interface CastOptions {
  /** `remove` (default): a blank value clears the field. `ignore`: a blank leaves it alone. */
  blank?: 'remove' | 'ignore'
  /** `error` (default): a key no field defines is an error. `ignore`: it is dropped. */
  unknown?: 'error' | 'ignore'
}

/**
 * Cast a bag of raw values against the field definitions. Returns what can be
 * written and one message per key that couldn't — the caller decides whether a
 * partial result is acceptable (a form signup: yes; an agent's call: no).
 */
export function castFieldValues(
  fields: ReadonlyMap<string, FieldType>,
  values: Record<string, unknown>,
  options: CastOptions = {},
): { changes: FieldChanges; errors: Record<string, string> } {
  const changes: FieldChanges = {}
  const errors: Record<string, string> = {}
  for (const [rawKey, raw] of Object.entries(values)) {
    const key = rawKey.trim().toLowerCase()
    const type = fields.get(key)
    if (!type) {
      if (options.unknown !== 'ignore') errors[rawKey] = 'is not a custom field'
      continue
    }
    const cast = castFieldValue(type, raw)
    if (!cast.ok) {
      errors[key] = cast.error
      continue
    }
    if (cast.value === null && options.blank === 'ignore') continue
    changes[key] = cast.value
  }
  return { changes, errors }
}

/** A stored value as a person reads it — in a merge tag, on a screen. */
export function displayFieldValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value === true) return 'Yes'
  if (value === false) return 'No'
  if (typeof value === 'object') return ''
  return String(value)
}

// ───────────────────────────────────────────────── segment conditions (pure)

export interface RawCondition {
  key: string
  op: string
  value?: unknown
}

/**
 * Validate segment conditions against the definitions: the key must be a
 * field, the op must suit its type, and the value must cast. The type is
 * copied from the definition, never from input.
 */
export function validateConditions(
  fields: ReadonlyMap<string, FieldType>,
  raw: RawCondition[],
): { ok: true; conditions: FieldCondition[] } | { ok: false; errors: string[] } {
  const conditions: FieldCondition[] = []
  const errors: string[] = []

  for (const r of raw) {
    const key = String(r.key ?? '').trim().toLowerCase()
    const type = fields.get(key)
    if (!type) {
      errors.push(`"${key}" is not a custom field`)
      continue
    }
    const op = String(r.op ?? '') as FieldOp
    if (!(FIELD_OPS as readonly string[]).includes(op) || !OPS_BY_TYPE[type].includes(op)) {
      errors.push(`"${opLabel(op, type) || op}" does not apply to ${key}, a ${type} field`)
      continue
    }
    if (!takesValue(op)) {
      conditions.push({ key, type, op })
      continue
    }
    // `contains` is a text search, whatever else the field is.
    const cast = op === 'contains' ? castFieldValue('text', r.value) : castFieldValue(type, r.value)
    if (!cast.ok) {
      errors.push(`${key}: the value ${cast.error}`)
      continue
    }
    if (cast.value === null) {
      errors.push(`${key}: "${opLabel(op, type)}" needs a value`)
      continue
    }
    conditions.push({ key, type, op, value: cast.value })
  }

  return errors.length ? { ok: false, errors } : { ok: true, conditions }
}

export function describeCondition(c: FieldCondition, label?: string): string {
  const name = label ?? c.key
  if (!takesValue(c.op)) return `${name} ${opLabel(c.op, c.type)}`
  const value = typeof c.value === 'string' && c.type !== 'date' ? `“${c.value}”` : displayFieldValue(c.value)
  return `${name} ${opLabel(c.op, c.type)} ${value}`
}

// ───────────────────────────────────────────────── definitions (database)

export async function listFields(db: Db): Promise<CustomField[]> {
  return await db.select().from(customFields).orderBy(asc(customFields.label)).all()
}

/** key → type, for casting. One query. */
export async function fieldTypes(db: Db): Promise<Map<string, FieldType>> {
  const rows = await db
    .select({ key: customFields.key, type: customFields.type })
    .from(customFields)
    .all()
  return new Map(rows.map((r) => [r.key, r.type]))
}

export async function getField(db: Db, id: number): Promise<CustomField | undefined> {
  return await db.select().from(customFields).where(eq(customFields.id, id)).get()
}

export type FieldResult = { ok: true; field: CustomField } | { ok: false; error: string }

export async function createField(
  db: Db,
  input: { label: string; key?: string | null; type?: string | null },
): Promise<FieldResult> {
  const label = input.label.trim()
  if (!label) return { ok: false, error: 'A field needs a name.' }
  if (label.length > 100) return { ok: false, error: 'Keep the name under 100 characters.' }

  const type = (input.type ?? 'text') as FieldType
  if (!(FIELD_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: `"${input.type}" is not a field type.` }
  }

  const key = input.key?.trim() ? input.key.trim().toLowerCase() : keyFor(label)
  if (!FIELD_KEY.test(key)) {
    return { ok: false, error: 'A key starts with a letter and uses only a–z, 0–9 and _.' }
  }
  if (RESERVED_FIELD_KEYS.has(key)) {
    return { ok: false, error: `“${key}” is already a built-in merge tag or column. Pick another key.` }
  }

  const clash = await db.select({ id: customFields.id }).from(customFields).where(eq(customFields.key, key)).get()
  if (clash) return { ok: false, error: `There is already a field called “${key}”.` }

  const [field] = await db
    .insert(customFields)
    .values({ key, label, type, createdAt: new Date() })
    .returning()
  return { ok: true, field: field! }
}

/** Renames the label. The key is fixed for life — rules and merge tags point at it. */
export async function renameField(db: Db, id: number, label: string): Promise<FieldResult> {
  const next = label.trim()
  if (!next) return { ok: false, error: 'A field needs a name.' }
  if (next.length > 100) return { ok: false, error: 'Keep the name under 100 characters.' }
  const [field] = await db.update(customFields).set({ label: next }).where(eq(customFields.id, id)).returning()
  return field ? { ok: true, field } : { ok: false, error: 'No such field.' }
}

/** Who still asks about a key: saved segments, and broadcasts that haven't gone out. */
export async function fieldUsage(
  db: Db,
  key: string,
): Promise<{ segments: string[]; broadcasts: string[] }> {
  const asks = (rule: SegmentRule | null | undefined) =>
    (rule?.conditions ?? []).some((c) => c.key === key)

  const segs = await db.select({ name: segments.name, rule: segments.rule }).from(segments).all()
  const unsent = await db
    .select({ subject: broadcasts.subject, segment: broadcasts.segment })
    .from(broadcasts)
    .where(inArray(broadcasts.status, ['draft', 'scheduled', 'sending']))
    .all()

  return {
    segments: segs.filter((s) => asks(s.rule)).map((s) => s.name),
    broadcasts: unsent.filter((b) => asks(b.segment)).map((b) => b.subject),
  }
}

/**
 * Delete a field and every value of it.
 *
 * ⭐ Refused while a saved segment or an unsent broadcast still tests the key.
 * Stripping the values under a live `is not set` condition would turn a
 * segment of "people without a plan" into everybody, and a scheduled broadcast
 * would mail them all. Sent broadcasts don't count: their rule is history.
 */
export async function deleteField(
  db: Db,
  id: number,
): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  const field = await getField(db, id)
  if (!field) return { ok: false, error: 'No such field.' }

  const usage = await fieldUsage(db, field.key)
  const users = [
    ...usage.segments.map((n) => `segment “${n}”`),
    ...usage.broadcasts.map((n) => `broadcast “${n}”`),
  ]
  if (users.length) {
    return {
      ok: false,
      error: `“${field.label}” is still used by ${users.join(', ')}. Take it out of those first.`,
    }
  }

  // One statement for the whole list. The path is built from a key that passed
  // `FIELD_KEY` when it was created, and bound rather than spliced regardless.
  const path = jsonPath(field.key)
  if (path) {
    await db
      .update(subscribers)
      .set({ attributes: sql`json_remove(${subscribers.attributes}, ${path})` })
      .where(sql`json_type(${subscribers.attributes}, ${path}) is not null`)
  }
  await db.delete(customFields).where(eq(customFields.id, id))
  return { ok: true, key: field.key }
}

/** `$.key` for a key that is safe to be one; null for anything else. */
export function jsonPath(key: string): string | null {
  return FIELD_KEY.test(key) ? `$.${key}` : null
}

// ───────────────────────────────────────────────── values (database)

/**
 * Write already-cast changes to one person: one UPDATE, whatever the count.
 *
 * `json(?)` carries the JSON encoding of each value, so a boolean lands as
 * JSON `true` and a number as a number — binding them raw would store `1` and
 * lose the type a segment compares on.
 *
 * Deliberately not `upsertSubscriber`: setting a field is not a signup and must
 * never be able to fire a sequence (ARCHITECTURE invariant 5).
 */
export async function setFieldValues(
  db: Db,
  subscriberId: number,
  changes: FieldChanges,
): Promise<number> {
  const sets: ReturnType<typeof sql>[] = []
  const removes: ReturnType<typeof sql>[] = []
  for (const [key, value] of Object.entries(changes)) {
    const path = jsonPath(key)
    if (!path) continue
    if (value === null) removes.push(sql`${path}`)
    else sets.push(sql`${path}, json(${JSON.stringify(value)})`)
  }
  if (!sets.length && !removes.length) return 0

  let expr = sql`${subscribers.attributes}`
  if (removes.length) expr = sql`json_remove(${expr}, ${sql.join(removes, sql`, `)})`
  if (sets.length) expr = sql`json_set(${expr}, ${sql.join(sets, sql`, `)})`

  await db.update(subscribers).set({ attributes: expr }).where(eq(subscribers.id, subscriberId))
  return sets.length + removes.length
}

/**
 * Cast raw input against the definitions and write it. The one door for the
 * subscriber screen, the form endpoint and MCP — each picks its own tolerance.
 */
export async function updateFieldValues(
  db: Db,
  subscriberId: number,
  values: Record<string, unknown>,
  options: CastOptions & { types?: ReadonlyMap<string, FieldType> } = {},
): Promise<{ written: number; errors: Record<string, string> }> {
  const types = options.types ?? (await fieldTypes(db))
  const { changes, errors } = castFieldValues(types, values, options)
  const written = await setFieldValues(db, subscriberId, changes)
  return { written, errors }
}

/** One person's fields, defined ones only, in label order — for screens and agents. */
export async function fieldsOf(
  db: Db,
  attributes: Record<string, unknown> | null | undefined,
  defs?: CustomField[],
): Promise<{ key: string; label: string; type: FieldType; value: FieldValue | null }[]> {
  const fields = defs ?? (await listFields(db))
  return fields.map((f) => {
    const v = attributes?.[f.key]
    return {
      key: f.key,
      label: f.label,
      type: f.type,
      value: typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null,
    }
  })
}

/** Field keys only — what the renderer needs to know which `{{tags}}` are fields. */
export async function fieldKeys(db: Db): Promise<string[]> {
  const rows = await db.select({ key: customFields.key }).from(customFields).all()
  return rows.map((r) => r.key)
}

/** Validate raw conditions against the live definitions. */
export async function checkConditions(
  db: Db,
  raw: RawCondition[],
): Promise<{ ok: true; conditions: FieldCondition[] } | { ok: false; errors: string[] }> {
  if (raw.length === 0) return { ok: true, conditions: [] }
  return validateConditions(await fieldTypes(db), raw)
}

