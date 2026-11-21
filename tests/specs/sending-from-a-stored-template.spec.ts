// Transactional templates: Let my other apps send a stored mail by name
// SPEC 7.1–7.7, invariant 9 (sent history is immutable).
//
// The contract is HTTP, so almost every Scenario drives `POST /api/send` through
// `worker.fetch`. Templates are written through the admin screen in the first
// Scenario (a real entry point) and through `core/transactional.ts` elsewhere,
// which is the same function the screen and the MCP tools call.
//
// Rules decided here:
//   - a missing {{variable}} fails the request with a 422 naming every one, and
//     nothing is recorded or sent;
//   - a request `subject` overrides the template's;
//   - deleting a template is allowed — sent mail keeps its own filled copy.
import { beforeAll, describe, expect, it } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import { createApiKey } from '../../src/core/api-keys.ts'
import { unsubscribeAll } from '../../src/core/consent.ts'
import {
  createTxTemplate,
  deleteTxTemplate,
  getTxTemplateBySlug,
  updateTxTemplate,
} from '../../src/core/transactional.ts'
import type { DevOutboxItem, DocNode, Message, TransactionalTemplate } from '../../src/db/schema.ts'
import { messages, subscribers, suppressions, transactionalTemplates } from '../../src/db/schema.ts'
import { aPerson } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

/** POST /api/send, the way a consuming app would. */
async function send(world: World, token: string | null, payload: Record<string, unknown>) {
  return await world.fetch('/api/send', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  })
}

const p = (...content: DocNode[]): DocNode => ({ type: 'paragraph', content })
const t = (text: string): DocNode => ({ type: 'text', text })

/** "Hi {{first_name}}, order {{order_id}} is ready. [Download]({{download_url}})" */
const RECEIPT_DOC: DocNode = {
  type: 'doc',
  content: [
    p(t('Hi '), { type: 'mergeTag', attrs: { field: 'first_name' } }, t(', order {{order_id}} is ready.')),
    p({
      type: 'text',
      text: 'Download it',
      marks: [{ type: 'link', attrs: { href: '{{download_url}}' } }],
    }),
  ],
}

async function aReceiptTemplate(world: World, overrides: { isActive?: boolean } = {}) {
  const result = await createTxTemplate(world.db, {
    name: 'Order receipt',
    subject: 'Order {{order_id}}',
    bodyJson: RECEIPT_DOC,
    bodyMd: 'Hi {{first_name}}, order {{order_id}} is ready.',
    ...overrides,
  })
  if (!result.ok) throw new Error(result.reason)
  return result.template
}

const VARS = { order_id: 'A-1042', download_url: 'https://files.example.test/a-1042' }

async function messageCount(world: World): Promise<number> {
  return (await world.db.select({ n: count() }).from(messages).get())?.n ?? 0
}

