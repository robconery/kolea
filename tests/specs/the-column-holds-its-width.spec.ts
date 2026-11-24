// The column holds its width — nothing in the body can widen the mail
//
// The mail is a table, and a table grows to fit the widest thing in it that
// cannot break. One code block holding a paragraph typed as a single line was
// enough to widen the whole column, and every paragraph in the mail ran off the
// right edge of the reader's window with it. The column's width has to come from
// the shell, never from the content.
import { beforeAll, describe, expect, it } from 'bun:test'
import type { DocNode } from '../../src/db/schema.ts'
import { type RenderContext, renderEmail } from '../../src/core/render.ts'

const LONG_LINE = 'One of the things I am missing here is a product owner. '.repeat(12).trim()

const DOC: DocNode = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Here is the prompt I used:' }] },
    { type: 'codeBlock', content: [{ type: 'text', text: LONG_LINE }] },
  ],
}

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
    subject: 'Why I stopped writing exacting prompts',
    ...over,
  }
}

/** The opening tag of the first element of that name, attributes and all. */
function openingTag(html: string, name: string): string {
  return new RegExp(`<${name}\\b[^>]*>`).exec(html)?.[0] ?? ''
}

describe('Feature: the column holds its width', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: a code block holding one very long line', () => {
    let pre: string
    let code: string

    beforeAll(() => {
      const { html } = renderEmail({ json: DOC, md: '' }, ctx())
      pre = openingTag(html, 'pre')
      code = openingTag(html, 'code')
    })

    it('wraps the block', () => {
      expect(pre).toContain('white-space:pre-wrap')
    })

    it('wraps the code inside it', () => {
      expect(code).toContain('white-space:pre-wrap')
    })

    it('never asks for an unbroken line', () => {
      expect(`${pre}${code}`).not.toMatch(/white-space:(pre|nowrap)[;"]/)
    })

    it('breaks a word that is wider than the column', () => {
      expect(code).toContain('overflow-wrap:anywhere')
    })
  })

  describe('Scenario: the shell around any body', () => {
    let column: string

    beforeAll(() => {
      const { html } = renderEmail({ json: DOC, md: '' }, ctx())
      column = /<table[^>]*max-width:620px[^>]*>/.exec(html)?.[0] ?? ''
    })

    it('fixes the layout of the column, so content cannot set its width', () => {
      expect(column).toContain('table-layout:fixed')
    })

    it('keeps the column at reading width', () => {
      expect(column).toContain('max-width:620px')
    })
  })
})
