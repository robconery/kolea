import { asc, count, eq, like, or } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import {
  type DocNode,
  type TransactionalTemplate,
  messages,
  subscribers,
  transactionalTemplates,
} from '../db/schema.ts'
import { isValidEmail, normalizeEmail, slugify } from './ids.ts'
import { mdToDoc } from './md-to-doc.ts'
import { docIsEmpty } from './render-doc.ts'
import { mergeFieldValue } from './render.ts'
import { upsertSubscriber } from './subscribers.ts'

/**
 * ⭐ Transactional mail through `POST /api/send` (SPEC 7, Kōlea SPEC 13): one
 * mail to one person, once. The route in `api/routes.ts` is HTTP shape only;
 * every rule is here.
 *
 *  - **A request carries a whole mail or names a stored template.** Either
 *    `subject` + `body`, or `template: "<slug>"` + `variables`. Never both.
 *  - **`{{variables}}` are filled when the request is accepted**, into a copy of
 *    the template's body, and that copy is what goes on the `messages` row
 *    (invariant 9). Editing or deleting the template later changes nothing that
 *    already went out.
 *  - **A caller's value is data, never markup.** It is written into the
 *    document as *text*, and the email renderer escapes every text node and
 *    attribute, so `<script>` arrives in the HTML part as `&lt;script&gt;` and
 *    in the plaintext part as itself. It is never re-expanded either: a value
 *    containing `{{email}}` stays those characters.
 *  - **A missing variable fails the request** with a 422 naming every one, and
 *    nothing is recorded or sent (Kōlea's rule: an unknown `{{field}}` is the
 *    caller's to fix). Rendering it empty would send "Your code is ." to a
 *    customer, which is worse than no mail, and the caller would never know.
 *  - **The recipient is never marketed to.** Someone new lands `pending`, source
 *    `transactional`, with `triggerSubscribeSequences: false`.
 *  - **Consent is the sender's**, at send time (`core/sending.ts`): only a hard
 *    bounce or a complaint stops a transactional mail.
 */

// ───────────────────────────────────────────────── stored templates

/** Fields every recipient row supplies. A request may not redefine them. */
export const BUILTIN_FIELDS = ['first_name', 'name', 'email'] as const

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

export async function listTxTemplates(db: Db): Promise<TransactionalTemplate[]> {
  return await db
    .select()
    .from(transactionalTemplates)
    .orderBy(asc(transactionalTemplates.name), asc(transactionalTemplates.id))
    .all()
}

export async function getTxTemplate(db: Db, id: number): Promise<TransactionalTemplate | undefined> {
  return await db.select().from(transactionalTemplates).where(eq(transactionalTemplates.id, id)).get()
}

export async function getTxTemplateBySlug(
  db: Db,
  slug: string,
): Promise<TransactionalTemplate | undefined> {
  return await db
    .select()
    .from(transactionalTemplates)
    .where(eq(transactionalTemplates.slug, slug))
    .get()
}

export interface TxTemplateInput {
  name: string
  subject: string
  bodyJson?: DocNode | null
  bodyMd?: string | null
  isActive?: boolean
  /** Optional on create. Left out, it comes from the name. Never changes afterwards. */
  slug?: string | null
}

export type TxTemplateResult =
  | { ok: true; template: TransactionalTemplate }
  | { ok: false; reason: string }

/**
 * A body as a document. Markdown-only bodies (written over MCP) are converted
 * once, here, so the send path only ever fills a document — the one shape whose
 * renderer escapes what it is given.
 */
function bodyOf(json: DocNode | null | undefined, md: string | null | undefined): DocNode | null {
  if (json && !docIsEmpty(json)) return json
  const doc = mdToDoc(md ?? '')
  return doc && !docIsEmpty(doc) ? doc : null
}

function problem(input: Pick<TxTemplateInput, 'name' | 'subject' | 'bodyJson' | 'bodyMd'>): string | null {
  if (!input.name.trim()) return 'A template needs a name.'
  if (!input.subject.trim()) return 'A template needs a subject.'
  if (!bodyOf(input.bodyJson, input.bodyMd)) return 'A template needs a body.'
  return null
}

