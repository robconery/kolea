import { Editor, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder, TrailingNode } from '@tiptap/extensions'
import { BubbleMenu } from '@tiptap/extension-bubble-menu'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details'
import DragHandle from '@tiptap/extension-drag-handle'
import FileHandler from '@tiptap/extension-file-handler'
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import NodeRange from '@tiptap/extension-node-range'
import { TableKit } from '@tiptap/extension-table'
import TextAlign from '@tiptap/extension-text-align'
import Typography from '@tiptap/extension-typography'
import Youtube from '@tiptap/extension-youtube'
import { createLowlight } from 'lowlight'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import elixir from 'highlight.js/lib/languages/elixir'
import go from 'highlight.js/lib/languages/go'
import js from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import md from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import ts from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

import { EmailButton } from './extensions/email-button.ts'
import { MergeTag } from './extensions/merge-tag.ts'
import { SlashMenu, pickAndUploadImage, uploadImage } from './extensions/slash-menu.ts'
import { SlopLint, type SlopState } from './extensions/slop-lint.ts'
import { buildBubbleMenu } from './bubble-menu.ts'
import { attachComposer, markDirty } from './composer.ts'
import { attachSlopPanel } from './slop-panel.ts'

// A curated language set rather than lowlight's `common`, which drags in ~40
// grammars and roughly doubles the bundle. One line per language to add more.
const lowlight = createLowlight({
  bash,
  css,
  diff,
  elixir,
  go,
  javascript: js,
  json,
  markdown: md,
  python,
  ruby,
  rust,
  sql,
  typescript: ts,
  xml,
  yaml,
})

/**
 * Mounts a TipTap editor over a hidden textarea.
 *
 * The form still posts a plain field, so the server contract is unchanged and the
 * page degrades to a textarea if this bundle fails to load — which matters when
 * the alternative is being unable to write an email at all.
 */
function mount(host: HTMLElement): void {
  const fieldName = host.dataset.field ?? 'body_json'
  const form = host.closest('form')
  const hidden = form?.querySelector<HTMLInputElement>(`input[name="${fieldName}"]`)
  const initial = hidden?.value?.trim()

  const editorEl = document.createElement('div')
  editorEl.className = 'bm-editor'
  host.append(editorEl)

  // The slop reader starts with the editor, and the panel it reports to is
  // built just after — so its readings go through a slot filled in below.
  let reportSlop: (state: SlopState) => void = () => {}

  const toolbar = document.createElement('div')
  toolbar.className = 'bm-bubble'
  document.body.append(toolbar)

  const editor = new Editor({
    element: editorEl,
    extensions: [
      // Nodes and marks first — the same set the read-only view uses.
      ...docExtensions(),
      TableKit.configure({ table: { resizable: true } }),
      Placeholder.configure({
        placeholder: ({ node }) =>
          node.type.name === 'heading'
            ? 'Heading'
            : "Write something. Press '/' for blocks, '@' to personalize.",
      }),
      TrailingNode,
      Typography,
      // Block-style editing: drag to reorder, multi-block selection.
      DragHandle.configure({ render: renderDragHandle }),
      NodeRange,
      SlashMenu,
      // Only where the page asks for it: a receipt needs no writing coach.
      SlopLint.configure({ enabled: Boolean(form?.dataset.slop), onReport: (s) => reportSlop(s) }),
      BubbleMenu.configure({
        element: toolbar,
        // Hide over code blocks and images, where inline formatting is meaningless.
        shouldShow: ({ editor: e, state }) => {
          if (e.isActive('codeBlock') || e.isActive('image')) return false
          return !state.selection.empty || e.isActive('emailButton')
        },
      }),
      FileHandler.configure({
        allowedMimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'],
        onDrop: (currentEditor, files) => {
          for (const file of files) void uploadImage(currentEditor, file)
        },
        onPaste: (currentEditor, files, htmlContent) => {
          // Pasted HTML that references an image should stay HTML, not re-upload.
          if (htmlContent) return false
          for (const file of files) void uploadImage(currentEditor, file)
          return true
        },
      }),
    ],
    content: initial ? safeParse(initial) : undefined,
    editorProps: {
      attributes: { class: 'bm-prose' },
    },
    onUpdate: ({ editor: e }) => {
      if (hidden) hidden.value = JSON.stringify(e.getJSON())
      markDirty()
    },
  })

  buildBubbleMenu(toolbar, editor)
  buildToolbar(host, editor)

  // The consent footer ships in the page beside the host and moves inside it,
  // under the editor, so the sheet the writer sees is the whole mail — text and
  // footer on one piece of paper, exactly as it lands.
  const mailFoot = host.parentElement?.querySelector<HTMLElement>('.bm-mailfoot')
  if (mailFoot) host.append(mailFoot)

  // Autosave and the preview dialog live on the form, not the editor; all they
  // need from here is a way to flush the document into the field they post.
  if (form) {
    const sync = () => {
      if (hidden) hidden.value = JSON.stringify(editor.getJSON())
    }
    attachComposer(form, sync)
    if (form.dataset.slop) reportSlop = attachSlopPanel(host, editor, form).onReport
  }

  // Belt and braces: sync on submit too, in case a command mutated the doc
  // without firing onUpdate.
  form?.addEventListener('submit', () => {
    if (hidden) hidden.value = JSON.stringify(editor.getJSON())
  })
}

