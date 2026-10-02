import type { Child, FC, PropsWithChildren } from 'hono/jsx'
import { mdToDoc } from '../core/md-to-doc.ts'
import type { Campaign, DocNode } from '../db/schema.ts'

/**
 * The look: the Kōlea admin, ported from the hosted app.
 *
 * Warm, light, dependable. It should feel like a notebook on a desk, not a
 * control room. A cream canvas; a narrow plumage rail of section icons with
 * the current section's pages docked beside it on a sunken column; the work in
 * crisp surface panels, each a hairline ring plus a soft contact shadow. One
 * marigold button per screen, lagoon for links, focus and the lit nav item.
 *
 * Rules that keep it fast on a Worker with no framework:
 *   · One stylesheet, inlined. No CSS build, no utility runtime.
 *   · Animation is `transform` and `opacity` only — never width/height/top/left.
 *   · Entrances are a short staggered CSS keyframe on load. Zero JavaScript.
 *   · The phone menu is a checkbox, so it works with JavaScript off.
 */
export const CSS = `
@layer base, shell, surface, controls, data, motion, compose;

@layer base {
:root{
  /* The palette is the bird: the kolea's breeding plumage (near-black olive),
     its marigold speckle, its cream eye-stripe, and the lagoon it winters on.
     Same tokens as the hosted Kōlea, so the two read as one family. */
  --canvas:#FBF8F1;          /* page background, cream-tinted */
  --surface:#FFFDF8;         /* panels */
  --sunken:#F3EEE2;          /* wells, the docked column, table hover */
  --ink:#1B1A13;             /* primary text: plumage */
  --muted:#57533F;           /* secondary text */
  --faint:#6B6650;           /* tertiary, placeholders, idle icons */
  --hairline:rgba(27,26,19,.10); /* the only border colour */
  --line:rgba(27,26,19,.16);     /* a control's outline at rest */

  /* Lagoon: links, focus, the lit nav item, chart series. Text-safe. */
  --accent:#0B6B63; --accent-hover:#08564F; --accent-bright:#2BB3A3;
  --accent-soft:rgba(11,107,99,.10);
  /* Marigold: the primary action. A fill only, always with ink on it. */
  --spark:#F5B731; --spark-hover:#E6A516; --spark-deep:#D48A0B;
  --spark-soft:rgba(245,183,49,.18);
  /* The rail: plumage, with cream text. */
  --rail:#1B1A13; --rail-raised:#2A2920; --rail-ink:#F4EAD0; --rail-muted:#B5AE92;
  /* Status: dots, pills, chart marks. Never large fills, never small text. */
  --positive:#2E7D3A; --caution:#B4530C; --critical:#B3261E;
  --positive-soft:rgba(46,125,58,.11); --caution-soft:rgba(180,83,12,.11);
  --critical-soft:rgba(179,38,30,.09);
  --plum:#7B4F9E; --deep:#3B679A; --hibiscus:#B2395E;

  /* Older names, still used by inline styles and the editor. They point at
     the new palette so nothing has to know the look changed. */
  --cyan:var(--accent); --azure:var(--deep); --indigo:var(--deep);
  --violet:var(--plum); --aqua:var(--positive); --rose:var(--critical);
  --beam:linear-gradient(90deg,var(--accent),var(--accent-bright));
  --rule:var(--hairline); --rule-v:var(--hairline); --rule-faint:rgba(27,26,19,.06);
  --line-2:var(--hairline);

  /* Depth: a hairline ring plus a soft contact shadow. Only overlays lift. */
  --shadow-soft:0 1px 0 rgba(27,26,19,.04),0 1px 3px rgba(27,26,19,.05);
  --shadow-lifted:0 1px 2px rgba(27,26,19,.06),0 16px 40px -12px rgba(27,26,19,.18);
  --shadow-press:inset 0 -2px 0 rgba(27,26,19,.14); /* the marigold button's lip */
  --ring:0 0 0 1px var(--hairline);

  --sans:'Geist',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Helvetica,sans-serif;
  --display:var(--sans);
  --mono:'Geist Mono',ui-monospace,SFMono-Regular,'SF Mono',Menlo,monospace;
  /* One curve for nearly everything: ease-out-quint, settled at 180ms. */
  --settle:cubic-bezier(.22,1,.36,1);
  --glide:var(--settle);
  --spring:cubic-bezier(.32,.72,0,1);
  --rail-w:64px; --dock-w:212px;
  --gut:24px;
}
*{box-sizing:border-box}
html{color-scheme:light;background:var(--canvas);scrollbar-color:rgba(27,26,19,.2) transparent}
body{margin:0;background:var(--canvas);color:var(--ink);
  font:14px/1.57 var(--sans);font-feature-settings:"ss01","cv11";
  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility}
::selection{background:var(--accent-soft)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
a{color:var(--accent);text-decoration:none;text-underline-offset:3px;transition:color .18s var(--settle)}
a:hover{color:var(--accent-hover)}
h1,h2,h3{margin:0;color:var(--ink)}
h1{font:700 32px/1.19 var(--display);letter-spacing:-.03em}
h2{font:600 16px/1.4 var(--display);letter-spacing:-.01em}
h3{font:600 12px/1 var(--display);text-transform:uppercase;letter-spacing:.08em;color:var(--faint)}
p{margin:0 0 12px}
hr{border:0;height:1px;background:var(--hairline);margin:24px 0}
table,time,.num{font-variant-numeric:tabular-nums}
code,kbd,pre,samp{font-family:var(--mono)}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:rgba(27,26,19,.16);border-radius:99px;
  border:3px solid transparent;background-clip:content-box}
::-webkit-scrollbar-thumb:hover{background:rgba(27,26,19,.28);background-clip:content-box}
::-webkit-scrollbar-track{background:transparent}
}

/* ─────────────────────────────────────────────────────────── the shell

   A narrow plumage rail of section icons, the current section's pages docked
   beside it on a sunken column, then the work on the cream canvas. Dashboard
   has no pages of its own, so nothing docks and the work takes the width. */
@layer shell {
.rail-cb{position:absolute;opacity:0;pointer-events:none}
.shell{min-height:100dvh}

.rail{position:fixed;top:0;bottom:0;left:0;z-index:40;display:flex}
.rail-bar{width:var(--rail-w);flex:0 0 auto;display:flex;flex-direction:column;align-items:center;
  padding:12px 0;background:var(--rail);color:var(--rail-ink)}
.mark{width:40px;height:40px;flex:0 0 auto;display:grid;place-items:center;overflow:hidden;
  border-radius:10px;background:var(--spark);box-shadow:var(--shadow-press);margin:0 0 16px;
  transition:transform .3s var(--spring)}
.mark img{width:30px;height:auto;display:block}
.mark:hover{transform:rotate(-6deg)}
.rail-nav{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;gap:4px}
.rail-nav .pin{margin-top:auto}
.re{position:relative;width:44px;height:44px;flex:0 0 auto;display:grid;place-items:center;
  border-radius:10px;color:var(--rail-muted);
  transition:background-color .18s var(--settle),color .18s var(--settle)}
.re svg{width:20px;height:20px;transition:transform .18s var(--settle)}
.re:hover{background:var(--rail-raised);color:var(--rail-ink)}
.re:hover svg{transform:translateY(-1px)}
.re.on{background:var(--spark);color:var(--ink);box-shadow:var(--shadow-press)}
.re.on:hover{color:var(--ink)}
.re.on:hover svg{transform:none}
/* The label is a tooltip to the right, shown on hover and on keyboard focus.
   It stays in the DOM, so it is the link's name. */
.re .tip{position:absolute;left:100%;top:50%;z-index:60;margin-left:12px;padding:7px 10px;
  border-radius:6px;background:var(--ink);color:var(--canvas);box-shadow:var(--shadow-lifted);
  font:500 13px/1 var(--sans);white-space:nowrap;pointer-events:none;
  opacity:0;transform:translate(-4px,-50%);transition:opacity .15s var(--settle),transform .15s var(--settle)}
.re:hover .tip,.re:focus-visible .tip{opacity:1;transform:translate(0,-50%)}

.dock{width:var(--dock-w);flex:0 0 auto;display:flex;flex-direction:column;
  background:var(--sunken);border-right:1px solid var(--hairline)}
.dock-h{height:64px;flex:0 0 auto;display:flex;align-items:center;padding:0 20px;
  font:600 16px/1 var(--display);letter-spacing:-.01em;color:var(--ink)}
.dock ul,.sheet ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.dock ul{flex:1;overflow-y:auto;padding:0 12px 24px}
.it{display:flex;align-items:center;gap:12px;height:36px;padding:0 12px;border-radius:10px;
  color:var(--muted);font:400 14px/1 var(--sans);
  transition:background-color .18s var(--settle),color .18s var(--settle)}
.it svg{width:18px;height:18px;flex:0 0 auto;color:var(--faint)}
.it:hover{background:rgba(255,253,248,.7);color:var(--ink)}
.it.on{background:var(--surface);color:var(--ink);font-weight:600;
  box-shadow:var(--ring),var(--shadow-soft)}
.it.on svg{color:var(--accent)}

/* The phone sheet: every section and its pages in one list. */
.sheet{display:none}

.stage{padding-left:var(--rail-w);min-height:100dvh}
.shell.docked .stage{padding-left:calc(var(--rail-w) + var(--dock-w))}
.wrap{max-width:76rem;margin:0 auto;padding:48px 48px 120px}
.wrap.wide{max-width:none;padding:48px 40px 120px}
@media (min-width:1536px){.wrap{padding-left:64px;padding-right:64px}.wrap.wide{padding-left:56px;padding-right:56px}}

.mobar{display:none}
.scrim{display:none}
.burger{display:none}

@media (max-width:1023px){
  .rail{width:min(300px,86vw);visibility:hidden;transform:translateX(-100%);
    box-shadow:var(--shadow-lifted);
    transition:transform .32s var(--settle),visibility .32s}
  .rail-cb:checked ~ .shell .rail{visibility:visible;transform:none}
  .rail-bar,.dock{display:none}
  .sheet{display:block;width:100%;height:100%;overflow-y:auto;background:var(--sunken);
    padding:0 12px 32px}
  .sheet-top{display:flex;align-items:center;height:56px;padding:0 4px;margin-bottom:4px}
  .sheet .grp{padding:18px 12px 6px;font:600 12px/1 var(--display);text-transform:uppercase;
    letter-spacing:.08em;color:var(--faint)}
  .stage,.shell.docked .stage{padding-left:0}
  .wrap,.wrap.wide{padding:24px 16px 100px}
  .mobar{display:flex;position:sticky;top:0;z-index:30;align-items:center;gap:8px;
    height:56px;padding:0 12px;background:var(--canvas);border-bottom:1px solid var(--hairline)}
  .burger{display:grid;place-items:center;width:36px;height:36px;border-radius:99px;cursor:pointer;
    color:var(--muted);transition:background-color .18s var(--settle)}
  .burger:hover{background:var(--sunken);color:var(--ink)}
  .burger span{position:relative;display:block;width:18px;height:2px}
  .burger i{position:absolute;left:0;top:0;display:block;width:18px;height:1.5px;border-radius:2px;
    background:currentColor;transition:transform .32s var(--spring)}
  .burger i:first-child{transform:translateY(-4px)}
  .burger i:last-child{transform:translateY(4px)}
  .rail-cb:checked ~ .shell .burger i:first-child{transform:translateY(0) rotate(45deg)}
  .rail-cb:checked ~ .shell .burger i:last-child{transform:translateY(0) rotate(-45deg)}
  .scrim{display:block;position:fixed;inset:0;z-index:35;opacity:0;pointer-events:none;
    background:rgba(27,26,19,.4);transition:opacity .32s var(--settle)}
  .rail-cb:checked ~ .shell .scrim{opacity:1;pointer-events:auto}
  .hide-sm{display:none}
  /* A wide table scrolls inside its panel, not the page. */
  .card-b.flush{overflow-x:auto}
}

/* The wordmark, for the phone bar and the sheet. */
.brand{display:inline-flex;align-items:center;gap:10px;color:var(--ink)}
.brand:hover{color:var(--ink)}
.brand .mark{width:32px;height:32px;margin:0;border-radius:8px}
.brand .mark img{width:24px}
.brand .wm{font:700 18px/1 var(--display);letter-spacing:-.02em}
}

/* ─────────────────────────────────────────────────── the working surface */
@layer surface {
/* Page header: an eyebrow, the title, one line of description, and the
   actions bottom-right. */
.head{display:flex;align-items:flex-end;gap:24px;flex-wrap:wrap;margin:0 0 32px}
.head .sub{color:var(--muted);font-size:16px;line-height:1.5;margin-top:8px;max-width:70ch}
.head .actions{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.eyebrow{display:inline-flex;align-items:center;gap:8px;margin-bottom:10px;
  font:600 13px/1 var(--display);color:var(--muted)}
.eyebrow::before{content:'';width:8px;height:8px;border-radius:50%;background:var(--spark)}

/* A panel: one crisp surface with a hairline ring and a soft contact shadow. */
.card{position:relative;margin:0 0 24px;padding:0;border:0;border-radius:16px;
  background:var(--surface);box-shadow:var(--ring),var(--shadow-soft)}
.card-h{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:16px 20px;
  border-bottom:1px solid var(--hairline)}
.card-h .actions{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.card-b{padding:20px}
/* Flush: tables run to the panel's edge, everything else keeps the padding. */
.card-b.flush{padding:0}
.card-b.flush>:not(table):not(.tscroll){margin:20px}

/* Panels pair on a 12-column grid. */
.bento{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));column-gap:var(--gut);align-items:start}
.bento>*{grid-column:span 12}
.col-4{grid-column:span 4}.col-5{grid-column:span 5}.col-6{grid-column:span 6}
.col-7{grid-column:span 7}.col-8{grid-column:span 8}.col-12{grid-column:span 12}
@media (max-width:1180px){
  .bento>*{grid-column:span 12!important}
}

/* Tabs: a segmented control. The lit one is a little surface of its own. */
.tabs{display:inline-flex;gap:2px;flex-wrap:wrap;margin:0 0 28px;padding:3px;border-radius:99px;
  background:var(--sunken);box-shadow:inset 0 0 0 1px var(--hairline)}
.tabs a{padding:7px 14px;border-radius:99px;font:500 13px/1.1 var(--sans);color:var(--muted);
  transition:background-color .18s var(--settle),color .18s var(--settle)}
.tabs a:hover{color:var(--ink)}
.tabs a.on{background:var(--surface);color:var(--ink);font-weight:600;
  box-shadow:var(--ring),var(--shadow-soft)}

/* An explanatory note: a marigold wash with a hairline ring, never a dark block. */
.note{position:relative;margin:0 0 20px;padding:12px 16px;border-radius:12px;
  font-size:14px;color:var(--ink);background:var(--spark-soft);
  box-shadow:inset 0 0 0 1px var(--hairline)}
.note.warn{background:var(--caution-soft)}
.note strong{color:var(--ink);font-weight:600}

.flash{position:relative;margin:0 0 24px;padding:12px 16px 12px 36px;border-radius:12px;
  font-size:14px;color:var(--ink);background:var(--positive-soft);
  box-shadow:inset 0 0 0 1px rgba(46,125,58,.16)}
.flash::before{content:'';position:absolute;left:16px;top:19px;width:8px;height:8px;border-radius:50%;
  background:var(--positive)}
.flash.warn{background:var(--caution-soft);box-shadow:inset 0 0 0 1px rgba(180,83,12,.18)}
.flash.warn::before{background:var(--caution)}

/* Empty: a glyph in a marigold circle, kept soft so the action leads. */
.empty{padding:48px 20px;text-align:center;color:var(--faint)}
.empty::before{content:'';display:block;width:44px;height:44px;margin:0 auto 16px;border-radius:50%;
  background:var(--spark-soft) no-repeat center/22px url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%231B1A13' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 13.6h4.2l1.3 2.5h5l1.3-2.5H20M6.5 4.8h11l2.5 8.8v5.6H4v-5.6l2.5-8.8Z'/%3E%3C/svg%3E")}
.empty p{margin:0 0 6px}
.empty p:first-child{color:var(--ink);font-size:15px;font-weight:500}

pre.code,.card pre{background:var(--sunken);padding:16px 18px;border-radius:12px;overflow:auto;border:0;
  box-shadow:inset 0 0 0 1px var(--hairline);font:13px/1.6 var(--mono);color:var(--ink)}

.mailview{border-radius:12px;overflow:hidden;background:#fff;box-shadow:var(--ring)}
.mailview iframe{width:100%;height:620px;border:0;display:block;background:#fff}
.mailhead{padding:12px 0;font-size:13px;color:var(--muted);border-bottom:1px solid var(--hairline)}
.mailhead b{display:inline-block;min-width:56px;color:var(--faint);font-weight:500}

.mono{font-family:var(--mono);font-size:12.5px;letter-spacing:-.01em}
.muted{color:var(--muted)}
.faint{color:var(--faint);font-size:13px}
}

/* ─────────────────────────────────────────────────────── the controls */
@layer controls {
/* Pills. One marigold per screen; icons that mean travel trail the label in
   a black circle. Pressed buttons scale to .98. */
.btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:8px;
  height:40px;padding:0 16px;border-radius:99px;border:0;cursor:pointer;white-space:nowrap;
  font:500 14px/1 var(--display);letter-spacing:-.005em;
  background:var(--surface);color:var(--ink);box-shadow:inset 0 0 0 1px var(--line),var(--shadow-soft);
  transition:background-color .18s var(--settle),color .18s var(--settle),transform .18s var(--settle)}
.btn:hover{background:var(--sunken);color:var(--ink)}
.btn:active{transform:scale(.98)}
.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
/* A disabled button that looks live is a button you click twice and blame. */
.btn:disabled{opacity:.45;cursor:default;pointer-events:none;transform:none}
.btn.primary{background:var(--spark);color:var(--ink);font-weight:600;box-shadow:var(--shadow-press)}
.btn.primary:hover{background:var(--spark-hover);color:var(--ink)}
.btn.accent{background:var(--accent);color:var(--surface);font-weight:600;box-shadow:none}
.btn.accent:hover{background:var(--accent-hover);color:var(--surface)}
.btn.danger{color:var(--critical);box-shadow:inset 0 0 0 1px rgba(179,38,30,.32)}
.btn.danger:hover{background:var(--critical-soft);color:var(--critical)}
.btn.sm{height:32px;padding:0 12px;font-size:13px}
.btn .chip{display:grid;place-items:center;width:24px;height:24px;margin:0 -10px 0 0;
  border-radius:99px;background:transparent;transition:transform .18s var(--settle)}
.btn.sm .chip{width:20px;height:20px;margin-right:-6px}
.btn.primary .chip{background:var(--ink);color:var(--spark)}
.btn:hover .chip{transform:translateX(2px)}

/* Status: a tone wash, a tone dot, and ink text. */
.pill{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:99px;
  font:500 12px/1.4 var(--display);white-space:nowrap;color:var(--ink);
  background:var(--sunken);box-shadow:inset 0 0 0 1px var(--hairline)}
.pill::before{content:'';width:6px;height:6px;border-radius:50%;flex:0 0 auto;background:var(--faint)}
.pill.ok{background:var(--positive-soft);box-shadow:inset 0 0 0 1px rgba(46,125,58,.16)}
.pill.ok::before{background:var(--positive)}
.pill.warn{background:var(--caution-soft);box-shadow:inset 0 0 0 1px rgba(180,83,12,.16)}
.pill.warn::before{background:var(--caution)}
.pill.bad{background:var(--critical-soft);box-shadow:inset 0 0 0 1px rgba(179,38,30,.16)}
.pill.bad::before{background:var(--critical)}

/* Fields: outlined at rest, a lagoon ring on focus. */
/* :not() on the two labels that are furniture rather than field captions. The
   hamburger and the drawer scrim are <label> elements so the menu works with
   JavaScript off, and this rule lives in a later @layer than the shell — layer
   order beats specificity, so without the exclusion it would quietly reset
   their display and un-centre the hamburger. */
label:not(.burger):not(.scrim){display:block;font:500 13px/1.3 var(--display);
  margin-bottom:6px;color:var(--ink)}
input[type=text],input[type=email],input[type=number],input[type=password],
input[type=search],input[type=url],input[type=date],input[type=datetime-local],
textarea,select{
  width:100%;min-height:40px;padding:9px 12px;border:0;border-radius:10px;color:var(--ink);
  background:var(--surface);font:14px var(--sans);
  box-shadow:inset 0 0 0 1px var(--line);
  transition:box-shadow .18s var(--settle)}
input::placeholder,textarea::placeholder{color:var(--faint);opacity:1}
textarea{font:13px/1.65 var(--mono);resize:vertical;min-height:200px}
select{appearance:none;cursor:pointer;padding-right:38px;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236B6650' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M8 9.5l4-4 4 4M8 14.5l4 4 4-4'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 12px center;background-size:16px}
select[multiple]{padding:8px;font-size:13px;background-image:none}
option{background:var(--surface);color:var(--ink)}
input:hover,textarea:hover,select:hover{box-shadow:inset 0 0 0 1px rgba(27,26,19,.28)}
input:focus,textarea:focus,select:focus{outline:0;
  box-shadow:inset 0 0 0 1px var(--accent),0 0 0 3px var(--accent-soft)}
input[readonly]{background:var(--sunken)}
input[type=checkbox],input[type=radio]{appearance:none;-webkit-appearance:none;
  width:16px;height:16px;flex:0 0 auto;margin:0;cursor:pointer;border-radius:4px;
  background:var(--surface);box-shadow:inset 0 0 0 1px rgba(27,26,19,.3);
  transition:background-color .18s var(--settle),box-shadow .18s var(--settle)}
input[type=radio]{border-radius:50%}
input[type=checkbox]:hover,input[type=radio]:hover{box-shadow:inset 0 0 0 1px rgba(27,26,19,.5)}
input[type=checkbox]:checked,input[type=radio]:checked{background:var(--accent);box-shadow:none}
input[type=checkbox]:checked::after{content:'';display:block;width:100%;height:100%;
  background:no-repeat center/11px url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23FFFDF8' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12.5l4.5 4.5L19 7'/%3E%3C/svg%3E")}
input[type=radio]:checked::after{content:'';display:block;width:100%;height:100%;
  background:radial-gradient(circle at 50% 50%,var(--surface) 0 28%,transparent 31%)}
input[type=checkbox]:focus,input[type=radio]:focus{box-shadow:inset 0 0 0 1px rgba(27,26,19,.3)}
input[type=checkbox]:checked:focus,input[type=radio]:checked:focus{box-shadow:none}
input[type=checkbox]:focus-visible,input[type=radio]:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
input[type=color]{width:44px;height:32px;padding:2px;border:0;border-radius:8px;cursor:pointer;
  background:var(--surface);box-shadow:inset 0 0 0 1px var(--line)}
/* Forms get a measure. A 1,500px-wide text input is not "using the space". */
.field{margin-bottom:20px;max-width:1040px}
.row{display:flex;gap:16px;flex-wrap:wrap;max-width:1040px}
.row>*{flex:1;min-width:210px}
.row .field{max-width:none}
.bm-editor-host{max-width:1040px}
}

/* ──────────────────────────────────────────────────────────── the data */
@layer data {
/* Stat tiles: one number, tabular, with its label above and a hint below. */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;padding:0}
.stat{position:relative;display:flex;flex-direction:column;min-width:0;padding:16px 18px;
  border-radius:12px;background:var(--canvas);box-shadow:inset 0 0 0 1px var(--hairline)}
.stat .l{order:-1;display:flex;align-items:center;gap:7px;margin:0 0 10px;
  font:500 13px/1.3 var(--display);color:var(--muted)}
.stat .n{font:700 28px/1.1 var(--display);font-variant-numeric:tabular-nums;
  letter-spacing:-.03em;color:var(--ink)}
.stat .h,.stat .hint{font-size:12.5px;color:var(--muted);margin-top:8px}
.stat.hi .l:not(:has(.tr-key))::before{content:'';width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:var(--spark)}
.stats.money .stat .n{font-size:24px}

/* ── Buzz: the traffic hero. The site and the list on one timeline. */
.tr-card .card-b{padding:24px}
.tr-top{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:24px}
.tr-headline{font:700 clamp(22px,2.2vw,28px)/1.2 var(--display);letter-spacing:-.03em;margin:0;
  color:var(--ink);max-width:30ch;text-wrap:balance}
.tr-side{display:flex;flex-direction:column;align-items:flex-end;gap:12px}
.tr-live{display:inline-flex;align-items:center;gap:8px;font:500 12.5px/1 var(--display);color:var(--faint)}
.tr-live.on{color:var(--accent)}
.tr-pulse{width:8px;height:8px;border-radius:50%;background:rgba(27,26,19,.2)}
.tr-live.on .tr-pulse{background:var(--accent);box-shadow:0 0 0 0 rgba(11,107,99,.45);animation:tr-pulse 2s infinite}
@keyframes tr-pulse{70%{box-shadow:0 0 0 8px rgba(11,107,99,0)}100%{box-shadow:0 0 0 0 rgba(11,107,99,0)}}
.tr-range{display:flex;gap:2px;padding:3px;border-radius:99px;background:var(--sunken);
  box-shadow:inset 0 0 0 1px var(--hairline)}
.tr-range a{font:500 12px/1 var(--display);color:var(--muted);padding:6px 11px;border-radius:99px;
  transition:color .18s var(--settle),background-color .18s var(--settle)}
.tr-range a:hover{color:var(--ink)}
.tr-range a.on{color:var(--ink);font-weight:600;background:var(--surface);box-shadow:var(--ring),var(--shadow-soft)}
.tr-stats{margin-bottom:28px}
.tr-delta{font:600 11.5px/1 var(--display);margin-left:8px;vertical-align:middle;letter-spacing:0}
.tr-delta.up{color:var(--positive)}.tr-delta.down{color:var(--critical)}
.tr-key{display:inline-block;width:8px;height:8px;border-radius:3px;margin-right:7px;vertical-align:0}
.tr-chart{margin:0 -4px}
.tr-legend{display:flex;flex-wrap:wrap;gap:8px 22px;margin:12px 4px 0;font:500 12px/1 var(--display);color:var(--muted)}
.tr-legend span{display:inline-flex;align-items:center;gap:8px}
.tr-legend i{width:12px;height:8px;border-radius:3px}
.tr-legend i.dash{height:2px;border-radius:1px}
.tr-legend b{color:var(--hibiscus);font-weight:500}
.tr-cols{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:clamp(28px,4vw,56px);
  margin-top:32px;padding-top:28px;border-top:1px solid var(--hairline)}
@media (max-width:900px){.tr-cols{grid-template-columns:1fr}.tr-side{align-items:flex-start}}
.tr-h{font:600 12px/1 var(--display);text-transform:uppercase;letter-spacing:.08em;color:var(--faint);margin:0 0 16px}
.tr-title a{color:var(--ink);font-weight:500}
.tr-title a:hover{color:var(--accent)}
.tr-title .meter{max-width:340px;height:4px;margin-top:8px}
.tr-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:14px}
.tr-row{display:flex;justify-content:space-between;gap:12px;font-size:14px;color:var(--ink)}
.tr-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tr-n{font-variant-numeric:tabular-nums;color:var(--ink);font-weight:600}
.tr-url{display:block;font-size:12px;color:var(--faint);margin-top:3px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.tr-url:hover{color:var(--accent)}
.tr-list .meter{height:4px;margin-top:7px}

/* ── Signal: the hero score. Colour carries meaning here, so every band is
   also named in words beside it, and nothing is legible by hue alone. */
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0}
.sig-card .card-b{padding:24px 24px 28px}
.sig-top{display:flex;flex-direction:column;gap:2px;margin-bottom:24px}
.sig-subject{font:600 clamp(16px,1.4vw,19px)/1.3 var(--display);color:var(--ink);
  letter-spacing:-.015em;max-width:60ch}
.sig-subject:hover{color:var(--accent)}

.sig-grid{display:grid;grid-template-columns:minmax(190px,auto) 1fr;gap:clamp(28px,4vw,56px);
  align-items:start}
.sig-score{display:flex;flex-direction:column}
.sig-n{font:700 clamp(64px,8vw,104px)/.88 var(--display);font-variant-numeric:tabular-nums;
  letter-spacing:-.05em;-webkit-background-clip:text;background-clip:text;color:transparent}
.sig-n.strong{background-image:linear-gradient(120deg,var(--accent),var(--accent-bright))}
.sig-n.good{background-image:linear-gradient(120deg,var(--deep),#5B8BC4)}
.sig-n.fair{background-image:linear-gradient(120deg,var(--caution),var(--spark-deep))}
.sig-n.weak{background-image:linear-gradient(120deg,var(--critical),#D9534A)}
.sig-den{display:flex;flex-direction:column;gap:5px;margin-top:16px}
.sig-band{font:600 12px/1 var(--display);text-transform:uppercase;letter-spacing:.08em;color:var(--ink)}
.sig-outof{font:500 12.5px/1 var(--display);color:var(--faint)}
.sig-vs{margin-top:14px;font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums}

.sig-read{min-width:0}
.sig-verdict{font:700 clamp(22px,2.2vw,28px)/1.22 var(--display);letter-spacing:-.03em;
  margin:0;color:var(--ink);max-width:24ch;text-wrap:balance}
.sig-ev{margin:14px 0 0;color:var(--muted);font-size:15px;line-height:1.6;max-width:56ch;
  font-variant-numeric:tabular-nums}
.sig-empty{font:600 clamp(19px,1.8vw,24px)/1.3 var(--display);letter-spacing:-.02em;margin:0}

/* History: one column per send, oldest left. A gap means "not measured", which
   is a different fact from a low score and must not look like one. */
.sig-hist{margin-top:24px}
.sig-hist-bars{display:flex;align-items:flex-end;gap:5px;height:64px}
.sig-col{flex:1 1 0;min-width:5px;max-width:26px;height:100%;display:flex;align-items:flex-end;
  border-radius:4px;background:var(--sunken)}
.sig-col-fill{width:100%;border-radius:4px;opacity:.8;transition:opacity .18s var(--settle);
  background:rgba(27,26,19,.2)}
.sig-col:hover .sig-col-fill,.sig-col.now .sig-col-fill{opacity:1}
.sig-col-fill.strong{background:var(--accent)}
.sig-col-fill.good{background:var(--deep)}
.sig-col-fill.fair{background:var(--spark-deep)}
.sig-col-fill.weak{background:var(--critical)}
.sig-hist-l{margin-top:10px;font:500 12px/1.3 var(--display);color:var(--faint)}

/* The three components, as tiles under the reading. */
.sig-parts{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;
  margin-top:32px;padding-top:28px;border-top:1px solid var(--hairline)}
.sig-part{padding:16px 18px;border-radius:12px;background:var(--canvas);box-shadow:inset 0 0 0 1px var(--hairline)}
.sig-part-h{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.sig-part-l{font:500 13px/1.3 var(--display);color:var(--muted)}
.sig-part-n{font:700 20px/1 var(--display);font-variant-numeric:tabular-nums;
  letter-spacing:-.02em;color:var(--ink)}
.sig-track{height:6px;border-radius:99px;background:var(--sunken);margin:12px 0 10px;overflow:hidden}
.sig-fill{height:100%;border-radius:99px;transition:width .8s var(--settle)}
.sig-fill.strong{background:var(--accent)}
.sig-fill.good{background:var(--deep)}
.sig-fill.fair{background:var(--spark-deep)}
.sig-fill.weak{background:var(--critical)}
.sig-part-d{font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.sig-part-w{margin-top:5px;font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums}

@media (max-width:820px){
  .sig-grid{grid-template-columns:1fr;gap:22px}
}
@media (prefers-reduced-motion:reduce){
  .sig-fill{transition:none}
}

/* Tables: 12px uppercase headers, 52px rows, hairlines between. */
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font:600 12px/1 var(--display);text-transform:uppercase;
  letter-spacing:.08em;color:var(--faint);padding:14px 16px;white-space:nowrap;
  border-bottom:1px solid var(--hairline)}
td{height:52px;padding:12px 16px;vertical-align:middle;color:var(--ink);
  border-bottom:1px solid var(--hairline)}
tbody tr:last-child td{border-bottom:0}
th:first-child,td:first-child{padding-left:0}
th:last-child,td:last-child{padding-right:0}
tbody tr{transition:background-color .18s var(--settle)}
tbody tr:hover{background:rgba(243,238,226,.6)}
tbody tr.sel{background:var(--accent-soft)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
td.tick,th.tick{width:32px;padding-right:0}
td b,td strong{color:var(--ink);font-weight:600}
td a{color:var(--ink)}
td a:hover{color:var(--accent)}
td a .faint{color:var(--faint)}

/* A row that is a link to its own editor: click the subject, or anywhere along
   the strip. Every cell carries its own anchor and the cell's padding moves onto
   it, so the target is the whole row including the gutters, with no JS.
   A stretched ::after does NOT work here: position:relative on a <tr> does not
   establish a containing block, so it would resolve against the already-relative
   <td> and only ever cover one cell. Verified in Chromium, don't "simplify" it.
   Only the subject anchor is reachable by keyboard or screen reader; the others
   are aria-hidden, so the row is one link, not three. */
tr.rowlink{cursor:pointer}
tr.rowlink td{padding:0}
tr.rowlink td>a{display:block;padding:15px 16px;color:inherit;text-decoration:none}
tr.rowlink td:first-child>a{padding-left:0}
tr.rowlink td:last-child>a{padding-right:0}
tr.rowlink td>a.rl{color:var(--ink);font-weight:500}
tr.rowlink:hover td>a.rl{color:var(--accent)}
tr.rowlink td>a.rl:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
/* Flush panels: tables run to the panel's edge, cells keep a 20px gutter.
   Here, not with .card: layer order beats specificity, so these must come
   after the bare th/td rules above. */
.card-b.flush th:first-child,.card-b.flush td:first-child{padding-left:20px}
.card-b.flush th:last-child,.card-b.flush td:last-child{padding-right:20px}
.card-b.flush tr.rowlink td{padding:0}
.card-b.flush tr.rowlink td:first-child>a{padding-left:20px}
.card-b.flush tr.rowlink td:last-child>a{padding-right:20px}

/* Meters: lagoon on a sunken track. */
.meter{height:6px;border-radius:99px;overflow:hidden;margin-top:8px;background:var(--sunken)}
.meter>i{display:block;height:100%;border-radius:99px;background:var(--accent)}

.chart{width:100%;min-height:60px;position:relative}
.chart-wait{position:absolute;inset:0;border-radius:10px;overflow:hidden;
  background:linear-gradient(100deg,var(--sunken),rgba(243,238,226,.4),var(--sunken));
  background-size:200% 100%;animation:shimmer 1.6s var(--settle) infinite}
@keyframes shimmer{from{background-position:120% 0}to{background-position:-120% 0}}
.chart.is-live{animation:rise .28s var(--settle) both}
.ct-row{display:flex;align-items:center;gap:9px;padding:9px 14px 11px;
  font:600 13px/1 var(--display);color:var(--ink)}
.ct-dot{width:8px;height:8px;border-radius:3px;flex:0 0 auto}
.ct-val{font-variant-numeric:tabular-nums}
.apexcharts-canvas{margin:0 auto}
.apexcharts-tooltip{background:var(--surface)!important;border:0!important;
  border-radius:10px!important;box-shadow:var(--ring),var(--shadow-lifted)!important;
  color:var(--ink)!important;font-family:var(--sans)!important}
.apexcharts-tooltip-title{background:var(--sunken)!important;border:0!important;
  font:600 11px/1 var(--display)!important;letter-spacing:.08em!important;text-transform:uppercase;
  color:var(--faint)!important;padding:10px 14px!important}
.apexcharts-tooltip-series-group{padding:6px 14px 10px!important}
.apexcharts-xaxistooltip,.apexcharts-yaxistooltip{display:none!important}
.apexcharts-legend-text{color:var(--muted)!important;font-family:var(--sans)!important}
}

/* ─────────────────────────────────────────────────────── choreography */
@layer motion {
/* Panels fade up once on load, staggered. Short and settled. */
@keyframes rise{from{opacity:0;transform:translate3d(0,6px,0)}to{opacity:1;transform:none}}
.head,.card,.tabs,.note,.flash,.reveal{animation:rise .28s var(--settle) both}
.card:nth-of-type(1){animation-delay:.03s}
.card:nth-of-type(2){animation-delay:.06s}
.card:nth-of-type(3){animation-delay:.09s}
.card:nth-of-type(n+4){animation-delay:.12s}

@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;
    transition-duration:.01ms!important;scroll-behavior:auto!important}
}
}

/* ────────────────────────────────────────────── public preference page */
@layer surface {
.prefs{max-width:640px;margin:0 auto;padding:min(13vh,120px) 20px 100px}
.prefs h1{font-size:clamp(27px,5.5vw,32px);margin-bottom:12px}
.prefs .lede{color:var(--muted);margin-bottom:14px;font-size:16px;line-height:1.5}
.prefs form{position:relative;padding:0;animation:rise .28s var(--settle) both;animation-delay:.05s}
.prefs form h3{padding-top:28px}
.pref-item{position:relative;display:flex;gap:16px;align-items:flex-start;padding:18px 0;
  border-bottom:1px solid var(--hairline)}
.pref-item .txt{flex:1}
.pref-item .nm{font-weight:600;font-size:15px;color:var(--ink)}
.pref-item .ds{font-size:13.5px;color:var(--muted);margin-top:4px}
.pref-item.focus{padding:18px 16px;margin:8px 0;border:0;border-radius:12px;
  background:var(--accent-soft);box-shadow:inset 0 0 0 1px rgba(11,107,99,.18)}
.tag-focus{display:inline-block;font:600 12px/1 var(--display);text-transform:uppercase;
  letter-spacing:.08em;color:var(--accent);margin-bottom:8px}
.nuke{margin-top:0;padding-top:26px}
}

/* ───────────────────────────────────────────────────────── the composer

   Writing mail is the one job in here that deserves the whole screen. Nothing
   docks beside the rail, the page stops scrolling, and the frame becomes three
   fixed bands: a slim bar naming what you're writing, the work, and a foot
   holding the count and the save. The editor between them fills whatever is
   left and scrolls inside itself, so the paper always reaches the bottom of the
   display no matter how short the draft is.

   The settings column has no boxes: blocks divided by a hairline, each opened
   by a small uppercase label. */
@layer compose {
/* The stage keeps its rail offset; only its height changes — the composer owns
   exactly the screen, and nothing outside it scrolls. The clamp on <body> is
   what stops the editor's own floating furniture, which lives at the end of the
   document until it is positioned, from giving the page a stray 38px of
   scroll. */
html:has(.compose-stage){overflow:hidden}
.compose-stage{height:100dvh;overflow:hidden}
.compose{position:relative;display:flex;flex-direction:column;height:100%;overflow:hidden;
  background:var(--canvas)}
/* The rail is the way out on a wide screen, so the drawer handle has no job. */
.compose-top .burger{display:none}
.compose-top{flex:0 0 auto;position:relative;display:flex;align-items:center;gap:14px;
  min-height:64px;padding:10px clamp(16px,2vw,24px);background:var(--canvas);
  border-bottom:1px solid var(--hairline)}
.cx{width:36px;height:36px;flex:0 0 auto;display:grid;place-items:center;border-radius:50%;
  color:var(--muted);
  transition:background-color .18s var(--settle),color .18s var(--settle),transform .18s var(--settle)}
.cx:hover{background:var(--sunken);color:var(--ink);transform:translateX(-2px)}
.cx svg{width:18px;height:18px}
.compose-id{min-width:0}
.compose-id .t{font:600 16px/1.2 var(--display);letter-spacing:-.015em;color:var(--ink);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.compose-id .s{margin-top:4px;font-size:12.5px;color:var(--faint);
  display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.compose-acts{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.compose-acts form{display:contents}

.compose-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 20rem}
@media (min-width:1536px){.compose-body{grid-template-columns:minmax(0,1fr) 23rem}}
@media (max-width:1320px){.compose-body{grid-template-columns:minmax(0,1fr) 296px}}
@media (max-width:1023px){
  /* Rail turned into a drawer — the composer's own bar carries the handle. */
  .compose-top .burger{display:grid}
}
/* The paper: a surface sheet between the bar and the foot. */
.compose-main{position:relative;min-width:0;display:flex;flex-direction:column;overflow-y:auto;
  overflow-x:hidden;background:var(--surface)}
/* The subject sets like a headline, because that is what it is. */
.compose-subject{flex:0 0 auto;padding:28px clamp(22px,5vw,74px) 20px}
/* A sent broadcast's numbers, heading the column above its subject. */
.compose-stats{position:relative;flex:0 0 auto;padding:24px clamp(22px,5vw,74px) 24px;
  border-bottom:1px solid var(--hairline)}
/* auto-fill, not auto-fit: a number that wraps lands under the one above it
   instead of stretching across the row. */
.compose-stats .stats{grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:10px}
.compose-stats .stat{padding:12px 14px}
.compose-stats .stat .l{white-space:nowrap;margin-bottom:8px;font-size:12.5px}
.compose-stats .stat .n{font-size:22px}
.compose-stats .stat .h{font-size:12px}
.compose-stats > .faint{font-size:12.5px;max-width:62ch}
.compose .subj{width:100%;min-height:0;padding:0;border:0;border-radius:0;background:none;box-shadow:none;
  font:700 clamp(22px,2.2vw,32px)/1.2 var(--display);letter-spacing:-.03em;color:var(--ink)}
.compose .subj:hover,.compose .subj:focus{box-shadow:none;outline:0;background:none}
.compose .subj::placeholder{color:rgba(107,102,80,.55)}

.compose-side{position:relative;overflow-y:auto;padding:24px 24px 72px;background:var(--canvas);
  border-left:1px solid var(--hairline)}
.compose-side .field,.compose-side .row{max-width:none}
.compose-side .field{margin-bottom:0}
.side-sec{position:relative;padding:20px 0 0;margin-top:20px;border-top:1px solid var(--hairline)}
.side-sec:first-child{margin-top:0;padding-top:0;border-top:0}
.side-sec>h3{margin-bottom:14px}
.side-sec>*+.field{margin-top:16px}

/* The step list in the composer sidebar — a table of contents you can steer by. */
.stepnav ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.stepnav ol a,.stepnav ol li>span{display:grid;grid-template-columns:20px 1fr auto;gap:10px;
  align-items:baseline;padding:8px 10px;border-radius:10px;font-size:13.5px;line-height:1.35;
  color:var(--muted);text-decoration:none}
.stepnav ol a:hover{background:var(--sunken);color:var(--ink)}
.stepnav li.here>span{background:var(--surface);color:var(--ink);font-weight:600;
  box-shadow:var(--ring),var(--shadow-soft)}
.stepnav .n{font-variant-numeric:tabular-nums;color:var(--faint);font-size:12px;text-align:right}
.stepnav li.here .n{color:var(--accent)}
.stepnav .s{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stepnav .d{font-size:11.5px;color:var(--faint);white-space:nowrap}
.stepnav-add{margin:14px 0 0 10px}
/* A caption the screen reader needs and the design does not. */
.hide-vis{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;
  clip-path:inset(50%);white-space:nowrap}

.compose-foot{flex:0 0 auto;position:relative;display:flex;align-items:center;gap:16px;
  padding:10px clamp(16px,2vw,24px);background:var(--canvas);border-top:1px solid var(--hairline)}
/* A refusal in the save bar. */
.foot-warn{font-size:13px;color:var(--caution)}
/* Autosave's running state. Quiet by design — it is reassurance, not news. */
.save-state{font-size:12.5px;color:var(--faint);font-variant-numeric:tabular-nums}
.save-state.bad{color:var(--critical)}

@media (max-width:980px){
  /* Nothing to fill on a phone — hand the page back its scroll and keep only
     the save bar riding along the bottom edge. */
  html:has(.compose-stage){overflow:visible}
  .compose-stage{height:auto;overflow:visible}
  .compose{height:auto;min-height:100dvh;overflow:visible}
  .compose-body{display:block}
  .compose-main{overflow:visible}
  .compose-subject{padding:20px 20px 16px}
  .compose-stats{padding:20px 20px 18px}
  .compose-side{overflow:visible;padding:24px 20px 40px;border-left:0;border-top:1px solid var(--hairline)}
  .compose-foot{position:sticky;bottom:0;z-index:20;background:rgba(251,248,241,.92);
    -webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px)}
}
}

/* ── Analytics ──────────────────────────────────────────────────────────────
   Measurement surfaces. Everything here is CSS-only: these screens are read,
   scanned, and left, and a reader must never wait for a chart runtime to boot
   before the number they came for exists on the page. */
@layer analytics {
/* The ring. A conic gradient with a hole punched in it. */
.dial{position:relative;flex:0 0 auto;display:grid;place-items:center;border-radius:50%;
  width:var(--d,132px);height:var(--d,132px);
  background:conic-gradient(var(--arc) calc(var(--p,0) * 1%),var(--sunken) 0);
  -webkit-mask:radial-gradient(circle,transparent calc(var(--d,132px) / 2 - 11px),#000 calc(var(--d,132px) / 2 - 10px));
  mask:radial-gradient(circle,transparent calc(var(--d,132px) / 2 - 11px),#000 calc(var(--d,132px) / 2 - 10px))}
.dial-w{position:relative;display:grid;place-items:center;flex:0 0 auto}
.dial-n{position:absolute;inset:0;display:grid;place-items:center;
  font:700 clamp(28px,2.8vw,36px)/1 var(--display);font-variant-numeric:tabular-nums;
  letter-spacing:-.04em;color:var(--ink)}
.dial-n small{display:block;text-align:center;font:600 11px/1.4 var(--display);
  letter-spacing:.08em;text-transform:uppercase;color:var(--faint);margin-top:6px}
.dial.strong{--arc:var(--accent)}.dial.good{--arc:var(--deep)}
.dial.fair{--arc:var(--spark-deep)}.dial.weak{--arc:var(--critical)}.dial.none{--arc:rgba(27,26,19,.2)}

/* The band chip. Four states, never colour alone — the word is always there. */
.score{display:inline-flex;flex:0 0 auto;align-items:center;gap:6px;padding:2px 8px;border-radius:99px;
  font:500 12px/1.4 var(--display);font-variant-numeric:tabular-nums;
  background:var(--sunken);color:var(--ink);box-shadow:inset 0 0 0 1px var(--hairline)}
.score i{width:6px;height:6px;border-radius:50%;flex:0 0 auto;background:var(--faint)}
.score.strong{background:var(--accent-soft)}.score.strong i{background:var(--accent)}
.score.good{background:rgba(59,103,154,.10)}.score.good i{background:var(--deep)}
.score.fair{background:var(--caution-soft)}.score.fair i{background:var(--spark-deep)}
.score.weak{background:var(--critical-soft)}.score.weak i{background:var(--critical)}

/* The step waterfall. One row per mail in a sequence: how many got it, and how
   much of that was opened and clicked. */
.wf{display:flex;flex-direction:column}
.wf-row{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:16px;align-items:center;
  padding:14px 0}
.wf-row+.wf-row{border-top:1px solid var(--hairline)}
.wf-i{font:600 12px/1 var(--display);color:var(--faint);font-variant-numeric:tabular-nums}
.wf-b{min-width:0}
.wf-s{display:block;font-size:14px;color:var(--ink);white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis}
.wf-track{position:relative;height:24px;border-radius:6px;margin-top:9px;overflow:hidden;
  background:var(--sunken)}
.wf-track>i{position:absolute;left:0;top:0;bottom:0;border-radius:6px;
  transition:width .9s var(--settle)}
.wf-sent{background:rgba(59,103,154,.22)}
.wf-open{background:rgba(43,179,163,.5)}
.wf-click{background:var(--accent)}
.wf-n{text-align:right;font-variant-numeric:tabular-nums;font-size:12.5px;color:var(--muted);
  white-space:nowrap}
.wf-n b{display:block;font:700 17px/1.1 var(--display);color:var(--ink)}
.wf-drop{margin-top:7px;font-size:12.5px;color:var(--critical)}
@media (max-width:720px){.wf-row{grid-template-columns:26px minmax(0,1fr);row-gap:6px}
  .wf-n{grid-column:2;text-align:left}.wf-n b{display:inline;font-size:14px;margin-right:6px}}

/* Part-to-whole as one rule rather than a donut. */
.split{display:flex;height:14px;border-radius:99px;overflow:hidden;gap:2px;background:var(--sunken)}
.split>i{display:block;transition:width .9s var(--settle)}
/* A channel that earned nothing draws nothing. */
.split>i[hidden]{display:none}
.split>i:nth-child(1){background:var(--accent)}
.split>i:nth-child(2){background:var(--deep)}
.split>i:nth-child(3){background:var(--plum)}
.split>i:nth-child(4){background:rgba(27,26,19,.2)}
.lg{display:flex;flex-wrap:wrap;gap:8px 22px;margin-top:16px}
.lg-i{display:flex;align-items:baseline;gap:9px;font-size:13px;color:var(--muted)}
.lg-i i{width:9px;height:9px;border-radius:3px;flex:0 0 auto;transform:translateY(-1px)}
.lg-i b{color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}

/* A metric row on the health screen: name, number, bar, and the sentence that
   says what to do about it. */
.hm{display:grid;grid-template-columns:minmax(120px,1fr) minmax(0,2fr);gap:8px 28px;
  padding:18px 0;align-items:baseline}
.hm+.hm{border-top:1px solid var(--hairline)}
.hm-l{font:600 12px/1.3 var(--display);text-transform:uppercase;letter-spacing:.08em;color:var(--faint)}
.hm-v{font:700 clamp(22px,2vw,28px)/1 var(--display);font-variant-numeric:tabular-nums;
  letter-spacing:-.03em;color:var(--ink);margin-top:8px}
.hm-d{font-size:13px;color:var(--muted);margin-top:7px}
.hm-note{margin-top:9px;font-size:13.5px;color:var(--caution);line-height:1.55}
@media (max-width:720px){.hm{grid-template-columns:1fr}}

/* Sortable column headers. */
th a{color:inherit}
th a:hover,th a.on{color:var(--accent)}

/* The dense comparison rail inside a table cell. */
.rt{display:flex;align-items:center;gap:9px;font-variant-numeric:tabular-nums}
.rt-b{flex:1 1 auto;min-width:34px;height:5px;border-radius:99px;overflow:hidden;background:var(--sunken)}
.rt-b>i{display:block;height:100%;border-radius:99px;background:var(--accent)}
.rt-b.warm>i{background:linear-gradient(90deg,var(--spark-deep),var(--critical))}

/* The analytics heroes put a dial (or two) beside the reading. */
.sig-grid.lead{grid-template-columns:auto minmax(0,1fr)}
.dials{display:flex;gap:clamp(20px,3vw,40px);align-items:center;flex-wrap:nowrap}
@media (max-width:980px){
  .sig-grid.lead{grid-template-columns:1fr}
  .dials{flex-wrap:wrap;gap:22px}
}

/* Wide tables scroll inside their own panel rather than taking the page with them. */
.tscroll{overflow-x:auto;overscroll-behavior-x:contain}
.tscroll>table{min-width:620px}

/* The one-line "what should I do about this" that closes every analytics card. */
.take{display:flex;gap:12px;align-items:flex-start;padding:16px 0 0;margin-top:18px;
  border-top:1px solid var(--hairline);font-size:14px;line-height:1.6;color:var(--ink)}
.take b{color:var(--ink)}
.take>em{font-style:normal;color:var(--faint);font:600 12px/1.6 var(--display);
  letter-spacing:.08em;text-transform:uppercase;flex:0 0 auto;padding-top:1px}
}


/* ─────────────── sequence templates ───────────────
   A gallery of shapes: each entry is a panel, and the only drawing is the
   rhythm strip — one dot per mail, placed on the day it lands, so "five mails
   in five days" and "three mails in nine" look different before a word is read. */
@layer data {
.tpl-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
@media (max-width:1180px){.tpl-grid{grid-template-columns:1fr}}
.tpl{position:relative;display:block;padding:22px 24px 24px;color:inherit;border-radius:16px;
  background:var(--surface);box-shadow:var(--ring),var(--shadow-soft);
  transition:box-shadow .18s var(--settle),transform .18s var(--settle)}
.tpl:hover,.tpl:focus-visible{color:inherit;box-shadow:var(--ring),var(--shadow-lifted);transform:translateY(-1px)}
.tpl h2{margin:0 0 8px;display:flex;align-items:baseline;gap:10px}
.tpl h2 span{opacity:0;transform:translateX(-6px);color:var(--accent);
  transition:opacity .18s var(--settle),transform .18s var(--settle)}
.tpl:hover h2 span,.tpl:focus-visible h2 span{opacity:1;transform:none}
.tpl p{color:var(--muted);font-size:14px;line-height:1.6;margin:0;max-width:52ch}
.tpl-meta{display:flex;gap:16px;flex-wrap:wrap;margin-top:4px;color:var(--faint);
  font-size:12.5px;font-variant-numeric:tabular-nums}

.rhythm{position:relative;height:24px;margin:18px 0 10px;max-width:440px}
.rhythm::before{content:'';position:absolute;left:0;right:0;top:50%;height:1px;background:var(--hairline)}
.rhythm i{position:absolute;top:50%;width:9px;height:9px;margin:-4.5px 0 0;border-radius:50%;
  left:calc((100% - 9px) * var(--at));background:var(--accent);box-shadow:0 0 0 3px var(--surface)}
.rhythm i:last-child{background:var(--spark-deep)}

/* The plan: a vertical line of days down the left, the mails hanging off it. */
.plan{list-style:none;margin:0;padding:0;position:relative}
.plan::before{content:'';position:absolute;left:63px;top:8px;bottom:8px;width:1px;background:var(--hairline)}
.plan>li{position:relative;display:grid;grid-template-columns:64px minmax(0,1fr);
  column-gap:26px;padding:0 0 32px}
.plan>li:last-child{padding-bottom:0}
.plan>li::before{content:'';position:absolute;left:59px;top:6px;width:9px;height:9px;
  border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px var(--surface)}
.plan>li:last-child::before{background:var(--spark-deep)}
.plan .day{font:500 12px/1.9 var(--mono);color:var(--faint);white-space:nowrap;
  font-variant-numeric:tabular-nums}
.plan h4{margin:0 0 5px;font:600 15.5px/1.35 var(--display);letter-spacing:-.012em;color:var(--ink)}
.plan .subj{font-size:14px;color:var(--muted);margin:0 0 8px}
.plan .subj em{font-style:normal;color:var(--faint);font:600 11px/1 var(--display);
  letter-spacing:.08em;text-transform:uppercase;margin-right:8px}
.plan p{font-size:14px;line-height:1.6;color:var(--muted);margin:0;max-width:60ch}
.plan details{margin-top:10px}
.plan summary{cursor:pointer;color:var(--faint);font-size:13px;transition:color .18s var(--settle)}
.plan summary:hover{color:var(--ink)}
.plan pre{white-space:pre-wrap;word-break:break-word;margin:12px 0 0;
  font:400 12.5px/1.7 var(--mono);color:var(--muted)}
mark.ph{background:rgba(123,79,158,.10);color:var(--plum);border-radius:4px;padding:0 3px}

/* One mail in the template editor: a band inside the panel, under a hairline. */
.tpl-step{position:relative;padding:28px 0 6px;margin-top:20px;scroll-margin-top:24px;
  border-top:1px solid var(--hairline)}
.tpl-step .card-h{padding:0 0 16px;border-bottom:0}

.tpl-list{list-style:none;margin:0 0 24px;padding:0}
.tpl-list li{position:relative;padding:0 0 9px 20px;font-size:14px;line-height:1.55;color:var(--muted)}
.tpl-list li::before{content:'';position:absolute;left:2px;top:.6em;width:6px;height:6px;
  border-radius:50%;background:var(--spark-deep)}
}
`

