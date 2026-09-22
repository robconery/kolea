/**
 * The template parser — Handlebars syntax, our own implementation.
 *
 * Why not Handlebars itself: `Handlebars.compile()` generates JavaScript and runs
 * it with `new Function`, and Workers forbid dynamic code. Precompiling only
 * works for templates known at deploy time, and a theme is uploaded at runtime.
 * So we parse to an AST here and `interpreter.ts` walks it. No code is ever
 * generated from a template, which is also why an uploaded theme can't execute
 * anything: the worst a template can do is print.
 *
 * Supported, because Ghost themes use it:
 *
 *   {{path}}  {{{raw}}}  {{& raw}}  {{! comment }}  {{!-- comment --}}
 *   {{#block a b key=value as |x y|}} … {{else}} / {{else if c}} / {{^}} … {{/block}}
 *   {{^inverse}} … {{/inverse}}
 *   {{> partial}}  {{> "icons/avatar" ctx key=value}}  {{#> partial}}fallback{{/partial}}
 *   {{helper (sub expr) "str" 'str' 12 true null}}  ../parent  this  @root  @index  [odd key]
 *   {{~ whitespace control ~}}
 *   {{!< default}}   ← express-hbs's layout directive, which every Ghost theme uses
 *
 * Not supported: decorators (`{{* }}`), raw blocks (`{{{{raw}}}}`), and
 * "standalone line" whitespace stripping. None of them change what a page says.
 */

export interface PathExpr {
  type: 'path'
  /** `@foo` — a data variable, not a context lookup. */
  data: boolean
  /** How many `../` precede it. */
  depth: number
  /** Segments after `this`/`../` are stripped. Empty means the context itself. */
  parts: string[]
  original: string
}

export interface LiteralExpr {
  type: 'literal'
  value: string | number | boolean | null | undefined
}

export interface SubExpr {
  type: 'sub'
  call: Call
}

export type Expr = PathExpr | LiteralExpr | SubExpr

export interface Call {
  /** What is being called or looked up. A literal only in `{{"foo"}}`-style oddities. */
  head: Expr
  params: Expr[]
  hash: Record<string, Expr>
}

export interface TextNode {
  type: 'text'
  value: string
}

export interface MustacheNode {
  type: 'mustache'
  call: Call
  escaped: boolean
}

export interface BlockNode {
  type: 'block'
  call: Call
  program: Node[]
  inverse: Node[] | null
  blockParams: string[]
  /** `{{^x}}…{{/x}}`: render the program when `x` is falsy. */
  inverted: boolean
}

export interface PartialNode {
  type: 'partial'
  name: Expr
  context: Expr | null
  hash: Record<string, Expr>
  /** `{{#> name}}fallback{{/name}}` — rendered when the partial doesn't exist. */
  fallback: Node[] | null
}

export type Node = TextNode | MustacheNode | BlockNode | PartialNode

export interface Template {
  body: Node[]
  /** From `{{!< default}}`: render this template, then the named layout around it. */
  layout: string | null
}

export class TemplateSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`${message} (line ${line})`)
    this.name = 'TemplateSyntaxError'
  }
}

// ─────────────────────────────────────────────────────────── scanning

type Tag =
  | { kind: 'text'; value: string }
  | {
      kind: 'tag'
      /** '', '#', '/', '^', '>', '#>', '&', '{', '!', 'else' */
      sigil: string
      content: string
      stripBefore: boolean
      stripAfter: boolean
      line: number
    }

function lineAt(src: string, index: number): number {
  let n = 1
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) n++
  return n
}

/**
 * Find the `}}` that ends a tag, skipping quoted strings — Ghost themes put
 * mustaches inside helper arguments (`filter="id:-{{id}}"`), so the first `}}`
 * is not necessarily the end.
 */
