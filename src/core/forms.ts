import { asc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { campaigns, formTags, forms, sequences, tags } from '../db/schema.ts'
import { recordTouch } from './campaigns.ts'
import { slugify } from './ids.ts'
import { enroll } from './sequences.ts'
import { upsertSubscriber } from './subscribers.ts'

// ───────────────────────────────────────────────── reading

export async function listForms(db: Db) {
  return await db
    .select({
      form: forms,
      sequenceName: sequences.name,
      sequenceActive: sequences.isActive,
      campaignName: campaigns.name,
    })
    .from(forms)
    .leftJoin(sequences, eq(sequences.id, forms.sequenceId))
    .leftJoin(campaigns, eq(campaigns.id, forms.campaignId))
    .orderBy(asc(forms.name))
    .all()
}

export async function getForm(db: Db, id: number) {
  return await db.select().from(forms).where(eq(forms.id, id)).get()
}

export async function getFormBySlug(db: Db, slug: string) {
  return await db.select().from(forms).where(eq(forms.slug, slug)).get()
}

export async function formTagIds(db: Db, formId: number): Promise<number[]> {
  const rows = await db
    .select({ tagId: formTags.tagId })
    .from(formTags)
    .where(eq(formTags.formId, formId))
    .all()
  return rows.map((r) => r.tagId)
}

export async function formTagList(db: Db, formId: number) {
  return await db
    .select({ id: tags.id, name: tags.name })
    .from(formTags)
    .innerJoin(tags, eq(tags.id, formTags.tagId))
    .where(eq(formTags.formId, formId))
    .orderBy(asc(tags.name))
    .all()
}

// ───────────────────────────────────────────────── writing

async function uniqueSlug(db: Db, name: string, exceptId?: number): Promise<string> {
  const base = slugify(name) || 'form'
  let slug = base
  for (let n = 2; ; n++) {
    const clash = await getFormBySlug(db, slug)
    if (!clash || clash.id === exceptId) return slug
    slug = `${base}-${n}`
  }
}

export interface FormInput {
  name: string
  slug?: string
  sequenceId?: number | null
  campaignId?: number | null
  redirectUrl?: string | null
  successMessage?: string
  isActive?: boolean
  tagIds?: number[]
}

export async function createForm(db: Db, input: FormInput): Promise<number> {
  const inserted = await db
    .insert(forms)
    .values({
      slug: input.slug ? await uniqueSlug(db, input.slug) : await uniqueSlug(db, input.name),
      name: input.name,
      sequenceId: input.sequenceId ?? null,
      campaignId: input.campaignId ?? null,
      redirectUrl: input.redirectUrl ?? null,
      successMessage: input.successMessage || "You're subscribed. Thanks!",
      isActive: input.isActive ?? true,
      createdAt: new Date(),
    })
    .returning({ id: forms.id })

  const id = inserted[0]!.id
  await setFormTags(db, id, input.tagIds ?? [])
  return id
}

export async function updateForm(db: Db, id: number, input: FormInput): Promise<void> {
  await db
    .update(forms)
    .set({
      slug: await uniqueSlug(db, input.slug || input.name, id),
      name: input.name,
      sequenceId: input.sequenceId ?? null,
      campaignId: input.campaignId ?? null,
      redirectUrl: input.redirectUrl ?? null,
      successMessage: input.successMessage || "You're subscribed. Thanks!",
      isActive: input.isActive ?? true,
    })
    .where(eq(forms.id, id))
  await setFormTags(db, id, input.tagIds ?? [])
}

export async function setFormTags(db: Db, formId: number, tagIds: number[]): Promise<void> {
  await db.delete(formTags).where(eq(formTags.formId, formId))
  for (const tagId of tagIds) {
    await db.insert(formTags).values({ formId, tagId }).onConflictDoNothing()
  }
}

export async function deleteForm(db: Db, id: number): Promise<void> {
  await db.delete(forms).where(eq(forms.id, id))
}

// ───────────────────────────────────────────────── submission

export interface SubmitInput {
  email: string
  name?: string | null
  /** Honeypot. Any value at all means a bot filled a field a human can't see. */
  trap?: string | null
}

export type SubmitStatus =
  | 'ok'
  | 'invalid_email'
  | 'unknown_form'
  | 'inactive_form'
  /** A bot tripped the honeypot. Reported as success to the caller, on purpose. */
  | 'trapped'

export interface SubmitResult {
  status: SubmitStatus
  subscriberId?: number
  /** Whether this submission started the form's sequence. */
  enrolled?: boolean
  message: string
  redirectUrl?: string | null
}

/**
 * Handle a public form post: create-or-update the person, tag them, credit the
 * campaign, start the sequence.
 *
 * Every effect here is idempotent, because a form gets double-submitted by
 * impatient people and retried by flaky networks. Tagging skips tags already
 * present, `recordTouch` collapses on its unique index, and `enroll` refuses a
 * second enrollment — so submitting twice is indistinguishable from once.
 */
export async function submitForm(db: Db, slug: string, input: SubmitInput): Promise<SubmitResult> {
  const form = await getFormBySlug(db, slug)
  if (!form) return { status: 'unknown_form', message: 'No such form.' }

  if (input.trap) {
    // Say nothing useful to the bot, and write nothing to the database.
    return { status: 'trapped', message: form.successMessage, redirectUrl: form.redirectUrl }
  }
  if (!form.isActive) {
    return { status: 'inactive_form', message: 'This form is closed.' }
  }

  const { outcome, id } = await upsertSubscriber(db, {
    email: input.email,
    name: input.name ?? null,
    source: `form:${form.slug}`,
    tagIds: await formTagIds(db, form.id),
  })
  if (outcome === 'invalid' || !id) {
    return { status: 'invalid_email', message: 'That email address looks wrong.' }
  }

  if (form.campaignId) {
    await recordTouch(db, {
      subscriberId: id,
      campaignId: form.campaignId,
      sourceKind: 'form',
      sourceId: form.id,
    })
  }

  let enrolled = false
  if (form.sequenceId) {
    const result = await enroll(db, form.sequenceId, id)
    // `already` counts: the caller asked whether this person is now in the
    // sequence, not whether this particular call was the one that put them
    // there. A `subscribe` trigger often gets there a millisecond earlier.
    enrolled = result === 'enrolled' || result === 'already'
  }

  // Counters live in D1 because Workers logs are gone within the week.
  await db
    .update(forms)
    .set({ submitCount: sql`${forms.submitCount} + 1`, lastSubmittedAt: new Date() })
    .where(eq(forms.id, form.id))

  return {
    status: 'ok',
    subscriberId: id,
    enrolled,
    message: form.successMessage,
    redirectUrl: form.redirectUrl,
  }
}
