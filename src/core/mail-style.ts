/**
 * The mail palette and type, as inline style strings.
 *
 * Mail content, not admin chrome: inboxes ignore stylesheets, so these values
 * are inlined into every element and cannot be CSS custom properties. Solid
 * colours only (Outlook drops `rgba`), plus the one sans stack every client
 * has. This module is the one place mail colours live; the body walker
 * (`render-doc.ts`) and the chrome around it (`render.ts`) both read it, so
 * the two cannot drift apart.
 */

export const MAIL_FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`
export const MAIL_MONO = `ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace`

export const MAIL_COLOUR = {
  ink: '#1F1B16',
  muted: '#5C5349',
  subtle: '#8A8075',
  hairline: '#E7E1D8',
  quoteRule: '#D9CFC2',
  sunken: '#F4F0EA',
  accent: '#B4532A',
  highlight: '#F6E7B8',
  paper: '#ffffff',
} as const

export type MailColour = keyof typeof MAIL_COLOUR

/** The width of the mail's column, in pixels. */
export const MAIL_COLUMN = 620

/** The gap under each block: paragraphs, lists, quotes, code. */
export const MAIL_BLOCK_GAP = '22px'

/**
 * Type longhands. Outlook reads longhands more reliably than the `font`
 * shorthand, which it drops whole when it dislikes one part of it.
 */
export function mailType(
  size: number,
  lineHeight: number | string,
  opts: { weight?: number; colour?: MailColour; mono?: boolean } = {},
): string {
  const family = opts.mono ? MAIL_MONO : MAIL_FONT
  const weight = opts.weight ? `font-weight:${opts.weight};` : ''
  return `font-family:${family};font-size:${size}px;line-height:${lineHeight};${weight}color:${MAIL_COLOUR[opts.colour ?? 'ink']}`
}
