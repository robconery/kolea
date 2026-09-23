import { marked } from 'marked'
import type { DocNode, MergeExtra, MergeExtras } from '../db/schema.ts'
import { type Scope, formatScope } from './consent.ts'
import { shareOnFacebookUrl, shareOnLinkedInUrl, shareOnXUrl } from './posts.ts'
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
  /** The subject line, used as the pre-filled text of the share link. */
  subject?: string
  /**
   * The published post this mail corresponds to, when there is one. Null for a
   * sequence step, a receipt, or a broadcast that isn't on the web — and the
   * "read online" and share links are omitted entirely rather than pointing
   * somewhere that 404s.
   */
  postUrl?: string | null
  /**
   * The headline at the top of the mail. Set for a broadcast, which is a piece
   * of writing with a title; left out for a sequence step or a receipt, which
   * read as a letter and would look odd under a banner.
   */
  title?: string | null
  /**
   * The grey line under the title. Only ever one the operator wrote — see
   * `authoredLead()` — and it doubles as the inbox preview text.
   */
  lead?: string | null
  /**
   * Per-message merge values the subscriber row can't supply — a lead magnet's
   * download URL, a buyer's offer name and download links — which are one
   * person's and so cannot be baked into the body the operator wrote.
   *
   * A value may be one string for both surfaces, or a `{ html, text }` pair when
   * they differ (a list of links being the case that forces it). See
   * `MergeExtras` in the schema.
   */
  extras?: MergeExtras
}

/** The HTML form of a merge extra. */
function extraHtml(value: MergeExtra): string {
  return typeof value === 'string' ? value : value.html
}

/** The plaintext form of a merge extra. */
function extraText(value: MergeExtra): string {
  return typeof value === 'string' ? value : value.text
}

/**
 * Collapse extras down to one surface's strings.
 *
 * Done here rather than by widening `mergeFields` and `mergeFieldValue`, because
 * those two are surface-blind by design — `mergeFields` is also the neutralizer
 * the *web* renderer uses, and giving it an opinion about HTML would be how an
 * email-shaped value ends up on a public page.
 */
