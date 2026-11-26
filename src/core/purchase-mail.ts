import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import {
  type DocNode,
  type MergeExtras,
  messages,
  purchaseTemplates,
  saleItems,
  sales,
  stripeProducts,
  subscribers,
} from '../db/schema.ts'
import type { Env } from '../types.ts'
import { dispatch } from './sending.ts'
import { escapeHtml, mergeFields } from './text.ts'

/**
 * ⭐ What a buyer is told after they buy.
 *
 * This is the one place that turns "a sale exists" into "a person was thanked".
 * The Stripe webhook deliberately does not call it — a webhook records what
 * happened, and deciding to mail somebody about it is a separate act (CLAUDE.md).
 * Today that act is an operator pressing a button; the shape here is ready for a
 * per-template auto-send flag when that has been watched enough times to trust.
 *
 * Three facts hold this together:
 *
 *  1. **The sku is the key.** A sale arrives as line items carrying a Stripe
 *     product, and `stripe_products.metadata.sku` is the only identifier the
 *     Stripe catalog and the offers already agree on. Nothing here joins
 *     through the `offers` mirror, which is allowed to disagree.
 *  2. **The body is snapshotted onto the message**, never read back from the
 *     template at send time. Editing a template must not rewrite what already
 *     went out (invariant 9).
 *  3. **It is transactional mail.** No unsubscribe footer, no open or click
 *     tracking, and only a hard bounce or a spam complaint can stop it. Somebody
 *     who unsubscribed from the newsletter last year still gets told what they
 *     just bought.
 */

/**
 * Where a buyer manages what they own, from the `ACCOUNT_URL` var. Not the
 * public site and not the admin host: it is wherever the operator's storefront
 * keeps a buyer's dashboard.
 *
 * Null when unset. Then `{{account_url}}` resolves to nothing and the downloads
 * list carries no dashboard line, because a link that goes nowhere is worse than
 * no link.
 */
export function accountUrl(env: Pick<Env, 'ACCOUNT_URL'>): string | null {
  const url = env.ACCOUNT_URL?.trim()
  return url ? url : null
}

/** The template that catches any offer without one of its own. */
export const FALLBACK_SLUG = '*'

// ───────────────────────────────────────────────── templates

export type TemplateRow = typeof purchaseTemplates.$inferSelect

export async function listTemplates(db: Db): Promise<TemplateRow[]> {
  return await db.select().from(purchaseTemplates).orderBy(purchaseTemplates.offerSlug).all()
}

export async function getTemplate(db: Db, id: number): Promise<TemplateRow | undefined> {
  return await db.select().from(purchaseTemplates).where(eq(purchaseTemplates.id, id)).get()
}

export async function getTemplateBySlug(db: Db, slug: string): Promise<TemplateRow | undefined> {
  return await db
    .select()
    .from(purchaseTemplates)
    .where(eq(purchaseTemplates.offerSlug, slug))
    .get()
}

export interface TemplateInput {
  offerSlug: string
  name: string
  subject: string
  bodyJson?: DocNode | null
  bodyMd?: string | null
  discordInviteUrl?: string | null
  isActive?: boolean
}

export async function createTemplate(db: Db, input: TemplateInput): Promise<number | null> {
  const slug = normalizeSlug(input.offerSlug)
  if (!slug || !input.name.trim() || !input.subject.trim()) return null

  const inserted = await db
    .insert(purchaseTemplates)
    .values({
      offerSlug: slug,
      name: input.name.trim(),
      subject: input.subject.trim(),
      bodyJson: input.bodyJson ?? null,
      bodyMd: input.bodyMd ?? null,
      discordInviteUrl: emptyToNull(input.discordInviteUrl),
      isActive: input.isActive ?? true,
      createdAt: new Date(),
    })
    // A second template for one offer is a mistake, not a merge: the unique index
    // says which one wins and silently replacing the operator's existing copy
    // would lose whatever they wrote.
    .onConflictDoNothing()
    .returning({ id: purchaseTemplates.id })

  return inserted[0]?.id ?? null
}

