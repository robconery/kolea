// gap.md "Custom fields" — named, typed facts about a person, asked about in
// segments and dropped into mail.
// Kōlea SPEC 7.2 (typed attributes), 7.5 (segments over attributes, one WHERE
// builder for resolve and count), 7.7 (import maps columns, never triggers),
// 10.1.3 (merge tags with a fallback). Big Mailer SPEC 1.3 (per-row report).
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { startBroadcast } from '../../src/core/broadcasts.ts'
import {
  type FieldResult,
  checkConditions,
  createField,
  deleteField,
  renameField,
  setFieldValues,
} from '../../src/core/fields.ts'
import { createForm, getForm } from '../../src/core/forms.ts'
import { countSegment, createSegment, describeRule, resolveSegment } from '../../src/core/segments.ts'
import { type ImportReport, importCsv } from '../../src/core/subscribers.ts'
import {
  type FieldCondition,
  type SegmentRule,
  type Subscriber,
  customFields,
  segments,
  subscribers,
} from '../../src/db/schema.ts'
import { aBroadcast, aPerson, reload } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

/** The fields most scenarios ask about. */
async function theFields(world: World) {
  await createField(world.db, { label: 'Plan', type: 'text' })
  await createField(world.db, { label: 'Seats', type: 'number' })
  await createField(world.db, { label: 'Renews on', type: 'date' })
  await createField(world.db, { label: 'VIP', type: 'boolean' })
}

/** Four people with different facts, and one who left the newsletter. */
async function anAudience(world: World) {
  await theFields(world)
  const pro = await aPerson(world, { email: 'pro@example.test' })
  await setFieldValues(world.db, pro.id, { plan: 'pro', seats: 12, renews_on: '2027-01-31', vip: true })
  const team = await aPerson(world, { email: 'team@example.test' })
  await setFieldValues(world.db, team.id, { plan: 'team plus', seats: 3, renews_on: '2026-06-01', vip: false })
  const bare = await aPerson(world, { email: 'bare@example.test' })
  // Old data written before definitions existed: a number stored as text.
  const odd = await aPerson(world, { email: 'odd@example.test' })
  await world.db
    .update(subscribers)
    .set({ attributes: { seats: '50' } })
    .where(eq(subscribers.id, odd.id))
  const gone = await aPerson(world, { email: 'gone@example.test' })
  await setFieldValues(world.db, gone.id, { plan: 'pro' })
  await world.db.update(subscribers).set({ status: 'unsubscribed' }).where(eq(subscribers.id, gone.id))
  return { pro, team, bare, odd, gone }
}

const emails = async (world: World, rule: SegmentRule) =>
  (await resolveSegment(world.db, rule)).map((r) => r.email).sort()

const cond = (c: FieldCondition): SegmentRule => ({ conditions: [c] })