/**
 * Ultra-light line icons, drawn at 24 and stroked at 1.3. Hand-rolled rather
 * than pulled from a set: an icon library is a dependency and a download, and
 * this is eleven glyphs.
 */
const ICONS: Record<string, string> = {
  home: 'M3.8 11.4 12 4.4l8.2 7M6.4 10v9.6h11.2V10M10.2 19.6v-5.2h3.6v5.2',
  /* A person in front of a page: who writes the site. */
  site: 'M12 11.2a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8ZM5.6 19.6c.8-3.4 3.4-5.4 6.4-5.4s5.6 2 6.4 5.4',
  /* A page with a layout on it: header bar, a column, a block. */
  theme: 'M4.4 4.4h15.2v15.2H4.4zM4.4 8.6h15.2M8.8 8.6v11M11.6 12h5.2M11.6 15.4h3.6',
  /* A heartbeat trace. The feed is a pulse — the one screen that shows the list
     as something moving rather than something counted. */
  act: 'M3.2 12.4h4l2.2-6 3.4 12.4 2.4-8.2 1.7 4.6h4.4',
  subs: 'M9.2 11.4a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM3.6 19.4c.4-3.1 2.8-5 5.6-5s5.2 1.9 5.6 5M16.2 5.5a3.1 3.1 0 0 1 0 5.9M17.4 14.8c1.9.6 3.1 2.2 3.4 4.4',
  /* A hash. Nothing else in the set uses it, and a tag reads as one on sight. */
  tags: 'M9.4 4.4 7.6 19.6M16.4 4.4l-1.8 15.2M4.8 8.8h15M4 15.2h15',
  /* Two overlapping circles: a segment is the part of the list that satisfies
     more than one thing at once. */
  segs: 'M9.6 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm4.8 0a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z',
  bc: 'M4 12.2 20.2 4.6l-4.4 15.2-3.9-5.9L4 12.2Zm7.9 1.7 4.9-8',
  seq: 'M5.4 6.6h6.2a3.1 3.1 0 0 1 0 6.2H9a3.1 3.1 0 0 0 0 6.2h6.6M14.6 16.6l2.6 2.4-2.6 2.4M14.6 4.2 17.2 6.6l-2.6 2.4',
  /* Two sheets, one behind the other: a copy waiting to be made. */
  tpl: 'M8.2 7.4h10.2v12.8H8.2V7.4ZM5.6 16.6V3.8h10.2M11 11.6h4.6M11 14.8h3',
  out: 'M4 13.6h4.2l1.3 2.5h5l1.3-2.5H20M6.5 4.8h11l2.5 8.8v5.6H4v-5.6l2.5-8.8Z',
  /* A sheet with a filled line and an arrow leaving it: fill this in, get that back. */
  forms: 'M6.2 3.8h11.6v16.4H6.2V3.8Zm2.8 4.2h6M9 11.2h3.2M14.8 12.6v5m0 0 2-2m-2 2-2-2',
  camp: 'M12 3.6a8.4 8.4 0 1 0 0 16.8 8.4 8.4 0 0 0 0-16.8Zm0 4.6a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Zm0 3.3a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1Z',
  store: 'M5.6 8.2h12.8l1 11.4H4.6l1-11.4Zm3.4 0V6.4a3 3 0 0 1 6 0v1.8',
  /* A dollar sign: the mail that goes out after money comes in. */
  pmail: 'M12 3.6v16.8M16.2 7.6c-.8-1.3-2.3-2-4.2-2-2.5 0-4.1 1.2-4.1 3.1 0 4.3 8.6 2.3 8.6 6.9 0 2-1.8 3.3-4.5 3.3-2.1 0-3.7-.8-4.5-2.2',
  /* A receipt, torn off at the bottom: the line items, after the fact. */
  sales:
    'M6.6 3.8h10.8v16.8l-1.8-1.4-1.8 1.4-1.8-1.4-1.8 1.4-1.8-1.4-1.8 1.4V3.8Zm2.8 4.4h5.2M9.4 11.8h5.2',
  /* A target with an arrow in it. */
  goals: 'M12 20.4a8.4 8.4 0 1 0 0-16.8 8.4 8.4 0 0 0 0 16.8Zm0-4.2a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4Zm0-3a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Z',
  /* A funnel narrowing to a drop — sent, opened, clicked, bought. */
  conv: 'M3.8 5.2h16.4l-6.3 7.4v6.1l-3.8 1.9v-8L3.8 5.2Z',
  /* A price tag: the thing that exists to be sold. */
  offers: 'M4.6 11.2V4.8h6.4l8.4 8.4-6.4 6.4-8.4-8.4Zm3.1-3.5a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z',
  /* Two figures with a coin — people, as customers. */
  cust: 'M9 11.2a3.1 3.1 0 1 0 0-6.2 3.1 3.1 0 0 0 0 6.2ZM3.4 19.4c.4-3 2.7-4.9 5.6-4.9 1.4 0 2.7.5 3.7 1.3M17.4 19.4a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Zm0-4.4v2.4',
  /* A spark over a rule: a suggestion drawn from what's underneath. */
  ideas: 'M12 3.6v2M5.8 6.2l1.4 1.4M18.2 6.2l-1.4 1.4M9.4 13.4a3.4 3.4 0 1 1 5.2 0c-.6.7-.9 1.3-.9 2.1h-3.4c0-.8-.3-1.4-.9-2.1ZM10.3 18.2h3.4M10.8 20.4h2.4',
  cons: 'M12 3.6 5.6 6.2v5.4c0 4 2.6 7.2 6.4 8.8 3.8-1.6 6.4-4.8 6.4-8.8V6.2L12 3.6Zm-2.7 8.5 2 2 3.5-4.1',
  /* Bars against a baseline: measurement, plainly. */
  an: 'M4.4 19.6h15.2M7.8 16.4V9.2M12 16.4V5.4M16.2 16.4V11',
  /* Rules getting shorter — the drop-off a sequence lives or dies by. */
  anseq: 'M4.6 6.4h11M4.6 11h8.4M4.6 15.6h5.6M4.6 20.2h3',
  /* One send's arc: a peak and what came after it. */
  anbc: 'M4 15.4l4.4-4.8 3.4 3.4 4-6.8 4.2 4.6',
  /* A wedge out of a whole: which slice of the result was mine. */
  ancon: 'M12 3.9a8.1 8.1 0 1 0 8.1 8.1H12V3.9Z',
  /* A pulse. The list either has one or it doesn't. */
  anhl: 'M3.8 12.4h3.1l2-4.6 2.7 9 2.5-6.3 1.6 1.9h4.5',
  set: 'M4.4 8h9.2M17.6 8h2M4.4 16h2.2M10.6 16h9M15.4 5.6v4.8M8.2 13.6v4.8',
  help: 'M12 3.8a8.2 8.2 0 1 0 0 16.4 8.2 8.2 0 0 0 0-16.4Zm-2.4 5.5a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.8-.9 1.4v.6m0 2.5v.1',
}