function findClose(src: string, from: number, close: string, line: number): number {
  let quote: string | null = null
  for (let i = from; i < src.length; i++) {
    const ch = src[i]
    if (quote) {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (src.startsWith(close, i)) return i
  }
  throw new TemplateSyntaxError(`Unclosed tag, expected "${close}"`, line)
}

function scan(src: string): Tag[] {
  const out: Tag[] = []
  let i = 0
  while (i < src.length) {
    const open = src.indexOf('{{', i)
    if (open === -1) {
      out.push({ kind: 'text', value: src.slice(i) })
      break
    }
    // `\{{` is a literal mustache in Handlebars.
    if (open > 0 && src[open - 1] === '\\') {
      out.push({ kind: 'text', value: `${src.slice(i, open - 1)}{{` })
      i = open + 2
      continue
    }
    if (open > i) out.push({ kind: 'text', value: src.slice(i, open) })
    const line = lineAt(src, open)

    // Comments first: their bodies may contain anything, including `}}`.
    const afterOpen = src[open + 2] === '~' ? open + 3 : open + 2
    if (src.startsWith('!--', afterOpen)) {
      const end = src.indexOf('--', afterOpen + 3)
      const close = end === -1 ? -1 : src.indexOf('}}', end)
      if (close === -1) throw new TemplateSyntaxError('Unclosed comment', line)
      const stripAfter = src[close - 1] === '~'
      out.push({
        kind: 'tag',
        sigil: '!',
        content: src.slice(afterOpen + 3, end),
        stripBefore: afterOpen === open + 3,
        stripAfter,
        line,
      })
      i = close + 2
      continue
    }
    if (src[afterOpen] === '!') {
      const close = src.indexOf('}}', afterOpen)
      if (close === -1) throw new TemplateSyntaxError('Unclosed comment', line)
      const stripAfter = src[close - 1] === '~'
      out.push({
        kind: 'tag',
        sigil: '!',
        content: src.slice(afterOpen + 1, stripAfter ? close - 1 : close),
        stripBefore: afterOpen === open + 3,
        stripAfter,
        line,
      })
      i = close + 2
      continue
    }

    // Triple-stash: {{{ raw }}}
    if (src[open + 2] === '{') {
      let start = open + 3
      const stripBefore = src[start] === '~'
      if (stripBefore) start++
      const close = findClose(src, start, '}}}', line)
      let end = close
      const stripAfter = src[end - 1] === '~'
      if (stripAfter) end--
      out.push({ kind: 'tag', sigil: '{', content: src.slice(start, end), stripBefore, stripAfter, line })
      i = close + 3
      continue
    }

    let start = open + 2
    const stripBefore = src[start] === '~'
    if (stripBefore) start++
    const close = findClose(src, start, '}}', line)
    let end = close
    const stripAfter = src[end - 1] === '~'
    if (stripAfter) end--
    let content = src.slice(start, end).trim()

    let sigil = ''
    if (content.startsWith('#>')) {
      sigil = '#>'
      content = content.slice(2)
    } else if (content.startsWith('#*')) {
      // Decorators — not supported, and not used by Ghost themes. Drop silently.
      i = close + 2
      continue
    } else if ('#/^>&'.includes(content[0] ?? '')) {
      sigil = content[0] as string
      content = content.slice(1)
    } else if (/^else(\s|$)/.test(content)) {
      sigil = 'else'
      content = content.slice(4)
    }
    // A bare `{{^}}` is an else.
    if (sigil === '^' && content.trim() === '') sigil = 'else'

    out.push({ kind: 'tag', sigil, content: content.trim(), stripBefore, stripAfter, line })
    i = close + 2
  }
  return out
}

// ─────────────────────────────────────────────────────────── expressions

type Tok =
  | { t: 'word'; v: string }
  | { t: 'str'; v: string }
  | { t: 'open' }
  | { t: 'close' }
  | { t: 'eq' }
  | { t: 'pipe' }

function tokenize(src: string, line: number): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i] as string
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '(') {
      out.push({ t: 'open' })
      i++
      continue
    }
    if (ch === ')') {
      out.push({ t: 'close' })
      i++
      continue
    }
    if (ch === '=') {
      out.push({ t: 'eq' })
      i++
      continue
    }
    if (ch === '|') {
      out.push({ t: 'pipe' })
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1
      let v = ''
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\' && j + 1 < src.length) {
          v += src[j + 1]
          j += 2
          continue
        }
        v += src[j]
        j++
      }
      if (j >= src.length) throw new TemplateSyntaxError('Unterminated string', line)
      out.push({ t: 'str', v })
      i = j + 1
      continue
    }
    // A word: a path, a number, a keyword. `[...]` segments may hold anything.
    let j = i
    let v = ''
    while (j < src.length) {
      const c = src[j] as string
      if (c === '[') {
        const end = src.indexOf(']', j)
        if (end === -1) throw new TemplateSyntaxError('Unclosed [', line)
        v += src.slice(j, end + 1)
        j = end + 1
        continue
      }
      if (/[\s()=|"']/.test(c)) break
      v += c
      j++
    }
    out.push({ t: 'word', v })
    i = j
  }
  return out
}

