// The masthead — a broadcast opens like a post: title, lead, share row
//
// Substack's shape. The title and the lead the operator wrote sit at the top,
// then a row of share buttons and "Read online" between two hairlines. Mail that
// reads as a letter (a sequence step, a receipt) gets none of it, and a mail with
// no published post gets no share row, because there would be nothing to share.
import { beforeAll, describe, expect, it } from 'bun:test'
import { authoredLead } from '../../src/core/posts.ts'
import { type RenderContext, renderEmail } from '../../src/core/render.ts'

const BODY = { md: 'Last week I opened a search result and got nothing.\n\nThe rest of it.' }
const POST = 'https://site.example.test/garbage-patch'

function ctx(over: Partial<RenderContext> = {}): RenderContext {
  return {
    publicUrl: 'https://mail.example.test',
    messageId: 1,
    unsubToken: 'tok',
    scope: { kind: 'broadcast' },
    scopeLabel: 'the newsletter',
    subscriber: { email: 'ada@example.test', name: 'Ada' },
    trackOpens: false,
    trackClicks: false,
    showFooter: true,
    subject: 'The Great Internet Garbage Patch',
    ...over,
  }
}

describe('Feature: the masthead', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: a published broadcast with a written lead', () => {
    let html: string
    let text: string

    beforeAll(() => {
      const r = renderEmail(
        BODY,
        ctx({ title: 'The Great Internet Garbage Patch', lead: 'Slop is choking the web.', postUrl: POST }),
      )
      html = r.html
      text = r.text
    })

    it('opens with the title as a headline', () => {
      expect(html).toContain('>The Great Internet Garbage Patch</h1>')
    })

    it('puts the lead under it', () => {
      expect(html).toContain('>Slop is choking the web.</p>')
    })

    it('uses the lead as the hidden inbox preview', () => {
      expect(html).toMatch(/<div style="display:none[^>]*>Slop is choking the web\./)
    })

    it('offers a share on X', () => {
      expect(html).toContain('https://x.com/intent/post?')
    })

    it('offers a share on LinkedIn', () => {
      expect(html).toContain(
        `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(POST)}`,
      )
    })

    it('loads the share icons from the public site, not the console behind Access', () => {
      expect(html).toContain('src="https://site.example.test/img/email/share-x.png"')
    })

    it('links "Read online" to the post', () => {
      expect(html).toContain(`<a href="${POST}" style="display:inline-block`)
    })

    it('invites a forwarded reader to subscribe', () => {
      expect(html).toContain('href="https://site.example.test/subscribe"')
    })

    it('carries the title and lead into the plain-text part', () => {
      expect(text.startsWith('The Great Internet Garbage Patch\nSlop is choking the web.\n')).toBe(true)
    })
  })

  // ───────────────────────────────────────────── sad paths

  describe('Scenario: a broadcast that is not on the web', () => {
    let html: string

    beforeAll(() => {
      html = renderEmail(BODY, ctx({ title: 'Just for the list', postUrl: null })).html
    })

    it('still carries the title', () => {
      expect(html).toContain('>Just for the list</h1>')
    })

    it('has no share row to point at a 404', () => {
      expect(html).not.toContain('share-x.png')
    })
  })

  describe('Scenario: a sequence step', () => {
    let html: string

    beforeAll(() => {
      html = renderEmail(
        BODY,
        ctx({ scope: { kind: 'sequence', sequenceId: 1 }, scopeLabel: 'Welcome' }),
      ).html
    })

    it('reads as a letter, with no headline', () => {
      expect(html).not.toContain('<h1')
    })
  })

  describe('Scenario: an excerpt the publisher derived from the body', () => {
    it('is not shown as a lead, so the opening sentence is not said twice', () => {
      expect(authoredLead('Last week I opened a search result and got nothing. The rest…', BODY)).toBeNull()
    })
  })

  describe('Scenario: an excerpt the operator wrote', () => {
    it('is the lead', () => {
      expect(authoredLead('Slop is choking the web.', BODY)).toBe('Slop is choking the web.')
    })
  })

  describe('Scenario: no excerpt at all', () => {
    it('gives no lead', () => {
      expect(authoredLead(null, BODY)).toBeNull()
    })
  })
})
