import type { BlockNode, Call, Expr, Node, PartialNode, PathExpr, Template } from './parser.ts'
import { parse } from './parser.ts'

/**
 * Walks a parsed template and produces HTML. Handlebars semantics, evaluated
 * directly rather than compiled — see `parser.ts` for why.
 *
 * Async all the way down, because a Ghost theme can ask for data mid-template
 * (`{{#get "posts"}}`), and on a Worker that is a D1 query.
 *
 * Lookups read own properties only. Handlebars' history of prototype-pollution
 * CVEs (`{{constructor.constructor ...}}`) all start with a template walking up
 * the prototype chain, so here there isn't one to walk.
 */

/** A string that has already been escaped, or is HTML on purpose. */
export class SafeString {
  constructor(readonly html: string) {}
  toString(): string {
    return this.html
  }
  toJSON(): string {
    return this.html
  }
}

export function safe(html: string): SafeString {
  return new SafeString(html)
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '`': '&#x60;',
  '=': '&#x3D;',
}

export function escapeExpression(value: unknown): string {
  if (value instanceof SafeString) return value.html
  if (value === null || value === undefined || value === false) return value === false ? 'false' : ''
  return String(value).replace(/[&<>"'`=]/g, (ch) => ESCAPES[ch] as string)
}

/** Handlebars' idea of "falsy": empty arrays count, zero does too. */
export function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === '' || value === 0) return true
  if (Array.isArray(value) && value.length === 0) return true
  return false
}

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype', '__defineGetter__', '__defineSetter__'])

/** One property, own-only. `length` is allowed on arrays and strings. */
export function prop(obj: unknown, key: string): unknown {
  if (obj === null || obj === undefined) return undefined
  if (FORBIDDEN.has(key)) return undefined
  if (key === 'length' && (Array.isArray(obj) || typeof obj === 'string')) return obj.length
  if (typeof obj !== 'object') return undefined
  if (obj instanceof Map) return obj.get(key)
  return Object.hasOwn(obj, key) ? (obj as Record<string, unknown>)[key] : undefined
}

// ─────────────────────────────────────────────────────────── frames

export type DataVars = Record<string, unknown>

interface Frame {
  context: unknown
  data: DataVars
  blockParams: Record<string, unknown> | null
  /** The frame a `../` climbs to: the nearest one whose context differs. */
  parent: Frame | null
  /** Lexical parent, for block-param lookups. */
  outer: Frame | null
}

export interface BlockOptions {
  data?: DataVars
  blockParams?: unknown[]
}

/** What a helper sees. Mirrors Handlebars' `options`, trimmed to what's used. */
export interface HelperCall {
  name: string
  params: unknown[]
  hash: Record<string, unknown>
  /** The current context — Handlebars' `this`. */
  context: unknown
  data: DataVars
  /** Present only for block helpers. */
  fn: ((context: unknown, options?: BlockOptions) => Promise<string>) | null
  inverse: ((context: unknown, options?: BlockOptions) => Promise<string>) | null
  /** Block params declared on the block, e.g. `as |post index|`. */
  blockParamCount: number
  render: Renderer
}

export type Helper = (call: HelperCall) => unknown | Promise<unknown>

export interface RenderOptions {
  helpers: Record<string, Helper>
  /** Resolve a partial by name (`post-card`, `icons/avatar`). Null if missing. */
  partial: (name: string) => Template | null
  /** Resolve a layout or top-level template by name (`default`). */
  template: (name: string) => Template | null
  /** Global `@` data: `@site`, `@custom`, `@config`, … */
  data: DataVars
  /** Anything helpers need that is not template data: DB access, the request. */
  services: unknown
}

export class Renderer {
  /** `{{#contentFor "x"}}` collects here; `{{{block "x"}}}` prints it. */
  readonly blocks = new Map<string, string[]>()
  private partialDepth = 0

  constructor(readonly opts: RenderOptions) {}

  get services(): unknown {
    return this.opts.services
  }