export async function updateTemplate(
  db: Db,
  id: number,
  patch: Partial<TemplateInput>,
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() }
  if (patch.offerSlug !== undefined) set.offerSlug = normalizeSlug(patch.offerSlug)
  if (patch.name !== undefined) set.name = patch.name.trim()
  if (patch.subject !== undefined) set.subject = patch.subject.trim()
  if (patch.bodyJson !== undefined) set.bodyJson = patch.bodyJson
  if (patch.bodyMd !== undefined) set.bodyMd = patch.bodyMd
  if (patch.discordInviteUrl !== undefined) {
    set.discordInviteUrl = emptyToNull(patch.discordInviteUrl)
  }
  if (patch.isActive !== undefined) set.isActive = patch.isActive

  await db.update(purchaseTemplates).set(set).where(eq(purchaseTemplates.id, id))
}

export async function deleteTemplate(db: Db, id: number): Promise<void> {
  await db.delete(purchaseTemplates).where(eq(purchaseTemplates.id, id))
}

/** `'*'` survives; anything else becomes a bare sku. */
function normalizeSlug(raw: string): string {
  const trimmed = raw.trim().toLowerCase()
  if (trimmed === FALLBACK_SLUG) return FALLBACK_SLUG
  return trimmed.replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '')
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

// ───────────────────────────────────────────────── what a sale contained

export interface PurchasedItem {
  sku: string | null
  /** The product name as Stripe knows it, which is what a buyer recognises. */
  title: string
  /** The storage object name from `stripe_products.metadata.file`, when there is one. */
  file: string | null
}

interface ProductMeta {
  sku?: string
  file?: string
}

/**
 * What this sale bought, resolved through the Stripe catalog mirror.
 *
 * Line items are the truth about a basket. A sale with none — a charge from another checkout
 * charge, or a `charge.succeeded` that arrived before its checkout session —
 * falls back to the free-text `sales.product`, which at least names something
 * the buyer will recognise even though no sku can be derived from it.
 */
export async function purchasedItems(db: Db, saleId: number): Promise<PurchasedItem[]> {
  const items = await db
    .select({
      description: saleItems.description,
      productId: saleItems.stripeProductId,
    })
    .from(saleItems)
    .where(eq(saleItems.saleId, saleId))
    .all()

  const productIds = items.flatMap((i) => (i.productId ? [i.productId] : []))
  const products = productIds.length
    ? await db
        .select({
          id: stripeProducts.id,
          name: stripeProducts.name,
          metadata: stripeProducts.metadata,
        })
        .from(stripeProducts)
        .where(inArray(stripeProducts.id, productIds.slice(0, 90)))
        .all()
    : []
  const byId = new Map(products.map((p) => [p.id, p]))

  const out: PurchasedItem[] = []
  for (const item of items) {
    const product = item.productId ? byId.get(item.productId) : undefined
    const meta = (product?.metadata ?? {}) as ProductMeta
    out.push({
      sku: meta.sku ?? null,
      title: product?.name ?? item.description ?? 'your purchase',
      file: meta.file ?? null,
    })
  }

  if (out.length === 0) {
    const sale = await db
      .select({ product: sales.product })
      .from(sales)
      .where(eq(sales.id, saleId))
      .get()
    if (sale?.product) out.push({ sku: null, title: sale.product, file: null })
  }

  return out
}

// ───────────────────────────────────────────────── the merge values

/**
 * A file the buyer is entitled to.
 *
 * `url` is null while fulfillment lives outside this system: Kōlea knows the
 * *names* of the files a purchase grants (they are on the Stripe product) but
 * cannot sign a URL from the operator's file storage, and should not learn how
 * to — fulfillment is a separate concern that will be folded in later. Until
 * then `{{downloads}}` names what they own and points at the dashboard (when
 * `ACCOUNT_URL` is set), and the day a signing source exists this fills in with
 * no template change.
 */
export interface DownloadLink {
  title: string
  url: string | null
}

/**
 * Build the per-message merge values for a sale.
 *
 * Pure apart from the reads: it resolves, it does not send, so the preview and
 * the real send are guaranteed to agree about what the buyer will be told.
 */
export async function purchaseExtras(
  db: Db,
  saleId: number,
  template: TemplateRow | undefined,
  account: string | null,
): Promise<MergeExtras> {
  const items = await purchasedItems(db, saleId)

  const offerName = formatList(items.map((i) => i.title)) || 'your purchase'
  const downloads: DownloadLink[] = items
    .filter((i) => i.file)
    .map((i) => ({ title: i.title, url: null }))

  return {
    offer_name: offerName,
    account_url: account ?? '',
    downloads: renderDownloads(downloads, account),
    discord_url: template?.discordInviteUrl ?? '',
  }
}