const Icon: FC<{ k: string; w?: number }> = ({ k, w = 1.3 }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width={String(w)}
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d={ICONS[k] ?? ''} />
  </svg>
)

/** The rail, in reading order: where am I, who is on the list, what goes out,
 *  what comes back, and the levers underneath all of it. */
const NAV: ({ grp: string } | { href: string; key: string; label: string })[] = [
  { href: '/', key: 'home', label: 'Dashboard' },
  { grp: 'Audience' },
  { href: '/subscribers', key: 'subs', label: 'Subscribers' },
  // ⭐ Their own slots rather than tabs off Subscribers. `AudienceTabs` was the
  // only route in, which made auto-tagging — the thing that turns a click into
  // an enrollment — effectively undiscoverable.
  { href: '/tags', key: 'tags', label: 'Tags & automation' },
  { href: '/segments', key: 'segs', label: 'Segments' },
  // ⭐ Mail sits directly under the audience: who is on the list, then what
  // goes out to them — the two screens used every day, at the top.
  { grp: 'Mail' },
  { href: '/broadcasts', key: 'bc', label: 'Broadcasts' },
  { href: '/sequences', key: 'seq', label: 'Sequences' },
  // Directly under Sequences: a template is where a sequence starts, and it is
  // a library you come back to, not a step inside "new sequence".
  { href: '/sequences/templates', key: 'tpl', label: 'Templates' },
  { href: '/outbox', key: 'out', label: 'Outbox' },
  // ⭐ Analytics follows the mail it measures. Six slots rather than
  // one-with-tabs because each is a different question, and burying five of
  // them behind a tab strip is how a measurement tool goes unread.
  { grp: 'Analytics' },
  { href: '/analytics', key: 'an', label: 'Overview' },
  // ⭐ First under Overview because it is the only screen here that reports
  // *events* rather than state — what happened, in order. Everything else on
  // this list is a number you read off the end of it.
  { href: '/activity', key: 'act', label: 'Activity' },
  { href: '/analytics/sequences', key: 'anseq', label: 'Sequences' },
  { href: '/analytics/broadcasts', key: 'anbc', label: 'Broadcasts' },
  { href: '/analytics/contribution', key: 'ancon', label: 'Contribution' },
  { href: '/analytics/health', key: 'anhl', label: 'List health' },
  { grp: 'Money' },
  { href: '/campaigns', key: 'camp', label: 'Campaigns' },
  // ⭐ Its own slot rather than a tab under Campaigns: a form is where a lead
  // magnet is built and where the file lives, and it was unfindable one level in.
  { href: '/forms', key: 'forms', label: 'Forms' },
  { href: '/sales', key: 'sales', label: 'Sales' },
  // Directly under Sales, because that is where it is used from: a sale is the
  // thing you press the button on, and this is what the button says.
  { href: '/purchase-mail', key: 'pmail', label: 'Purchase mail' },
  // ⭐ Target first, then the events measured against it, then the catalogue
  // they were sold from: the funnel reads top to bottom in the rail too.
  { href: '/goals', key: 'goals', label: 'Goals' },
  { href: '/conversions', key: 'conv', label: 'Conversions' },
  { href: '/store', key: 'store', label: 'Store overview' },
  { href: '/store/offers', key: 'offers', label: 'Offers' },
  { href: '/store/customers', key: 'cust', label: 'Customers' },
  { href: '/store/ideas', key: 'ideas', label: 'Segment ideas' },
  // Who the site is (the profile) and how it looks (themes) sit with the rest
  // of the setup, not in a group of their own.
  { grp: 'System' },
  { href: '/site', key: 'site', label: 'Profile' },
  { href: '/themes', key: 'theme', label: 'Themes' },
  { href: '/consent', key: 'cons', label: 'Consent' },
  { href: '/settings', key: 'set', label: 'Settings' },
  { href: '/help', key: 'help', label: 'Help' },
]