  /**
   * Render a named template, then its layout chain (`{{!< default}}`), passing
   * each inner result to the layout as `body`.
   */
  async renderTemplate(template: Template, context: unknown): Promise<string> {
    let out = await this.renderRoot(template, context)
    let layoutName = template.layout
    let guard = 0
    while (layoutName) {
      if (++guard > 5) throw new Error('Layout chain is too deep')
      const layout = this.opts.template(layoutName)
      if (!layout) throw new Error(`Layout "${layoutName}" not found`)
      const layoutContext =
        context && typeof context === 'object' ? { ...(context as object), body: safe(out) } : { body: safe(out) }
      out = await this.renderRoot(layout, layoutContext)
      layoutName = layout.layout
    }
    return out
  }

  async renderRoot(template: Template, context: unknown): Promise<string> {
    const frame: Frame = {
      context,
      data: { ...this.opts.data, root: context },
      blockParams: null,
      parent: null,
      outer: null,
    }
    return this.nodes(template.body, frame)
  }

  private async nodes(nodes: Node[], frame: Frame): Promise<string> {
    let out = ''
    for (const node of nodes) {
      switch (node.type) {
        case 'text':
          out += node.value
          break
        case 'mustache': {
          const value = await this.mustache(node.call, frame)
          out += node.escaped ? escapeExpression(value) : raw(value)
          break
        }
        case 'block':
          out += await this.block(node, frame)
          break
        case 'partial':
          out += await this.partial(node, frame)
          break
      }
    }
    return out
  }

  // ───────────────────────────────────────── expressions

  private helperName(expr: Expr): string | null {
    if (expr.type !== 'path' || expr.data || expr.depth > 0 || expr.parts.length !== 1) return null
    const name = expr.parts[0] as string
    return Object.hasOwn(this.opts.helpers, name) ? name : null
  }

  /** `{{x}}`: a helper when one has that name, otherwise a lookup. */
  private async mustache(call: Call, frame: Frame): Promise<unknown> {
    const name = this.helperName(call.head)
    if (name) return this.invoke(name, call, frame, null)
    if (call.params.length || Object.keys(call.hash).length) {
      // Handlebars throws "Missing helper". A page that renders minus one
      // helper beats a theme that 500s because it targets a newer Ghost.
      return undefined
    }
    return this.evaluate(call.head, frame)
  }

  async evaluate(expr: Expr, frame: Frame): Promise<unknown> {
    switch (expr.type) {
      case 'literal':
        return expr.value
      case 'sub': {
        const name = this.helperName(expr.call.head)
        if (!name) return undefined
        return this.invoke(name, expr.call, frame, null)
      }
      case 'path':
        return this.lookup(expr, frame)
    }
  }

  private lookup(path: PathExpr, frame: Frame): unknown {
    if (path.data) {
      let value: unknown = frame.data
      for (const part of path.parts) value = prop(value, part)
      return value
    }

    let [first, ...rest] = path.parts
    let value: unknown

    if (path.depth === 0 && first !== undefined) {
      // Block params shadow the context: `{{#foreach posts as |post|}}{{post.title}}`.
      for (let f: Frame | null = frame; f; f = f.outer) {
        if (f.blockParams && Object.hasOwn(f.blockParams, first)) {
          value = f.blockParams[first]
          for (const part of rest) value = prop(value, part)
          return value
        }
      }
    }

    let target: Frame = frame
    for (let d = 0; d < path.depth && target.parent; d++) target = target.parent
    value = target.context
    if (first === undefined) return value
    value = prop(value, first)
    for (const part of rest) value = prop(value, part)
    return value
  }