/**
 * Creates a template. Its slug is the one given, or one made from the name with
 * `-2`, `-3` on collision — and is never changed again, because another app's
 * code has it baked in. A slug given explicitly that is already taken is
 * refused rather than renumbered: the caller asked for that exact name.
 */
export async function createTxTemplate(db: Db, input: TxTemplateInput): Promise<TxTemplateResult> {
  const bad = problem(input)
  if (bad) return { ok: false, reason: bad }

  let slug: string
  if (input.slug?.trim()) {
    slug = input.slug.trim().toLowerCase()
    if (!SLUG_RE.test(slug)) {
      return { ok: false, reason: 'A slug is lowercase letters, digits and single dashes.' }
    }
    if (await getTxTemplateBySlug(db, slug)) {
      return { ok: false, reason: `The slug "${slug}" is already taken.` }
    }
  } else {
    slug = await freeSlug(db, slugify(input.name) || 'template')
  }

  const inserted = await db
    .insert(transactionalTemplates)
    .values({
      slug,
      name: input.name.trim(),
      subject: input.subject.trim(),
      bodyJson: input.bodyJson ?? null,
      bodyMd: input.bodyMd ?? null,
      isActive: input.isActive ?? true,
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .returning()

  const template = inserted[0]
  if (!template) return { ok: false, reason: `The slug "${slug}" is already taken.` }
  return { ok: true, template }
}

async function freeSlug(db: Db, base: string): Promise<string> {
  const rows = await db
    .select({ slug: transactionalTemplates.slug })
    .from(transactionalTemplates)
    .where(or(eq(transactionalTemplates.slug, base), like(transactionalTemplates.slug, `${base}-%`)))
    .all()
  const taken = new Set(rows.map((r) => r.slug))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

/** Changes the name, subject, body or active flag. The slug is kept, always. */
export async function updateTxTemplate(
  db: Db,
  id: number,
  patch: Partial<Omit<TxTemplateInput, 'slug'>>,
): Promise<TxTemplateResult> {
  const current = await getTxTemplate(db, id)
  if (!current) return { ok: false, reason: `No transactional template #${id}.` }

  const next = {
    name: patch.name ?? current.name,
    subject: patch.subject ?? current.subject,
    bodyJson: patch.bodyJson !== undefined ? patch.bodyJson : current.bodyJson,
    bodyMd: patch.bodyMd !== undefined ? patch.bodyMd : current.bodyMd,
  }
  const bad = problem(next)
  if (bad) return { ok: false, reason: bad }

  const updated = await db
    .update(transactionalTemplates)
    .set({
      name: next.name.trim(),
      subject: next.subject.trim(),
      bodyJson: next.bodyJson ?? null,
      bodyMd: next.bodyMd ?? null,
      ...(patch.isActive === undefined ? {} : { isActive: patch.isActive }),
      updatedAt: new Date(),
    })
    .where(eq(transactionalTemplates.id, id))
    .returning()

  return { ok: true, template: updated[0]! }
}

/**
 * Deletes a template. Allowed even when mail has gone out from it (Kōlea's
 * rule): every such message carries its own filled-in body and the template's
 * slug, so nothing that was sent is lost. A caller still naming the slug gets a
 * 422 from then on, never a silent drop.
 */
export async function deleteTxTemplate(db: Db, id: number): Promise<boolean> {
  const deleted = await db
    .delete(transactionalTemplates)
    .where(eq(transactionalTemplates.id, id))
    .returning({ id: transactionalTemplates.id })
  return deleted.length > 0
}

/** How many messages went out naming this slug — shown before a delete. */
export async function txTemplateUsage(db: Db, slug: string): Promise<number> {
  const row = await db
    .select({ n: count() })
    .from(messages)
    .where(eq(messages.templateSlug, slug))
    .get()
  return row?.n ?? 0
}

// ───────────────────────────────────────────────── filling a template

/** A request's variables, already checked: names to text. */
export type Variables = Record<string, string>

const TOKEN_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g
/** The same token after a link was percent-encoded by the editor or a tracker. */
const ENCODED_TOKEN_RE = /%7B%7B\s*([A-Za-z_][A-Za-z0-9_]*)\s*%7D%7D/gi

const SAFE_URL_RE = /^(https?:|mailto:|tel:|#|\/)/i
const URL_ATTRS = new Set(['href', 'src'])

/** Every `{{field}}` a subject and document use, built-ins included. */
export function fieldsUsed(subject: string, doc: DocNode | null): string[] {
  const found = new Set<string>()
  const scan = (s: string) => {
    for (const m of s.matchAll(TOKEN_RE)) found.add(m[1]!)
    for (const m of s.matchAll(ENCODED_TOKEN_RE)) found.add(m[1]!)
  }
  scan(subject)
  const walk = (node: DocNode) => {
    if (node.type === 'mergeTag') found.add(String(node.attrs?.field ?? ''))
    if (node.text) scan(node.text)
    for (const v of Object.values(node.attrs ?? {})) if (typeof v === 'string') scan(v)
    for (const mark of node.marks ?? []) {
      for (const v of Object.values(mark.attrs ?? {})) if (typeof v === 'string') scan(v)
    }
    for (const c of node.content ?? []) walk(c)
  }
  if (doc) walk(doc)
  found.delete('')
  return [...found]
}

/** One pass, so a value is never itself expanded. */
function fill(s: string, resolve: (field: string) => string | undefined, encode = false): string {
  const swap = (whole: string, field: string) => {
    const v = resolve(field)
    if (v === undefined) return whole
    return encode ? encodeURIComponent(v) : v
  }
  const out = s.replace(TOKEN_RE, swap)
  return encode ? out.replace(ENCODED_TOKEN_RE, swap) : out
}

/**
 * A URL a caller's value turned into `javascript:` or `data:` is dropped to
 * `#`. The operator wrote `href="{{reset_url}}"` expecting a link; nobody
 * expects a script, and escaping the quotes does not stop that one.
 */
function fillUrl(original: string, resolve: (field: string) => string | undefined): string {
  const filled = fill(original, resolve, /%7B%7B/i.test(original))
  if (filled === original) return original
  return SAFE_URL_RE.test(filled.trim()) || !/^[a-z][a-z0-9+.-]*:/i.test(filled.trim())
    ? filled
    : '#'
}

function fillDoc(node: DocNode, resolve: (field: string) => string | undefined): DocNode {
  // A mergeTag naming a request variable becomes plain text, keeping its marks.
  // Built-in tags stay nodes and the renderer resolves them, as everywhere else.
  if (node.type === 'mergeTag') {
    const field = String(node.attrs?.field ?? '')
    if ((BUILTIN_FIELDS as readonly string[]).includes(field)) return node
    const v = resolve(field)
    if (v === undefined) return node
    return node.marks?.length ? { type: 'text', text: v, marks: node.marks } : { type: 'text', text: v }
  }

  const out: DocNode = { ...node }
  if (node.text !== undefined) out.text = fill(node.text, resolve)
  if (node.attrs) {
    out.attrs = Object.fromEntries(
      Object.entries(node.attrs).map(([k, v]) =>
        typeof v !== 'string' ? [k, v] : [k, URL_ATTRS.has(k) ? fillUrl(v, resolve) : fill(v, resolve)],
      ),
    )
  }
  if (node.marks) {
    out.marks = node.marks.map((m) =>
      m.attrs
        ? {
            ...m,
            attrs: Object.fromEntries(
              Object.entries(m.attrs).map(([k, v]) =>
                typeof v !== 'string'
                  ? [k, v]
                  : [k, URL_ATTRS.has(k) ? fillUrl(v, resolve) : fill(v, resolve)],
              ),
            ),
          }
        : m,
    )
  }
  if (node.content) {
    // An empty value leaves an empty text node, which ProseMirror refuses.
    out.content = node.content
      .map((c) => fillDoc(c, resolve))
      .filter((c) => c.type !== 'text' || (c.text ?? '') !== '')
  }
  return out
}

/** The variables a template asks a caller for, built-ins left out, sorted. */
export function templateAsks(t: Pick<TransactionalTemplate, 'subject' | 'bodyJson' | 'bodyMd'>): string[] {
  const builtin = BUILTIN_FIELDS as readonly string[]
  return fieldsUsed(t.subject, bodyOf(t.bodyJson, t.bodyMd))
    .filter((f) => !builtin.includes(f))
    .sort()
}

export type Filled =
  | { ok: true; subject: string; bodyJson: DocNode; bodyMd: string | null }
  | { ok: false; missing: string[] }

/**
 * A template with a request's variables filled in, for one recipient. Pure.
 *
 * The subject is plain text (a header, not markup) and gets built-ins and
 * variables alike. The document gets the variables only; its built-in tags are
 * left for the renderer. `bodyMd` is kept as the operator wrote it, unfilled —
 * a record of the source, never rendered while the document has content.
 */
export function fillTemplate(
  template: Pick<TransactionalTemplate, 'subject' | 'bodyJson' | 'bodyMd'>,
  variables: Variables,
  recipient: { email: string; name: string | null },
  subjectOverride?: string | null,
): Filled {
  const doc = bodyOf(template.bodyJson, template.bodyMd)
  const subject = subjectOverride?.trim() ? subjectOverride : template.subject
  const builtin = BUILTIN_FIELDS as readonly string[]

  const missing = fieldsUsed(subject, doc)
    .filter((f) => !builtin.includes(f) && !(f in variables))
    .sort()
  if (missing.length > 0 || !doc) return { ok: false, missing }

  const resolveVar = (f: string) => (Object.hasOwn(variables, f) ? variables[f] : undefined)
  const resolveSubject = (f: string) =>
    builtin.includes(f) ? mergeFieldValue(f, recipient) : resolveVar(f)

  return {
    ok: true,
    subject: fill(subject, resolveSubject),
    bodyJson: fillDoc(doc, resolveVar),
    bodyMd: template.bodyMd ?? null,
  }
}

// ───────────────────────────────────────────────── the request

const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const MAX_VARIABLES = 100
const MAX_VARIABLE_CHARS = 10_000

export interface SendRequest {
  to: string
  name: string | null
  subject: string | null
  body: string | null
  template: string | null
  variables: Variables
  idempotencyKey: string | null
}

export type Parsed = { ok: true; request: SendRequest } | { ok: false; error: string }

/**
 * A `POST /api/send` body, checked at the boundary. Every refusal names the
 * field (SPEC 7.6). Shape only — whether the template exists is `acceptSend`'s.
 */
export function parseSendRequest(payload: unknown): Parsed {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null)

  const to = normalizeEmail(typeof p.to === 'string' ? p.to : '')
  if (!to || !isValidEmail(to)) return { ok: false, error: 'field `to` must be a valid email' }

  const template = str(p.template)?.trim().toLowerCase() ?? null
  const body = str(p.body)
  const subject = str(p.subject)

  if (template && body) {
    return { ok: false, error: 'send only one of `body` or `template`' }
  }
  if (template && !SLUG_RE.test(template)) {
    return { ok: false, error: 'field `template` must be a template slug' }
  }
  if (!template) {
    if (!subject) return { ok: false, error: 'field `subject` is required' }
    if (!body) return { ok: false, error: 'field `body` is required (or name a `template`)' }
    if (p.variables !== undefined) {
      return { ok: false, error: 'field `variables` only applies with a `template`' }
    }
  }

  const vars = parseVariables(p.variables)
  if (!vars.ok) return vars

  return {
    ok: true,
    request: {
      to,
      name: str(p.name),
      subject,
      body,
      template,
      variables: vars.variables,
      idempotencyKey: str(p.idempotency_key),
    },
  }
}

function parseVariables(raw: unknown): { ok: true; variables: Variables } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, variables: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'field `variables` must be an object of names to values' }
  }
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > MAX_VARIABLES) {
    return { ok: false, error: `field \`variables\` can hold at most ${MAX_VARIABLES} names` }
  }
  const variables: Variables = {}
  for (const [k, v] of entries) {
    if (!VARIABLE_NAME_RE.test(k)) {
      return { ok: false, error: 'field `variables`: names must be letters, digits and underscores' }
    }
    if ((BUILTIN_FIELDS as readonly string[]).includes(k)) {
      return {
        ok: false,
        error: `field \`variables\`: \`${k}\` comes from the recipient and cannot be set`,
      }
    }
    if (typeof v === 'string') {
      if (v.length > MAX_VARIABLE_CHARS) {
        return { ok: false, error: `field \`variables\`: \`${k}\` is longer than ${MAX_VARIABLE_CHARS} characters` }
      }
      variables[k] = v
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      variables[k] = String(v)
    } else if (typeof v === 'boolean') {
      variables[k] = String(v)
    } else {
      return { ok: false, error: `field \`variables\`: \`${k}\` must be text, a number, or true/false` }
    }
  }
  return { ok: true, variables }
}