const FONTS =
  'https://fonts.googleapis.com/css2?family=Geist:wght@400..700&family=Geist+Mono:wght@400;500&display=swap'

/** One section of the rail: its icon, and the pages that dock beside it. */
interface Section {
  id: string
  label: string
  icon: string
  items: { href: string; key: string; label: string }[]
}

/** The rail icon for each group. Dashboard is a shortcut, not a section. */
const SECTION_ICON: Record<string, string> = {
  Audience: 'subs',
  Mail: 'bc',
  Analytics: 'an',
  Money: 'sales',
  System: 'set',
}

/** `NAV`, folded into the rail's sections. The flat list stays the source of
 *  truth for order; this is only its shape. */
const SECTIONS: Section[] = NAV.reduce<Section[]>((all, it) => {
  if ('grp' in it) {
    all.push({ id: it.grp.toLowerCase(), label: it.grp, icon: SECTION_ICON[it.grp] ?? 'home', items: [] })
  } else if (all.length > 0) {
    all[all.length - 1]?.items.push(it)
  }
  return all
}, [])

/** System sits at the foot of the rail, the way settings do everywhere else. */
const PINNED = new Set(['system'])

const DASHBOARD = { href: '/', key: 'home', label: 'Dashboard' }

const sectionOf = (nav?: string) => SECTIONS.find((s) => s.items.some((it) => it.key === nav))