describe('Feature: custom fields', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: the operator adds a field through the console', () => {
    let world: World
    let response: Response
    let page: string

    beforeAll(async () => {
      world = createWorld()
      response = await world.post('/fields', { label: 'Signup Plan', key: '', type: 'text' })
      page = await (await world.fetch('/fields')).text()
    })

    it('sends them back to the list', () => {
      expect(response.status).toBe(302)
    })

    it('derives the key from the name', async () => {
      const row = await world.db.select().from(customFields).get()
      expect(row?.key).toBe('signup_plan')
    })

    it('lists it with its merge tag', () => {
      expect(page).toContain('{{signup_plan}}')
    })
  })

  describe('Scenario: renaming a field', () => {
    let world: World
    let renamed: FieldResult

    beforeAll(async () => {
      world = createWorld()
      const made = await createField(world.db, { label: 'Plan' })
      renamed = await renameField(world.db, made.ok ? made.field.id : 0, 'Subscription plan')
    })

    it('changes the label', () => {
      expect(renamed.ok && renamed.field.label).toBe('Subscription plan')
    })

    it('keeps the key, so rules and merge tags still point at it', () => {
      expect(renamed.ok && renamed.field.key).toBe('plan')
    })
  })

  describe("Scenario: editing a person's fields on their screen", () => {
    let world: World
    let response: Response
    let person: Subscriber

    beforeAll(async () => {
      world = createWorld()
      await theFields(world)
      person = await aPerson(world, { email: 'ada@example.test' })
      await setFieldValues(world.db, person.id, { plan: 'old' })
      response = await world.post(`/subscribers/${person.id}/fields`, {
        f_plan: '',
        f_seats: '5',
        f_renews_on: '2027-01-31',
        f_vip: 'yes',
        f_not_a_field: 'ignored',
      })
      person = await reload(world, person)
    })

    it('redirects back to the person', () => {
      expect(response.headers.get('location')).toContain(`/subscribers/${person.id}`)
    })

    it('stores a number as a number', () => {
      expect(person.attributes.seats).toBe(5)
    })

    it('stores a date as YYYY-MM-DD', () => {
      expect(person.attributes.renews_on).toBe('2027-01-31')
    })

    it('stores yes as true', () => {
      expect(person.attributes.vip).toBe(true)
    })

    it('clears a value left blank', () => {
      expect('plan' in person.attributes).toBe(false)
    })

    it('never writes a key no field defines', () => {
      expect('not_a_field' in person.attributes).toBe(false)
    })

    it('shows the values on the screen', async () => {
      const html = await (await world.fetch(`/subscribers/${person.id}`)).text()
      expect(html).toContain('value="2027-01-31"')
    })
  })

  describe('Scenario: segments ask about fields', () => {
    let world: World
    const r: Record<string, string[]> = {}
    let counted: number
    let resolvedForCount: number

    beforeAll(async () => {
      world = createWorld()
      await anAudience(world)
      r.equals = await emails(world, cond({ key: 'plan', type: 'text', op: 'equals', value: 'pro' }))
      r.notEquals = await emails(world, cond({ key: 'plan', type: 'text', op: 'not_equals', value: 'pro' }))
      r.contains = await emails(world, cond({ key: 'plan', type: 'text', op: 'contains', value: 'PLUS' }))
      r.over = await emails(world, cond({ key: 'seats', type: 'number', op: 'greater_than', value: 5 }))
      r.under = await emails(world, cond({ key: 'seats', type: 'number', op: 'less_than', value: 5 }))
      r.before = await emails(world, cond({ key: 'renews_on', type: 'date', op: 'less_than', value: '2026-12-31' }))
      r.after = await emails(world, cond({ key: 'renews_on', type: 'date', op: 'greater_than', value: '2026-12-31' }))
      r.isSet = await emails(world, cond({ key: 'plan', type: 'text', op: 'is_set' }))
      r.notSet = await emails(world, cond({ key: 'plan', type: 'text', op: 'is_not_set' }))
      r.vip = await emails(world, cond({ key: 'vip', type: 'boolean', op: 'equals', value: true }))
      r.notVip = await emails(world, cond({ key: 'vip', type: 'boolean', op: 'equals', value: false }))
      r.both = await emails(world, {
        conditions: [
          { key: 'plan', type: 'text', op: 'is_set' },
          { key: 'seats', type: 'number', op: 'greater_than', value: 5 },
        ],
      })
      const rule = cond({ key: 'plan', type: 'text', op: 'not_equals', value: 'pro' })
      counted = await countSegment(world.db, rule)
      resolvedForCount = (await resolveSegment(world.db, rule)).length
    })

    it('matches text exactly with "is"', () => {
      expect(r.equals).toEqual(['pro@example.test'])
    })

    it('includes people with no value in "is not"', () => {
      expect(r.notEquals).toEqual(['bare@example.test', 'odd@example.test', 'team@example.test'])
    })

    it('matches "contains" without regard to case', () => {
      expect(r.contains).toEqual(['team@example.test'])
    })

    it('compares numbers as numbers, and a number stored as text is not over 5', () => {
      expect(r.over).toEqual(['pro@example.test'])
    })

    it('finds the people under a number', () => {
      expect(r.under).toEqual(['team@example.test'])
    })

    it('reads "before" for a date', () => {
      expect(r.before).toEqual(['team@example.test'])
    })

    it('reads "after" for a date', () => {
      expect(r.after).toEqual(['pro@example.test'])
    })

    it('finds who has a value ⭐ and never the person who unsubscribed', () => {
      expect(r.isSet).toEqual(['pro@example.test', 'team@example.test'])
    })

    it('finds who has no value', () => {
      expect(r.notSet).toEqual(['bare@example.test', 'odd@example.test'])
    })

    it('matches yes', () => {
      expect(r.vip).toEqual(['pro@example.test'])
    })

    it('matches no, which is not the same as not set', () => {
      expect(r.notVip).toEqual(['team@example.test'])
    })

    it('requires every condition to hold', () => {
      expect(r.both).toEqual(['pro@example.test'])
    })

    it('counts the same number it would send to', () => {
      expect(counted).toBe(resolvedForCount)
    })

    it('describes itself with the field label', () => {
      expect(
        describeRule(cond({ key: 'seats', type: 'number', op: 'greater_than', value: 5 }), [], [], [
          { key: 'seats', label: 'Seats' },
        ]),
      ).toBe('Active, Seats is over 5')
    })
  })

  describe('Scenario: saving a segment with a field condition through the console', () => {
    let world: World
    let stored: SegmentRule | undefined

    beforeAll(async () => {
      world = createWorld()
      await theFields(world)
      const body = new URLSearchParams()
      body.append('name', 'Big teams')
      body.append('cond_key', 'seats')
      body.append('cond_op', 'greater_than')
      body.append('cond_value', '10')
      body.append('cond_key', '')
      body.append('cond_op', 'equals')
      body.append('cond_value', '')
      await world.fetch('/segments', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      })
      stored = (await world.db.select().from(segments).get())?.rule
    })

    it('stores the condition with its value cast and its type copied from the field', () => {
      expect(stored?.conditions).toEqual([{ key: 'seats', type: 'number', op: 'greater_than', value: 10 }])
    })
  })

  describe('Scenario: a broadcast greets people by their fields', () => {
    let world: World
    let proMail: string
    let bareMail: string

    beforeAll(async () => {
      world = createWorld()
      await anAudience(world)
      const id = await aBroadcast(world, {
        body: 'Your plan: {{plan|free}}. Seats: {{ seats }}. VIP: {{vip|no}}. Unknown: {{nope}}.',
      })
      await startBroadcast(world.env, world.db, id)
      // The deployed entry point drives the send to completion.
      await world.tick()
      proMail = (await world.mailTo('pro@example.test')).text
      bareMail = (await world.mailTo('bare@example.test')).text
    })

    it("fills in the reader's own value", () => {
      expect(proMail).toContain('Your plan: pro.')
    })

    it('renders a number field', () => {
      expect(proMail).toContain('Seats: 12.')
    })

    it('renders a yes/no field as Yes', () => {
      expect(proMail).toContain('VIP: Yes.')
    })

    it('uses the fallback when the reader has no value', () => {
      expect(bareMail).toContain('Your plan: free.')
    })

    it('renders nothing for an empty field with no fallback', () => {
      expect(bareMail).toContain('Seats: .')
    })

    it('leaves a tag that is not a field exactly as written, for the preflight to catch', () => {
      expect(bareMail).toContain('Unknown: {{nope}}.')
    })
  })

  describe('Scenario: a field value carrying markup', () => {
    let world: World
    let html: string

    beforeAll(async () => {
      world = createWorld()
      await theFields(world)
      const p = await aPerson(world, { email: 'x@example.test' })
      await setFieldValues(world.db, p.id, { plan: '<b>pro</b>' })
      const id = await aBroadcast(world, { body: 'Plan {{plan}}' })
      await startBroadcast(world.env, world.db, id)
      html = (await world.mailTo('x@example.test')).html
    })

    it('is escaped in the HTML part', () => {
      expect(html).toContain('&lt;b&gt;pro&lt;/b&gt;')
    })
  })

  describe('Scenario: importing a CSV with field columns', () => {
    let world: World
    let report: ImportReport
    let ada: Subscriber
    let grace: Subscriber

    beforeAll(async () => {
      world = createWorld()
      await theFields(world)
      const existing = await aPerson(world, { email: 'grace@example.test' })
      await setFieldValues(world.db, existing.id, { plan: 'team' })
      report = await importCsv(
        world.db,
        [
          'email,name,Plan,seats,renews_on,favourite_colour',
          'ada@example.test,Ada,pro,lots,2027-01-31,blue',
          'grace@example.test,Grace,,4,2026-02-31,green',
        ].join('\n'),
      )
      ada = (await world.db.select().from(subscribers).where(eq(subscribers.email, 'ada@example.test')).get())!
      grace = await reload(world, existing)
    })

    it('recognises the field columns, by key or by label', () => {
      expect(report.fieldColumns).toEqual(['plan', 'seats', 'renews_on'])
    })

    it('fills a field from its column', () => {
      expect(ada.attributes.plan).toBe('pro')
    })

    it('still imports the person whose row had a bad value', () => {
      expect(report.created).toBe(1)
    })

    it('leaves the bad value out', () => {
      expect('seats' in ada.attributes).toBe(false)
    })

    it('reports each bad value with its row and field', () => {
      expect(report.fieldErrors.map((e) => `${e.row}:${e.field}`)).toEqual(['1:seats', '2:renews_on'])
    })

    it('casts a number cell to a number', () => {
      expect(grace.attributes.seats).toBe(4)
    })

    it('never clears a stored value with an empty cell', () => {
      expect(grace.attributes.plan).toBe('team')
    })

    it('ignores a column that is no field', () => {
      expect('favourite_colour' in ada.attributes).toBe(false)
    })
  })

  describe('Scenario: importing through the console reports bad field values', () => {
    let world: World
    let location: string

    beforeAll(async () => {
      world = createWorld()
      await theFields(world)
      const response = await world.post('/subscribers/import', {
        csv: ['email,seats', 'ada@example.test,lots'].join('\n'),
      })
      location = decodeURIComponent(response.headers.get('location') ?? '')
    })

    it('names the row and the field in the flash message', () => {
      expect(location).toContain('row 1 seats is not a number')
    })
  })

  describe('Scenario: a signup form carries field values', () => {
    let world: World
    let person: Subscriber | undefined

    beforeAll(async () => {
      world = createWorld()
      await theFields(world)
      const formId = await createForm(world.db, { name: 'Newsletter', doubleOptIn: false })
      const form = (await getForm(world.db, formId))!
      await world.post(`/f/${form.slug}`, {
        email: 'ada@example.test',
        plan: 'pro',
        'fields[renews_on]': '2027-01-31',
        seats: 'many',
        is_admin: 'true',
      })
      person = await world.db.select().from(subscribers).where(eq(subscribers.email, 'ada@example.test')).get()
    })

    it('signs them up even though one value was bad', () => {
      expect(person?.status).toBe('active')
    })

    it('sets a field named at the top level', () => {
      expect(person?.attributes.plan).toBe('pro')
    })

    it('sets a field named as fields[key]', () => {
      expect(person?.attributes.renews_on).toBe('2027-01-31')
    })

    it('drops a value that does not fit its type', () => {
      expect(person && 'seats' in person.attributes).toBe(false)
    })

    it('ignores a key that is no field', () => {
      expect(person && 'is_admin' in person.attributes).toBe(false)
    })
  })

  describe('Scenario: deleting a field nobody asks about', () => {
    let world: World
    let person: Subscriber

    beforeAll(async () => {
      world = createWorld()
      const made = await createField(world.db, { label: 'Plan' })
      await createField(world.db, { label: 'Seats', type: 'number' })
      person = await aPerson(world)
      await setFieldValues(world.db, person.id, { plan: 'pro', seats: 2 })
      await world.post(`/fields/${made.ok ? made.field.id : 0}/delete`, {})
      person = await reload(world, person)
    })

    it('removes its values from everyone', () => {
      expect('plan' in person.attributes).toBe(false)
    })

    it('leaves the other fields alone', () => {
      expect(person.attributes.seats).toBe(2)
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: a field that would shadow a built-in merge tag', () => {
    let result: FieldResult

    beforeAll(async () => {
      result = await createField(createWorld().db, { label: 'Email', key: 'email' })
    })

    it('is refused', () => {
      expect(result.ok).toBe(false)
    })
  })

  describe('Scenario: a key that is not a key', () => {
    let result: FieldResult

    beforeAll(async () => {
      result = await createField(createWorld().db, { label: 'x', key: `plan') or 1=1 --` })
    })

    it('is refused', () => {
      expect(result.ok).toBe(false)
    })
  })

  describe('Scenario: a second field with the same key', () => {
    let result: FieldResult

    beforeAll(async () => {
      const db = createWorld().db
      await createField(db, { label: 'Plan' })
      result = await createField(db, { label: 'plan' })
    })

    it('is refused', () => {
      expect(result.ok).toBe(false)
    })
  })

  describe('Scenario: conditions that do not fit the fields', () => {
    let world: World
    const errors: Record<string, boolean> = {}

    beforeAll(async () => {
      world = createWorld()
      await theFields(world)
      errors.unknown = !(await checkConditions(world.db, [{ key: 'nope', op: 'is_set' }])).ok
      errors.op = !(await checkConditions(world.db, [{ key: 'seats', op: 'contains', value: '1' }])).ok
      errors.value = !(await checkConditions(world.db, [{ key: 'seats', op: 'greater_than', value: 'ten' }])).ok
      errors.date = !(await checkConditions(world.db, [{ key: 'renews_on', op: 'less_than', value: '2026-02-31' }])).ok
      errors.empty = !(await checkConditions(world.db, [{ key: 'plan', op: 'equals', value: '' }])).ok
    })

    it('refuses a key that is no field', () => {
      expect(errors.unknown).toBe(true)
    })

    it('refuses an operator that does not suit the type', () => {
      expect(errors.op).toBe(true)
    })

    it('refuses a value that does not cast', () => {
      expect(errors.value).toBe(true)
    })

    it('refuses a date that does not exist', () => {
      expect(errors.date).toBe(true)
    })

    it('refuses a comparison with nothing to compare to', () => {
      expect(errors.empty).toBe(true)
    })
  })

  describe('Scenario: a stored rule tampered with to inject SQL', () => {
    // ⭐ Rules are JSON in a row and can be edited around validation. The WHERE
    // builder re-checks and fails closed: matching nobody, never everybody.
    let world: World
    const counts: Record<string, number> = {}

    beforeAll(async () => {
      world = createWorld()
      await anAudience(world)
      const evil = (c: object) => countSegment(world.db, { conditions: [c as FieldCondition] })
      counts.key = await evil({ key: "plan') or 1=1 --", type: 'text', op: 'is_not_set' })
      counts.path = await evil({ key: 'plan.x', type: 'text', op: 'is_not_set' })
      counts.op = await evil({ key: 'plan', type: 'text', op: 'or 1=1' })
      counts.mismatch = await evil({ key: 'plan', type: 'text', op: 'greater_than', value: 'a' })
      counts.value = await evil({ key: 'seats', type: 'number', op: 'greater_than', value: '0 or 1=1' })
      counts.like = await countSegment(world.db, cond({ key: 'plan', type: 'text', op: 'contains', value: '%' }))
    })

    it('matches nobody when the key is not a key', () => {
      expect(counts.key).toBe(0)
    })

    it('matches nobody when the key would reach into a nested path', () => {
      expect(counts.path).toBe(0)
    })

    it('matches nobody for an operator it does not know', () => {
      expect(counts.op).toBe(0)
    })

    it('matches nobody for an operator the type does not allow', () => {
      expect(counts.mismatch).toBe(0)
    })

    it('matches nobody for a value of the wrong kind', () => {
      expect(counts.value).toBe(0)
    })

    it('treats % in "contains" as a character, not a wildcard', () => {
      expect(counts.like).toBe(0)
    })
  })

  describe('Scenario: deleting a field a saved segment still asks about', () => {
    // ⭐ Stripping the values under a live "is not set" rule would turn
    // "people without a plan" into everybody.
    let world: World
    let refused: boolean
    let stillThere: boolean

    beforeAll(async () => {
      world = createWorld()
      const made = await createField(world.db, { label: 'Plan' })
      await createSegment(world.db, 'No plan', cond({ key: 'plan', type: 'text', op: 'is_not_set' }))
      const result = await deleteField(world.db, made.ok ? made.field.id : 0)
      refused = !result.ok
      stillThere = Boolean(await world.db.select().from(customFields).get())
    })

    it('is refused', () => {
      expect(refused).toBe(true)
    })

    it('keeps the field', () => {
      expect(stillThere).toBe(true)
    })
  })

  describe('Scenario: deleting a field an unsent broadcast still asks about', () => {
    let world: World
    let refused: boolean

    beforeAll(async () => {
      world = createWorld()
      const made = await createField(world.db, { label: 'Plan' })
      await aBroadcast(world, { segment: cond({ key: 'plan', type: 'text', op: 'equals', value: 'pro' }) })
      refused = !(await deleteField(world.db, made.ok ? made.field.id : 0)).ok
    })

    it('is refused', () => {
      expect(refused).toBe(true)
    })
  })
})
