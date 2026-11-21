import { and, asc, count, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import {
  type DocNode,
  campaigns,
  formConfirmations,
  formTags,
  forms,
  messages,
  sequences,
  subscribers,
  tags,
} from '../db/schema.ts'
import type { Env } from '../types.ts'
import { logActivity } from './activity.ts'
import { recordTouch } from './campaigns.ts'
import { grantDownload } from './downloads.ts'
import { isValidEmail, normalizeEmail, randomToken, slugify } from './ids.ts'
import { docIsEmpty } from './render-doc.ts'
import { dispatch } from './sending.ts'
import { enroll } from './sequences.ts'
import { updateFieldValues } from './fields.ts'
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
    // `form` only: a double opt-in confirmation carries the form id too, and a
    // confirmation is not the reply.
    .where(and(eq(messages.formId, formId), eq(messages.kind, 'form'), eq(messages.status, 'sent')))
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

// ───────────────────────────────────────────────── views

/**
 * Things that fetch an image without a person looking at it. Link unfurlers
 * and crawlers render embedded pages too, and every one of them would read as
 * a reader who saw the form and walked away.
 */
export const NOT_A_READER = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|headless/i

/**
 * Count one render of a form. One upsert, no read first.
 *
 * Never throws: this sits behind a pixel on somebody's web page, and a failed
 * counter must never become a broken image. Unknown and closed forms count
 * nothing — a closed form still embedded somewhere isn't being offered.
 */
export async function recordFormView(db: Db, slug: string, userAgent = ''): Promise<void> {
  if (NOT_A_READER.test(userAgent)) return
  try {
    await db.run(sql`
      insert into form_views (form_id, day, views)
      select id, date('now'), 1 from forms where slug = ${slug} and is_active = 1
      on conflict (form_id, day) do update set views = views + 1
    `)
  } catch {
    /* the pixel matters more than the datapoint */
  }
}

export interface FormViewStat {
  id: number
  slug: string
  name: string
  isActive: boolean
  /** Renders inside the window. */
  views: number
  /** Submits inside the window, from the activity log. */
  submits: number
  /**
   * Submits over views, counting only submits on or after the form's first
   * recorded view. Null until there are views to divide by — a form embedded
   * before the pixel existed has submits and no views, and that is not a rate.
   */
  rate: number | null
}

/**
 * Views, submits and the rate between them, per form, over the last `days`.
 * Two grouped queries however many forms exist.
 */
export async function formViewStats(db: Db, days = 30): Promise<FormViewStat[]> {
  const since = new Date(Date.now() - days * 86_400_000)
  const sinceDay = since.toISOString().slice(0, 10)

  const views = (await db.all(sql`
    select f.id, f.slug, f.name, f.is_active,
           coalesce(sum(v.views), 0) as views,
           min(v.day) as first_day
    from forms f
    left join form_views v on v.form_id = f.id and v.day >= ${sinceDay}
    group by f.id
  `)) as {
    id: number
    slug: string
    name: string
    is_active: number
    views: number
    first_day: string | null
  }[]

  // `import` excluded, as everywhere the activity log is counted.
  const submits = (await db.all(sql`
    select cast(json_extract(meta, '$.formId') as integer) as id,
           date(occurred_at / 1000, 'unixepoch') as day,
           count(*) as n
    from activities
    where type = 'form_submitted' and source <> 'import'
      and occurred_at >= ${since.getTime()}
    group by 1, 2
  `)) as { id: number; day: string; n: number }[]

  return views
    .map((f) => {
      const mine = submits.filter((s) => Number(s.id) === f.id)
      const all = mine.reduce((n, s) => n + Number(s.n), 0)
      const tracked = f.first_day
        ? mine.filter((s) => s.day >= (f.first_day as string)).reduce((n, s) => n + Number(s.n), 0)
        : 0
      const v = Number(f.views)
      return {
        id: f.id,
        slug: f.slug,
        name: f.name,
        isActive: !!f.is_active,
        views: v,
        submits: all,
        rate: v ? tracked / v : null,
      }
    })
    .sort((a, b) => b.views - a.views || b.submits - a.submits)
}

/** Views per day for one form, oldest first. Feeds the form's own page. */
export async function formViewsByDay(
  db: Db,
  formId: number,
  days = 30,
): Promise<{ day: string; views: number }[]> {
  const sinceDay = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  const rows = (await db.all(sql`
    select day, views from form_views
    where form_id = ${formId} and day >= ${sinceDay}
    order by day
  `)) as { day: string; views: number }[]
  return rows.map((r) => ({ day: r.day, views: Number(r.views) }))
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
  /**
   * New forms default to on (Kōlea's default). On update, leaving it out keeps
   * what the form has: switching confirmation off is never a side effect of
   * saving some other field.
   */
  doubleOptIn?: boolean
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
      doubleOptIn: input.doubleOptIn ?? true,
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
      ...(input.doubleOptIn === undefined ? {} : { doubleOptIn: input.doubleOptIn }),
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
  /**
   * Everything else the form posted. Only keys that name a custom field are
   * kept (allowlisted by definition); unknown keys are ignored, values that
   * don't fit their type are dropped, and a blank never clears a stored value —
   * a signup should not fail, or erase anything, over an optional extra.
   */
  fields?: Record<string, unknown>
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
  /**
   * A double opt-in form: nothing has happened yet but the confirmation mail.
   * Tags, the sequence and the reply all wait for the click.
   */
  pending?: boolean
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

  if (form.doubleOptIn) return await submitPending(env, db, form, input)

  const { outcome, id } = await upsertSubscriber(db, {
    email: input.email,
    name: input.name ?? null,
    source: `form:${form.slug}`,
    tagIds: await formTagIds(db, form.id),
  })
  if (outcome === 'invalid' || !id) {
    return { status: 'invalid_email', message: 'That email address looks wrong.' }
  }

  if (input.fields && Object.keys(input.fields).length) {
    await updateFieldValues(db, id, input.fields, { unknown: 'ignore', blank: 'ignore' })
  }

  // ⭐ "How they got in", recorded against the form itself rather than inferred
  // from `subscribers.source`, which is a single overwritable text column and
  // says nothing about the second time somebody used a different form.
  //
  // Not deduped: a form gets double-submitted, and unlike the touch it collapses
  // into, each submission is a real thing that happened. The upsert above is
  // what keeps the *person* from being created twice.
  await logActivity(db, {
    type: 'form_submitted',
    subscriberId: id,
    campaignId: form.campaignId,
    sequenceId: form.sequenceId,
    meta: { formId: form.id, formSlug: form.slug, formName: form.name, outcome },
  })

  const { enrolled, delivered } = await joinThrough(env, db, form, {
    id,
    email: normalizeEmail(input.email),
  })
  await countSubmit(db, form.id)

  return {
    status: 'ok',
    subscriberId: id,
    enrolled,
    delivered,
    message: form.successMessage,
    redirectUrl: form.redirectUrl,
  }
}

/**
 * What a signup sets going once the person is on the list with their tags:
 * the campaign touch, the form's sequence, the reply. Shared by the single
 * opt-in submit and the double opt-in click, so the two can never drift.
 */
async function joinThrough(
  env: Env,
  db: Db,
  form: typeof forms.$inferSelect,
  subscriber: { id: number; email: string },
): Promise<{ enrolled: boolean; delivered: boolean }> {
  if (form.campaignId) {
    await recordTouch(db, {
      subscriberId: subscriber.id,
      campaignId: form.campaignId,
      sourceKind: 'form',
      sourceId: form.id,
    })
  }

  let enrolled = false
  if (form.sequenceId) {
    const result = await enroll(db, form.sequenceId, subscriber.id)
    // `already` counts: the caller asked whether this person is now in the
    // sequence, not whether this particular call was the one that put them
    // there. A `subscribe` trigger often gets there a millisecond earlier.
    enrolled = result === 'enrolled' || result === 'already'
  }

  // Fulfillment last, and only after the person exists: everything above is a
  // database write we can repeat, and this is the one step that leaves the
  // building.
  const delivery = await deliver(env, db, form, subscriber)
  return { enrolled, delivered: delivery === 'queued' }
}

/** Counters live in D1 because Workers logs are gone within the week. */
async function countSubmit(db: Db, formId: number): Promise<void> {
  await db
    .update(forms)
    .set({ submitCount: sql`${forms.submitCount} + 1`, lastSubmittedAt: new Date() })
    .where(eq(forms.id, formId))
}

// ───────────────────────────────────────────────── double opt-in

/** How long a confirmation link works. Kōlea's number. */
export const CONFIRM_TTL_MS = 7 * 86_400_000
/** No second confirmation to one address inside this gap, whichever form asked. */
export const CONFIRM_MIN_GAP_MS = 10 * 60_000
/** And no more than this many in any 24 hours. Kōlea's mail-bomb cap. */
export const CONFIRM_MAX_PER_DAY = 3

/** What the browser is told after a double opt-in submit. */
export const CONFIRM_PROMPT = 'Almost done. Check your inbox for a link to confirm your subscription.'

export function confirmPath(slug: string, token: string): string {
  return `/f/${encodeURIComponent(slug)}/confirm/${token}`
}

export type ConfirmationMail =
  /** A confirmation was queued. It may still be refused at send time (suppressed). */
  | 'queued'
  /** One went to this address too recently. The open link in it still works. */
  | 'throttled'

/**
 * ⭐ A submit to a double opt-in form.
 *
 * The person is created `pending` if they are new and left exactly as they are
 * if not: an `active` subscriber is never downgraded, an `unsubscribed` one is
 * never promoted, a buyer on file stays a buyer on file. Nothing that can start
 * mail runs (no tags, so no `tag_added` sequence; no subscribe sequences; no
 * form sequence; no reply), because the submitter has not yet proved the
 * address is theirs. One confirmation mail goes out, throttled per address.
 */
async function submitPending(
  env: Env,
  db: Db,
  form: typeof forms.$inferSelect,
  input: SubmitInput,
): Promise<SubmitResult> {
  const email = normalizeEmail(input.email)
  if (!isValidEmail(email)) {
    return { status: 'invalid_email', message: 'That email address looks wrong.' }
  }

  let person = await db
    .select({ id: subscribers.id })
    .from(subscribers)
    .where(eq(subscribers.email, email))
    .get()
  let outcome: 'created' | 'existing' = 'existing'
  if (!person) {
    // `pending`, so no welcome series, no broadcast, nothing until the click.
    // No tags here either: a tag can start a `tag_added` sequence.
    const created = await upsertSubscriber(db, {
      email,
      name: input.name ?? null,
      source: `form:${form.slug}`,
      status: 'pending',
      triggerSubscribeSequences: false,
    })
    if (!created.id) return { status: 'invalid_email', message: 'That email address looks wrong.' }
    person = { id: created.id }
    outcome = 'created'
    // Field values ride along on a NEW pending person only. On someone already
    // on the list they wait like everything else: a stranger can type any
    // address, and must not be able to rewrite another person's data.
    if (input.fields && Object.keys(input.fields).length) {
      await updateFieldValues(db, created.id, input.fields, { unknown: 'ignore', blank: 'ignore' })
    }
  }

  const mail = await requestConfirmation(env, db, form, { id: person.id, email })

  await logActivity(db, {
    type: 'form_submitted',
    subscriberId: person.id,
    campaignId: form.campaignId,
    sequenceId: form.sequenceId,
    meta: {
      formId: form.id,
      formSlug: form.slug,
      formName: form.name,
      outcome,
      doubleOptIn: true,
      confirmation: mail,
    },
  })
  await countSubmit(db, form.id)

  return {
    status: 'ok',
    subscriberId: person.id,
    pending: true,
    enrolled: false,
    delivered: false,
    message: CONFIRM_PROMPT,
    redirectUrl: form.redirectUrl,
  }
}

/**
 * Open (or reuse) this person's confirmation for this form, and mail the link
 * unless one went to the address too recently.
 *
 * The mail is a `messages` row of kind `confirmation`, sent down the ordinary
 * path, so the consent check happens immediately before the provider call and
 * a suppressed address ends as a visible `suppressed` row, never a send.
 */
async function requestConfirmation(
  env: Env,
  db: Db,
  form: typeof forms.$inferSelect,
  subscriber: { id: number; email: string },
): Promise<ConfirmationMail> {
  const now = Date.now()

  // Reuse an open one, so every copy of the mail carries a link that works.
  let open = await db
    .select({ id: formConfirmations.id, token: formConfirmations.token })
    .from(formConfirmations)
    .where(
      and(
        eq(formConfirmations.formId, form.id),
        eq(formConfirmations.subscriberId, subscriber.id),
        eq(formConfirmations.status, 'pending'),
        sql`${formConfirmations.expiresAt} > ${now}`,
      ),
    )
    .orderBy(sql`${formConfirmations.id} desc`)
    .get()
  if (!open) {
    const inserted = await db
      .insert(formConfirmations)
      .values({
        formId: form.id,
        subscriberId: subscriber.id,
        token: randomToken(),
        status: 'pending',
        createdAt: new Date(now),
        expiresAt: new Date(now + CONFIRM_TTL_MS),
      })
      .returning({ id: formConfirmations.id, token: formConfirmations.token })
    open = inserted[0]!
  }

  // ⭐ The mail-bomb throttle. Counted from `messages`, which records every
  // confirmation whatever became of it, so a suppressed one counts too.
  const recent = (await db.all(sql`
    select count(*) as n, max(created_at) as last
    from messages
    where subscriber_id = ${subscriber.id} and kind = 'confirmation'
      and created_at > ${now - 86_400_000}
  `)) as { n: number; last: number | null }[]
  const n = Number(recent[0]?.n ?? 0)
  const last = recent[0]?.last == null ? null : Number(recent[0].last)
  if (n >= CONFIRM_MAX_PER_DAY || (last !== null && now - last < CONFIRM_MIN_GAP_MS)) {
    return 'throttled'
  }

  const url = `${env.PUBLIC_URL}${confirmPath(form.slug, open.token)}`
  const who = env.FROM_NAME || 'this list'
  let messageId: number
  try {
    const inserted = await db
      .insert(messages)
      .values({
        subscriberId: subscriber.id,
        kind: 'confirmation',
        // Provenance only. `formDeliveryCount` and the grant lookup both read
        // kind `form`, so this never counts as, or renders like, the reply.
        formId: form.id,
        toEmail: subscriber.email,
        subject: `Confirm your subscription to ${who}`,
        bodyJson: confirmationDoc(who, form.name, url),
        bodyMd: confirmationText(who, form.name, url),
        status: 'queued',
        idempotencyKey: `confirm:${open.id}:${now}`,
        createdAt: new Date(now),
      })
      .returning({ id: messages.id })
    messageId = inserted[0]!.id
  } catch {
    // Two submits in the same millisecond: the other one is sending it.
    return 'throttled'
  }

  try {
    await dispatch(env, db, [messageId])
  } catch {
    // Same reasoning as the reply: the row exists and `health` reports anything
    // left `queued`. Losing the signup over a queue hiccup is the worse outcome.
  }
  return 'queued'
}

function paragraph(text: string): DocNode {
  return { type: 'paragraph', content: [{ type: 'text', text }] }
}

function confirmationDoc(who: string, formName: string, url: string): DocNode {
  return {
    type: 'doc',
    content: [
      paragraph(`Please confirm you asked to hear from ${who}.`),
      paragraph(`Someone, hopefully you, signed up with this address through “${formName}”.`),
      {
        type: 'emailButton',
        attrs: { href: url, align: 'left' },
        content: [{ type: 'text', text: 'Yes, subscribe me' }],
      },
      paragraph("If it wasn't you, ignore this email. You won't hear from us again."),
    ],
  }
}

function confirmationText(who: string, formName: string, url: string): string {
  return [
    `Please confirm you asked to hear from ${who}.`,
    `Someone, hopefully you, signed up with this address through “${formName}”.`,
    `[Yes, subscribe me](${url})`,
    "If it wasn't you, ignore this email. You won't hear from us again.",
  ].join('\n\n')
}

export type ConfirmationState = 'pending' | 'confirmed' | 'expired' | 'unknown'

async function findConfirmation(db: Db, slug: string, token: string) {
  if (!/^[a-z0-9]{16,64}$/.test(token)) return undefined
  return await db
    .select({ confirmation: formConfirmations, form: forms })
    .from(formConfirmations)
    .innerJoin(forms, eq(forms.id, formConfirmations.formId))
    .where(and(eq(formConfirmations.token, token), eq(forms.slug, slug)))
    .get()
}

function stateOf(c: typeof formConfirmations.$inferSelect, now: number): ConfirmationState {
  if (c.status === 'confirmed') return 'confirmed'
  return c.expiresAt.getTime() <= now ? 'expired' : 'pending'
}

/**
 * What the link's page shows before the click. Read-only on purpose: mail
 * scanners fetch every link in a message, so the GET must change nothing and
 * only the button on the page (a POST) confirms.
 */
export async function lookupConfirmation(
  db: Db,
  slug: string,
  token: string,
): Promise<{ state: ConfirmationState; formName?: string }> {
  const row = await findConfirmation(db, slug, token)
  if (!row) return { state: 'unknown' }
  return { state: stateOf(row.confirmation, Date.now()), formName: row.form.name }
}

export interface ConfirmResult {
  /** `already` is a second click on a link that worked the first time. */
  status: 'confirmed' | 'already' | 'expired' | 'unknown'
  subscriberId?: number
  /** The person's status afterwards. `unsubscribed` stays `unsubscribed`. */
  subscriberStatus?: string
  /** For the "you're still off the newsletter" line on the page. */
  unsubToken?: string
  enrolled?: boolean
  delivered?: boolean
  message?: string
  redirectUrl?: string | null
}

/**
 * ⭐ The click. Runs what a single opt-in submit runs, now that the person has
 * shown the address is theirs: `pending` becomes `active` with `confirmed_at`
 * (and the subscribe sequences fire, through `upsertSubscriber`'s promotion,
 * the one place that rule lives), the form's tags land, then the campaign
 * touch, the form's sequence and the reply.
 *
 * Only `pending` is promoted. Somebody `unsubscribed` who clicks gets the
 * form's tags, sequence and file, because they asked for those, and stays off
 * the newsletter: only the preference center returns somebody who left, which
 * is Kōlea's rule (and the page links them there).
 *
 * Idempotent: the row is claimed with a conditional update, so a double click
 * runs the effects once.
 */
export async function confirmSignup(
  env: Env,
  db: Db,
  slug: string,
  token: string,
): Promise<ConfirmResult> {
  const row = await findConfirmation(db, slug, token)
  if (!row) return { status: 'unknown' }
  const { confirmation, form } = row
  const now = Date.now()

  const state = stateOf(confirmation, now)
  if (state === 'expired') return { status: 'expired' }

  const claimed =
    state === 'pending'
      ? await db
          .update(formConfirmations)
          .set({ status: 'confirmed', confirmedAt: new Date(now) })
          .where(and(eq(formConfirmations.id, confirmation.id), eq(formConfirmations.status, 'pending')))
          .returning({ id: formConfirmations.id })
      : []

  const person = await db
    .select()
    .from(subscribers)
    .where(eq(subscribers.id, confirmation.subscriberId))
    .get()
  if (!person) return { status: 'unknown' }

  if (claimed.length === 0) {
    return {
      status: 'already',
      subscriberId: person.id,
      subscriberStatus: person.status,
      unsubToken: person.unsubToken,
      message: form.successMessage,
      redirectUrl: form.redirectUrl,
    }
  }

  // Asking for `active` promotes `pending` and nothing else (SPEC 1.2), adds
  // the form's tags, and fires the subscribe sequences only on that promotion.
  await upsertSubscriber(db, {
    email: person.email,
    source: `form:${form.slug}`,
    tagIds: await formTagIds(db, form.id),
    status: 'active',
  })
  await db
    .update(subscribers)
    .set({ confirmedAt: new Date(now) })
    .where(
      and(
        eq(subscribers.id, person.id),
        eq(subscribers.status, 'active'),
        sql`${subscribers.confirmedAt} is null`,
      ),
    )

  const { enrolled, delivered } = await joinThrough(env, db, form, {
    id: person.id,
    email: person.email,
  })

  const after = await db
    .select({ status: subscribers.status })
    .from(subscribers)
    .where(eq(subscribers.id, person.id))
    .get()

  return {
    status: 'confirmed',
    subscriberId: person.id,
    subscriberStatus: after?.status ?? person.status,
    unsubToken: person.unsubToken,
    enrolled,
    delivered,
    message: form.successMessage,
    redirectUrl: form.redirectUrl,
  }
}