const Mark: FC = () => (
  <span class="mark" aria-hidden="true">
    {/* The bird itself, perched on a marigold tile. Served from `public/`. */}
    <img src="/logo_200.png" alt="" width="30" height="29" />
  </span>
)

const Brand: FC = () => (
  <a class="brand" href="/">
    <Mark />
    <span class="wm">Kōlea</span>
  </a>
)

/** One rail tile: an icon, its label as a tooltip to the right. */
const RailEntry: FC<{ href: string; icon: string; label: string; on: boolean }> = ({
  href,
  icon,
  label,
  on,
}) => (
  <a href={href} class={on ? 're on' : 're'} aria-current={on ? 'page' : undefined}>
    <Icon k={icon} w={1.6} />
    <span class="tip">{label}</span>
  </a>
)

const DockLink: FC<{ it: { href: string; key: string; label: string }; nav?: string }> = ({
  it,
  nav,
}) => (
  <li>
    <a href={it.href} class={nav === it.key ? 'it on' : 'it'} aria-current={nav === it.key ? 'page' : undefined}>
      <Icon k={it.key} w={1.5} />
      {it.label}
    </a>
  </li>
)

/**
 * The site menu. One copy, worn by both the ordinary pages and the composer.
 *
 * On a wide screen: a narrow plumage rail of section icons, and the current
 * section's pages docked beside it (not in the composer, which owns the
 * screen). On a phone: one sheet, every section and its pages in a list.
 */
