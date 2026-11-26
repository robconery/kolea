// Purchase mail's `{{account_url}}` and the dashboard line under `{{downloads}}`
// come from the operator's `ACCOUNT_URL` var. Nothing about any one store is
// baked into the code: unset, the link is left out rather than pointing nowhere.
import { beforeAll, describe, expect, it } from 'bun:test'
import { type PurchaseMailPlan, createTemplate, planPurchaseMail } from '../../src/core/purchase-mail.ts'
import { type MergeExtras, saleItems, sales, stripeProducts } from '../../src/db/schema.ts'
import type { Env } from '../../src/types.ts'
import { aPerson } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

const ACCOUNT = 'https://shop.example.test/account'

/** A buyer who bought one product that grants a file, and a fallback template. */
async function aSaleWithAFile(overrides: Partial<Env> = {}): Promise<{ world: World; saleId: number }> {
  const world = createWorld(overrides)
  const buyer = await aPerson(world, { email: 'buyer@example.test', triggerSubscribeSequences: false })
  const now = new Date()
  await world.db.insert(stripeProducts).values({
    id: 'prod_handbook',
    name: 'The Field Guide',
    metadata: { sku: 'field-guide', file: 'field-guide.zip' },
    syncedAt: now,
  })
  const sale = await world.db
    .insert(sales)
    .values({
      subscriberId: buyer.id,
      product: 'The Field Guide',
      amountCents: 4900,
      occurredAt: now,
      createdAt: now,
    })
    .returning({ id: sales.id })
    .get()
  await world.db.insert(saleItems).values({
    saleId: sale.id,
    stripeProductId: 'prod_handbook',
    description: 'The Field Guide',
    createdAt: now,
  })
  await createTemplate(world.db, {
    offerSlug: '*',
    name: 'Thanks',
    subject: 'Thanks for {{offer_name}}',
    bodyMd: 'Manage it at {{account_url}}\n\n{{downloads}}',
  })
  return { world, saleId: sale.id }
}

async function planFor(overrides: Partial<Env> = {}): Promise<PurchaseMailPlan> {
  const { world, saleId } = await aSaleWithAFile(overrides)
  const planned = await planPurchaseMail(world.env, world.db, saleId)
  if (!planned.ok) throw new Error(planned.reason)
  return planned.plan
}

const downloads = (extras: MergeExtras) => extras.downloads as { html: string; text: string }

describe('Feature: thanking a buyer', () => {
  describe('Scenario: the operator has set ACCOUNT_URL', () => {
    let plan: PurchaseMailPlan

    beforeAll(async () => {
      plan = await planFor({ ACCOUNT_URL: ACCOUNT })
    })

    it('fills {{account_url}} with it', () => {
      expect(plan.extras.account_url).toBe(ACCOUNT)
    })

    it('links the dashboard under the downloads in the HTML', () => {
      expect(downloads(plan.extras).html).toContain(`<a href="${ACCOUNT}">`)
    })

    it('names the dashboard under the downloads in the plain text', () => {
      expect(downloads(plan.extras).text).toContain(`Grab them from your dashboard: ${ACCOUNT}`)
    })
  })

  describe('Scenario: ACCOUNT_URL is not set', () => {
    let plan: PurchaseMailPlan

    beforeAll(async () => {
      plan = await planFor()
    })

    it('still names the file the buyer owns', () => {
      expect(downloads(plan.extras).text).toContain('The Field Guide')
    })

    it('leaves {{account_url}} empty', () => {
      expect(plan.extras.account_url).toBe('')
    })

    it('leaves the dashboard line out of the HTML', () => {
      expect(downloads(plan.extras).html).not.toContain('dashboard')
    })

    it('leaves the dashboard line out of the plain text', () => {
      expect(downloads(plan.extras).text).not.toContain('dashboard')
    })
  })

  describe('Scenario: ACCOUNT_URL is only whitespace', () => {
    let plan: PurchaseMailPlan

    beforeAll(async () => {
      plan = await planFor({ ACCOUNT_URL: '   ' })
    })

    it('is treated as unset', () => {
      expect(plan.extras.account_url).toBe('')
    })
  })
})
