import type { Editor } from '@tiptap/core'

/**
 * Selection toolbar. Two modes: normal inline formatting, and a URL field when a
 * CTA button is selected — the button's label is edited inline, so its href needs
 * somewhere to live.
 */
export function buildBubbleMenu(root: HTMLElement, editor: Editor): void {
  const inline = document.createElement('div')
  inline.className = 'bm-bubble-row'

  const buttonRow = document.createElement('div')
  buttonRow.className = 'bm-bubble-row bm-bubble-link'

  const actives: [HTMLElement, () => boolean][] = []

  const btn = (label: string, title: string, run: () => void, active?: () => boolean) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'bm-bb'
    b.title = title
    b.innerHTML = label
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', run)
    if (active) actives.push([b, active])
    return b
  }

  const setLink = () => {
    const previous = String(editor.getAttributes('link').href ?? '')
    const url = window.prompt('Link URL', previous)
    if (url === null) return
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      return
    }
    editor
      .chain()
      .focus()
      .extendMarkRange('link')
      .setLink({ href: url.startsWith('http') || url.startsWith('mailto:') ? url : `https://${url}` })
      .run()
  }

  inline.append(
    btn('<b>B</b>', 'Bold', () => editor.chain().focus().toggleBold().run(), () => editor.isActive('bold')),
    btn('<i>I</i>', 'Italic', () => editor.chain().focus().toggleItalic().run(), () => editor.isActive('italic')),
    btn('<s>S</s>', 'Strike', () => editor.chain().focus().toggleStrike().run(), () => editor.isActive('strike')),
    btn('<code>&lt;&gt;</code>', 'Code', () => editor.chain().focus().toggleCode().run(), () => editor.isActive('code')),
    btn('<span class="bm-hl">A</span>', 'Highlight', () => editor.chain().focus().toggleHighlight().run(), () => editor.isActive('highlight')),
    btn('&#128279;', 'Link', setLink, () => editor.isActive('link')),
    btn('&#8676;', 'Align left', () => editor.chain().focus().setTextAlign('left').run(), () => editor.isActive({ textAlign: 'left' })),
    btn('&#8596;', 'Align center', () => editor.chain().focus().setTextAlign('center').run(), () => editor.isActive({ textAlign: 'center' })),
  )

  // ── CTA button controls
  const urlInput = document.createElement('input')
  urlInput.type = 'text'
  urlInput.placeholder = 'https://…'
  urlInput.className = 'bm-bb-input'
  urlInput.addEventListener('input', () => {
    editor.commands.updateAttributes('emailButton', { href: urlInput.value })
  })
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      editor.commands.focus()
    }
  })

  const swatches = document.createElement('div')
  swatches.className = 'bm-swatches'
  for (const color of ['#1f6f5c', '#22262b', '#a33224', '#9a5b1e', '#2d5f8a']) {
    const s = document.createElement('button')
    s.type = 'button'
    s.className = 'bm-swatch'
    s.style.background = color
    s.title = color
    s.addEventListener('mousedown', (e) => e.preventDefault())
    s.addEventListener('click', () =>
      editor.commands.updateAttributes('emailButton', { background: color }),
    )
    swatches.append(s)
  }

  const label = document.createElement('span')
  label.className = 'bm-bb-label'
  label.textContent = 'Button link'

  buttonRow.append(label, urlInput, swatches)
  root.append(inline, buttonRow)

  const refresh = () => {
    const isButton = editor.isActive('emailButton')
    inline.style.display = isButton ? 'none' : 'flex'
    buttonRow.style.display = isButton ? 'flex' : 'none'
    if (isButton) {
      const href = String(editor.getAttributes('emailButton').href ?? '')
      // Don't clobber what's being typed.
      if (document.activeElement !== urlInput) urlInput.value = href
    }
    for (const [el, is] of actives) el.classList.toggle('on', is())
  }

  editor.on('selectionUpdate', refresh)
  editor.on('transaction', refresh)
  refresh()
}