  private async args(call: Call, frame: Frame): Promise<{ params: unknown[]; hash: Record<string, unknown> }> {
    const params: unknown[] = []
    for (const p of call.params) params.push(await this.evaluate(p, frame))
    const hash: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(call.hash)) hash[k] = await this.evaluate(v, frame)
    return { params, hash }
  }

  private async invoke(name: string, call: Call, frame: Frame, block: BlockNode | null): Promise<unknown> {
    const helper = this.opts.helpers[name] as Helper
    const { params, hash } = await this.args(call, frame)
    return helper({
      name,
      params,
      hash,
      context: frame.context,
      data: frame.data,
      fn: block ? (ctx, o) => this.child(block.program, block, frame, ctx, o) : null,
      inverse: block
        ? (ctx, o) => (block.inverse ? this.child(block.inverse, block, frame, ctx, o) : Promise.resolve(''))
        : null,
      blockParamCount: block?.blockParams.length ?? 0,
      render: this,
    })
  }

  /** Render a block's body in a new frame. */
  private child(nodes: Node[], block: BlockNode, frame: Frame, context: unknown, o?: BlockOptions): Promise<string> {
    const params: Record<string, unknown> | null = block.blockParams.length ? {} : null
    if (params) block.blockParams.forEach((name, i) => (params[name] = o?.blockParams?.[i]))
    const sameContext = context === frame.context
    const next: Frame = {
      context,
      data: o?.data ?? frame.data,
      blockParams: params,
      // Handlebars only adds a `../` level when the context actually changes, so
      // `{{#if}}` inside `{{#foreach}}` doesn't cost the template a `../`.
      parent: sameContext ? frame.parent : frame,
      outer: frame,
    }
    return this.nodes(nodes, next)
  }

  // ───────────────────────────────────────── blocks

  private async block(node: BlockNode, frame: Frame): Promise<string> {
    const name = this.helperName(node.call.head)

    if (node.inverted) {
      const value = name ? await this.invoke(name, node.call, frame, null) : await this.evaluate(node.call.head, frame)
      return isEmpty(value)
        ? this.child(node.program, node, frame, frame.context)
        : node.inverse
          ? this.child(node.inverse, node, frame, frame.context)
          : ''
    }

    if (name) return raw(await this.invoke(name, node.call, frame, node))

    // Not a helper: Handlebars' `blockHelperMissing`. An array iterates, an
    // object becomes the context, true renders once, falsy renders the inverse.
    const value = await this.evaluate(node.call.head, frame)
    if (isEmpty(value)) {
      return node.inverse ? this.child(node.inverse, node, frame, frame.context) : ''
    }
    if (Array.isArray(value)) {
      let out = ''
      for (let i = 0; i < value.length; i++) {
        const data = { ...frame.data, index: i, first: i === 0, last: i === value.length - 1 }
        out += await this.child(node.program, node, frame, value[i], { data, blockParams: [value[i], i] })
      }
      return out
    }
    if (value === true) return this.child(node.program, node, frame, frame.context)
    return this.child(node.program, node, frame, value, { blockParams: [value] })
  }

  // ───────────────────────────────────────── partials

  private async partial(node: PartialNode, frame: Frame): Promise<string> {
    const nameValue = await this.evaluate(node.name, frame)
    const name = String(nameValue ?? '')
    const template = name ? this.opts.partial(name) : null

    if (!template) {
      if (node.fallback) return this.nodes(node.fallback, frame)
      return ''
    }

    if (++this.partialDepth > 40) {
      this.partialDepth = 0
      throw new Error(`Partial "${name}" recurses too deeply`)
    }
    try {
      let context = node.context ? await this.evaluate(node.context, frame) : frame.context
      const hashKeys = Object.keys(node.hash)
      if (hashKeys.length) {
        const extra: Record<string, unknown> = {}
        for (const k of hashKeys) extra[k] = await this.evaluate(node.hash[k] as Expr, frame)
        context = context && typeof context === 'object' ? { ...(context as object), ...extra } : extra
      }
      const partialFrame: Frame = {
        context,
        data: frame.data,
        blockParams: null,
        parent: context === frame.context ? frame.parent : frame,
        outer: frame,
      }
      return await this.nodes(template.body, partialFrame)
    } finally {
      this.partialDepth--
    }
  }
}

function raw(value: unknown): string {
  if (value instanceof SafeString) return value.html
  if (value === null || value === undefined) return ''
  if (value === false) return 'false'
  return String(value)
}

/** Parse-and-render in one call. For tests and one-off strings, not for themes. */
export async function renderString(
  source: string,
  context: unknown,
  opts: Partial<RenderOptions> = {},
): Promise<string> {
  const renderer = new Renderer({
    helpers: opts.helpers ?? {},
    partial: opts.partial ?? (() => null),
    template: opts.template ?? (() => null),
    data: opts.data ?? {},
    services: opts.services ?? null,
  })
  return renderer.renderTemplate(parse(source), context)
}
