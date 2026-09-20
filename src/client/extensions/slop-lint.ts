import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { type Block, type Hit, type Report, findSlop } from '../../slop/index.ts'

/**
 * Underlines slop in the draft, as it is written.
 *
 * All the judgement lives in `src/slop/` — a dependency-free module that knows
 * nothing about editors. This file is the adapter: it turns the document into
 * the blocks that module reads, and turns the character ranges it answers with
 * back into document positions.
 *
 * The mapping is exact because each block's text is built here, one document
 * position per character: text is itself, and an inline atom (a merge tag, a
 * hard break) becomes a single placeholder. So `block start + 1 + offset` is
 * the position, with no searching and nothing to drift.
 *
 * Quotes and code are skipped at the walk. Somebody else's words are not the
 * writer's slop, and a code listing is not prose.
 *
 * Decorations only — nothing here ever touches the document, so it cannot
 * dirty a draft, trigger an autosave, or end up in the mail.
 */

export interface LocatedHit extends Hit {
  from: number
  to: number
}

export interface SlopState {
  report: Report
  hits: LocatedHit[]
}

export interface SlopLintOptions {
  enabled: boolean
  /** Called with every fresh reading, including the first. */
  onReport: (state: SlopState) => void
}

const key = new PluginKey<{ decos: DecorationSet }>('slopLint')

/** Long enough that a word being typed isn't judged halfway through. */
const SETTLE_MS = 350

/** Stands in for an inline atom, so offsets and positions stay in step. */
const ATOM = '￼'

const SKIP = new Set(['codeBlock', 'blockquote'])
const ITEMS = new Set(['listItem', 'taskItem'])

export function readSlop(doc: PMNode): SlopState {
  const blocks: Block[] = []
  const starts: number[] = []

  doc.descendants((node, pos, parent) => {
    if (SKIP.has(node.type.name)) return false
    if (!node.isTextblock) return true

    let text = ''
    let leadBold = 0
    let leading = true
    node.forEach((child) => {
      if (!child.isText) {
        text += ATOM.repeat(child.nodeSize)
        leading = false
        return
      }
      const t = child.text ?? ''
      const marks = child.marks.map((m) => m.type.name)
      if (leading && marks.includes('bold')) leadBold += t.length
      else leading = false
      // Inline code is an identifier, not a word choice.
      text += marks.includes('code') ? ATOM.repeat(t.length) : t
    })

    blocks.push({
      text,
      leadBold,
      kind: node.type.name === 'heading' ? 'heading' : ITEMS.has(parent?.type.name ?? '') ? 'listItem' : 'paragraph',
    })
    starts.push(pos + 1)
    return false
  })

  const report = findSlop(blocks)
  const hits = report.hits.map((h) => {
    const base = starts[h.block] ?? 0
    return { ...h, from: base + h.start, to: base + h.end }
  })
  return { report, hits }
}

export const SlopLint = Extension.create<SlopLintOptions>({
  name: 'slopLint',

  addOptions() {
    return { enabled: false, onReport: () => {} }
  },

  addProseMirrorPlugins() {
    if (!this.options.enabled) return []
    const { onReport } = this.options

    return [
      new Plugin({
        key,
        state: {
          init: () => ({ decos: DecorationSet.empty }),
          apply(tr, prev) {
            const next = tr.getMeta(key) as DecorationSet | undefined
            if (next) return { decos: next }
            // Between readings the underlines ride along with the edits, so
            // they stay under the right words while the writer keeps typing.
            return tr.docChanged ? { decos: prev.decos.map(tr.mapping, tr.doc) } : prev
          },
        },
        props: {
          decorations: (state) => key.getState(state)?.decos,
        },
        view(view) {
          let timer = 0
          const read = () => {
            timer = 0
            const state = readSlop(view.state.doc)
            const decos = state.hits.map((h) =>
              Decoration.inline(h.from, h.to, {
                class: `bm-slop bm-slop-w${h.weight}`,
                'data-slop-label': h.label,
                'data-slop-why': h.why,
              }),
            )
            view.dispatch(view.state.tr.setMeta(key, DecorationSet.create(view.state.doc, decos)))
            onReport(state)
          }
          // After the editor has finished mounting: dispatching from inside
          // the plugin's own construction is a re-entrant update.
          timer = window.setTimeout(read, 0)
          return {
            update(v, prev) {
              if (v.state.doc.eq(prev.doc)) return
              if (timer) clearTimeout(timer)
              timer = window.setTimeout(read, SETTLE_MS)
            },
            destroy() {
              if (timer) clearTimeout(timer)
            },
          }
        },
      }),
    ]
  },
})