const Rail: FC<{ nav?: string; dock?: boolean }> = ({ nav, dock = true }) => {
  const here = sectionOf(nav)
  const entry = (s: Section) => (
    <RailEntry href={s.items[0]?.href ?? '/'} icon={s.icon} label={s.label} on={here?.id === s.id} />
  )
  return (
    <aside class="rail" aria-label="Main">
      <div class="rail-bar">
        <a href="/" aria-label="Kōlea">
          <Mark />
        </a>
        <nav class="rail-nav" aria-label="Sections">
          <RailEntry href={DASHBOARD.href} icon={DASHBOARD.key} label={DASHBOARD.label} on={nav === 'home'} />
          {SECTIONS.filter((s) => !PINNED.has(s.id)).map(entry)}
          <div class="pin">{SECTIONS.filter((s) => PINNED.has(s.id)).map(entry)}</div>
        </nav>
      </div>
      {dock && here ? (
        <nav class="dock" aria-label={here.label}>
          <div class="dock-h">{here.label}</div>
          <ul>
            {here.items.map((it) => (
              <DockLink it={it} nav={nav} />
            ))}
          </ul>
        </nav>
      ) : null}
      <nav class="sheet" aria-label="Main">
        <div class="sheet-top">
          <Brand />
        </div>
        <ul>
          <DockLink it={DASHBOARD} nav={nav} />
        </ul>
        {SECTIONS.map((s) => (
          <>
            <div class="grp">{s.label}</div>
            <ul>
              {s.items.map((it) => (
                <DockLink it={it} nav={nav} />
              ))}
            </ul>
          </>
        ))}
      </nav>
    </aside>
  )
}