/**
 * `{{downloads}}`, in both surfaces.
 *
 * Empty when the purchase grants no files — a cohort seat or a membership is
 * access, not a zip — and an empty string is deliberate: the operator can leave
 * the placeholder in a shared template and it simply disappears for offers that
 * have nothing to hand over.
 */
export function renderDownloads(
  downloads: DownloadLink[],
  account: string | null = null,
): { html: string; text: string } {
  if (downloads.length === 0) return { html: '', text: '' }

  const rows = downloads
    .map((d) => {
      const label = escapeHtml(d.title)
      return d.url
        ? `<li><a href="${escapeHtml(d.url)}">${label}</a></li>`
        : `<li>${label}</li>`
    })
    .join('')

  const lines = downloads.map((d, i) =>
    d.url ? `${i + 1}. ${d.title}\n   ${d.url}` : `${i + 1}. ${d.title}`,
  )

  // Only when there is somewhere to send them. With no dashboard configured the
  // files are still named, so the buyer knows what they own.
  const needsDashboard = account !== null && downloads.some((d) => !d.url)
  const href = account ? escapeHtml(account) : ''
  const note = needsDashboard
    ? `<p>Grab them from your dashboard: <a href="${href}">${href}</a></p>`
    : ''
  const noteText = needsDashboard ? `\nGrab them from your dashboard: ${account}` : ''

  return {
    html: `<ul>${rows}</ul>${note}`,
    text: `${lines.join('\n')}${noteText}`,
  }
}

/**
 * Resolve the merge tags in a subject line.
 *
 * `renderEmail` only ever touches the body, so a subject has always arrived at
 * the provider exactly as it was typed. That is harmless for a broadcast, whose
 * subject is written for one audience, and wrong here: `{{offer_name}}` belongs
 * in a purchase subject more than anywhere else. Resolved at queue time and
 * frozen onto `messages.subject`, so what is recorded is what was sent.
 *
 * The plaintext surface, because a subject is not HTML — `{{downloads}}` in a
 * subject line would be a mistake either way, but it should not emit markup.
 */
function resolveSubject(
  subject: string,
  sub: { email: string; name: string | null },
  extras: MergeExtras,
): string {
  const flat = Object.fromEntries(
    Object.entries(extras).map(([k, v]) => [k, typeof v === 'string' ? v : v.text]),
  )
  return mergeFields(subject, sub, flat)
}

/** "A, B and C" — how a person would say a basket out loud. */
function formatList(names: string[]): string {
  const unique = [...new Set(names.filter(Boolean))]
  if (unique.length === 0) return ''
  if (unique.length === 1) return unique[0]!
  return `${unique.slice(0, -1).join(', ')} and ${unique.at(-1)}`
}

// ───────────────────────────────────────────────── choosing the template

/**
 * The template for a sale: the first sku on it that has an active template of
 * its own, else the active fallback.
 *
 * "First matching wins" rather than "one mail per line item", because a basket
 * is one purchase and one thank-you. A bundle that spans two offers gets the
 * mail for whichever of them was configured — and `{{offer_name}}` still names
 * everything they bought.
 */
export async function templateForSale(
  db: Db,
  saleId: number,
): Promise<{ template: TemplateRow | undefined; matchedSlug: string | null }> {
  const items = await purchasedItems(db, saleId)
  const skus = [...new Set(items.flatMap((i) => (i.sku ? [i.sku] : [])))]

  if (skus.length > 0) {
    const rows = await db
      .select()
      .from(purchaseTemplates)
      .where(
        and(inArray(purchaseTemplates.offerSlug, skus.slice(0, 90)), eq(purchaseTemplates.isActive, true)),
      )
      .all()
    // Walk `skus`, not `rows`, so the winner is decided by basket order rather
    // than by whatever order the database felt like returning.
    for (const sku of skus) {
      const hit = rows.find((r) => r.offerSlug === sku)
      if (hit) return { template: hit, matchedSlug: sku }
    }
  }

  const fallback = await db
    .select()
    .from(purchaseTemplates)
    .where(and(eq(purchaseTemplates.offerSlug, FALLBACK_SLUG), eq(purchaseTemplates.isActive, true)))
    .get()

  return { template: fallback, matchedSlug: fallback ? FALLBACK_SLUG : null }
}