export type Accepted =
  | { kind: 'accepted'; messageId: number; template: string | null }
  | { kind: 'replayed'; messageId: number; status: string; template: string | null }
  | { kind: 'refused'; status: 422; error: string; missing?: string[] }

/**
 * Records one transactional mail, or says why not. The caller dispatches the
 * returned message after answering (SPEC 7.5) — this only makes it durable.
 */
export async function acceptSend(db: Db, request: SendRequest): Promise<Accepted> {
  // Replaying an idempotency key returns the original result rather than
  // sending twice (SPEC 7.3) — checked before the template, so a replay still
  // answers after the template was edited, deactivated or deleted.
  const idem = request.idempotencyKey ? `txn:${request.idempotencyKey}` : null
  if (idem) {
    const existing = await db.select().from(messages).where(eq(messages.idempotencyKey, idem)).get()
    if (existing) {
      return {
        kind: 'replayed',
        messageId: existing.id,
        status: existing.status,
        template: existing.templateSlug,
      }
    }
  }

  let template: TransactionalTemplate | undefined
  if (request.template) {
    template = await getTxTemplateBySlug(db, request.template)
    if (!template) {
      return { kind: 'refused', status: 422, error: `field \`template\`: no template "${request.template}"` }
    }
    if (!template.isActive) {
      return {
        kind: 'refused',
        status: 422,
        error: `field \`template\`: "${template.slug}" is inactive; turn it back on to send it`,
      }
    }
    // Checked against a stand-in recipient before anybody is created, so a
    // refused request leaves no trace on the list.
    const check = fillTemplate(template, request.variables, { email: request.to, name: request.name }, request.subject)
    if (!check.ok) {
      return {
        kind: 'refused',
        status: 422,
        error: `field \`variables\`: missing ${check.missing.map((m) => `\`${m}\``).join(', ')}`,
        missing: check.missing,
      }
    }
  }

  // Transactional recipients may not be on the list at all; create them quietly
  // so the send is attributable, but never enroll or market to them.
  let sub = await db.select().from(subscribers).where(eq(subscribers.email, request.to)).get()
  if (!sub) {
    const { id } = await upsertSubscriber(db, {
      email: request.to,
      name: request.name,
      source: 'transactional',
      // Somebody receiving a password reset did not join the newsletter, so they
      // land `pending`: reachable by this send and invisible to every broadcast.
      status: 'pending',
      triggerSubscribeSequences: false,
    })
    sub = await db.select().from(subscribers).where(eq(subscribers.id, id!)).get()
  }
  if (!sub) throw new Error('could not resolve recipient')

  let subject: string
  let bodyMd: string | null
  let bodyJson: DocNode | null = null
  if (template) {
    const filled = fillTemplate(template, request.variables, { email: sub.email, name: sub.name }, request.subject)
    if (!filled.ok) throw new Error('template check passed and then failed')
    subject = filled.subject
    bodyJson = filled.bodyJson
    bodyMd = filled.bodyMd
  } else {
    subject = request.subject!
    bodyMd = request.body
  }

  const inserted = await db
    .insert(messages)
    .values({
      subscriberId: sub.id,
      kind: 'transactional',
      toEmail: request.to,
      subject,
      bodyMd,
      bodyJson,
      templateSlug: template?.slug ?? null,
      status: 'queued',
      idempotencyKey: idem,
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: messages.id })

  // Two requests with one key raced and the other won the unique index: its
  // result is the answer, and nothing is queued twice.
  if (!inserted[0] && idem) {
    const winner = await db.select().from(messages).where(eq(messages.idempotencyKey, idem)).get()
    if (winner) {
      return { kind: 'replayed', messageId: winner.id, status: winner.status, template: winner.templateSlug }
    }
  }
  if (!inserted[0]) throw new Error('message was not recorded')

  return { kind: 'accepted', messageId: inserted[0].id, template: template?.slug ?? null }
}
