import { marked } from 'marked'
import type { DocNode } from '../db/schema.ts'
import { type Scope, formatScope } from './consent.ts'
import { escapeHtml, mergeFields } from './text.ts'
import { docIsEmpty, renderDocToEmailHtml, renderDocToText } from './render-doc.ts'

marked.setOptions({ gfm: true, breaks: false })

// Re-exported so `render.ts` stays the one door for the email pipeline, while
// the definitions live somewhere a web renderer can reach without dragging
// consent and the database along with them.
export { escapeHtml, mergeFields }

export interface RenderContext {
  publicUrl: string
  messageId: number
  unsubToken: string
  scope: Scope
  /** Shown in the footer so the reader knows which sequence they'd be leaving. */
  scopeLabel: string
  subscriber: { email: string; name: string | null }
  trackOpens: boolean
  trackClicks: boolean
  /** False for transactional mail: a receipt gets no unsubscribe footer. */
  showFooter: boolean
  /**
   * Per-message merge values the subscriber row can't supply — today `{{link}}`,
   * a lead magnet's download URL, which is one person's grant token and so
   * cannot be baked into the body the operator wrote.
   */
  extras?: Record<string, string>
}

export interface RenderedEmail {
  html: string
  text: string
  preferenceUrl: string
  oneClickUnsubscribeUrl: string
}


export interface EmailBody {
  /** Rich document — the source of truth when present. */
  json?: DocNode | null
  /** Markdown fallback, for content authored before the editor existed. */
  md: string
}

