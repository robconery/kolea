import type { FC, PropsWithChildren } from 'hono/jsx'
import { mdToDoc } from '../core/md-to-doc.ts'
import type { Campaign, DocNode } from '../db/schema.ts'

export const CSS = `
:root{
  --paper:#faf9f7; --card:#fff; --ink:#1a1d21; --muted:#6b7280; --faint:#9aa0a8;
  --line:#e8e5e0; --line-2:#f1efec;
  --accent:#1f6f5c; --accent-soft:#e8f2ef;
  --warn:#9a5b1e; --warn-soft:#fbf1e4;
  --danger:#a33224; --danger-soft:#fbecea;
  --radius:10px;
  --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Helvetica,Arial,sans-serif;
  --serif:ui-serif,Georgia,'Times New Roman',serif;
  --mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 var(--sans);
  -webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
h1,h2,h3{margin:0;font-weight:600;letter-spacing:-.015em}
h1{font:600 27px/1.2 var(--serif);letter-spacing:-.02em}
h2{font-size:16px}
h3{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);font-weight:600}
p{margin:0 0 12px}

.top{border-bottom:1px solid var(--line);background:#fff}
.top-in{max-width:1080px;margin:0 auto;padding:0 24px;display:flex;align-items:center;gap:28px;height:56px}
.brand{font:600 16px/1 var(--serif);letter-spacing:-.01em;color:var(--ink)}
.brand:hover{text-decoration:none}
.brand span{color:var(--accent)}
nav{display:flex;gap:2px;margin-left:auto;flex-wrap:wrap}
nav a{padding:6px 11px;border-radius:7px;color:var(--muted);font-size:14px}
nav a:hover{background:var(--line-2);text-decoration:none;color:var(--ink)}
nav a.on{background:var(--ink);color:#fff}

.wrap{max-width:1080px;margin:0 auto;padding:32px 24px 80px}
.head{display:flex;align-items:flex-end;gap:16px;margin-bottom:24px;flex-wrap:wrap}
.head .sub{color:var(--muted);font-size:14px;margin-top:5px}
.head .actions{margin-left:auto;display:flex;gap:8px;align-items:center}

.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);margin-bottom:20px}
.card-h{padding:14px 18px;border-bottom:1px solid var(--line-2);display:flex;align-items:center;gap:12px}
.card-h .actions{margin-left:auto;display:flex;gap:8px}
.card-b{padding:18px}
.card-b.flush{padding:0}

table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--faint);
  font-weight:600;padding:10px 18px;border-bottom:1px solid var(--line-2)}
td{padding:12px 18px;border-bottom:1px solid var(--line-2);vertical-align:middle}
tr:last-child td{border-bottom:0}
tbody tr:hover{background:#fcfbfa}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}

.btn{display:inline-flex;align-items:center;gap:6px;padding:7px 13px;border-radius:7px;
  border:1px solid var(--line);background:#fff;color:var(--ink);font:500 14px var(--sans);
  cursor:pointer;transition:.12s}
.btn:hover{background:var(--line-2);text-decoration:none}
.btn.primary{background:var(--ink);border-color:var(--ink);color:#fff}
.btn.primary:hover{background:#000}
.btn.accent{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.accent:hover{background:#18594a}
.btn.danger{color:var(--danger);border-color:#eddcd9}
.btn.danger:hover{background:var(--danger-soft)}
.btn.sm{padding:4px 9px;font-size:13px}

.pill{display:inline-block;padding:2px 8px;border-radius:20px;font-size:12px;font-weight:500;
  background:var(--line-2);color:var(--muted)}
.pill.ok{background:var(--accent-soft);color:var(--accent)}
.pill.warn{background:var(--warn-soft);color:var(--warn)}
.pill.bad{background:var(--danger-soft);color:var(--danger)}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1px;background:var(--line-2)}
.stat{background:#fff;padding:16px 18px}
.stat .n{font:600 24px/1 var(--sans);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.stat .l{font-size:12px;color:var(--faint);margin-top:5px;text-transform:uppercase;letter-spacing:.06em}
.stat.hi .n{color:var(--accent)}

label{display:block;font-size:13px;font-weight:500;margin-bottom:5px;color:var(--muted)}
input[type=text],input[type=email],input[type=number],textarea,select{
  width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:7px;background:#fff;
  font:14px var(--sans);color:var(--ink)}
textarea{font:14px/1.6 var(--mono);resize:vertical;min-height:200px}
input:focus,textarea:focus,select:focus{outline:2px solid var(--accent-soft);border-color:var(--accent)}
.field{margin-bottom:16px}
.row{display:flex;gap:14px;flex-wrap:wrap}
.row>*{flex:1;min-width:200px}

.tabs{display:flex;gap:2px;margin:-10px 0 20px;flex-wrap:wrap}
.tabs a{padding:6px 12px;border-radius:7px;font-size:14px;color:var(--muted)}
.tabs a:hover{background:var(--line-2);text-decoration:none;color:var(--ink)}
.tabs a.on{background:var(--accent-soft);color:var(--accent);font-weight:500}
select[multiple]{padding:6px;font-size:13px}
td.tick,th.tick{width:34px;padding-right:0}

.mono{font-family:var(--mono);font-size:13px}
.muted{color:var(--muted)}
.faint{color:var(--faint);font-size:13px}
.empty{padding:44px 18px;text-align:center;color:var(--faint)}
.empty p{margin:0 0 4px}

.flash{padding:11px 16px;border-radius:8px;margin-bottom:20px;font-size:14px;
  background:var(--accent-soft);color:#154c40;border:1px solid #cfe4dd}
.flash.warn{background:var(--warn-soft);color:var(--warn);border-color:#f0dcc2}

.note{background:var(--accent-soft);border:1px solid #cfe4dd;border-radius:8px;padding:12px 14px;
  font-size:13px;color:#1b5548;margin-bottom:18px}
.note strong{color:#123f35}

/* preference center */
.prefs{max-width:540px;margin:0 auto;padding:48px 20px 80px}
.prefs h1{font-size:25px;margin-bottom:8px}
.prefs .lede{color:var(--muted);margin-bottom:26px}
.pref-item{display:flex;gap:14px;align-items:flex-start;padding:16px 0;border-bottom:1px solid var(--line-2)}
.pref-item:last-of-type{border-bottom:0}
.pref-item .txt{flex:1}
.pref-item .nm{font-weight:600;font-size:15px}
.pref-item .ds{font-size:13px;color:var(--muted);margin-top:3px}
.pref-item.focus{background:#fffdf6;margin:0 -14px;padding:16px 14px;border-radius:8px;
  border:1px solid #f0e4c4;border-bottom:1px solid #f0e4c4}
.tag-focus{display:inline-block;font-size:11px;font-weight:600;text-transform:uppercase;
  letter-spacing:.06em;color:var(--warn);background:var(--warn-soft);padding:2px 7px;
  border-radius:4px;margin-bottom:6px}
.nuke{margin-top:32px;padding-top:22px;border-top:1px solid var(--line)}
.nuke .btn{color:var(--danger);border-color:#eddcd9;background:#fff}
.nuke .btn:hover{background:var(--danger-soft)}

.mailview{border:1px solid var(--line);border-radius:8px;overflow:hidden;background:#fff}
.mailview iframe{width:100%;height:520px;border:0;display:block;background:#f6f5f3}
.mailhead{padding:12px 16px;border-bottom:1px solid var(--line-2);font-size:13px}
.mailhead b{display:inline-block;min-width:52px;color:var(--faint);font-weight:500}
`