describe('Feature: another application sends a stored template by name', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: the operator writes a receipt on the admin screen and an app sends it', () => {
    let world: World
    let saved: Response
    let template: TransactionalTemplate | undefined
    let response: Response
    let payload: { id: number; status: string; template: string }
    let mail: DevOutboxItem
    let row: Message | undefined

    beforeAll(async () => {
      world = createWorld()
      await aPerson(world, { email: 'buyer@example.test', name: 'Ada Lovelace' })
      saved = await world.post('/transactional', {
        name: 'Order receipt',
        subject: 'Order {{order_id}}',
        body_json: JSON.stringify(RECEIPT_DOC),
        body_md_fallback: '',
        isActive: '1',
      })
      template = await getTxTemplateBySlug(world.db, 'order-receipt')

      const { token } = await createApiKey(world.db, 'the checkout')
      response = await send(world, token, {
        to: 'buyer@example.test',
        template: 'order-receipt',
        variables: VARS,
      })
      payload = await response.json()
      await world.settle()
      mail = await world.mailTo('buyer@example.test')
      row = await world.db.select().from(messages).get()
    })

    it('saves the template from the screen', () => {
      expect(saved.status).toBe(302)
    })

    it('gives it a slug made from its name', () => {
      expect(template?.slug).toBe('order-receipt')
    })

    it('accepts the request', () => {
      expect(response.status).toBe(202)
    })

    it('says which template it sent', () => {
      expect(payload.template).toBe('order-receipt')
    })

    it('fills the subject from the variables', () => {
      expect(mail.subject).toBe('Order A-1042')
    })

    it('fills the body in the HTML part', () => {
      expect(mail.html).toContain('order A-1042 is ready')
    })

    it('fills the body in the plaintext part', () => {
      expect(mail.text).toContain('order A-1042 is ready')
    })

    it('fills a link target', () => {
      expect(mail.html).toContain('href="https://files.example.test/a-1042"')
    })

    it('still resolves the recipient’s own merge tags', () => {
      expect(mail.html).toContain('Hi Ada,')
    })

    it('carries no unsubscribe footer (SPEC 7.7)', () => {
      expect(mail.html).not.toContain('Unsubscribe')
    })

    it('records it as transactional', () => {
      expect(row?.kind).toBe('transactional')
    })

    it('records which template it came from', () => {
      expect(row?.templateSlug).toBe('order-receipt')
    })

    it('snapshots the filled body onto the message  ⭐', () => {
      expect(JSON.stringify(row?.bodyJson)).toContain('order A-1042 is ready')
    })
  })

  describe('Scenario: a caller passes markup as a variable', () => {
    // ⭐ A caller's value is data. It must not become HTML in anybody's inbox.
    let world: World
    let mail: DevOutboxItem

    beforeAll(async () => {
      world = createWorld()
      await aReceiptTemplate(world)
      const { token } = await createApiKey(world.db, 'the checkout')
      await send(world, token, {
        to: 'buyer@example.test',
        template: 'order-receipt',
        variables: {
          order_id: '<script>alert(1)</script> {{email}}',
          download_url: 'javascript:alert(1)',
        },
      })
      await world.settle()
      mail = await world.mailTo('buyer@example.test')
    })

    it('escapes it in the HTML part  ⭐', () => {
      expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    })

    it('never lets it through as a tag  ⭐', () => {
      expect(mail.html).not.toContain('<script>')
    })

    it('leaves it as typed in the plaintext part', () => {
      expect(mail.text).toContain('<script>alert(1)</script>')
    })

    it('does not expand a merge tag hidden inside a value', () => {
      expect(mail.text).toContain('{{email}}')
    })

    it('drops a script link to a harmless one  ⭐', () => {
      expect(mail.html).not.toContain('javascript:')
    })
  })

  describe('Scenario: the template is edited, and then deleted, after a mail was accepted', () => {
    // ⭐ Invariant 9: what went out stays what went out.
    let world: World
    let row: Message | undefined
    let mail: DevOutboxItem
    let afterDelete: Response
    let afterDeleteBody: { error: string }

    beforeAll(async () => {
      world = createWorld()
      const template = await aReceiptTemplate(world)
      const { token } = await createApiKey(world.db, 'the checkout')
      await send(world, token, { to: 'buyer@example.test', template: 'order-receipt', variables: VARS })

      await updateTxTemplate(world.db, template.id, {
        subject: 'Something else entirely',
        bodyJson: { type: 'doc', content: [p(t('Rewritten.'))] },
      })
      await world.settle()
      await deleteTxTemplate(world.db, template.id)

      mail = await world.mailTo('buyer@example.test')
      row = await world.db.select().from(messages).get()
      afterDelete = await send(world, token, {
        to: 'buyer@example.test',
        template: 'order-receipt',
        variables: VARS,
      })
      afterDeleteBody = await afterDelete.json()
    })

    it('sends what was accepted, not the edit  ⭐', () => {
      expect(mail.subject).toBe('Order A-1042')
    })

    it('keeps the original body on the message  ⭐', () => {
      expect(JSON.stringify(row?.bodyJson)).not.toContain('Rewritten')
    })

    it('keeps the message when the template is deleted', () => {
      expect(row).toBeDefined()
    })

    it('keeps the slug it came from', () => {
      expect(row?.templateSlug).toBe('order-receipt')
    })

    it('refuses a later request for the deleted slug, out loud', () => {
      expect(afterDelete.status).toBe(422)
    })

    it('names the template field', () => {
      expect(afterDeleteBody.error).toContain('`template`')
    })
  })

  describe('Scenario: the same idempotency key twice, with the template edited in between', () => {
    let world: World
    let first: { id: number }
    let second: { id: number; idempotent?: boolean; template?: string }
    let secondResponse: Response

    beforeAll(async () => {
      world = createWorld()
      const template = await aReceiptTemplate(world)
      const { token } = await createApiKey(world.db, 'the checkout')
      const payload = { to: 'buyer@example.test', template: 'order-receipt', variables: VARS, idempotency_key: 'order-1042' }

      first = await (await send(world, token, payload)).json()
      await world.settle()
      await updateTxTemplate(world.db, template.id, { isActive: false })
      secondResponse = await send(world, token, payload)
      second = await secondResponse.json()
      await world.settle()
    })

    it('answers the replay, even though the template is now off', () => {
      expect(secondResponse.status).toBe(200)
    })

    it('returns the original message', () => {
      expect(second.id).toBe(first.id)
    })

    it('says which template the original used', () => {
      expect(second.template).toBe('order-receipt')
    })

    it('sends nothing a second time  ⭐', async () => {
      expect(await world.outbox()).toHaveLength(1)
    })
  })

  describe('Scenario: a buyer who unsubscribed from everything gets a templated receipt', () => {
    // ⭐ Receipts are not marketing (ARCHITECTURE → Consent).
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      const reader = await aPerson(world, { email: 'buyer@example.test' })
      await unsubscribeAll(world.db, reader.id, reader.email)
      await aReceiptTemplate(world)
      const { token } = await createApiKey(world.db, 'the checkout')
      response = await send(world, token, { to: 'buyer@example.test', template: 'order-receipt', variables: VARS })
      await world.settle()
    })

    it('accepts it', () => {
      expect(response.status).toBe(202)
    })

    it('delivers it', async () => {
      expect(await world.outbox()).toHaveLength(1)
    })
  })

  describe('Scenario: a stranger is sent a templated mail', () => {
    let world: World
    let created: { status: string; source: string | null } | undefined

    beforeAll(async () => {
      world = createWorld()
      await aReceiptTemplate(world)
      const { token } = await createApiKey(world.db, 'the checkout')
      await send(world, token, { to: 'new@example.test', template: 'order-receipt', variables: VARS })
      await world.settle()
      created = await world.db.select().from(subscribers).where(eq(subscribers.email, 'new@example.test')).get()
    })

    it('adds them as pending, never as a subscriber  ⭐', () => {
      expect(created?.status).toBe('pending')
    })

    it('records where they came from', () => {
      expect(created?.source).toBe('transactional')
    })
  })

  describe('Scenario: a request supplies its own subject', () => {
    let world: World
    let mail: DevOutboxItem

    beforeAll(async () => {
      world = createWorld()
      await aReceiptTemplate(world)
      const { token } = await createApiKey(world.db, 'the checkout')
      await send(world, token, {
        to: 'buyer@example.test',
        template: 'order-receipt',
        subject: 'Your files for {{order_id}}',
        variables: VARS,
      })
      await world.settle()
      mail = await world.mailTo('buyer@example.test')
    })

    it('uses it in place of the template’s, filled', () => {
      expect(mail.subject).toBe('Your files for A-1042')
    })
  })

  describe('Scenario: the operator renames a template', () => {
    let world: World
    let renamed: TransactionalTemplate | undefined
    let twin: TransactionalTemplate | undefined

    beforeAll(async () => {
      world = createWorld()
      const template = await aReceiptTemplate(world)
      await updateTxTemplate(world.db, template.id, { name: 'Receipt, new wording' })
      renamed = await world.db.select().from(transactionalTemplates).where(eq(transactionalTemplates.id, template.id)).get()
      const second = await aReceiptTemplate(world)
      twin = second
    })

    it('keeps the slug the calling apps already use', () => {
      expect(renamed?.slug).toBe('order-receipt')
    })

    it('numbers a second template with the same name rather than colliding', () => {
      expect(twin?.slug).toBe('order-receipt-2')
    })
  })

  describe('Scenario: the operator looks at the template list', () => {
    let world: World
    let html: string

    beforeAll(async () => {
      world = createWorld()
      await aReceiptTemplate(world)
      html = await (await world.fetch('/transactional')).text()
    })

    it('shows the slug a caller names', () => {
      expect(html).toContain('order-receipt')
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: a request leaves variables out', () => {
    let world: World
    let response: Response
    let body: { error: string; missing: string[] }

    beforeAll(async () => {
      world = createWorld()
      await aReceiptTemplate(world)
      const { token } = await createApiKey(world.db, 'the checkout')
      response = await send(world, token, { to: 'stranger@example.test', template: 'order-receipt', variables: {} })
      body = await response.json()
      await world.settle()
    })

    it('is refused as unprocessable', () => {
      expect(response.status).toBe(422)
    })

    it('names every missing variable', () => {
      expect(body.missing).toEqual(['download_url', 'order_id'])
    })

    it('says so in the error', () => {
      expect(body.error).toContain('`order_id`')
    })

    it('records no message  ⭐', async () => {
      expect(await messageCount(world)).toBe(0)
    })

    it('adds nobody to the list', async () => {
      const n = (await world.db.select({ n: count() }).from(subscribers).get())?.n
      expect(n).toBe(0)
    })

    it('sends nothing', async () => {
      expect(await world.outbox()).toHaveLength(0)
    })
  })

  describe('Scenario: a request names a template that does not exist', () => {
    let world: World
    let response: Response
    let body: { error: string }

    beforeAll(async () => {
      world = createWorld()
      const { token } = await createApiKey(world.db, 'the checkout')
      response = await send(world, token, { to: 'buyer@example.test', template: 'no-such-thing', variables: VARS })
      body = await response.json()
    })

    it('is refused as unprocessable', () => {
      expect(response.status).toBe(422)
    })

    it('names the template field (SPEC 7.6)', () => {
      expect(body.error).toContain('`template`')
    })
  })

  describe('Scenario: a request names an inactive template', () => {
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      await aReceiptTemplate(world, { isActive: false })
      const { token } = await createApiKey(world.db, 'the checkout')
      response = await send(world, token, { to: 'buyer@example.test', template: 'order-receipt', variables: VARS })
      await world.settle()
    })

    it('is refused, so the caller knows to send it later', () => {
      expect(response.status).toBe(422)
    })

    it('sends nothing', async () => {
      expect(await world.outbox()).toHaveLength(0)
    })
  })

  describe('Scenario: a request carries both a body and a template', () => {
    let world: World
    let response: Response
    let body: { error: string }

    beforeAll(async () => {
      world = createWorld()
      await aReceiptTemplate(world)
      const { token } = await createApiKey(world.db, 'the checkout')
      response = await send(world, token, {
        to: 'buyer@example.test',
        subject: 'Hi',
        body: 'Thanks',
        template: 'order-receipt',
        variables: VARS,
      })
      body = await response.json()
    })

    it('is rejected', () => {
      expect(response.status).toBe(400)
    })

    it('names both fields', () => {
      expect(body.error).toContain('`body` or `template`')
    })
  })

  describe('Scenario: a request tries to set a recipient field as a variable', () => {
    let world: World
    let response: Response
    let body: { error: string }

    beforeAll(async () => {
      world = createWorld()
      await aReceiptTemplate(world)
      const { token } = await createApiKey(world.db, 'the checkout')
      response = await send(world, token, {
        to: 'buyer@example.test',
        template: 'order-receipt',
        variables: { ...VARS, email: 'someone-else@example.test' },
      })
      body = await response.json()
    })

    it('is rejected', () => {
      expect(response.status).toBe(400)
    })

    it('names the variable', () => {
      expect(body.error).toContain('`email`')
    })
  })

  describe('Scenario: a templated request with no credentials', () => {
    let world: World
    let response: Response

    beforeAll(async () => {
      world = createWorld()
      await aReceiptTemplate(world)
      response = await send(world, null, { to: 'buyer@example.test', template: 'order-receipt', variables: VARS })
      await world.settle()
    })

    it('is rejected as unauthorized', () => {
      expect(response.status).toBe(401)
    })

    it('records no message', async () => {
      expect(await messageCount(world)).toBe(0)
    })
  })

  describe('Scenario: a templated mail to an address that hard-bounced', () => {
    // ⭐ The one case a receipt is stopped, and it is a visible row.
    let world: World
    let row: Message | undefined

    beforeAll(async () => {
      world = createWorld()
      const person = await aPerson(world, { email: 'buyer@example.test' })
      await aReceiptTemplate(world)
      await world.db.insert(suppressions).values({ email: person.email, reason: 'hard_bounce', createdAt: new Date() })
      const { token } = await createApiKey(world.db, 'the checkout')
      await send(world, token, { to: 'buyer@example.test', template: 'order-receipt', variables: VARS })
      await world.settle()
      row = await world.db.select().from(messages).get()
    })

    it('records the block against the message', () => {
      expect(row?.status).toBe('suppressed')
    })
  })

  describe('Scenario: a template saved without a body', () => {
    let world: World
    let result: { ok: boolean; reason?: string }

    beforeAll(async () => {
      world = createWorld()
      result = await createTxTemplate(world.db, { name: 'Empty', subject: 'Hi', bodyMd: '' })
    })

    it('is refused', () => {
      expect(result.ok).toBe(false)
    })

    it('says what is missing', () => {
      expect(result.reason).toContain('body')
    })
  })
})