export function renderEmail(body: EmailBody, ctx: RenderContext): RenderedEmail {
  const scopeParam = encodeURIComponent(formatScope(ctx.scope))

  // `m` is the message that carried this link, so an unsubscribe can be charged
  // to the mail that caused it. It is a hint, not an authority — the preference
  // centre checks the message actually belongs to the token holder before
  // recording anything against it.
  const from = `scope=${scopeParam}&m=${ctx.messageId}`

  const preferenceUrl = `${ctx.publicUrl}/p/${ctx.unsubToken}?${from}`
  // One-click (List-Unsubscribe-Post) must act on the NARROW scope, not globally.
  // A mail client's "unsubscribe" button on a sequence email leaves that sequence.
  const oneClickUnsubscribeUrl = `${ctx.publicUrl}/p/${ctx.unsubToken}/one-click?${from}`

  // Never track the unsubscribe link itself — a click on "leave this series"
  // must not be routed through a redirect that could fail. Download links are
  // exempt for the same reason: the download is already counted on its grant
  // row, so the redirect would add a way for the one link that matters to break
  // and buy nothing.
  const trackLink = (url: string): string => {
    if (!ctx.trackClicks) return url
    if (url.startsWith(`${ctx.publicUrl}/p/`)) return url
    if (url.startsWith(`${ctx.publicUrl}/d/`)) return url
    if (!/^https?:\/\//i.test(url)) return url
    return `${ctx.publicUrl}/t/click/${ctx.messageId}?u=${encodeURIComponent(url)}`
  }

  const mergeValue = (field: string): string => mergeFieldValue(field, ctx.subscriber, ctx.extras)

  let inner: string
  let plain: string

  if (body.json && !docIsEmpty(body.json)) {
    const o = { trackLink, mergeValue }
    inner = renderDocToEmailHtml(body.json, o)
    plain = renderDocToText(body.json, o)
  } else {
    // Legacy markdown path.
    const merged = mergeFields(body.md, ctx.subscriber, ctx.extras)
    inner = marked.parse(merged, { async: false }) as string
    if (ctx.trackClicks) inner = rewriteLinks(inner, ctx)
    plain = stripMd(merged)
  }

  const pixel = ctx.trackOpens
    ? `<img src="${ctx.publicUrl}/t/open/${ctx.messageId}.gif" width="1" height="1" alt="" style="display:block;border:0" />`
    : ''

  // A second pass over the finished strings, because `{{link}}` is most useful
  // as a *link target* — the href of a button or a link — and the
  // document walker only merges text nodes. Cheap, and it means the operator can
  // put the token wherever it reads best without learning which places work.
  for (const [field, value] of Object.entries(ctx.extras ?? {})) {
    const token = `{{${field}}}`
    inner = inner.replaceAll(token, value)
    plain = plain.replaceAll(token, value)
    // A link href goes through `trackLink` first, which percent-encodes the whole
    // target into `?u=` — so by the time we get here the braces are `%7B%7B…`.
    // Substituting that form too is what makes a click-tracked download button work.
    const wrapped = encodeURIComponent(token)
    if (wrapped !== token) {
      inner = inner.replaceAll(wrapped, encodeURIComponent(value))
      plain = plain.replaceAll(wrapped, encodeURIComponent(value))
    }
  }

  const html = shell(inner, ctx.showFooter ? footerHtml(ctx, preferenceUrl) : '', pixel)
  const text = ctx.showFooter
    ? `${plain}\n\n---\n${footerText(ctx)}\n${preferenceUrl}`
    : plain

  return { html, text, preferenceUrl, oneClickUnsubscribeUrl }
}

/**
 * Render a body for the admin's own eyes: no tracking rewrites, merge tags shown
 * with sample values. Used on read-only views of already-sent mail.
 */
export function previewHtml(json: DocNode | null | undefined, md: string): string {
  if (json && !docIsEmpty(json)) {
    return renderDocToEmailHtml(json, {
      trackLink: (url) => url,
      mergeValue: (field) =>
        mergeFieldValue(field, { email: 'ada@example.com', name: 'Ada Lovelace' }),
    })
  }
  return marked.parse(md, { async: false }) as string
}

/** What a broadcast calls itself in the consent footer. */
export const BROADCAST_SCOPE_LABEL = 'the newsletter'

/**
 * The consent footer exactly as the reader will get it, for the composer's
 * paper preview. Same function the wire uses — one copy of this wording, ever —
 * with an inert link, because a draft has no message to unsubscribe from yet.
 */
export function footerPreviewHtml(scope: Scope, scopeLabel: string): string {
  return footerHtml({ scope, scopeLabel } as RenderContext, '#')
}

/** Shared by the markdown path and the rich-document `mergeTag` node. */
export function mergeFieldValue(
  field: string,
  sub: { email: string; name: string | null },
  extras?: Record<string, string>,
): string {
  const first = (sub.name ?? '').trim().split(/\s+/)[0] ?? ''
  switch (field) {
    case 'first_name':
      return first || 'there'
    case 'name':
      return sub.name ?? 'there'
    case 'email':
      return sub.email
    default:
      return extras?.[field] ?? ''
  }
}

/**
 * ⭐ The footer names the scope. A reader on a sequence email is told they can
 * leave *that sequence* and stay subscribed to everything else — which is the
 * whole reason this project exists. "Unsubscribe from everything" lives one
 * click deeper, on the preference center, never here.
 */
function footerHtml(ctx: RenderContext, preferenceUrl: string): string {
  const line =
    ctx.scope.kind === 'sequence'
      ? `You're receiving this because you joined <strong>${escapeHtml(ctx.scopeLabel)}</strong>.`
      : `You're receiving this because you subscribed to <strong>${escapeHtml(ctx.scopeLabel)}</strong>.`

  const action =
    ctx.scope.kind === 'sequence'
      ? `<a href="${preferenceUrl}" style="color:#5b6470">Stop just this series</a>`
      : `<a href="${preferenceUrl}" style="color:#5b6470">Unsubscribe from the newsletter</a>`

  return `${line}<br />${action} &nbsp;·&nbsp; <a href="${preferenceUrl}" style="color:#5b6470">Manage all your preferences</a>`
}

function footerText(ctx: RenderContext): string {
  return ctx.scope.kind === 'sequence'
    ? `You're receiving this because you joined "${ctx.scopeLabel}". You can stop just this series without leaving anything else:`
    : `You're receiving this because you subscribed to "${ctx.scopeLabel}". Manage your preferences:`
}

function rewriteLinks(html: string, ctx: RenderContext): string {
  return html.replace(/href="(https?:\/\/[^"]+)"/g, (match, url: string) => {
    if (url.startsWith(`${ctx.publicUrl}/p/`)) return match // never track the unsubscribe link
    if (url.startsWith(`${ctx.publicUrl}/d/`)) return match // nor the download, counted on its grant
    return `href="${ctx.publicUrl}/t/click/${ctx.messageId}?u=${encodeURIComponent(url)}"`
  })
}

function shell(inner: string, footer: string, pixel: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /></head>
<body style="margin:0;padding:0;background:#f6f5f3">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f5f3">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:10px;border:1px solid #e6e3de">
<tr><td style="padding:36px 40px;font:16px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#22262b">
${inner}
</td></tr>
${
  footer
    ? `<tr><td style="padding:20px 40px 32px;border-top:1px solid #eeebe6;font:13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#8b9199">
${footer}
</td></tr>`
    : ''
}
</table>
</td></tr></table>
${pixel}
</body></html>`
}

function stripMd(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)')
    .trim()
}