function parsePath(word: string, line: number): PathExpr {
  const original = word
  let s = word
  let data = false
  if (s.startsWith('@')) {
    data = true
    s = s.slice(1)
  }
  let depth = 0
  while (s.startsWith('../')) {
    depth++
    s = s.slice(3)
  }
  if (s === '..') {
    depth++
    s = ''
  }
  const parts: string[] = []
  let i = 0
  let seg = ''
  const push = () => {
    if (seg !== '') parts.push(seg)
    seg = ''
  }
  while (i < s.length) {
    const c = s[i] as string
    if (c === '[') {
      const end = s.indexOf(']', i)
      if (end === -1) throw new TemplateSyntaxError('Unclosed [', line)
      seg += s.slice(i + 1, end)
      i = end + 1
      continue
    }
    if (c === '.' || c === '/') {
      push()
      i++
      continue
    }
    seg += c
    i++
  }
  push()
  // `this`, `this.foo`, `./foo` all mean "start at the current context".
  if (!data && (parts[0] === 'this' || parts[0] === '.')) parts.shift()
  if (!data && word === '.') parts.length = 0
  return { type: 'path', data, depth, parts, original }
}

function wordToExpr(word: string, line: number): Expr {
  if (word === 'true') return { type: 'literal', value: true }
  if (word === 'false') return { type: 'literal', value: false }
  if (word === 'null') return { type: 'literal', value: null }
  if (word === 'undefined') return { type: 'literal', value: undefined }
  if (/^-?\d+(\.\d+)?$/.test(word)) return { type: 'literal', value: Number(word) }
  return parsePath(word, line)
}

class ExprParser {
  private i = 0
  constructor(
    private readonly toks: Tok[],
    private readonly line: number,
  ) {}

  done(): boolean {
    return this.i >= this.toks.length
  }

  peek(offset = 0): Tok | undefined {
    return this.toks[this.i + offset]
  }

  skip(): void {
    this.i++
  }

  /** `head param* hash*` up to the end or a closing paren. */
  call(): Call {
    const head = this.value()
    return { head, ...this.args() }
  }

  /** `param* hash*` — a call without its head; also the shape of a partial's arguments. */
  args(): { params: Expr[]; hash: Record<string, Expr> } {
    const params: Expr[] = []
    const hash: Record<string, Expr> = {}
    while (!this.done()) {
      const tok = this.peek()
      if (!tok || tok.t === 'close') break
      if (tok.t === 'word' && tok.v === 'as' && this.peek(1)?.t === 'pipe') break
      if (tok.t === 'word' && this.peek(1)?.t === 'eq') {
        this.i += 2
        hash[tok.v] = this.value()
        continue
      }
      params.push(this.value())
    }
    return { params, hash }
  }

  value(): Expr {
    const tok = this.toks[this.i++]
    if (!tok) throw new TemplateSyntaxError('Expected an expression', this.line)
    if (tok.t === 'str') return { type: 'literal', value: tok.v }
    if (tok.t === 'word') return wordToExpr(tok.v, this.line)
    if (tok.t === 'open') {
      const call = this.call()
      const closing = this.toks[this.i++]
      if (!closing || closing.t !== 'close') throw new TemplateSyntaxError('Unclosed (', this.line)
      return { type: 'sub', call }
    }
    throw new TemplateSyntaxError('Unexpected token', this.line)
  }

  blockParams(): string[] {
    const tok = this.peek()
    if (!(tok?.t === 'word' && tok.v === 'as')) return []
    this.i += 2 // as |
    const names: string[] = []
    while (!this.done()) {
      const t = this.toks[this.i++]
      if (!t || t.t === 'pipe') break
      if (t.t === 'word') names.push(t.v)
    }
    return names
  }
}

function parseCall(content: string, line: number): { call: Call; blockParams: string[] } {
  const p = new ExprParser(tokenize(content, line), line)
  if (p.done()) throw new TemplateSyntaxError('Empty tag', line)
  const call = p.call()
  const blockParams = p.blockParams()
  if (!p.done()) throw new TemplateSyntaxError('Unexpected content in tag', line)
  return { call, blockParams }
}

function nameOf(call: Call): string {
  return call.head.type === 'path' ? call.head.original : String((call.head as LiteralExpr).value)
}

// ─────────────────────────────────────────────────────────── tree

/** The name recorded for a partial block whose name is an expression. */
const DYNAMIC = '\u0000dynamic'