/** Opens the rail where it's a drawer rather than a column. */
const Burger: FC = () => (
  <label class="burger" for="rail-open" title="Menu">
    <span>
      <i />
      <i />
    </span>
  </label>
)

/** The `<head>` every admin page shares. */
const Head: FC<{ title: string }> = ({ title }) => (
  <>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="theme-color" content="#FBF8F1" />
    <title>{title} · Kōlea</title>
    <link rel="icon" href="/favicon.ico" sizes="any" />
    <link rel="icon" href="/favicon.png" type="image/png" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
    <link rel="stylesheet" href={FONTS} />
    <style dangerouslySetInnerHTML={{ __html: CSS }} />
  </>
)

export const Layout: FC<
  PropsWithChildren<{ title: string; nav?: string; editor?: boolean; charts?: boolean }>
> = ({ title, nav, editor, charts, children }) => (
  <html lang="en">
    <head>
      <Head title={title} />
      {/* ~226KB gzipped, so it loads only on the two screens that compose mail. */}
      {editor ? <link rel="stylesheet" href="/editor.css" /> : null}
      {editor ? <script src="/editor.js" type="module" defer /> : null}
      {/* Same deal for the chart runtime: dashboard and store, nowhere else. */}
      {charts ? <script src="/charts.js" type="module" defer /> : null}
    </head>
    <body>
      {/* The rail's open state is a checkbox, so the menu works with JavaScript
          off and costs nothing to ship. It must precede .shell for the sibling
          selectors that drive the drawer and the hamburger morph. */}
      <input type="checkbox" id="rail-open" class="rail-cb" aria-label="Toggle navigation" />
      <div class={sectionOf(nav) ? 'shell docked' : 'shell'}>
        <label class="scrim" for="rail-open" aria-hidden="true" />
        <Rail nav={nav} />
        <div class="stage">
          <div class="mobar">
            <Burger />
            <Brand />
          </div>
          {/* The Dashboard alone takes the whole width; every other page reads
              in a centred column. */}
          <main class={nav === 'home' ? 'wrap wide' : 'wrap'}>{children}</main>
        </div>
      </div>
    </body>
  </html>
)

