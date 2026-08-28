import { and, asc, count, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { type DocNode, campaigns, formTags, forms, messages, sequences, tags } from '../db/schema.ts'
import type { Env } from '../types.ts'
import { recordTouch } from './campaigns.ts'
import { grantDownload } from './downloads.ts'
import { normalizeEmail, slugify } from './ids.ts'
import { docIsEmpty } from './render-doc.ts'
import { dispatch } from './sending.ts'
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

/** How much delivery mail this form has actually put on the wire. */
export async function formDeliveryCount(db: Db, formId: number): Promise<number> {
  const row = await db
    .select({ n: count() })
    .from(messages)
    .where(and(eq(messages.formId, formId), eq(messages.status, 'sent')))
    .get()
  return row?.n ?? 0
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
  // ── The reply and its file are NOT here. They are written only by
  // `setFormReply` and the upload endpoint, so saving a form's settings can
  // never silently change — or erase — what lands in somebody's inbox.
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

/**
 * The reply, written on its own.
 *
 * Separate from `updateForm` because it is the one part of a form that puts mail
 * on the wire: saving the settings must never be able to quietly change, or
 * quietly erase, what gets sent.
 */
export interface ReplyInput {
  /** Empty turns the reply off. That check is the whole on/off switch. */
  subject: string | null
  bodyJson: DocNode | null
  bodyMd: string
}

export async function setFormReply(db: Db, id: number, input: ReplyInput): Promise<void> {
  await db
    .update(forms)
    .set({
      deliverySubject: input.subject?.trim() || null,
      deliveryBodyJson: input.bodyJson,
      deliveryBodyMd: input.bodyMd,
    })
    .where(eq(forms.id, id))
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
  /** Whether the reply — the one carrying the file — was queued by this submission. */
  delivered?: boolean
  message: string
  redirectUrl?: string | null
}

export type DeliveryOutcome =
  /** The form has no reply configured. Most forms. */
  | 'none'
  /** A subject with nothing under it. Refused rather than sending a blank email. */
  | 'no_body'
  | 'queued'
  /** This address already got it today. See the idempotency key below. */
  | 'already'

/**
 * ⭐ Hand over the lead magnet, now.
 *
 * Deliberately *not* step 1 of a sequence. A sequence step waits for the minutely
 * tick, is silently swallowed while the sequence is paused, and is refused for
 * anyone holding a `sequence_optouts` row for that series — three ways for
 * somebody who just asked for a file to get nothing. This goes out inside the
 * submit request, under the transactional consent rule, so an unsubscribed
 * reader still receives what they asked for. `forms.sequence_id` still handles
 * whatever nurture follows.
 *
 * ⚠️ `/f/:slug` is public, unauthenticated and CORS-open, so this is the one
 * place in Kōlea where a stranger's HTTP request causes mail to be sent. The
 * idempotency key is dated on purpose: at most one delivery per address per form
 * per day. That caps what a bot can do with the endpoint to a single message,
 * while still letting somebody who genuinely lost the mail re-submit tomorrow.
 */
async function deliver(
  env: Env,
  db: Db,
  form: typeof forms.$inferSelect,
  subscriber: { id: number; email: string },
): Promise<DeliveryOutcome> {
  const subject = form.deliverySubject?.trim()
  if (!subject) return 'none'

  const json = form.deliveryBodyJson
  const md = form.deliveryBodyMd ?? ''
  const hasBody = (json && !docIsEmpty(json)) || md.trim().length > 0
  if (!hasBody) return 'no_body'

  // The link is per person, so it has to exist before the mail is rendered.
  if (form.downloadKey) await grantDownload(db, form.id, subscriber.id)

  const idempotencyKey = `form:${form.id}:${subscriber.id}:${new Date().toISOString().slice(0, 10)}`
  const already = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.idempotencyKey, idempotencyKey))
    .get()
  if (already) return 'already'

  let messageId: number
  try {
    const inserted = await db
      .insert(messages)
      .values({
        subscriberId: subscriber.id,
        kind: 'form',
        formId: form.id,
        toEmail: subscriber.email,
        subject,
        // Snapshotted, not referenced: the form is a template the operator keeps
        // editing, and what went out has to stay what went out (invariant 9).
        bodyJson: json ?? null,
        bodyMd: md,
        status: 'queued',
        idempotencyKey,
        createdAt: new Date(),
      })
      .returning({ id: messages.id })
    messageId = inserted[0]!.id
  } catch {
    // Lost the race with a double-click: the unique index on `idempotency_key`
    // caught the second insert, which is the index doing its job. Somebody
    // impatient must not get a 500 from a form that worked.
    return 'already'
  }

  try {
    await dispatch(env, db, [messageId])
  } catch {
    // A queue that refuses the job must not fail the submission: the person is
    // saved, the message row exists, and `health` reports anything left sitting
    // in `queued`. Losing the mail is recoverable; losing the signup is not.
  }
  return 'queued'
}

/**
 * Handle a public form post: create-or-update the person, tag them, credit the
 * campaign, start the sequence.
 *
 * Every effect here is idempotent, because a form gets double-submitted by
 * impatient people and retried by flaky networks. Tagging skips tags already
 * present, `recordTouch` collapses on its unique index, `enroll` refuses a
 * second enrollment, and the delivery mail is keyed by form+person+day — so
 * submitting twice is indistinguishable from once.
 */
export async function submitForm(
  env: Env,
  db: Db,
  slug: string,
  input: SubmitInput,
): Promise<SubmitResult> {
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

  // Fulfillment last, and only after the person exists: everything above is a
  // database write we can repeat, and this is the one step that leaves the
  // building.
  const delivery = await deliver(env, db, form, { id, email: normalizeEmail(input.email) })

  // Counters live in D1 because Workers logs are gone within the week.
  await db
    .update(forms)
    .set({ submitCount: sql`${forms.submitCount} + 1`, lastSubmittedAt: new Date() })
    .where(eq(forms.id, form.id))

  return {
    status: 'ok',
    subscriberId: id,
    enrolled,
    delivered: delivery === 'queued',
    message: form.successMessage,
    redirectUrl: form.redirectUrl,
  }
}