interface OpenBlock {
  node: BlockNode | PartialNode
  name: string
  /** Where children currently go: the program, or the inverse after an else. */
  target: Node[]
  line: number
  /** `{{else if x}}` opens a nested block that closes with its parent. */
  chained: boolean
}

export function parse(src: string): Template {
  const tags = scan(src)
  let layout: string | null = null

  // Whitespace control: `{{~` trims the text before, `~}}` the text after.
  for (let k = 0; k < tags.length; k++) {
    const tag = tags[k] as Tag
    if (tag.kind !== 'tag') continue
    const prev = tags[k - 1]
    const next = tags[k + 1]
    if (tag.stripBefore && prev?.kind === 'text') prev.value = prev.value.replace(/\s+$/, '')
    if (tag.stripAfter && next?.kind === 'text') next.value = next.value.replace(/^\s+/, '')
  }

  const root: Node[] = []
  const stack: OpenBlock[] = []
  const target = () => (stack.length ? (stack[stack.length - 1] as OpenBlock).target : root)

  const closeChained = () => {
    // Pop every `else if` block that was opened inside the current real block.
    while (stack.length && (stack[stack.length - 1] as OpenBlock).chained) stack.pop()
  }

  for (const tag of tags) {
    if (tag.kind === 'text') {
      if (tag.value) target().push({ type: 'text', value: tag.value })
      continue
    }
    const { sigil, content, line } = tag

    switch (sigil) {
      case '!': {
        const m = /^\s*<\s*([\w\-/.]+)\s*$/.exec(content)
        if (m && layout === null) layout = m[1] as string
        break
      }
      case '':
      case '&':
      case '{': {
        const { call } = parseCall(content, line)
        target().push({ type: 'mustache', call, escaped: sigil === '' })
        break
      }
      case '#':
      case '^': {
        const { call, blockParams } = parseCall(content, line)
        const node: BlockNode = {
          type: 'block',
          call,
          program: [],
          inverse: null,
          blockParams,
          inverted: sigil === '^',
        }
        target().push(node)
        stack.push({ node, name: nameOf(call), target: node.program, line, chained: false })
        break
      }
      case '>':
      case '#>': {
        const p = new ExprParser(tokenize(content, line), line)
        const nameTok = p.peek()
        // A bare partial name like `post-card` or `icons/avatar` is a name,
        // not a path to look up.
        let name: Expr
        if (nameTok?.t === 'word') {
          p.skip()
          name = { type: 'literal', value: nameTok.v }
        } else {
          name = p.value()
        }
        const call = p.args()
        const node: PartialNode = {
          type: 'partial',
          name,
          context: call.params[0] ?? null,
          hash: call.hash,
          fallback: sigil === '#>' ? [] : null,
        }
        target().push(node)
        if (sigil === '#>') {
          // A dynamic name — `{{#> (concat "icons/" type)}}` — has no name to
          // close with, and Handlebars itself closes it with `{{/undefined}}`.
          // Casper and Source both do exactly that, so any closer is accepted.
          const label = name.type === 'literal' ? String(name.value) : DYNAMIC
          stack.push({ node, name: label, target: node.fallback as Node[], line, chained: false })
        }
        break
      }
      case 'else': {
        const top = stack[stack.length - 1]
        if (!top || top.node.type !== 'block') throw new TemplateSyntaxError('{{else}} outside a block', line)
        if (top.node.inverse) throw new TemplateSyntaxError('Two {{else}} in one block', line)
        top.node.inverse = []
        top.target = top.node.inverse
        if (content) {
          // `{{else if x}}` — a new block living in this block's inverse, which
          // closes when the outer block does.
          const { call, blockParams } = parseCall(content, line)
          const node: BlockNode = { type: 'block', call, program: [], inverse: null, blockParams, inverted: false }
          top.node.inverse.push(node)
          stack.push({ node, name: nameOf(call), target: node.program, line, chained: true })
        }
        break
      }
      case '/': {
        closeChained()
        const top = stack.pop()
        if (!top) throw new TemplateSyntaxError(`Unexpected {{/${content}}}`, line)
        if (top.name !== content && top.name !== DYNAMIC) {
          throw new TemplateSyntaxError(`{{/${content}}} closes {{#${top.name}}} from line ${top.line}`, line)
        }
        break
      }
    }
  }

  closeChained()
  if (stack.length) {
    const top = stack[stack.length - 1] as OpenBlock
    throw new TemplateSyntaxError(`{{#${top.name}}} is never closed`, top.line)
  }
  return { body: root, layout }
}
