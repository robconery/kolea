import { Node, mergeAttributes } from '@tiptap/core'
import Suggestion from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'

export interface MergeField {
  field: string
  label: string
  sample: string
}

/**
 * Personalization fields, as real nodes rather than raw `{{first_name}}` text.
 *
 * Typing them by hand is how you ship an email that says "Hi {{frist_name}}" to
 * twenty-five thousand people. As a node, the field name can't be misspelled and
 * the editor can show the sample value inline.
 */
export const MERGE_FIELDS: MergeField[] = [
  { field: 'first_name', label: 'First name', sample: 'Ada' },
  { field: 'name', label: 'Full name', sample: 'Ada Lovelace' },
  { field: 'email', label: 'Email address', sample: 'ada@example.com' },
]

export const MergeTag = Node.create({
  name: 'mergeTag',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      field: {
        default: 'first_name',
        parseHTML: (el) => el.getAttribute('data-field'),
        renderHTML: (attrs) => ({ 'data-field': attrs.field as string }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="merge-tag"]' }]
  },

  renderHTML({ HTMLAttributes, node }) {
    const def = MERGE_FIELDS.find((f) => f.field === node.attrs.field)
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-type': 'merge-tag', class: 'bm-merge' }),
      def?.label ?? String(node.attrs.field),
    ]
  },

  renderText({ node }) {
    return `{{${node.attrs.field}}}`
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        char: '@',
        pluginKey: new PluginKey('mergeTagSuggestion'),
        allowSpaces: false,
        items: ({ query }) =>
          MERGE_FIELDS.filter((f) =>
            `${f.label} ${f.field}`.toLowerCase().includes(query.toLowerCase()),
          ),
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              { type: 'mergeTag', attrs: { field: (props as MergeField).field } },
              { type: 'text', text: ' ' },
            ])
            .run()
        },
        render: () => makeDropdown((item: MergeField) => ({
          title: item.label,
          subtitle: `{{${item.field}}}, e.g. ${item.sample}`,
          icon: '◆',
        })),
      }),
    ]
  },
})

/**
 * Shared keyboard-navigable dropdown for both suggestion menus.
 * Positioned manually; Floating UI would work too but this needs no extra dep.
 */
export function makeDropdown<T>(
  present: (item: T) => { title: string; subtitle?: string; icon?: string },
) {
  let el: HTMLDivElement | null = null
  let selected = 0
  let currentItems: T[] = []
  let onPick: ((item: T) => void) | null = null

  const paint = () => {
    if (!el) return
    el.innerHTML = ''
    if (currentItems.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'bm-menu-empty'
      empty.textContent = 'No matches'
      el.append(empty)
      return
    }
    currentItems.forEach((item, i) => {
      const p = present(item)
      const row = document.createElement('button')
      row.type = 'button'
      row.className = `bm-menu-item${i === selected ? ' on' : ''}`
      row.innerHTML = `<span class="bm-menu-icon">${p.icon ?? '•'}</span><span class="bm-menu-text"><span class="bm-menu-title"></span>${p.subtitle ? '<span class="bm-menu-sub"></span>' : ''}</span>`
      row.querySelector('.bm-menu-title')!.textContent = p.title
      if (p.subtitle) row.querySelector('.bm-menu-sub')!.textContent = p.subtitle
      row.addEventListener('mousedown', (e) => {
        e.preventDefault()
        onPick?.(item)
      })
      el!.append(row)
    })
  }

  const place = (rect: DOMRect | null) => {
    if (!el || !rect) return
    // Flip above the caret when there isn't room below.
    const below = window.innerHeight - rect.bottom
    const height = el.offsetHeight || 240
    el.style.left = `${Math.min(rect.left, window.innerWidth - 320)}px`
    el.style.top = below < height + 16 ? `${rect.top - height - 6}px` : `${rect.bottom + 6}px`
  }

  return {
    onStart: (props: { items: T[]; command: (i: T) => void; clientRect?: (() => DOMRect | null) | null }) => {
      selected = 0
      currentItems = props.items
      onPick = props.command
      el = document.createElement('div')
      el.className = 'bm-menu'
      document.body.append(el)
      paint()
      place(props.clientRect?.() ?? null)
    },
    onUpdate: (props: { items: T[]; command: (i: T) => void; clientRect?: (() => DOMRect | null) | null }) => {
      currentItems = props.items
      onPick = props.command
      selected = 0
      paint()
      place(props.clientRect?.() ?? null)
    },
    onKeyDown: (props: { event: KeyboardEvent }) => {
      if (!el || currentItems.length === 0) return false
      const { key } = props.event
      if (key === 'ArrowDown') {
        selected = (selected + 1) % currentItems.length
        paint()
        return true
      }
      if (key === 'ArrowUp') {
        selected = (selected - 1 + currentItems.length) % currentItems.length
        paint()
        return true
      }
      if (key === 'Enter' || key === 'Tab') {
        onPick?.(currentItems[selected]!)
        return true
      }
      if (key === 'Escape') {
        el.remove()
        el = null
        return true
      }
      return false
    },
    onExit: () => {
      el?.remove()
      el = null
    },
  }
}