function renderDragHandle(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'bm-drag'
  el.innerHTML =
    '<svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true"><g fill="currentColor">' +
    [2, 7, 12].map((y) => `<circle cx="3" cy="${y}" r="1.4"/><circle cx="9" cy="${y}" r="1.4"/>`).join('') +
    '</g></svg>'
  el.title = 'Drag to move · click to select'
  return el
}

/** Persistent toolbar above the editor for the things worth one click. */
function buildToolbar(host: HTMLElement, editor: Editor): void {
  const bar = document.createElement('div')
  bar.className = 'bm-toolbar'

  const group = (...nodes: HTMLElement[]) => {
    const g = document.createElement('div')
    g.className = 'bm-tb-group'
    g.append(...nodes)
    return g
  }

  const btn = (label: string, title: string, run: () => void, active?: () => boolean) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'bm-tb'
    b.title = title
    b.innerHTML = label
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', () => {
      run()
      refresh()
    })
    if (active) actives.push([b, active])
    return b
  }

  const actives: [HTMLElement, () => boolean][] = []
  /**
   * Lighting up the active buttons means ~25 `isActive()` queries, each of which
   * walks the selection. Run at most one sweep per animation frame: a keystroke
   * that changes nothing about the marks under the cursor then costs nothing,
   * and typing stays ahead of the fingers.
   */
  let queued = 0
  const refresh = () => {
    if (queued) return
    queued = requestAnimationFrame(() => {
      queued = 0
      for (const [el, is] of actives) el.classList.toggle('on', is())
    })
  }

  bar.append(
    group(
      btn('<b>B</b>', 'Bold  ⌘B', () => editor.chain().focus().toggleBold().run(), () => editor.isActive('bold')),
      btn('<i>I</i>', 'Italic  ⌘I', () => editor.chain().focus().toggleItalic().run(), () => editor.isActive('italic')),
      btn('<s>S</s>', 'Strikethrough', () => editor.chain().focus().toggleStrike().run(), () => editor.isActive('strike')),
      btn('<code>&lt;&gt;</code>', 'Inline code', () => editor.chain().focus().toggleCode().run(), () => editor.isActive('code')),
      btn('<span class="bm-hl">A</span>', 'Highlight', () => editor.chain().focus().toggleHighlight().run(), () => editor.isActive('highlight')),
    ),
    group(
      btn('H1', 'Heading 1', () => editor.chain().focus().toggleHeading({ level: 1 }).run(), () => editor.isActive('heading', { level: 1 })),
      btn('H2', 'Heading 2', () => editor.chain().focus().toggleHeading({ level: 2 }).run(), () => editor.isActive('heading', { level: 2 })),
      btn('H3', 'Heading 3', () => editor.chain().focus().toggleHeading({ level: 3 }).run(), () => editor.isActive('heading', { level: 3 })),
    ),
    group(
      btn('&bull;&nbsp;&mdash;', 'Bullet list', () => editor.chain().focus().toggleBulletList().run(), () => editor.isActive('bulletList')),
      btn('1.&nbsp;&mdash;', 'Numbered list', () => editor.chain().focus().toggleOrderedList().run(), () => editor.isActive('orderedList')),
      btn('&#9745;', 'Checklist', () => editor.chain().focus().toggleTaskList().run(), () => editor.isActive('taskList')),
      btn('&#10077;', 'Quote', () => editor.chain().focus().toggleBlockquote().run(), () => editor.isActive('blockquote')),
      btn('{&nbsp;}', 'Code block', () => editor.chain().focus().toggleCodeBlock().run(), () => editor.isActive('codeBlock')),
    ),
    group(
      btn('&#11162;', 'Call-to-action button', () => editor.chain().focus().setEmailButton().run()),
      btn('&#128247;', 'Upload an image', () => pickAndUploadImage(editor)),
      btn('&#9638;', 'Table', () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()),
      btn('&mdash;', 'Divider', () => editor.chain().focus().setHorizontalRule().run()),
      btn('&#9670;', 'Personalize', () => editor.chain().focus().insertContent([{ type: 'mergeTag', attrs: { field: 'first_name' } }, { type: 'text', text: ' ' }]).run()),
    ),
    group(
      btn('&#8630;', 'Undo  ⌘Z', () => editor.chain().focus().undo().run()),
      btn('&#8631;', 'Redo  ⇧⌘Z', () => editor.chain().focus().redo().run()),
    ),
  )

  host.prepend(bar)
  editor.on('selectionUpdate', refresh)
  editor.on('transaction', refresh)
  refresh()
}

