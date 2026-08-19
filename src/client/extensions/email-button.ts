import { Node, mergeAttributes } from '@tiptap/core'

/**
 * A call-to-action button — the one thing every marketing email needs and no
 * generic editor ships.
 *
 * The label is inline *content* rather than an attribute, so it's typed directly
 * in the document (marks, merge tags and all) instead of through a modal. The
 * URL is an attribute, edited from the bubble menu when the node is selected.
 *
 * The server renders this as a nested table — see `core/render-doc.ts`.
 */
export const EmailButton = Node.create({
  name: 'emailButton',
  group: 'block',
  content: 'inline*',
  defining: true,

  addAttributes() {
    return {
      href: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-href') ?? '',
        renderHTML: (attrs) => ({ 'data-href': attrs.href as string }),
      },
      background: {
        default: '#1f6f5c',
        parseHTML: (el) => el.getAttribute('data-background') ?? '#1f6f5c',
        renderHTML: (attrs) => ({ 'data-background': attrs.background as string }),
      },
      align: {
        default: 'left',
        parseHTML: (el) => el.getAttribute('data-align') ?? 'left',
        renderHTML: (attrs) => ({ 'data-align': attrs.align as string }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="email-button"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-type': 'email-button', class: 'bm-button' }),
      0,
    ]
  },

  addNodeView() {
    return ({ node, HTMLAttributes }) => {
      const dom = document.createElement('div')
      dom.className = 'bm-button-wrap'
      dom.setAttribute('data-align', node.attrs.align as string)

      const button = document.createElement('div')
      button.className = 'bm-button'
      button.style.background = node.attrs.background as string
      Object.entries(HTMLAttributes).forEach(([k, v]) => {
        if (k !== 'class') dom.setAttribute(k, String(v))
      })

      const hint = document.createElement('span')
      hint.className = 'bm-button-hint'
      hint.contentEditable = 'false'
      hint.textContent = node.attrs.href ? '' : 'no link set'

      dom.append(button, hint)
      return { dom, contentDOM: button }
    }
  },

  addCommands() {
    return {
      setEmailButton:
        (attrs: { href?: string; label?: string } = {}) =>
        ({ chain }) =>
          chain()
            .insertContent({
              type: this.name,
              attrs: { href: attrs.href ?? '' },
              content: [{ type: 'text', text: attrs.label ?? 'Read the post' }],
            })
            .run(),
    }
  },
})

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    emailButton: {
      setEmailButton: (attrs?: { href?: string; label?: string }) => ReturnType
    }
  }
}
