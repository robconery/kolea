import { Extension } from '@tiptap/core'
import type { Editor, Range } from '@tiptap/core'
import Suggestion from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'
import { makeDropdown } from './merge-tag.ts'

interface SlashItem {
  title: string
  subtitle: string
  icon: string
  keywords: string
  run: (editor: Editor, range: Range) => void
}

/**
 * Slash-command menu. TipTap has no published package for this — their own
 * slash-commands page is an unmaintained experiment — so this is the sanctioned
 * pattern: a thin Extension over the (MIT) `@tiptap/suggestion` plugin.
 */
export const SLASH_ITEMS: SlashItem[] = [
  {
    title: 'Text',
    subtitle: 'Plain paragraph',
    icon: '¶',
    keywords: 'paragraph text body',
    run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run(),
  },
  {
    title: 'Heading 1',
    subtitle: 'Big section title',
    icon: 'H1',
    keywords: 'h1 title heading big',
    run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run(),
  },
  {
    title: 'Heading 2',
    subtitle: 'Section title',
    icon: 'H2',
    keywords: 'h2 heading subtitle',
    run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run(),
  },
  {
    title: 'Heading 3',
    subtitle: 'Sub-section',
    icon: 'H3',
    keywords: 'h3 heading small',
    run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run(),
  },
  {
    title: 'Bullet list',
    subtitle: 'Unordered list',
    icon: '•',
    keywords: 'bullet unordered list ul',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
  },
  {
    title: 'Numbered list',
    subtitle: 'Ordered list',
    icon: '1.',
    keywords: 'numbered ordered list ol',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
  },
  {
    title: 'Checklist',
    subtitle: 'Task list with checkboxes',
    icon: '☑',
    keywords: 'task todo checklist check',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run(),
  },
  {
    title: 'Button',
    subtitle: 'Call-to-action button',
    icon: '⬢',
    keywords: 'button cta link call to action',
    run: (e, r) => e.chain().focus().deleteRange(r).setEmailButton().run(),
  },
  {
    title: 'Image',
    subtitle: 'Upload from your machine',
    icon: '🖼',
    keywords: 'image picture photo upload',
    run: (e, r) => {
      e.chain().focus().deleteRange(r).run()
      pickAndUploadImage(e)
    },
  },
  {
    title: 'Image from library',
    subtitle: 'Reuse an image you uploaded before',
    icon: '🗂',
    keywords: 'image picture photo library media reuse',
    run: (e, r) => {
      e.chain().focus().deleteRange(r).run()
      void pickFromLibrary(e)
    },
  },
  {
    title: 'Code block',
    subtitle: 'Syntax-highlighted code',
    icon: '{ }',
    keywords: 'code snippet pre monospace',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run(),
  },
  {
    title: 'Quote',
    subtitle: 'Block quotation',
    icon: '❝',
    keywords: 'quote blockquote citation',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run(),
  },
  {
    title: 'Divider',
    subtitle: 'Horizontal rule',
    icon: '─',
    keywords: 'divider rule hr separator line',
    run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
  },
  {
    title: 'Table',
    subtitle: '3×3 with a header row',
    icon: '▦',
    keywords: 'table grid rows columns',
    run: (e, r) =>
      e
        .chain()
        .focus()
        .deleteRange(r)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
  {
    title: 'Toggle',
    subtitle: 'Collapsible section',
    icon: '▸',
    keywords: 'toggle details collapse accordion',
    run: (e, r) => e.chain().focus().deleteRange(r).setDetails().run(),
  },
  {
    title: 'YouTube',
    subtitle: 'Becomes a link in email',
    icon: '▶',
    keywords: 'youtube video embed',
    run: (e, r) => {
      e.chain().focus().deleteRange(r).run()
      const src = window.prompt('YouTube URL')
      if (src) e.commands.setYoutubeVideo({ src })
    },
  },
  {
    title: 'Personalize',
    subtitle: 'Insert a merge field',
    icon: '◆',
    keywords: 'merge field personalize name email variable',
    run: (e, r) =>
      e
        .chain()
        .focus()
        .deleteRange(r)
        .insertContent([{ type: 'mergeTag', attrs: { field: 'first_name' } }, { type: 'text', text: ' ' }])
        .run(),
  },
]

export const SlashMenu = Extension.create({
  name: 'slashMenu',

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        char: '/',
        pluginKey: new PluginKey('slashMenu'),
        // Only at the start of an empty-ish block, so "and/or" mid-sentence is safe.
        startOfLine: false,
        allowSpaces: false,
        items: ({ query }) => {
          const q = query.toLowerCase()
          return SLASH_ITEMS.filter((i) =>
            `${i.title} ${i.keywords}`.toLowerCase().includes(q),
          ).slice(0, 10)
        },
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () =>
          makeDropdown<SlashItem>((item) => ({
            title: item.title,
            subtitle: item.subtitle,
            icon: item.icon,
          })),
      }),
    ]
  },
})

/**
 * Upload an image and insert it once the URL comes back.
 *
 * Inserts nothing until the upload resolves — a placeholder node that fails to
 * resolve leaves a broken image in a draft that someone then mails to the list.
 */
export async function uploadImage(editor: Editor, file: File): Promise<void> {
  const body = new FormData()
  body.append('file', file)

  editor.view.dom.classList.add('bm-uploading')
  try {
    const res = await fetch('/api/media/upload', { method: 'POST', body })
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string }
      window.alert(`Upload failed: ${err.error ?? res.statusText}`)
      return
    }
    const { url } = (await res.json()) as { url: string }
    editor.chain().focus().setImage({ src: url, alt: file.name }).run()
  } catch (err) {
    window.alert(`Upload failed: ${String(err)}`)
  } finally {
    editor.view.dom.classList.remove('bm-uploading')
  }
}

export function pickAndUploadImage(editor: Editor): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/avif'
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (file) void uploadImage(editor, file)
  })
  input.click()
}

interface LibraryItem {
  url: string
  filename: string
}

/**
 * The media library as a picker: reads `GET /api/media` (newest first) into a
 * plain `<dialog>` of thumbnails, and inserts the one clicked. Nothing is
 * inserted until a pick, same rule as an upload.
 */
export async function pickFromLibrary(editor: Editor): Promise<void> {
  let items: LibraryItem[]
  try {
    const res = await fetch('/api/media?per_page=60')
    if (!res.ok) throw new Error(res.statusText)
    items = ((await res.json()) as { items: LibraryItem[] }).items
  } catch (err) {
    window.alert(`Could not load the media library: ${String(err)}`)
    return
  }
  if (items.length === 0) {
    window.alert('The media library is empty. Upload an image first.')
    return
  }

  const dialog = document.createElement('dialog')
  dialog.className = 'bm-library'
  dialog.style.cssText = 'max-width:720px;width:90vw;border:0;border-radius:12px;padding:16px'
  const grid = document.createElement('div')
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px'
  for (const item of items) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.title = item.filename
    btn.style.cssText = 'padding:0;border:0;background:none;cursor:pointer'
    const img = document.createElement('img')
    img.src = item.url
    img.alt = item.filename
    img.loading = 'lazy'
    img.style.cssText = 'width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:6px;display:block'
    btn.append(img)
    btn.addEventListener('click', () => {
      dialog.close()
      editor.chain().focus().setImage({ src: item.url, alt: item.filename }).run()
    })
    grid.append(btn)
  }
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = 'Cancel'
  close.style.cssText = 'margin-top:12px'
  close.addEventListener('click', () => dialog.close())
  dialog.append(grid, close)
  dialog.addEventListener('close', () => dialog.remove())
  document.body.append(dialog)
  dialog.showModal()
}