// ───────────────────────────────────────────────── preview and send

export interface PurchaseMailPlan {
  saleId: number
  to: string
  subscriberId: number
  subject: string
  bodyJson: DocNode | null
  bodyMd: string | null
  extras: MergeExtras
  template: TemplateRow
  matchedSlug: string | null
  /** A message already sent for this sale, if there is one. */
  alreadySentMessageId: number | null
}

export type PlanResult = { ok: true; plan: PurchaseMailPlan } | { ok: false; reason: string }

/**
 * Work out exactly what would be sent, without sending it.
 *
 * Every refusal the send can produce is produced here too, so the admin screen
 * and the MCP tool can show the operator the real answer before anything moves.
 */
export async function planPurchaseMail(
  env: Pick<Env, 'ACCOUNT_URL'>,
  db: Db,
  saleId: number,
): Promise<PlanResult> {
  const sale = await db.select().from(sales).where(eq(sales.id, saleId)).get()
  if (!sale) return { ok: false, reason: `There is no sale #${saleId}.` }

  const sub = await db
    .select()
    .from(subscribers)
    .where(eq(subscribers.id, sale.subscriberId))
    .get()
  if (!sub) return { ok: false, reason: 'The sale has no subscriber to send to.' }

  const { template, matchedSlug } = await templateForSale(db, saleId)
  if (!template) {
    return {
      ok: false,
      reason:
        'No active template matches this sale, and there is no active fallback template. Create one keyed to the offer, or a `*` template to catch everything.',
    }
  }

  const extras = await purchaseExtras(db, saleId, template, accountUrl(env))

  const previous = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.saleId, saleId), isNotNull(messages.sentAt)))
    .orderBy(desc(messages.id))
    .get()

  return {
    ok: true,
    plan: {
      saleId,
      to: sub.email,
      subscriberId: sub.id,
      subject: resolveSubject(template.subject, { email: sub.email, name: sub.name }, extras),
      bodyJson: template.bodyJson ?? null,
      bodyMd: template.bodyMd ?? null,
      extras,
      template,
      matchedSlug,
      alreadySentMessageId: previous?.id ?? null,
    },
  }
}

export type SendResult =
  | { ok: true; messageId: number; to: string }
  | { ok: false; reason: string }

/**
 * Queue the purchase mail for a sale.
 *
 * Idempotent on `purchase:<saleId>`: the same order cannot be thanked twice by
 * accident. `resend` is the deliberate override — it mints a distinct key, which
 * is what makes "send it again, the first one bounced" possible without making
 * a double-send the default outcome of a double-click.
 *
 * Consent is *not* checked here. It is checked in `sendMessages`, immediately
 * before the provider call, like every other send in this system (invariant 4).
 */
export async function sendPurchaseMail(
  env: Env,
  db: Db,
  saleId: number,
  opts: { resend?: boolean } = {},
): Promise<SendResult> {
  const planned = await planPurchaseMail(env, db, saleId)
  if (!planned.ok) return planned
  const { plan } = planned

  if (plan.alreadySentMessageId && !opts.resend) {
    return {
      ok: false,
      reason: `Sale #${saleId} was already thanked in message #${plan.alreadySentMessageId}. Pass resend to send it again.`,
    }
  }

  const idempotencyKey = opts.resend
    ? `purchase:${saleId}:resend:${Date.now()}`
    : `purchase:${saleId}`

  const existing = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.idempotencyKey, idempotencyKey))
    .get()
  if (existing) return { ok: false, reason: `Already queued as message #${existing.id}.` }

  const inserted = await db
    .insert(messages)
    .values({
      subscriberId: plan.subscriberId,
      kind: 'transactional',
      saleId,
      toEmail: plan.to,
      subject: plan.subject,
      // Snapshotted, not referenced — invariant 9.
      bodyJson: plan.bodyJson,
      bodyMd: plan.bodyMd,
      extras: plan.extras,
      status: 'queued',
      idempotencyKey,
      createdAt: new Date(),
    })
    .returning({ id: messages.id })

  const messageId = inserted[0]!.id
  await dispatch(env, db, [messageId])
  return { ok: true, messageId, to: plan.to }
}