export const Layout: FC<
  PropsWithChildren<{ title: string; nav?: string; editor?: boolean }>
> = ({ title, nav, editor, children }) => {
  const item = (href: string, key: string, label: string) => (
    <a href={href} class={nav === key ? 'on' : ''}>
      {label}
    </a>
  )
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{title} · big-mailer</title>
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" href="/favicon.png" type="image/png" />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        {/* ~226KB gzipped, so it loads only on the two screens that compose mail. */}
        {editor ? <link rel="stylesheet" href="/editor.css" /> : null}
        {editor ? <script src="/editor.js" type="module" defer /> : null}
      </head>
      <body>
        <header class="top">
          <div class="top-in">
            <a class="brand" href="/">
              big<span>·</span>mailer
            </a>
            <nav>
              {item('/', 'home', 'Dashboard')}
              {item('/subscribers', 'subs', 'Subscribers')}
              {item('/broadcasts', 'bc', 'Broadcasts')}
              {item('/sequences', 'seq', 'Sequences')}
              {item('/campaigns', 'camp', 'Campaigns')}
              {item('/store', 'store', 'Store')}
              {item('/outbox', 'out', 'Outbox')}
              {item('/consent', 'cons', 'Consent')}
              {item('/settings', 'set', 'Settings')}
              {item('/help', 'help', 'Help')}
            </nav>
          </div>
        </header>
        <main class="wrap">{children}</main>
      </body>
    </html>
  )
}

/**
 * Sub-navigation for the three audience screens. They share one top-nav slot so
 * the header doesn't grow a tab per concept — people, the facts you store about
 * them, and the questions you ask of those facts.
 */
export const AudienceTabs: FC<{ on: 'people' | 'tags' | 'segments' }> = ({ on }) => (
  <div class="tabs">
    <a href="/subscribers" class={on === 'people' ? 'on' : ''}>
      People
    </a>
    <a href="/tags" class={on === 'tags' ? 'on' : ''}>
      Tags &amp; automation
    </a>
    <a href="/segments" class={on === 'segments' ? 'on' : ''}>
      Segments
    </a>
  </div>
)

/**
 * Sub-navigation for the storefront.
 *
 * Its own top-nav slot rather than a fourth audience tab: this is the customer
 * side of the house — what exists to sell, who bought it, and what to do about
 * that. It answers questions about *people as customers*, which is a different
 * job from the list hygiene the audience screens do.
 */