/**
 * Sub-navigation for the three audience screens. They share one rail slot so
 * the nav doesn't grow an entry per concept — people, the facts you store about
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
 * Sub-navigation for the money side: the push, the way in, and the result.
 * One rail slot, same reasoning as `AudienceTabs`.
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

/** "4.2 MB". Sizes are for a human deciding whether a zip is too big to email about. */
export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let n = bytes / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`
}

/** The eyebrow that sits over a page title. Small, quiet, and always there. */
export const Eyebrow: FC<PropsWithChildren> = ({ children }) => (
  <div class="eyebrow">{children}</div>
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
      <p class="faint" style="margin:8px 0 0">
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
      <meta name="color-scheme" content="light" />
      <title>{title}</title>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
      <link rel="stylesheet" href={FONTS} />
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
export const RichEditor: FC<{
  json?: DocNode | null
  md?: string
  bare?: boolean
  /** The consent footer, rendered by `footerPreviewHtml`, shown under the paper. */
  footer?: string
  /**
   * Standing in an ordinary page rather than the composer frame, where the host
   * is the whole sheet — so the footer closes it instead of floating under it as
   * a second, narrower one. See `.bm-inline` in `client/editor.css`.
   */
  inline?: boolean
}> = ({ json, md, bare, footer, inline }) => {
  // Markdown-authored content is converted for editing. Without this the editor
  // would open empty on legacy content and the first save would erase it.
  const doc = json ?? (md ? mdToDoc(md) : null)
  const guts = (
    <>
      <input type="hidden" name="body_json" value={doc ? JSON.stringify(doc) : ''} />
      <div
        class={inline ? 'bm-editor-host bm-inline' : 'bm-editor-host'}
        data-editor
        data-field="body_json"
      />
      <noscript>
        <textarea name="body_md_fallback" placeholder="Markdown (JavaScript is off)">
          {md ?? ''}
        </textarea>
      </noscript>
      {/* Inert: it is the mail's own footer shown for reference, not something
          to edit. The editor moves it inside the sheet on mount. */}
      {footer ? (
        <div class="bm-mailfoot" aria-hidden="true" dangerouslySetInnerHTML={{ __html: footer }} />
      ) : null}
    </>
  )
  // Inside the composer the editor is the page, so it carries no label, no hint
  // and no field box — it has to be a bare flex child that can grow to the foot
  // of the frame.
  if (bare) return guts
  return (
    <div class="field">
      <label>Body</label>
      {guts}
      <p class="faint" style="margin:10px 0 0">
        Press <span class="mono">/</span> for blocks · <span class="mono">@</span> to personalize ·
        drag the handle in the left margin to reorder · drop an image anywhere
      </p>
    </div>
  )
}

/**
 * A finished piece of mail, read-only.
 *
 * Same TipTap document, same paper, same block rhythm as the composer — the
 * editor bundle mounts a non-editable instance over this host, so a sent
 * broadcast reads exactly as it read while it was being written, and as it
 * landed in the reader's inbox. Until (or without) that bundle, the server's
 * own email HTML stands in: `fallback` is what `previewHtml` produced, which is
 * literally the markup that went on the wire.
 */
export const MailReader: FC<{
  json?: DocNode | null
  md?: string
  /** Email HTML shown before the bundle mounts, and forever if it never does. */
  fallback: string
  /** The consent footer, rendered by `footerPreviewHtml`, on the same sheet. */
  footer?: string
}> = ({ json, md, fallback, footer }) => {
  const doc = json ?? (md ? mdToDoc(md) : null)
  return (
    <div class="bm-reader">
      <div class="bm-reader-host" data-reader>
        <div class="bm-prose bm-reader-fallback" dangerouslySetInnerHTML={{ __html: fallback }} />
        {doc ? (
          <script
            type="application/json"
            class="bm-reader-doc"
            // `<` escaped so a "</script>" inside the copy cannot close this tag.
            dangerouslySetInnerHTML={{ __html: JSON.stringify(doc).replaceAll('<', '\\u003c') }}
          />
        ) : null}
      </div>
      {footer ? (
        <div class="bm-mailfoot" aria-hidden="true" dangerouslySetInnerHTML={{ __html: footer }} />
      ) : null}
    </div>
  )
}

/**
 * Read a body back out of a posted form: the rich document if the editor posted
 * one, markdown otherwise (the `<noscript>` path, or a legacy form).
 *
 * Lives next to `RichEditor` because it is the other half of the same contract —
 * one field of body content, however it was authored.
 */
export function readEditorBody(form: FormData): { bodyJson: DocNode | null; bodyMd: string } {
  const raw = String(form.get('body_json') ?? '').trim()
  const md = String(form.get('body_md_fallback') ?? form.get('body') ?? '')
  if (!raw) return { bodyJson: null, bodyMd: md }
  try {
    return { bodyJson: JSON.parse(raw) as DocNode, bodyMd: md }
  } catch {
    // Never lose someone's writing to a parse error.
    return { bodyJson: null, bodyMd: md || raw }
  }
}

/** The hint that lives under the editor everywhere else. */
export const EditorHint: FC = () => (
  <p class="faint" style="margin:0">
    Press <span class="mono">/</span> for blocks · <span class="mono">@</span> to personalize · drag
    the handle in the left margin to reorder · drop an image anywhere
  </p>
)

/**
 * Full-height frame for writing one piece of mail.
 *
 * The site menu stays where it always is — writing mail is a page like any
 * other, and there is no reason to strand somebody in a mode they have to find
 * their way out of. Everything right of the rail becomes the composer: a bar
 * naming the mail, the work, and a foot holding the count and the save.
 *
 * All of it — subject, body and the sidebar settings alike — lives inside one
 * form, so the Save in the foot is a plain submit with no JavaScript behind it.
 * Anything that posts somewhere else (sending, deleting) goes in `extra` as its
 * own hidden form and is reached from a button carrying `form="<id>"`.
 */
/** What the composer's AI buttons need to know: which models, and where the mail goes. */
export interface ComposeAi {
  /** Display names, for the small print under each button. */
  subjectModel: string
  cleanupModel: string
  /** A few words on where this mail goes, handed to the subject suggester. */
  context?: string
}

export const ComposeLayout: FC<
  PropsWithChildren<{
    title: string
    nav?: string
    action: string
    /** Endpoint the timed save posts to. Absent means no autosave on this page. */
    autosave?: string
    /** Endpoint the preview dialog posts to. */
    preview?: string
    /**
     * Turns on the slop coach: underlines in the draft, and the dial in the
     * toolbar. Off by default — a receipt is not the kind of writing anyone
     * needs coaching on.
     */
    slop?: boolean
    /**
     * Turns on the writing help (`client/ai.ts`): subject suggestions beside
     * the subject, and "Clean this up" under the slop dial. Null when
     * OpenRouter isn't configured, which hides both.
     */
    ai?: ComposeAi | null
    /** The row being edited, or null for one that autosave will create. */
    recordId?: number | null
    back: string
    backLabel?: string
    heading: string
    sub?: Child
    actions?: Child
    side?: Child
    foot?: Child
    extra?: Child
  }>
> = ({
  title,
  nav,
  action,
  autosave,
  preview,
  slop,
  ai,
  recordId,
  back,
  backLabel,
  heading,
  sub,
  actions,
  side,
  foot,
  extra,
  children,
}) => (
  <html lang="en">
    <head>
      <Head title={title} />
      <link rel="stylesheet" href="/editor.css" />
      <script src="/editor.js" type="module" defer />
    </head>
    <body>
      <input type="checkbox" id="rail-open" class="rail-cb" aria-label="Toggle navigation" />
      <div class="shell">
        <label class="scrim" for="rail-open" aria-hidden="true" />
        {/* The composer owns the screen beside the rail: nothing docks. */}
        <Rail nav={nav} dock={false} />
        <div class="stage compose-stage">
          <form
        method="post"
        action={action}
        class="compose"
        data-autosave={autosave}
        data-preview={preview}
        data-slop={slop ? '1' : undefined}
        data-ai={ai ? '1' : undefined}
        data-ai-subject-model={ai?.subjectModel}
        data-ai-cleanup-model={ai?.cleanupModel}
        data-ai-context={ai?.context}
        data-record-id={recordId ? String(recordId) : undefined}
      >
        {/* Autosave posts the form as-is, so the row it should write has to be
            in the form. On a new draft it starts empty and the first save fills
            it in. */}
        <input type="hidden" name="id" value={recordId ? String(recordId) : ''} />
            <header class="compose-top">
              {/* Where the rail is a drawer, the way to it is here — the
                  composer has no room for a bar of its own. */}
              <Burger />
              <a class="cx" href={back} title={backLabel ?? 'Back'} aria-label={backLabel ?? 'Back'}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M19 12H5m0 0l6-6m-6 6l6 6" />
                </svg>
              </a>
              <div class="compose-id">
                <div class="t">{heading}</div>
                {sub ? <div class="s">{sub}</div> : null}
              </div>
              <div class="compose-acts">{actions}</div>
            </header>
            <div class="compose-body">
              <main class="compose-main">{children}</main>
              <aside class="compose-side">
                {/* First thing in the panel, above who it goes to: the dial and
                    its to-do list mount here (`client/slop-panel.ts`). */}
                {slop ? <div class="side-sec" data-slop-panel /> : null}
                {side}
              </aside>
            </div>
            <footer class="compose-foot">
              {/* Autosave writes its state here: Unsaved / Saving… / Saved 14:22.
                  It is the only running commentary the composer gives, which is
                  why it sits next to the button it is reassuring you about. */}
              <span class="save-state" data-save-state />
              <div class="compose-acts">{foot}</div>
            </footer>
          </form>
          {extra}
        </div>
      </div>
    </body>
  </html>
)

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