function safeParse(raw: string): JSONContent {
  try {
    return JSON.parse(raw) as JSONContent
  } catch {
    // A stored value that isn't JSON is legacy markdown — show it as plain text
    // rather than silently discarding someone's draft.
    return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: raw }] }] }
  }
}

/**
 * The extensions a *document* needs — everything that gives a node its shape,
 * and nothing that exists to help you author one. Shared by the editor and the
 * read-only view below, so a sent broadcast renders through exactly the same
 * schema it was written in: same nodes, same marks, same paper.
 */
function docExtensions() {
  return [
    StarterKit.configure({
      codeBlock: false,
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
    }),
    CodeBlockLowlight.configure({ lowlight }),
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Image.configure({ inline: false, allowBase64: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Details.configure({ persist: true }),
    DetailsSummary,
    DetailsContent,
    Youtube.configure({ controls: true, nocookie: true }),
    EmailButton,
    MergeTag,
  ]
}

/**
 * Mounts a non-editable TipTap over an already-sent piece of mail.
 *
 * Reading a broadcast should show the thing that was sent, not a second
 * rendering of it — so this is the editor's own view with the authoring tools
 * taken away: no toolbar, no drag handles, no slash menu, nothing to type into.
 * The server-rendered email HTML sits in the host until this replaces it, which
 * keeps the page readable with the bundle still in flight or never arriving.
 */
function mountReader(host: HTMLElement): void {
  const raw = host.querySelector('script.bm-reader-doc')?.textContent?.trim()
  if (!raw) return

  const el = document.createElement('div')
  el.className = 'bm-editor'
  host.append(el)

  // Sent mail gets its reading too. Same dial, nothing to hold.
  let reportSlop: (state: SlopState) => void = () => {}

  const editor = new Editor({
    element: el,
    editable: false,
    extensions: [
      ...docExtensions(),
      SlopLint.configure({ enabled: true, onReport: (s) => reportSlop(s) }),
      // Read-only, so the table has nothing to resize.
      TableKit.configure({ table: { resizable: false } }),
    ],
    content: safeParse(raw),
    editorProps: { attributes: { class: 'bm-prose' } },
  })

  host.querySelector('.bm-reader-fallback')?.remove()
  reportSlop = attachSlopPanel(host, editor).onReport

  // Same move the composer makes: the consent footer joins the sheet, so what
  // you read is the whole mail on one piece of paper.
  const mailFoot = host.parentElement?.querySelector<HTMLElement>('.bm-mailfoot')
  if (mailFoot) host.append(mailFoot)
}

document.querySelectorAll<HTMLElement>('[data-editor]').forEach(mount)
document.querySelectorAll<HTMLElement>('[data-reader]').forEach(mountReader)