export const StoreTabs: FC<{ on: 'overview' | 'offers' | 'customers' | 'ideas' }> = ({ on }) => (
  <div class="tabs">
    <a href="/store" class={on === 'overview' ? 'on' : ''}>
      Overview
    </a>
    <a href="/store/offers" class={on === 'offers' ? 'on' : ''}>
      Offers
    </a>
    <a href="/store/customers" class={on === 'customers' ? 'on' : ''}>
      Customers
    </a>
    <a href="/store/ideas" class={on === 'ideas' ? 'on' : ''}>
      Segment ideas
    </a>
  </div>
)

/**
 * Sub-navigation for the money side: the push, the way in, and the result.
 * One top-nav slot, same reasoning as `AudienceTabs`.
 */
export const CampaignTabs: FC<{ on: 'campaigns' | 'forms' | 'sales' }> = ({ on }) => (
  <div class="tabs">
    <a href="/campaigns" class={on === 'campaigns' ? 'on' : ''}>
      Campaigns
    </a>
    <a href="/forms" class={on === 'forms' ? 'on' : ''}>
      Forms
    </a>
    <a href="/sales" class={on === 'sales' ? 'on' : ''}>
      Sales
    </a>
  </div>
)

/**
 * Optional campaign membership for a broadcast or a sequence. Optional on
 * purpose — most mail isn't part of a push, and forcing a choice would produce a
 * junk campaign called "general".
 */
export const CampaignPicker: FC<{ all: Campaign[]; value: number | null; hint?: string }> = ({
  all,
  value,
  hint,
}) =>
  all.length === 0 ? null : (
    <div class="field">
      <label>Campaign</label>
      <select name="campaignId">
        <option value="">(not part of a campaign)</option>
        {all.map((c) => (
          <option value={String(c.id)} selected={c.id === value}>
            {c.name}
          </option>
        ))}
      </select>
      <p class="faint" style="margin:6px 0 0">
        {hint ?? 'Clicks on this mail count as a touch for the campaign.'}
      </p>
    </div>
  )

/** Reads the picker above. Empty means "no campaign", never 0. */
export function readCampaignId(form: FormData): number | null {
  const raw = String(form.get('campaignId') ?? '').trim()
  const n = Number(raw)
  return raw && Number.isFinite(n) && n > 0 ? n : null
}

/** Cents → "$49.00". Integer cents in, never a float anywhere near the math. */
export function fmtMoney(cents: number, currency = 'usd'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100)
}

export const PublicLayout: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>{title}</title>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </head>
    <body>
      <div class="prefs">{children}</div>
    </body>
  </html>
)

/**
 * Rich-text field. Renders a hidden input holding the TipTap document JSON plus
 * a `<noscript>` textarea fallback, so the form works either way and the server
 * contract is just "one field of body content".
 */
export const RichEditor: FC<{ json?: DocNode | null; md?: string }> = ({ json, md }) => {
  // Markdown-authored content is converted for editing. Without this the editor
  // would open empty on legacy content and the first save would erase it.
  const doc = json ?? (md ? mdToDoc(md) : null)
  return (
  <div class="field">
    <label>Body</label>
    <input type="hidden" name="body_json" value={doc ? JSON.stringify(doc) : ''} />
    <div class="bm-editor-host" data-editor data-field="body_json" />
    <noscript>
      <textarea name="body_md_fallback" placeholder="Markdown (JavaScript is off)">
        {md ?? ''}
      </textarea>
    </noscript>
    <p class="faint" style="margin:8px 0 0">
      Press <span class="mono">/</span> for blocks · <span class="mono">@</span> to personalize ·
      drag the handle in the left margin to reorder · drop an image anywhere
    </p>
  </div>
  )
}

export const Flash: FC<{ msg?: string; kind?: string }> = ({ msg, kind }) =>
  msg ? <div class={kind === 'warn' ? 'flash warn' : 'flash'}>{msg}</div> : null

export function fmtDate(d: Date | null | undefined): string {
  if (!d) return '-'
  return new Date(d).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * Date with the year, and no clock.
 *
 * `fmtDate` above is tuned for things that happened this week — a message, a
 * send, a click — where the year is noise. Order history reaches back to 2015,
 * and "Jul 17, 4:32 AM" for a ten-year-old purchase is worse than useless.
 */
export function fmtDay(d: Date | null | undefined): string {
  if (!d) return '-'
  return new Date(d).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function statusPill(status: string) {
  const map: Record<string, string> = {
    active: 'ok',
    sent: 'ok',
    delivered: 'ok',
    draft: '',
    queued: 'warn',
    sending: 'warn',
    scheduled: 'warn',
    pending: 'warn',
    unsubscribed: '',
    cancelled: '',
    suppressed: 'bad',
    failed: 'bad',
    bounced: 'bad',
    complained: 'bad',
  }
  return <span class={`pill ${map[status] ?? ''}`}>{status}</span>
}