function flattenExtras(
  extras: MergeExtras | undefined,
  surface: 'html' | 'text',
): Record<string, string> | undefined {
  if (!extras) return undefined
  const pick = surface === 'html' ? extraHtml : extraText
  return Object.fromEntries(Object.entries(extras).map(([k, v]) => [k, pick(v)]))
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

  // Two flattenings, because a `{{downloads}}` list is markup in one surface and
  // a numbered list in the other. The walker resolves merge-tag *nodes* during
  // the walk, so it has to be handed the right surface up front — the second
  // pass further down only catches literal `{{…}}` text that survived.
  const htmlExtras = flattenExtras(ctx.extras, 'html')
  const textExtras = flattenExtras(ctx.extras, 'text')
  const htmlMergeValue = (field: string): string =>
    mergeFieldValue(field, ctx.subscriber, htmlExtras)
  const textMergeValue = (field: string): string =>
    mergeFieldValue(field, ctx.subscriber, textExtras)

  let inner: string
  let plain: string

  if (body.json && !docIsEmpty(body.json)) {
    inner = renderDocToEmailHtml(body.json, { trackLink, mergeValue: htmlMergeValue })
    plain = renderDocToText(body.json, { trackLink, mergeValue: textMergeValue })
  } else {
    // Legacy markdown path.
    const mergedHtml = mergeFields(body.md, ctx.subscriber, htmlExtras)
    inner = marked.parse(mergedHtml, { async: false }) as string
    if (ctx.trackClicks) inner = rewriteLinks(inner, ctx)
    plain = stripMd(mergeFields(body.md, ctx.subscriber, textExtras))
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
    const html = extraHtml(value)
    const text = extraText(value)
    inner = inner.replaceAll(token, html)
    plain = plain.replaceAll(token, text)
    // A link href goes through `trackLink` first, which percent-encodes the whole
    // target into `?u=` — so by the time we get here the braces are `%7B%7B…`.
    // Substituting that form too is what makes a click-tracked download button work.
    // Only the plain form is ever a usable href, so a `{ html, text }` pair is
    // skipped here: a list of links is not a link target, and encoding its markup
    // into a `?u=` parameter would produce a tracking URL that redirects nowhere.
    const wrapped = encodeURIComponent(token)
    if (wrapped !== token && typeof value === 'string') {
      inner = inner.replaceAll(wrapped, encodeURIComponent(value))
      plain = plain.replaceAll(wrapped, encodeURIComponent(value))
    }
  }

  // Deliberately built outside the body, which is the only thing `trackLink` and
  // `rewriteLinks` touch — so the chrome stays untracked, exactly like the
  // preference and download links.
  const masthead = ctx.title ? mastheadHtml(ctx.title, ctx.lead ?? null, ctx.postUrl ?? null, ctx.subject ?? ctx.title) : ''
  const share = ctx.postUrl ? shareHtml(ctx.postUrl, ctx.subject ?? '') : ''

  const html = shell(
    `${masthead}${inner}${share}`,
    ctx.showFooter ? footerHtml(ctx, preferenceUrl) : '',
    pixel,
    ctx.title ? (ctx.lead ?? null) : null,
  )

  const text = [
    ctx.title ? `${ctx.title}\n${ctx.lead ? `${ctx.lead}\n` : ''}\n` : '',
    ctx.postUrl ? `Read this online: ${ctx.postUrl}\n\n` : '',
    plain,
    ctx.postUrl
      ? `\n\nShare it:\nX: ${shareOnXUrl(ctx.postUrl, ctx.subject ?? '')}\nLinkedIn: ${shareOnLinkedInUrl(ctx.postUrl)}`
      : '',
    ctx.showFooter ? `\n\n---\n${footerText(ctx)}\n${preferenceUrl}` : '',
  ].join('')

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

/**
 * The masthead: title, lead, and — when the piece is on the web — a row of share
 * buttons with "Read online" at the right, between two hairlines. Substack's
 * shape, because it puts the thing a reader might do with a good piece (pass it
 * on) at the top, where it is seen, instead of under 1,500 words where it isn't.
 *
 * Every link here is a plain share intent: no API key, no OAuth, nothing to
 * break when a platform changes its mind. Without a published post there is
 * nothing to share, and the row is left out rather than pointing at a 404.
 */
function mastheadHtml(title: string, lead: string | null, postUrl: string | null, subject: string): string {
  const forwarded = postUrl
    ? `<p style="margin:0 0 28px;font:13px/1.5 ${FOOT_FONT};color:#8b8b8b;text-align:right">Forwarded this email? <a href="${escapeHtml(`${siteOrigin(postUrl)}/subscribe`)}" style="color:#8b8b8b;text-decoration:underline">Subscribe here</a> for more</p>`
    : ''
  const h1 = `<h1 style="margin:0 0 14px;font:700 34px/1.2 ${TITLE_FONT};color:#1a1a1a;letter-spacing:-0.01em">${escapeHtml(title)}</h1>`
  const sub = lead
    ? `<p style="margin:0 0 26px;font:19px/1.5 ${FOOT_FONT};color:#6b6b6b">${escapeHtml(lead)}</p>`
    : ''
  const rule = `<div style="height:1px;line-height:1px;font-size:1px;background:#e6e6e6">&nbsp;</div>`
  const row = postUrl ? shareRowHtml(postUrl, subject) : ''
  return `${forwarded}${h1}${sub}${lead ? '' : '<div style="height:12px;line-height:12px;font-size:1px">&nbsp;</div>'}${rule}${row ? `${row}${rule}` : ''}<div style="height:30px;line-height:30px;font-size:1px">&nbsp;</div>`
}

/**
 * The round buttons. Each is one PNG with the white disc and grey ring baked in
 * (`public/img/email/`) rather than a styled cell: Outlook ignores border-radius,
 * and Gmail's dark mode repaints a cell's background but never an image — a
 * black glyph on a transparent PNG would vanish into the dark. Served from the
 * public site's host because the console's host sits behind Cloudflare Access.
 */
function shareRowHtml(url: string, subject: string): string {
  const base = `${siteOrigin(url)}/img/email`
  const button = (href: string, icon: string, label: string): string =>
    `<td style="padding:0 10px 0 0"><a href="${escapeHtml(href)}" title="${label}" style="text-decoration:none"><img src="${base}/share-${icon}.png" width="40" height="40" alt="${label}" style="display:block;border:0;width:40px;height:40px" /></a></td>`
  const buttons = [
    button(shareOnXUrl(url, subject), 'x', 'Share on X'),
    button(shareOnLinkedInUrl(url), 'linkedin', 'Share on LinkedIn'),
    button(shareOnFacebookUrl(url), 'facebook', 'Share on Facebook'),
  ].join('')
  const readOnline = `<a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 20px;border:1.5px solid #d9d9d9;border-radius:999px;font:600 13px/18px ${FOOT_FONT};letter-spacing:0.04em;color:#3a3a3a;text-decoration:none;white-space:nowrap">READ ONLINE &#8599;</a>`
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:14px 0">
<table role="presentation" cellpadding="0" cellspacing="0" align="left"><tr>${buttons}</tr></table>
</td><td align="right" style="padding:14px 0">${readOnline}</td></tr></table>`
}

/** Share row, under the body and above the consent footer. */
function shareHtml(url: string, subject: string): string {
  const x = escapeHtml(shareOnXUrl(url, subject))
  const li = escapeHtml(shareOnLinkedInUrl(url))
  return `<p style="margin:36px 0 0;padding-top:20px;border-top:1px solid #e6e6e6;font:14px/1.6 ${FOOT_FONT};color:#6b6b6b">Worth passing on? <a href="${x}" style="color:#1a1a1a;font-weight:600">Post it on X</a> &nbsp;·&nbsp; <a href="${li}" style="color:#1a1a1a;font-weight:600">share it on LinkedIn</a> &nbsp;·&nbsp; <a href="${escapeHtml(url)}" style="color:#1a1a1a;font-weight:600">copy the link</a></p>`
}

/** Scheme and host of the public site, taken from a post URL on it. */
function siteOrigin(postUrl: string): string {
  return new URL(postUrl).origin
}

const TITLE_FONT = `'SF Mono',ui-monospace,Menlo,Consolas,'Liberation Mono',monospace`

const FOOT_FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`

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

/**
 * White, edge to edge, one column. No card, no tinted page behind it — the
 * paper *is* the page, which is most of why a Substack mail reads easily.
 *
 * `preheader` is the inbox preview line: hidden in the body, read by the client.
 * Padded out with zero-width joiners so the client doesn't fill the rest of the
 * preview with the first words of the body, which it would otherwise do.
 */
function shell(inner: string, footer: string, pixel: string, preheader: string | null): string {
  const hidden = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff;opacity:0">${escapeHtml(preheader)}${'&#847;&zwnj;&nbsp;'.repeat(60)}</div>\n`
    : ''
  return `<!doctype html>
<html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /></head>
<body style="margin:0;padding:0;background:#ffffff">
${hidden}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff">
<tr><td align="center" style="padding:28px 20px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px">
<tr><td style="padding:0;font:17px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f1f1f">
${inner}
</td></tr>
${
  footer
    ? `<tr><td style="height:36px;line-height:36px;font-size:1px">&nbsp;</td></tr>
<tr><td style="padding:24px 0 32px;border-top:1px solid #e6e6e6;font:13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#8b8b8b">
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

