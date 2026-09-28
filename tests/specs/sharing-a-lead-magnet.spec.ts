// Sharing a lead magnet directly
//
// A form's file normally reaches people one way: they sign up, and the reply
// carries a link that is theirs alone. The writer also wants to hand the file to
// somebody themselves — a friend, a podcast host, a reply to a support mail —
// without sending them through the form. So every attached file has one direct
// link, shown wherever the file is shown. It serves the file to whoever holds
// it, is counted on the form (it cannot say who), survives a replaced file, and
// can be reset without touching the links already mailed to subscribers.
import { beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { downloadUrl, grantDownload } from '../../src/core/downloads.ts'
import { createForm, getForm } from '../../src/core/forms.ts'
import { downloadGrants, forms } from '../../src/db/schema.ts'
import { aPerson } from '../support/factories.ts'
import { PUBLIC_URL, createWorld, type World } from '../support/world.ts'

const BYTES = new TextEncoder().encode('%PDF-1.7 the toolkit')

async function upload(world: World, formId: number, filename = 'toolkit.pdf'): Promise<Response> {
  const res = await world.fetch(`/api/forms/${formId}/file?filename=${filename}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/pdf' },
    body: BYTES,
  })
  // The in-memory bucket can't drain a request stream, so the bytes are put
  // where the upload said they went. The rows are the ones the route wrote.
  const form = await getForm(world.db, formId)
  await world.env.DOWNLOADS.put(form!.downloadKey!, BYTES)
  return res
}

async function aFormWithAFile(world: World): Promise<{ id: number; link: string }> {
  const id = await createForm(world.db, { name: 'Toolkit' })
  await upload(world, id)
  const form = await getForm(world.db, id)
  return { id, link: `/d/${form!.downloadShareToken}` }
}

describe('Feature: sharing a lead magnet directly', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: the writer attaches a file to a form', () => {
    let uploaded: { url: string | null }
    let expected: string
    let page: string
    let list: string

    beforeAll(async () => {
      const world = createWorld()
      const id = await createForm(world.db, { name: 'Toolkit' })
      uploaded = (await (await upload(world, id)).json()) as { url: string | null }
      const form = await getForm(world.db, id)
      expected = downloadUrl(PUBLIC_URL, form!.downloadShareToken ?? 'missing')
      page = await (await world.fetch(`/forms/${id}`)).text()
      list = await (await world.fetch('/forms')).text()
    })

    it('answers the upload with the direct link', () => {
      expect(uploaded.url).toBe(expected)
    })

    it("shows the direct link on the form's page", () => {
      expect(page).toContain(`value="${expected}"`)
    })

    it('offers the direct link in the list of forms', () => {
      expect(list).toContain(`data-copy="${expected}"`)
    })
  })

  describe('Scenario: somebody follows the direct link', () => {
    let world: World
    let id: number
    let res: Response
    let body: string

    beforeAll(async () => {
      world = createWorld()
      const made = await aFormWithAFile(world)
      id = made.id
      res = await world.fetch(made.link)
      body = await res.text()
    })

    it('hands over the file', () => {
      expect(body).toBe('%PDF-1.7 the toolkit')
    })

    it('saves it under the name it was uploaded with', () => {
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="toolkit.pdf"')
    })

    it('keeps it out of every shared cache', () => {
      expect(res.headers.get('cache-control')).toBe('private, no-store')
    })

    it('⭐ counts the download on the form', async () => {
      expect((await getForm(world.db, id))?.downloadShareCount).toBe(1)
    })

    it('issues no personal link for it', async () => {
      expect(await world.db.select().from(downloadGrants).all()).toHaveLength(0)
    })
  })

  describe('Scenario: the writer replaces the file', () => {
    let before: string
    let after: string

    beforeAll(async () => {
      const world = createWorld()
      const made = await aFormWithAFile(world)
      before = made.link
      await upload(world, made.id, 'toolkit-v2.pdf')
      after = `/d/${(await getForm(world.db, made.id))?.downloadShareToken}`
    })

    it('keeps the direct link that was already sent out', () => {
      expect(after).toBe(before)
    })
  })

  describe('Scenario: the file was attached before direct links existed', () => {
    let world: World
    let first: string
    let second: string

    const linkOn = (page: string) => /id="direct-link"[\s\S]*?value="([^"]+)"/.exec(page)?.[1] ?? ''

    beforeAll(async () => {
      world = createWorld()
      const { id } = await aFormWithAFile(world)
      await world.db.update(forms).set({ downloadShareToken: null }).where(eq(forms.id, id))
      first = linkOn(await (await world.fetch(`/forms/${id}`)).text())
      second = linkOn(await (await world.fetch(`/forms/${id}`)).text())
    })

    it('gives it one the first time the form is opened', () => {
      expect(first).toStartWith(`${PUBLIC_URL}/d/`)
    })

    it('shows the same one every time after', () => {
      expect(second).toBe(first)
    })

    it('serves the file from it', async () => {
      expect((await world.fetch(first)).status).toBe(200)
    })
  })

  // ───────────────────────────────────────────── sad paths

  describe('Scenario: the writer resets a direct link that travelled too far', () => {
    let world: World
    let old: string
    let fresh: string
    let personal: string

    beforeAll(async () => {
      world = createWorld()
      const made = await aFormWithAFile(world)
      old = made.link
      const ada = await aPerson(world, { email: 'ada@example.test' })
      personal = `/d/${await grantDownload(world.db, made.id, ada.id)}`
      await world.post(`/forms/${made.id}/file/link/reset`, {})
      fresh = `/d/${(await getForm(world.db, made.id))?.downloadShareToken}`
    })

    it('⭐ stops serving the old link', async () => {
      expect((await world.fetch(old)).status).toBe(404)
    })

    it('serves the new one', async () => {
      expect((await world.fetch(fresh)).status).toBe(200)
    })

    it("leaves a subscriber's own link working", async () => {
      expect((await world.fetch(personal)).status).toBe(200)
    })
  })

  describe('Scenario: the writer removes the file', () => {
    let world: World
    let link: string

    beforeAll(async () => {
      world = createWorld()
      const made = await aFormWithAFile(world)
      link = made.link
      await world.post(`/forms/${made.id}/file/delete`, {})
    })

    it('⭐ stops serving the direct link', async () => {
      expect((await world.fetch(link)).status).toBe(404)
    })
  })

  describe('Scenario: somebody guesses at a link', () => {
    it('finds nothing', async () => {
      const world = createWorld()
      await aFormWithAFile(world)
      expect((await world.fetch('/d/not-a-real-token')).status).toBe(404)
    })
  })
})
