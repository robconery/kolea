// The frame around a mail's body: the headline, the reason line and the
// sender's postal address. The reader should be told who is writing to them,
// by name, and where that sender can be found.
import { beforeAll, describe, expect, it } from 'bun:test'
import { type RenderedEmail, renderEmail } from '../../src/core/render.ts'

const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello.' }] }] }
const base = {
  publicUrl: 'https://list.example.test',
  messageId: 7,
  unsubToken: 'token',
  subscriber: { email: 'reader@example.test', name: null },
  trackOpens: false,
  trackClicks: false,
  showFooter: true,
}

describe('Feature: the footer says who is writing and where they are', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: a broadcast from a named publication with an address', () => {
    let mail: RenderedEmail

    beforeAll(() => {
      mail = renderEmail(
        { json: doc, md: '' },
        {
          ...base,
          scope: { kind: 'broadcast' },
          scopeLabel: 'the newsletter',
          accountName: 'Field Notes',
          postalAddress: '1 Example Road\nSpringfield',
          subject: 'This week',
          title: 'This week',
        },
      )
    })

    it('names the publication they subscribed to', () => {
      expect(mail.html).toContain('subscribed to <strong>Field Notes</strong>')
    })

    it('prints the postal address, one line per line', () => {
      expect(mail.html).toContain('1 Example Road<br>Springfield')
    })

    it('prints the address in the plaintext part too', () => {
      expect(mail.text).toContain('1 Example Road\nSpringfield')
    })

    it('sets the headline in the same sans face as the body', () => {
      expect(mail.html).toMatch(/<h1 style="[^"]*font-family:-apple-system[^"]*font-size:32px/)
    })

    it('sets body copy at 17 pixels', () => {
      expect(mail.html).toMatch(/<p style="margin:0 0 22px;[^"]*font-size:17px;line-height:1.65/)
    })
  })

  describe('Scenario: a sequence step from a named publication', () => {
    let mail: RenderedEmail

    beforeAll(() => {
      mail = renderEmail(
        { json: doc, md: '' },
        { ...base, scope: { kind: 'sequence', sequenceId: 1 }, scopeLabel: 'Welcome', accountName: 'Field Notes' },
      )
    })

    it('says which series they joined, and whose it is', () => {
      expect(mail.html).toContain('joined <strong>Welcome</strong> from Field Notes.')
    })

    it('carries no headline, because it reads as a letter', () => {
      expect(mail.html).not.toContain('<h1')
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: no publication name and no address are set', () => {
    let mail: RenderedEmail

    beforeAll(() => {
      mail = renderEmail({ json: doc, md: '' }, { ...base, scope: { kind: 'broadcast' }, scopeLabel: 'the newsletter' })
    })

    it('falls back to naming the newsletter', () => {
      expect(mail.html).toContain('subscribed to <strong>the newsletter</strong>')
    })

    it('leaves the address line out rather than printing an empty one', () => {
      expect(mail.html).not.toContain('<p style="margin:0"></p>')
    })
  })
})
