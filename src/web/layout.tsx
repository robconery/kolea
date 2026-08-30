import type { Child, FC, PropsWithChildren } from 'hono/jsx'
import { mdToDoc } from '../core/md-to-doc.ts'
import type { Campaign, DocNode } from '../db/schema.ts'

/**
 * The look: "Abyssal".
 *
 * A dashboard you sit in front of for hours should feel like somewhere, not like
 * a form. This one is a dive: deep water at the bottom of the page, sunlight
 * raking down from above, and the work floating in it.
 *
 * There are no containers. Not a card, not a panel, not a sidebar with a wall
 * around it — everything sits directly on the water, edge to edge, and the only
 * thing that ever separates two regions is a one-pixel gradient rule that fades
 * out before it reaches either end. A rule that fades has no corners, and
 * without corners nothing reads as a window pasted onto the page. Whitespace
 * does the rest of the work.
 *
 * Rules that keep it fast on a Worker with no framework:
 *   · One stylesheet, inlined. No CSS build, no utility runtime.
 *   · Animation is `transform` and `opacity` only — never width/height/top/left.
 *   · `backdrop-filter` appears only on the mobile bar, which is the one piece
 *     of furniture with content scrolling beneath it.
 *   · The ocean is one fixed, `pointer-events:none` layer behind everything.
 *   · Entrances are a staggered CSS keyframe on load. Zero JavaScript.
 */
export const CSS = `
@layer base, ocean, shell, surface, controls, data, motion, compose;

@layer base {
:root{
  /* depth */
  --abyss:#03060f; --deep:#050c22; --mid:#08142f;
  /* light */
  --cyan:#22d3ee; --azure:#3b82f6; --indigo:#6366f1; --violet:#a855f7;
  --aqua:#2dd4bf; --rose:#fb7185;
  --beam:linear-gradient(120deg,#22d3ee 0%,#60a5fa 38%,#a855f7 100%);
  /* ink */
  --ink:#eaf3ff; --muted:#9db2d4; --faint:#6d84a8;
  /* The only two dividers in the building. Both fade out at their ends, so a
     rule never terminates in a hard corner and nothing reads as a box. */
  --rule:linear-gradient(90deg,transparent,rgba(148,190,255,.17) 6%,
    rgba(148,190,255,.17) 94%,transparent);
  --rule-v:linear-gradient(180deg,transparent,rgba(148,190,255,.15) 10%,
    rgba(148,190,255,.15) 90%,transparent);
  --rule-faint:linear-gradient(90deg,transparent,rgba(148,190,255,.085) 4%,
    rgba(148,190,255,.085) 96%,transparent);
  /* One neutral grotesk for everything. Two faces and a display serif read as
     three opinions; a single family carried by weight, size and tracking reads
     as one. Inter's tabular figures matter here — most of this UI is numbers. */
  --sans:'Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Helvetica,sans-serif;
  --display:var(--sans);
  --mono:'JetBrains Mono',ui-monospace,SFMono-Regular,'SF Mono',Menlo,monospace;
  /* the only easing curves in the building */
  --spring:cubic-bezier(.32,.72,0,1);
  --glide:cubic-bezier(.22,1,.36,1);
  --rail-w:250px;
  --gut:clamp(26px,3.4vw,64px);
}
*{box-sizing:border-box}
html{scrollbar-color:rgba(148,190,255,.2) transparent}
body{margin:0;background:var(--abyss);color:var(--ink);
  font:15px/1.6 var(--sans);letter-spacing:-.005em;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
::selection{background:rgba(34,211,238,.28);color:#fff}
a{color:#7dd3fc;text-decoration:none;transition:color .35s var(--glide)}
a:hover{color:#a5f3fc}
h1,h2,h3{margin:0;font-weight:600;letter-spacing:-.02em}
/* Big type earns its presence from weight and tight tracking, not from a
   different family. Optical sizing: the larger it gets, the tighter it sets. */
h1{font:700 clamp(28px,2.9vw,38px)/1.08 var(--display);letter-spacing:-.038em;
  background:linear-gradient(178deg,#ffffff 10%,#b6cff2 92%);
  -webkit-background-clip:text;background-clip:text;color:transparent}
h2{font:600 16.5px/1.3 var(--display);letter-spacing:-.02em;color:#e6f0ff}
h3{font:600 10.5px/1 var(--display);text-transform:uppercase;letter-spacing:.19em;color:var(--faint)}
p{margin:0 0 12px}
hr{border:0;height:1px;background:var(--rule);margin:26px 0}
::-webkit-scrollbar{width:9px;height:9px}
::-webkit-scrollbar-thumb{background:rgba(148,190,255,.16);border-radius:99px;
  border:3px solid transparent;background-clip:content-box}
::-webkit-scrollbar-thumb:hover{background:rgba(148,190,255,.3);background-clip:content-box}
::-webkit-scrollbar-track{background:transparent}
}

/* ─────────────────────────────────────────────────────────── the ocean */
@layer ocean {
.ocean{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;
  background:
    radial-gradient(120% 78% at 50% -18%,rgba(56,189,248,.20),transparent 62%),
    radial-gradient(85% 58% at 88% 6%,rgba(139,92,246,.20),transparent 66%),
    radial-gradient(80% 60% at 4% 96%,rgba(45,212,191,.10),transparent 62%),
    radial-gradient(60% 45% at 78% 92%,rgba(99,102,241,.14),transparent 66%),
    linear-gradient(178deg,#07183a 0%,var(--deep) 42%,var(--abyss) 100%)}

/* Sunlight, raked through the surface. Two sheets at different rakes and speeds
   so the interference between them reads as moving water rather than stripes. */
.rays,.rays-b{position:absolute;left:-25%;top:-45%;width:150%;height:130%;
  will-change:transform;transform:translateZ(0)}
.rays{background:repeating-linear-gradient(99deg,
    rgba(186,230,253,.070) 0 2px,transparent 2px 11px,
    rgba(224,242,254,.045) 11px 14px,transparent 14px 34px);
  -webkit-mask-image:radial-gradient(58% 74% at 46% -4%,#000 0%,rgba(0,0,0,.55) 40%,transparent 76%);
  mask-image:radial-gradient(58% 74% at 46% -4%,#000 0%,rgba(0,0,0,.55) 40%,transparent 76%);
  animation:rake 26s var(--glide) infinite alternate}
.rays-b{background:repeating-linear-gradient(84deg,
    rgba(165,243,252,.055) 0 3px,transparent 3px 22px);
  -webkit-mask-image:radial-gradient(64% 60% at 68% -8%,#000 0%,transparent 72%);
  mask-image:radial-gradient(64% 60% at 68% -8%,#000 0%,transparent 72%);
  animation:rake-b 34s var(--glide) infinite alternate}
@keyframes rake{from{transform:translate3d(-2.5%,0,0) rotate(-1.1deg) scaleY(1)}
  to{transform:translate3d(3.5%,0,0) rotate(1.4deg) scaleY(1.06)}}
@keyframes rake-b{from{transform:translate3d(3%,0,0) rotate(1deg)}
  to{transform:translate3d(-3%,0,0) rotate(-1.2deg)}}

/* Caustics: one turbulence tile, rasterised once, then only ever transformed. */
.caustic{position:absolute;inset:-20%;opacity:.30;mix-blend-mode:screen;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='320'%3E%3Cfilter id='c'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.012 0.018' numOctaves='2' seed='7'/%3E%3CfeColorMatrix values='0 0 0 0 0.42 0 0 0 0 0.78 0 0 0 0 1 0 0 0 -1.6 0.72'/%3E%3C/filter%3E%3Crect width='320' height='320' filter='url(%23c)'/%3E%3C/svg%3E");
  background-size:760px 760px;
  -webkit-mask-image:radial-gradient(70% 55% at 50% 0%,#000,transparent 78%);
  mask-image:radial-gradient(70% 55% at 50% 0%,#000,transparent 78%);
  animation:swell 40s linear infinite}
@keyframes swell{from{transform:translate3d(0,0,0) scale(1.04)}
  50%{transform:translate3d(-3%,2%,0) scale(1.12)}
  to{transform:translate3d(0,0,0) scale(1.04)}}

/* Plankton. Six of them. Any more and it is a screensaver. */
.mote{position:absolute;border-radius:50%;background:rgba(186,230,253,.62);
  box-shadow:0 0 12px 2px rgba(103,232,249,.35);animation:drift 26s var(--glide) infinite}
.mote:nth-child(1){width:3px;height:3px;left:12%;top:72%;animation-duration:31s}
.mote:nth-child(2){width:2px;height:2px;left:31%;top:88%;animation-duration:24s;animation-delay:-6s}
.mote:nth-child(3){width:4px;height:4px;left:58%;top:80%;animation-duration:38s;animation-delay:-14s;opacity:.6}
.mote:nth-child(4){width:2px;height:2px;left:74%;top:66%;animation-duration:28s;animation-delay:-3s}
.mote:nth-child(5){width:3px;height:3px;left:88%;top:84%;animation-duration:35s;animation-delay:-19s}
.mote:nth-child(6){width:2px;height:2px;left:46%;top:94%;animation-duration:21s;animation-delay:-9s;opacity:.5}
@keyframes drift{0%{transform:translate3d(0,0,0);opacity:0}
  12%{opacity:.75}
  100%{transform:translate3d(38px,-78vh,0);opacity:0}}

/* Film grain. Fixed, above the ocean, below everything real. */
.grain{position:fixed;inset:0;z-index:1;pointer-events:none;opacity:.05;
  mix-blend-mode:overlay;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E")}
}

/* ─────────────────────────────────────────────────────────── the shell */
@layer shell {
.rail-cb{position:absolute;opacity:0;pointer-events:none}
.shell{position:relative;z-index:2;min-height:100dvh}

/* No panel. The rail is type and icons standing on the water, separated from
   the work by one hairline that fades out top and bottom. */
.rail{position:fixed;top:0;bottom:0;left:0;width:var(--rail-w);z-index:40;
  transition:transform .6s var(--spring)}
.rail::after{content:'';position:absolute;top:0;bottom:0;right:0;width:1px;
  background:var(--rule-v)}
.rail-in{height:100%;display:flex;flex-direction:column;
  padding:34px 24px 22px;overflow:hidden}

.brand{display:flex;align-items:center;gap:11px;padding:0 0 26px;color:var(--ink)}
.brand:hover{color:var(--ink)}
.brand .sigil{width:32px;height:32px;flex:0 0 auto;border-radius:11px;display:grid;place-items:center;
  background:var(--beam);box-shadow:0 8px 24px -8px rgba(34,211,238,.9);
  transition:transform .6s var(--spring)}
.brand .sigil img{width:26px;height:25px;object-fit:contain;display:block}
.brand:hover .sigil{transform:rotate(-8deg) scale(1.06)}
.brand .wm{font:700 16.5px/1 var(--display);letter-spacing:-.035em}
.brand .wm i{font-style:normal;background:var(--beam);-webkit-background-clip:text;
  background-clip:text;color:transparent}
.brand .wm em{display:block;font:500 8.5px/1 var(--display);font-style:normal;
  text-transform:uppercase;letter-spacing:.28em;color:var(--faint);margin-top:5px}

/* The wash bleeds to both edges of the rail, so the active row has no left or
   right boundary — it dissolves instead of stopping. */
.rail nav{display:flex;flex-direction:column;gap:1px;overflow-y:auto;flex:1;
  margin:0 -24px;padding:0 24px;scrollbar-width:thin}
.rail .grp{padding:20px 0 8px;font:600 9.5px/1 var(--display);text-transform:uppercase;
  letter-spacing:.22em;color:rgba(109,132,168,.8)}
.rail .grp:first-child{padding-top:0}
.rail nav a{position:relative;display:flex;align-items:center;gap:13px;padding:9px 24px;
  margin:0 -24px;color:rgba(196,216,244,.7);font:500 14px/1 var(--sans);
  transition:color .4s var(--glide),transform .5s var(--spring)}
.rail nav a svg{width:17px;height:17px;flex:0 0 auto;opacity:.6;
  transition:opacity .4s var(--glide),color .4s var(--glide)}
.rail nav a:hover{color:#fff;transform:translateX(3px)}
.rail nav a:hover svg{opacity:1}
.rail nav a.on{color:#fff;
  background:linear-gradient(90deg,rgba(34,211,238,.16),rgba(168,85,247,.07) 55%,transparent)}
.rail nav a.on svg{opacity:1;color:#7dd3fc}
.rail nav a.on::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;
  background:var(--beam);box-shadow:0 0 14px 1px rgba(34,211,238,.8)}

.rail-foot{margin-top:18px;padding:16px 0 0;position:relative;
  font:500 10px/1.5 var(--display);letter-spacing:.18em;text-transform:uppercase;color:var(--faint);
  display:flex;align-items:center;gap:9px}
.rail-foot::before{content:'';position:absolute;top:0;left:-24px;right:-24px;height:1px;
  background:var(--rule)}
.pulse{width:5px;height:5px;border-radius:50%;background:var(--aqua);flex:0 0 auto;
  box-shadow:0 0 0 0 rgba(45,212,191,.65);animation:pulse 3.4s var(--glide) infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(45,212,191,.6)}
  70%{box-shadow:0 0 0 8px rgba(45,212,191,0)}100%{box-shadow:0 0 0 0 rgba(45,212,191,0)}}

/* Edge to edge. The screen is the canvas; there is no page inside it. */
.stage{margin-left:var(--rail-w);min-height:100dvh}
.wrap{max-width:none;margin:0;padding:46px var(--gut) 140px}

.mobar{display:none}
.scrim{display:none}

@media (max-width:1080px){
  .rail{transform:translateX(-100%);width:min(292px,84vw);
    background:linear-gradient(120deg,rgba(6,16,40,.97),rgba(4,10,28,.99))}
  .rail-cb:checked ~ .shell .rail{transform:none}
  .stage{margin-left:0}
  .wrap{padding:20px 20px 110px}
  .mobar{display:flex;position:sticky;top:0;z-index:30;align-items:center;gap:12px;
    padding:11px 20px;margin:0 0 4px;
    background:linear-gradient(180deg,rgba(5,12,34,.9),rgba(5,12,34,.55));
    -webkit-backdrop-filter:blur(22px) saturate(150%);backdrop-filter:blur(22px) saturate(150%)}
  .mobar::after{content:'';position:absolute;left:0;right:0;bottom:0;height:1px;background:var(--rule)}
  .mobar .brand{padding:0}
  /* -8px so the 18px glyph inside the 34px hit area lines up with the page
     gutter, not the button's own box edge. */
  .burger{width:34px;height:34px;display:grid;place-items:center;cursor:pointer;margin:0 0 0 -8px}
  .burger span{position:relative;display:block;width:18px;height:2px}
  .burger i{position:absolute;left:0;top:0;display:block;width:18px;height:1.5px;border-radius:2px;
    background:var(--ink);transition:transform .5s var(--spring)}
  .burger i:first-child{transform:translateY(-4px)}
  .burger i:last-child{transform:translateY(4px)}
  .rail-cb:checked ~ .shell .burger i:first-child{transform:translateY(0) rotate(45deg)}
  .rail-cb:checked ~ .shell .burger i:last-child{transform:translateY(0) rotate(-45deg)}
  .scrim{display:block;position:fixed;inset:0;z-index:35;opacity:0;pointer-events:none;
    background:rgba(3,6,15,.7);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);
    transition:opacity .5s var(--glide)}
  .rail-cb:checked ~ .shell .scrim{opacity:1;pointer-events:auto}
  .hide-sm{display:none}
}
}

/* ─────────────────────────────────────────────────── the working surface */
@layer surface {
.head{display:flex;align-items:flex-end;gap:24px;margin:0 0 8px;flex-wrap:wrap;
  padding-bottom:34px}
.head .sub{color:var(--muted);font-size:14px;margin-top:11px;max-width:70ch}
.head .actions{margin-left:auto;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.eyebrow{display:inline-flex;align-items:center;gap:8px;margin-bottom:15px;
  font:600 9.5px/1 var(--display);text-transform:uppercase;letter-spacing:.24em;color:#8fb4dd}
.eyebrow::before{content:'';width:18px;height:1.5px;border-radius:2px;background:var(--beam);
  box-shadow:0 0 10px rgba(34,211,238,.9)}

/* A "card" is no longer a container. It is a band of the page: one hairline
   above it, air around it, and nothing else. Nothing is enclosed, nothing is
   glued on — the content sits directly on the water. */
.card{position:relative;margin:0;padding:44px 0 0;background:none;box-shadow:none;border:0}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:var(--rule)}
.card-h{padding:0 0 22px;display:flex;align-items:baseline;gap:16px;border:0;flex-wrap:wrap}
.card-h .actions{margin-left:auto;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.card-b{padding:0 0 42px}
.card-b.flush{padding:0 0 42px}

/* Side by side, split by a vertical hairline rather than by two boxes. */
.bento{display:grid;grid-template-columns:repeat(12,1fr);column-gap:var(--gut);align-items:start}
.bento>*{grid-column:span 12}
.col-4{grid-column:span 4}.col-5{grid-column:span 5}.col-6{grid-column:span 6}
.col-7{grid-column:span 7}.col-8{grid-column:span 8}.col-12{grid-column:span 12}
.bento>.card+.card::after{content:'';position:absolute;left:calc(var(--gut) / -2);
  top:44px;bottom:42px;width:1px;background:var(--rule-v)}
@media (max-width:1180px){
  .bento{column-gap:0}
  .bento>*{grid-column:span 12!important}
  .bento>.card+.card::after{display:none}
}

.tabs{display:flex;gap:30px;margin:-6px 0 34px;padding:0;background:none;
  border:0;flex-wrap:wrap}
.tabs a{position:relative;padding:0 0 12px;border-radius:0;font:500 14px/1 var(--sans);
  color:var(--muted);transition:color .4s var(--glide)}
.tabs a:hover{color:var(--ink);background:none}
.tabs a.on{color:#fff;background:none;font-weight:600}
.tabs a.on::after{content:'';position:absolute;left:0;right:0;bottom:0;height:2px;border-radius:2px;
  background:var(--beam);box-shadow:0 0 14px rgba(34,211,238,.7)}

/* An aside, not a box: a gradient rule down the left and a wash that fades to
   nothing before it reaches the right-hand side. */
.note{position:relative;border:0;border-radius:0;box-shadow:none;
  padding:2px 0 2px 20px;margin:0 0 24px;font-size:13.5px;color:#cfe2ff;
  background:linear-gradient(90deg,rgba(34,211,238,.075),transparent 62%)}
.note::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;border-radius:2px;
  background:linear-gradient(180deg,#22d3ee,rgba(168,85,247,.35))}
.note strong{color:#fff;font-weight:600}

.flash{position:relative;border:0;border-radius:0;box-shadow:none;
  padding:14px 0 14px 20px;margin:0 0 30px;font-size:14px;color:#d7fff6;
  background:linear-gradient(90deg,rgba(45,212,191,.13),transparent 58%)}
.flash::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;border-radius:2px;
  background:linear-gradient(180deg,#5eead4,rgba(34,211,238,.3))}
.flash.warn{color:#f0dcff;background:linear-gradient(90deg,rgba(168,85,247,.15),transparent 58%)}
.flash.warn::before{background:linear-gradient(180deg,#c084fc,rgba(99,102,241,.3))}

.empty{padding:64px 0;text-align:center;color:var(--faint)}
.empty p{margin:0 0 6px}
.empty p:first-child{color:var(--muted);font-size:15px}

pre.code,.card pre{background:linear-gradient(180deg,rgba(2,8,23,.5),rgba(2,8,23,.28));
  padding:18px 20px;border-radius:14px;overflow:auto;border:0;
  font:13px/1.6 var(--mono);color:#bfe3ff}

.mailview{border-radius:14px;overflow:hidden;background:rgba(2,8,23,.4);border:0}
.mailview iframe{width:100%;height:620px;border:0;display:block;background:#f6f5f3}
.mailhead{position:relative;padding:14px 0;font-size:13px;color:var(--muted)}
.mailhead::after{content:'';position:absolute;left:0;right:0;bottom:0;height:1px;background:var(--rule)}
.mailhead b{display:inline-block;min-width:56px;color:var(--faint);font-weight:500}

.mono{font-family:var(--mono);font-size:12.5px;letter-spacing:-.01em}
.muted{color:var(--muted)}
.faint{color:var(--faint);font-size:13px}
}

/* ─────────────────────────────────────────────────────── the controls */
@layer controls {
.btn{position:relative;display:inline-flex;align-items:center;gap:8px;padding:9px 17px;
  border-radius:99px;border:0;cursor:pointer;white-space:nowrap;
  font:600 13.5px/1 var(--display);letter-spacing:-.01em;
  background:rgba(255,255,255,.065);color:var(--ink);box-shadow:none;
  transition:transform .45s var(--spring),background-color .45s var(--glide),color .45s var(--glide)}
.btn:hover{background:rgba(255,255,255,.13);color:#fff;transform:translateY(-1px)}
.btn:active{transform:scale(.975)}
.btn:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
.btn.primary{background:var(--beam);color:#03121f;
  box-shadow:0 12px 30px -16px rgba(56,189,248,.95)}
.btn.primary:hover{color:#03121f;box-shadow:0 18px 40px -16px rgba(56,189,248,1)}
.btn.accent{background:linear-gradient(120deg,#2dd4bf,#22d3ee);color:#032420;
  box-shadow:0 12px 30px -16px rgba(45,212,191,.9)}
.btn.danger{color:#ffc4cd;background:rgba(251,113,133,.1)}
.btn.danger:hover{background:rgba(251,113,133,.2);color:#ffdde2}
.btn.sm{padding:6px 13px;font-size:12px}
.btn .chip{display:grid;place-items:center;width:22px;height:22px;margin:-4px -8px -4px 2px;
  border-radius:99px;background:rgba(0,0,0,.16);
  transition:transform .5s var(--spring)}
.btn:hover .chip{transform:translate(2px,-1px) scale(1.08)}
.btn:not(.primary):not(.accent) .chip{background:rgba(255,255,255,.1)}

.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border-radius:99px;
  font:600 11.5px/1.35 var(--display);background:rgba(255,255,255,.06);color:var(--muted);box-shadow:none}
.pill.ok{background:rgba(45,212,191,.13);color:#7fecd8}
.pill.warn{background:rgba(168,85,247,.15);color:#e0bbff}
.pill.bad{background:rgba(251,113,133,.14);color:#ffb3bf}

/* Fields are a wash and an underline that lights up. No frames. */
/* :not() on the two labels that are furniture rather than field captions. The
   hamburger and the drawer scrim are <label> elements so the menu works with
   JavaScript off, and this rule lives in a later @layer than the shell — layer
   order beats specificity, so without the exclusion it would quietly reset
   their display and un-centre the hamburger. */
label:not(.burger):not(.scrim){display:block;font:600 10.5px/1 var(--display);
  text-transform:uppercase;letter-spacing:.15em;margin-bottom:10px;color:var(--faint)}
input[type=text],input[type=email],input[type=number],input[type=password],
input[type=search],input[type=url],input[type=date],input[type=datetime-local],
textarea,select{
  width:100%;padding:11px 14px;border:0;border-radius:10px 10px 2px 2px;color:var(--ink);
  background:linear-gradient(180deg,rgba(148,190,255,.045),rgba(148,190,255,.075));
  font:14px var(--sans);
  box-shadow:inset 0 -1px 0 rgba(148,190,255,.22);
  transition:box-shadow .4s var(--glide),background-color .4s var(--glide)}
input::placeholder,textarea::placeholder{color:rgba(109,132,168,.7)}
textarea{font:13px/1.65 var(--mono);resize:vertical;min-height:200px}
select{appearance:none;cursor:pointer;padding-right:38px;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%239db2d4' stroke-width='1.4' stroke-linecap='round'%3E%3Cpath d='M6 9.5l6 5.5 6-5.5'/%3E%3C/svg%3E"),
    linear-gradient(180deg,rgba(148,190,255,.045),rgba(148,190,255,.075));
  background-repeat:no-repeat,repeat;background-position:right 12px center,0 0;
  background-size:16px,auto}
select[multiple]{appearance:none;padding:8px;font-size:13px;border-radius:10px;
  background-image:none;background:rgba(148,190,255,.06)}
option{background:#0a1730;color:var(--ink)}
input:hover,textarea:hover,select:hover{box-shadow:inset 0 -1px 0 rgba(148,190,255,.4)}
input:focus,textarea:focus,select:focus{outline:0;
  box-shadow:inset 0 -2px 0 #22d3ee,0 6px 22px -14px rgba(34,211,238,.9)}
input[type=checkbox],input[type=radio]{appearance:none;-webkit-appearance:none;
  width:17px;height:17px;flex:0 0 auto;margin:0;cursor:pointer;border-radius:6px;
  background:rgba(148,190,255,.12);
  transition:background .3s var(--glide),transform .35s var(--spring)}
input[type=radio]{border-radius:50%}
input[type=checkbox]:hover,input[type=radio]:hover{background:rgba(148,190,255,.24)}
input[type=checkbox]:checked,input[type=radio]:checked{background:var(--beam)}
input[type=checkbox]:checked::after{content:'';display:block;width:100%;height:100%;
  background:no-repeat center/11px url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23041423' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12.5l4.5 4.5L19 7'/%3E%3C/svg%3E")}
input[type=radio]:checked::after{content:'';display:block;width:100%;height:100%;
  background:radial-gradient(circle at 50% 50%,#041423 0 30%,transparent 32%)}
input[type=checkbox]:focus-visible,input[type=radio]:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
/* Forms get a measure. A 1,500px-wide text input is not "using the space", it
   is making somebody track a metre of empty box with their eye — and the
   composer's page is a preview of mail that lands about 600px wide. Data —
   tables, charts, KPI rows — still runs edge to edge. */
.field{margin-bottom:24px;max-width:1040px}
.row{display:flex;gap:20px;flex-wrap:wrap;max-width:1040px}
.row>*{flex:1;min-width:210px}
.row .field{max-width:none}
.bm-editor-host{max-width:1040px}
}

/* ──────────────────────────────────────────────────────────── the data */
@layer data {
/* KPIs stand in a row divided by hairlines, not in five little windows. */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:26px 0;padding:0}
.stat{position:relative;padding:2px 26px}
.stat:first-child{padding-left:0}
.stat::before{content:'';position:absolute;left:0;top:2px;bottom:2px;width:1px;
  background:var(--rule-v)}
.stat:first-child::before{display:none}
.stat .n{font:600 clamp(25px,2.2vw,32px)/1 var(--display);font-variant-numeric:tabular-nums;
  letter-spacing:-.045em;color:#f2f8ff;text-shadow:0 0 30px rgba(125,211,252,.25)}
.stat .l{font:600 10px/1.3 var(--display);color:var(--faint);margin-top:11px;
  text-transform:uppercase;letter-spacing:.17em}
.stat .h,.stat .hint{font-size:12.5px;color:var(--muted);margin-top:7px}
.stat.hi .n{background:linear-gradient(120deg,#5eead4,#22d3ee 55%,#818cf8);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  filter:drop-shadow(0 0 20px rgba(34,211,238,.4))}
.stats.money .stat .n{font-size:clamp(21px,1.9vw,27px)}
@media (max-width:900px){
  .stats{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}
  .stat{padding:2px 16px}
  .stat:nth-child(odd){padding-left:0}
  .stat:nth-child(odd)::before{display:none}
}

/* ── Signal: the hero score. Colour carries meaning here, which it does nowhere
   else in this interface — so every band is also named in words beside it, and
   nothing is legible by hue alone. */
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0}
.sig-card .card-b{padding-bottom:46px}
.sig-top{display:flex;flex-direction:column;gap:2px;margin-bottom:26px}
.sig-subject{font:600 clamp(17px,1.5vw,21px)/1.3 var(--display);color:var(--ink);
  letter-spacing:-.02em;text-decoration:none;max-width:60ch}
.sig-subject:hover{color:#fff;text-decoration:underline;text-underline-offset:4px}

.sig-grid{display:grid;grid-template-columns:minmax(190px,auto) 1fr;gap:clamp(28px,4vw,64px);
  align-items:start}
.sig-score{display:flex;flex-direction:column}
.sig-n{font:600 clamp(66px,8.5vw,116px)/.86 var(--display);font-variant-numeric:tabular-nums;
  letter-spacing:-.055em;-webkit-background-clip:text;background-clip:text;color:transparent}
.sig-n.strong{background-image:linear-gradient(120deg,#5eead4,#22d3ee 60%,#60a5fa);
  filter:drop-shadow(0 0 26px rgba(34,211,238,.38))}
.sig-n.good{background-image:linear-gradient(120deg,#60a5fa,#818cf8 60%,#a855f7);
  filter:drop-shadow(0 0 26px rgba(99,102,241,.34))}
.sig-n.fair{background-image:linear-gradient(120deg,#fcd34d,#fbbf24 60%,#f59e0b);
  filter:drop-shadow(0 0 26px rgba(251,191,36,.28))}
.sig-n.weak{background-image:linear-gradient(120deg,#fda4af,#fb7185 60%,#f43f5e);
  filter:drop-shadow(0 0 26px rgba(251,113,133,.3))}
.sig-den{display:flex;flex-direction:column;gap:5px;margin-top:16px}
.sig-band{font:600 11px/1 var(--display);text-transform:uppercase;letter-spacing:.19em;
  color:var(--ink)}
.sig-outof{font:500 12px/1 var(--display);color:var(--faint);letter-spacing:.02em}
.sig-vs{margin-top:15px;font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums}

.sig-read{min-width:0}
.sig-verdict{font:600 clamp(22px,2.5vw,34px)/1.22 var(--display);letter-spacing:-.032em;
  margin:0;color:#f2f8ff;max-width:24ch;text-wrap:balance}
.sig-ev{margin:16px 0 0;color:var(--muted);font-size:14.5px;line-height:1.65;max-width:56ch;
  font-variant-numeric:tabular-nums}
.sig-empty{font:600 clamp(20px,2vw,27px)/1.25 var(--display);letter-spacing:-.028em;margin:0}

/* History: one column per send, oldest left. A gap means "not measured", which
   is a different fact from a low score and must not look like one. */
.sig-hist{margin-top:26px}
.sig-hist-bars{display:flex;align-items:flex-end;gap:5px;height:64px}
.sig-col{flex:1 1 0;min-width:5px;max-width:26px;height:100%;display:flex;align-items:flex-end;
  border-radius:3px;background:rgba(148,190,255,.05)}
.sig-col-fill{width:100%;border-radius:3px;opacity:.85;transition:opacity .3s var(--glide);
  background:linear-gradient(180deg,rgba(148,190,255,.42),rgba(148,190,255,.2))}
.sig-col:hover .sig-col-fill{opacity:1}
.sig-col.now .sig-col-fill{opacity:1}
.sig-col-fill.strong{background:linear-gradient(180deg,#22d3ee,#0ea5e9)}
.sig-col-fill.good{background:linear-gradient(180deg,#818cf8,#4f46e5)}
.sig-col-fill.fair{background:linear-gradient(180deg,#fbbf24,#d97706)}
.sig-col-fill.weak{background:linear-gradient(180deg,#fb7185,#e11d48)}
.sig-hist-l{margin-top:11px;font:500 10px/1.3 var(--display);color:var(--faint);
  text-transform:uppercase;letter-spacing:.16em}

/* The three components. Same hairline division as .stats, so the hero reads as
   part of the same page rather than a widget dropped onto it. */
.sig-parts{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:26px 0;
  margin-top:42px;padding-top:32px;position:relative}
.sig-parts::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;
  background:var(--rule-faint)}
.sig-part{position:relative;padding:0 26px}
.sig-part:first-child{padding-left:0}
.sig-part::before{content:'';position:absolute;left:0;top:0;bottom:0;width:1px;
  background:var(--rule-v)}
.sig-part:first-child::before{display:none}
.sig-part-h{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.sig-part-l{font:600 10px/1.3 var(--display);color:var(--faint);text-transform:uppercase;
  letter-spacing:.17em}
.sig-part-n{font:600 19px/1 var(--display);font-variant-numeric:tabular-nums;
  letter-spacing:-.03em;color:#f2f8ff}
.sig-track{height:4px;border-radius:3px;background:rgba(148,190,255,.08);margin:12px 0 11px;
  overflow:hidden}
.sig-fill{height:100%;border-radius:3px;transition:width .8s var(--spring)}
.sig-fill.strong{background:linear-gradient(90deg,#5eead4,#22d3ee)}
.sig-fill.good{background:linear-gradient(90deg,#60a5fa,#818cf8)}
.sig-fill.fair{background:linear-gradient(90deg,#fcd34d,#f59e0b)}
.sig-fill.weak{background:linear-gradient(90deg,#fda4af,#fb7185)}
.sig-part-d{font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.sig-part-w{margin-top:5px;font-size:11px;color:var(--faint);font-variant-numeric:tabular-nums}

@media (max-width:820px){
  .sig-grid{grid-template-columns:1fr;gap:22px}
  .sig-part{padding:0 16px}
  .sig-part:nth-child(odd){padding-left:0}
  .sig-part:nth-child(odd)::before{display:none}
}
@media (prefers-reduced-motion:reduce){
  .sig-fill{transition:none}
}

/* Tables run to the full width of the band and align on its left edge. */
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{position:relative;text-align:left;font:600 9.5px/1 var(--display);text-transform:uppercase;
  letter-spacing:.18em;color:var(--faint);padding:0 18px 14px;white-space:nowrap}
th::after{content:'';position:absolute;left:0;right:0;bottom:0;height:1px;
  background:rgba(148,190,255,.16)}
/* Row rules stay flat. They are already inside a band the page has delimited,
   and a fade on every one of two hundred rows reads as a printing fault. */
td{position:relative;padding:15px 18px;vertical-align:middle;color:#d5e4fb}
td::after{content:'';position:absolute;left:0;right:0;bottom:0;height:1px;
  background:rgba(148,190,255,.08)}
tr:last-child td::after{display:none}
th:first-child,td:first-child{padding-left:0}
th:last-child,td:last-child{padding-right:0}
tbody tr{transition:background-color .35s var(--glide)}
tbody tr:hover{background:linear-gradient(90deg,rgba(34,211,238,.07),rgba(168,85,247,.03) 60%,transparent)}
tbody tr.sel{background:linear-gradient(90deg,rgba(34,211,238,.14),transparent 70%)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
td.tick,th.tick{width:32px;padding-right:0}
td b,td strong{color:#fff;font-weight:600}
td a{color:#dbe9ff}
td a:hover{color:#7dd3fc}
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
tr.rowlink td>a{display:block;padding:15px 18px;color:inherit;text-decoration:none}
tr.rowlink td:first-child>a{padding-left:0}
tr.rowlink td:last-child>a{padding-right:0}
tr.rowlink td>a.rl{color:#fff;font-weight:500}
tr.rowlink:hover td>a.rl{color:#7dd3fc}
tr.rowlink td>a.rl:focus-visible{outline:2px solid var(--beam,#38bdf8);outline-offset:-2px}

.meter{height:5px;border-radius:99px;overflow:hidden;margin-top:8px;
  background:rgba(148,190,255,.1)}
.meter>i{display:block;height:100%;border-radius:99px;background:var(--beam);
  box-shadow:0 0 12px rgba(56,189,248,.5)}

.chart{width:100%;min-height:60px;position:relative}
.chart-wait{position:absolute;inset:0;border-radius:10px;overflow:hidden;
  background:linear-gradient(100deg,rgba(148,190,255,.03),rgba(148,190,255,.08),rgba(148,190,255,.03));
  background-size:200% 100%;animation:shimmer 1.6s var(--glide) infinite}
@keyframes shimmer{from{background-position:120% 0}to{background-position:-120% 0}}
.chart.is-live{animation:surface-in .8s var(--spring) both}
.ct-row{display:flex;align-items:center;gap:9px;padding:9px 14px 11px;
  font:600 13px/1 var(--display);color:var(--ink)}
.ct-dot{width:8px;height:8px;border-radius:3px;flex:0 0 auto}
.ct-val{font-variant-numeric:tabular-nums}
.apexcharts-canvas{margin:0 auto}
.apexcharts-tooltip{background:rgba(8,20,47,.94)!important;border:0!important;
  border-radius:12px!important;box-shadow:0 24px 50px -22px rgba(0,0,0,.9)!important;
  color:var(--ink)!important;-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);
  font-family:var(--sans)!important}
.apexcharts-tooltip-title{background:rgba(148,190,255,.08)!important;border:0!important;
  font:600 11px/1 var(--display)!important;letter-spacing:.12em!important;text-transform:uppercase;
  color:var(--faint)!important;padding:10px 14px!important}
.apexcharts-tooltip-series-group{padding:6px 14px 10px!important}
.apexcharts-xaxistooltip,.apexcharts-yaxistooltip{display:none!important}
.apexcharts-legend-text{color:var(--muted)!important;font-family:var(--sans)!important}
}

/* ─────────────────────────────────────────────────────── choreography */
@layer motion {
/* Nothing arrives statically. Deliberately not a view() scroll timeline: a
   band taller than the viewport never finishes its entry range, so a long
   table would sit there half-faded forever. A staggered entrance completes. */
@keyframes surface-in{from{opacity:0;transform:translate3d(0,22px,0);filter:blur(5px)}
  to{opacity:1;transform:none;filter:blur(0)}}
.head,.card,.tabs,.note,.flash,.reveal{animation:surface-in .9s var(--spring) both}
.head{animation-delay:.02s}
.card:nth-of-type(1){animation-delay:.08s}
.card:nth-of-type(2){animation-delay:.14s}
.card:nth-of-type(3){animation-delay:.2s}
.card:nth-of-type(4){animation-delay:.26s}
.card:nth-of-type(n+5){animation-delay:.3s}
.rail{animation:rail-in 1s var(--spring) both}
@keyframes rail-in{from{opacity:0;transform:translate3d(-20px,0,0)}to{opacity:1;transform:none}}
@media (max-width:1080px){.rail{animation:none}}

@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;
    transition-duration:.001ms!important}
  .rays,.rays-b,.caustic,.mote{display:none}
}
}

/* ────────────────────────────────────────────── public preference page */
@layer surface {
.prefs{max-width:640px;margin:0 auto;padding:min(13vh,120px) var(--gut) 100px;position:relative;z-index:2}
.prefs h1{font-size:clamp(27px,5.5vw,34px);margin-bottom:14px}
.prefs .lede{color:var(--muted);margin-bottom:14px;font-size:15.5px}
.prefs form{position:relative;padding:0;animation:surface-in .9s var(--spring) both;
  animation-delay:.1s}
.prefs form h3{padding-top:28px}
.pref-item{position:relative;display:flex;gap:16px;align-items:flex-start;padding:20px 0}
.pref-item::after{content:'';position:absolute;left:0;right:0;bottom:0;height:1px;
  background:rgba(148,190,255,.09)}
.pref-item .txt{flex:1}
.pref-item .nm{font-weight:600;font-size:15px;color:#fff}
.pref-item .ds{font-size:13px;color:var(--muted);margin-top:4px}
.pref-item.focus{padding-left:20px;
  background:linear-gradient(90deg,rgba(34,211,238,.1),transparent 70%)}
.pref-item.focus::before{content:'';position:absolute;left:0;top:0;bottom:1px;width:2px;
  border-radius:2px;background:linear-gradient(180deg,#22d3ee,rgba(168,85,247,.35))}
.tag-focus{display:inline-block;font:600 9.5px/1 var(--display);text-transform:uppercase;
  letter-spacing:.2em;color:#a5f3fc;margin-bottom:9px}
.nuke{margin-top:0;padding-top:26px}
}

/* ───────────────────────────────────────────────────────── the composer

   Writing mail is the one job in here that deserves the whole screen. The rail
   goes away, the page stops scrolling, and the frame becomes three fixed bands:
   a slim bar naming what you're writing, the work, and a foot holding the count
   and the save. The editor between them fills whatever is left and scrolls
   inside itself, so the paper always reaches the bottom of the display no
   matter how short the draft is.

   Same hairlines as everywhere else. No panels, no boxes — the sidebar is
   separated from the paper by one vertical rule and nothing more. */
@layer compose {
/* Still water while you write.
   The ocean's rays, caustics and grain are blend-mode layers animating over the
   whole viewport, forever. On every other screen that is the point; here the
   paper covers almost all of it, so the compositor would be blending frames
   nobody can see while the one thing that must stay responsive is the cursor.
   The gradient stays, the motion stops. */
body:has(.compose-stage) .rays,
body:has(.compose-stage) .rays-b,
body:has(.compose-stage) .mote{animation:none}
body:has(.compose-stage) .caustic,
body:has(.compose-stage) .grain{display:none}

/* The stage keeps its rail offset; only its height changes — the composer owns
   exactly the screen, and nothing outside it scrolls. The clamp on <body> is
   what stops the editor's own floating furniture, which lives at the end of the
   document until it is positioned, from giving the page a stray 38px of
   scroll. */
html:has(.compose-stage){overflow:hidden}
.compose-stage{height:100dvh;overflow:hidden}
.compose{position:relative;z-index:2;display:flex;flex-direction:column;height:100%;overflow:hidden}
/* The rail is the way out on a wide screen, so the drawer handle has no job. */
.compose-top .burger{display:none}
.compose-top{flex:0 0 auto;position:relative;display:flex;align-items:center;gap:16px;
  padding:12px clamp(16px,2.2vw,28px)}
.compose-top::after{content:'';position:absolute;left:0;right:0;bottom:0;height:1px;background:var(--rule)}
.cx{width:34px;height:34px;flex:0 0 auto;display:grid;place-items:center;border-radius:50%;
  color:var(--muted);
  transition:background-color .4s var(--glide),color .4s var(--glide),transform .5s var(--spring)}
.cx:hover{background:rgba(255,255,255,.08);color:#fff;transform:translateX(-2px)}
.cx svg{width:18px;height:18px}
.compose-id{min-width:0}
.compose-id .t{font:600 15.5px/1.2 var(--display);letter-spacing:-.022em;color:#eef5ff;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.compose-id .s{margin-top:5px;font-size:12.5px;color:var(--faint);
  display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.compose-acts{margin-left:auto;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.compose-acts form{display:contents}

.compose-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 340px}
@media (max-width:1320px){.compose-body{grid-template-columns:minmax(0,1fr) 296px}}
@media (max-width:1080px){
  /* Rail turned into a drawer — the composer's own bar carries the handle. */
  .compose-top .burger{display:grid}
}
.compose-main{position:relative;min-width:0;display:flex;flex-direction:column;overflow-y:auto;
  overflow-x:hidden}
/* The subject sets like a headline, because that is what it is. */
.compose-subject{flex:0 0 auto;padding:26px clamp(22px,5vw,74px) 20px}
.compose .subj{width:100%;padding:0;border:0;border-radius:0;background:none;box-shadow:none;
  font:600 clamp(20px,2.2vw,27px)/1.25 var(--display);letter-spacing:-.032em;color:#f2f8ff}
.compose .subj:hover,.compose .subj:focus{box-shadow:none;outline:0;background:none}
.compose .subj::placeholder{color:rgba(109,132,168,.55)}

.compose-side{position:relative;overflow-y:auto;padding:28px 28px 70px}
.compose-side::before{content:'';position:absolute;left:0;top:0;bottom:0;width:1px;
  background:var(--rule-v)}
.compose-side .field,.compose-side .row{max-width:none}
.compose-side .field{margin-bottom:0}
.side-sec{position:relative;padding:24px 0 0;margin-top:24px}
.side-sec::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:var(--rule-faint)}
.side-sec:first-child{margin-top:0;padding-top:0}
.side-sec:first-child::before{display:none}
.side-sec>h3{margin-bottom:15px}
.side-sec>*+.field{margin-top:20px}
/* A caption the screen reader needs and the design does not. */
.hide-vis{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;
  clip-path:inset(50%);white-space:nowrap}

.compose-foot{flex:0 0 auto;position:relative;display:flex;align-items:center;gap:16px;
  padding:11px clamp(16px,2.2vw,28px)}
.compose-foot::before{content:'';position:absolute;left:0;right:0;top:0;height:1px;background:var(--rule)}
/* A refusal in the save bar. Same violet the warning flash uses elsewhere. */
.foot-warn{font-size:13px;color:#e0bbff}
/* Autosave's running state. Quiet by design — it is reassurance, not news. */
.save-state{font-size:12.5px;color:var(--faint);font-variant-numeric:tabular-nums}
.save-state.bad{color:#ffb3bf}

@media (max-width:980px){
  /* Nothing to fill on a phone — hand the page back its scroll and keep only
     the save bar riding along the bottom edge. */
  html:has(.compose-stage){overflow:visible}
  .compose-stage{height:auto;overflow:visible}
  .compose{height:auto;min-height:100dvh;overflow:visible}
  /* The title bar scrolls away here and the editor's own toolbar takes the top
     edge — two stacked sticky bars on a phone leaves nothing to write in. */
  .compose-body{display:block}
  .compose-main{overflow:visible}
  .compose-subject{padding:20px 20px 16px}
  .compose-side{overflow:visible;padding:26px 20px 40px}
  .compose-side::before{left:0;right:0;top:0;bottom:auto;width:auto;height:1px;background:var(--rule)}
  .compose-foot{position:sticky;bottom:0;z-index:20;
    background:linear-gradient(0deg,rgba(5,12,34,.95),rgba(5,12,34,.72));
    -webkit-backdrop-filter:blur(22px) saturate(150%);backdrop-filter:blur(22px) saturate(150%)}
}
}

/* ── Analytics ──────────────────────────────────────────────────────────────
   Measurement surfaces. Everything here is CSS-only: these screens are read,
   scanned, and left, and a reader must never wait for a chart runtime to boot
   before the number they came for exists on the page. The heavy plots (mix over
   time, cadence) still go through ApexCharts — but nothing load-bearing does. */
@layer analytics {
/* The ring. A conic gradient with a hole punched in it, so one number can carry
   its own magnitude without a chart, a canvas, or a millisecond of JavaScript. */
.dial{position:relative;flex:0 0 auto;display:grid;place-items:center;border-radius:50%;
  width:var(--d,132px);height:var(--d,132px);
  background:conic-gradient(var(--arc) calc(var(--p,0) * 1%),rgba(148,190,255,.09) 0);
  -webkit-mask:radial-gradient(circle,transparent calc(var(--d,132px) / 2 - 11px),#000 calc(var(--d,132px) / 2 - 10px));
  mask:radial-gradient(circle,transparent calc(var(--d,132px) / 2 - 11px),#000 calc(var(--d,132px) / 2 - 10px))}
.dial-w{position:relative;display:grid;place-items:center;flex:0 0 auto}
.dial-n{position:absolute;inset:0;display:grid;place-items:center;
  font:600 clamp(29px,3vw,40px)/1 var(--display);font-variant-numeric:tabular-nums;
  letter-spacing:-.04em;color:#fff}
.dial-n small{display:block;text-align:center;font:600 9.5px/1.4 var(--display);
  letter-spacing:.19em;text-transform:uppercase;color:var(--faint);margin-top:7px}
.dial.strong{--arc:#22d3ee}.dial.good{--arc:#818cf8}
.dial.fair{--arc:#fbbf24}.dial.weak{--arc:#fb7185}.dial.none{--arc:rgba(148,190,255,.28)}

/* The band chip. Four states, never colour alone — the word is always there. */
.score{display:inline-flex;flex:0 0 auto;align-items:center;gap:7px;padding:3px 10px;border-radius:99px;
  font:600 11px/1 var(--display);letter-spacing:.04em;font-variant-numeric:tabular-nums;
  background:rgba(148,190,255,.09);color:var(--ink)}
.score i{width:7px;height:7px;border-radius:2px;flex:0 0 auto;background:rgba(148,190,255,.4)}
.score.strong{background:rgba(34,211,238,.14);color:#9beef8}.score.strong i{background:#22d3ee}
.score.good{background:rgba(129,140,248,.15);color:#c7cbff}.score.good i{background:#818cf8}
.score.fair{background:rgba(251,191,36,.13);color:#fcd98b}.score.fair i{background:#fbbf24}
.score.weak{background:rgba(251,113,133,.14);color:#ffb3bf}.score.weak i{background:#fb7185}

/* The step waterfall. One row per mail in a sequence: how many got it, and how
   much of that was opened and clicked. The bar is the population; the fills are
   what happened to it — so the decline down the page is the shape of the story. */
.wf{display:flex;flex-direction:column;gap:2px}
.wf-row{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:16px;align-items:center;
  padding:13px 0;position:relative}
.wf-row+.wf-row::before{content:'';position:absolute;left:0;right:0;top:0;height:1px;
  background:rgba(148,190,255,.08)}
.wf-i{font:600 11px/1 var(--display);color:var(--faint);font-variant-numeric:tabular-nums;
  letter-spacing:.1em}
.wf-b{min-width:0}
.wf-s{display:block;font-size:13.5px;color:#dbe9ff;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis}
.wf-track{position:relative;height:24px;border-radius:6px;margin-top:9px;overflow:hidden;
  background:rgba(148,190,255,.07)}
.wf-track>i{position:absolute;left:0;top:0;bottom:0;border-radius:6px;
  transition:width .9s var(--spring)}
.wf-sent{background:rgba(99,102,241,.28)}
.wf-open{background:rgba(56,189,248,.42)}
.wf-click{background:linear-gradient(90deg,#22d3ee,#38bdf8);box-shadow:0 0 16px rgba(34,211,238,.4)}
.wf-n{text-align:right;font-variant-numeric:tabular-nums;font-size:12.5px;color:var(--muted);
  white-space:nowrap}
.wf-n b{display:block;font:600 17px/1.1 var(--display);color:#fff}
.wf-drop{margin-top:7px;font-size:12px;color:#ffb3bf}
@media (max-width:720px){.wf-row{grid-template-columns:26px minmax(0,1fr);row-gap:6px}
  .wf-n{grid-column:2;text-align:left}.wf-n b{display:inline;font-size:14px;margin-right:6px}}

/* Part-to-whole as one rule rather than a donut: four channels, ordered, and
   the eye compares lengths far better than it compares wedges. */
.split{display:flex;height:14px;border-radius:99px;overflow:hidden;gap:2px;
  background:rgba(148,190,255,.07)}
.split>i{display:block;transition:width .9s var(--spring)}
/* A channel that earned nothing draws nothing. A 2px sliver for zero is a lie
   the eye believes before the legend can correct it. */
.split>i[hidden]{display:none}
.split>i:nth-child(1){background:#22d3ee}
.split>i:nth-child(2){background:#6366f1}
.split>i:nth-child(3){background:#a855f7}
.split>i:nth-child(4){background:rgba(148,190,255,.22)}
.lg{display:flex;flex-wrap:wrap;gap:8px 22px;margin-top:16px}
.lg-i{display:flex;align-items:baseline;gap:9px;font-size:13px;color:var(--muted)}
.lg-i i{width:9px;height:9px;border-radius:3px;flex:0 0 auto;transform:translateY(-1px)}
.lg-i b{color:#fff;font-weight:600;font-variant-numeric:tabular-nums}

/* A metric row on the health screen: name, number, bar, and the sentence that
   says what to do about it. The sentence is the point — a bar nobody can act on
   is decoration. */
.hm{display:grid;grid-template-columns:minmax(120px,1fr) minmax(0,2fr);gap:8px 28px;
  padding:18px 0;position:relative;align-items:baseline}
.hm+.hm::before{content:'';position:absolute;left:0;right:0;top:0;height:1px;
  background:rgba(148,190,255,.08)}
.hm-l{font:600 10px/1.3 var(--display);text-transform:uppercase;letter-spacing:.19em;
  color:var(--faint)}
.hm-v{font:600 clamp(22px,2vw,29px)/1 var(--display);font-variant-numeric:tabular-nums;
  letter-spacing:-.03em;color:#fff;margin-top:8px}
.hm-d{font-size:12.5px;color:var(--muted);margin-top:7px}
.hm-note{margin-top:9px;font-size:13px;color:#ffd9a0;line-height:1.55}
@media (max-width:720px){.hm{grid-template-columns:1fr}}

/* Sortable column headers. A link that looks like a header, because that is
   exactly what it is. */
th a{color:inherit}
th a:hover{color:#7dd3fc}
th a.on{color:#7dd3fc}

/* The dense comparison rail under a leaderboard row — two or three rates with
   their own hairline meters, sized to sit inside a table cell. */
.rt{display:flex;align-items:center;gap:9px;font-variant-numeric:tabular-nums}
.rt-b{flex:1 1 auto;min-width:34px;height:4px;border-radius:99px;overflow:hidden;
  background:rgba(148,190,255,.1)}
.rt-b>i{display:block;height:100%;border-radius:99px;background:var(--beam)}
.rt-b.warm>i{background:linear-gradient(90deg,#fbbf24,#fb7185)}

/* The analytics heroes put a dial (or two) beside the reading. An inline
   grid-template would beat the responsive rule underneath it, so it lives here
   as a class and collapses on a phone like everything else. */
.sig-grid.lead{grid-template-columns:auto minmax(0,1fr)}
.dials{display:flex;gap:clamp(20px,3vw,40px);align-items:center;flex-wrap:nowrap}
@media (max-width:980px){
  .sig-grid.lead{grid-template-columns:1fr}
  .dials{flex-wrap:wrap;gap:22px}
}

/* Wide tables scroll inside their own card rather than taking the page with
   them. Analytics carries the widest tables in the app — seven columns of
   numbers do not fit a phone, and shrinking them to fit makes them unreadable
   instead of unfitting. */
.tscroll{overflow-x:auto;overscroll-behavior-x:contain}
.tscroll>table{min-width:620px}

/* The one-line "what should I do about this" that closes every analytics card. */
.take{display:flex;gap:13px;align-items:flex-start;padding:16px 0 0;margin-top:18px;
  position:relative;font-size:14px;line-height:1.6;color:var(--ink)}
.take::before{content:'';position:absolute;left:0;right:0;top:0;height:1px;background:var(--rule)}
.take b{color:#fff}
.take>em{font-style:normal;color:var(--faint);font:600 10px/1.5 var(--display);
  letter-spacing:.19em;text-transform:uppercase;flex:0 0 auto;padding-top:3px}
}

`

/**
 * Ultra-light line icons, drawn at 24 and stroked at 1.3. Hand-rolled rather
 * than pulled from a set: an icon library is a dependency and a download, and
 * this is eleven glyphs.
 */
const ICONS: Record<string, string> = {
  home: 'M3.8 11.4 12 4.4l8.2 7M6.4 10v9.6h11.2V10M10.2 19.6v-5.2h3.6v5.2',
  subs: 'M9.2 11.4a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM3.6 19.4c.4-3.1 2.8-5 5.6-5s5.2 1.9 5.6 5M16.2 5.5a3.1 3.1 0 0 1 0 5.9M17.4 14.8c1.9.6 3.1 2.2 3.4 4.4',
  bc: 'M4 12.2 20.2 4.6l-4.4 15.2-3.9-5.9L4 12.2Zm7.9 1.7 4.9-8',
  seq: 'M5.4 6.6h6.2a3.1 3.1 0 0 1 0 6.2H9a3.1 3.1 0 0 0 0 6.2h6.6M14.6 16.6l2.6 2.4-2.6 2.4M14.6 4.2 17.2 6.6l-2.6 2.4',
  out: 'M4 13.6h4.2l1.3 2.5h5l1.3-2.5H20M6.5 4.8h11l2.5 8.8v5.6H4v-5.6l2.5-8.8Z',
  /* A sheet with a filled line and an arrow leaving it: fill this in, get that back. */
  forms: 'M6.2 3.8h11.6v16.4H6.2V3.8Zm2.8 4.2h6M9 11.2h3.2M14.8 12.6v5m0 0 2-2m-2 2-2-2',
  camp: 'M12 3.6a8.4 8.4 0 1 0 0 16.8 8.4 8.4 0 0 0 0-16.8Zm0 4.6a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Zm0 3.3a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1Z',
  store: 'M5.6 8.2h12.8l1 11.4H4.6l1-11.4Zm3.4 0V6.4a3 3 0 0 1 6 0v1.8',
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

const Icon: FC<{ k: string }> = ({ k }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.3"
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
  // ⭐ Analytics sits directly under the audience, before the mail: you read
  // what happened before you decide what to send next. Five slots rather than
  // one-with-tabs because each is a different question, and burying four of
  // them behind a tab strip is how a measurement tool goes unread.
  { grp: 'Analytics' },
  { href: '/analytics', key: 'an', label: 'Overview' },
  { href: '/analytics/sequences', key: 'anseq', label: 'Sequences' },
  { href: '/analytics/broadcasts', key: 'anbc', label: 'Broadcasts' },
  { href: '/analytics/contribution', key: 'ancon', label: 'Contribution' },
  { href: '/analytics/health', key: 'anhl', label: 'List health' },
  { grp: 'Mail' },
  { href: '/broadcasts', key: 'bc', label: 'Broadcasts' },
  { href: '/sequences', key: 'seq', label: 'Sequences' },
  { href: '/outbox', key: 'out', label: 'Outbox' },
  { grp: 'Money' },
  { href: '/campaigns', key: 'camp', label: 'Campaigns' },
  // ⭐ Its own slot rather than a tab under Campaigns: a form is where a lead
  // magnet is built and where the file lives, and it was unfindable one level in.
  { href: '/forms', key: 'forms', label: 'Forms' },
  // ⭐ Target first, then the events measured against it, then the catalogue
  // they were sold from: the funnel reads top to bottom in the rail too.
  { href: '/goals', key: 'goals', label: 'Goals' },
  { href: '/conversions', key: 'conv', label: 'Conversions' },
  { href: '/store/offers', key: 'offers', label: 'Offers' },
  { href: '/store/customers', key: 'cust', label: 'Customers' },
  { href: '/store/ideas', key: 'ideas', label: 'Segment ideas' },
  { grp: 'System' },
  { href: '/consent', key: 'cons', label: 'Consent' },
  { href: '/settings', key: 'set', label: 'Settings' },
  { href: '/help', key: 'help', label: 'Help' },
]

const FONTS =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap'

/** The ocean itself: one fixed layer, no pointer events, nothing to click. */
const Ocean: FC = () => (
  <>
    <div class="ocean" aria-hidden="true">
      <div class="rays" />
      <div class="rays-b" />
      <div class="caustic" />
      <div class="mote" />
      <div class="mote" />
      <div class="mote" />
      <div class="mote" />
      <div class="mote" />
      <div class="mote" />
    </div>
    <div class="grain" aria-hidden="true" />
  </>
)

const Brand: FC = () => (
  <a class="brand" href="/">
    <span class="sigil" aria-hidden="true">
      {/* The bird itself. Served from `public/`, so it needs no build step. */}
      <img src="/logo_200.png" alt="" width="26" height="25" />
    </span>
    <span class="wm">
      K<i>ō</i>lea
      <em>owned list</em>
    </span>
  </a>
)

/** The site menu. One copy, worn by both the ordinary pages and the composer. */
const Rail: FC<{ nav?: string }> = ({ nav }) => (
  <aside class="rail">
    <div class="rail-in">
      <Brand />
      <nav>
        {NAV.map((it) =>
          'grp' in it ? (
            <div class="grp">{it.grp}</div>
          ) : (
            <a href={it.href} class={nav === it.key ? 'on' : ''}>
              <Icon k={it.key} />
              {it.label}
            </a>
          ),
        )}
      </nav>
      <div class="rail-foot">
        <span class="pulse" />
        self-hosted
      </div>
    </div>
  </aside>
)

/** Opens the rail where it's a drawer rather than a column. */
const Burger: FC = () => (
  <label class="burger" for="rail-open" title="Menu">
    <span>
      <i />
      <i />
    </span>
  </label>
)

export const Layout: FC<
  PropsWithChildren<{ title: string; nav?: string; editor?: boolean; charts?: boolean }>
> = ({ title, nav, editor, charts, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <meta name="color-scheme" content="dark" />
      <meta name="theme-color" content="#050c22" />
      <title>{title} · Kōlea</title>
      <link rel="icon" href="/favicon.ico" sizes="any" />
      <link rel="icon" href="/favicon.png" type="image/png" />
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
      <link rel="stylesheet" href={FONTS} />
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      {/* ~226KB gzipped, so it loads only on the two screens that compose mail. */}
      {editor ? <link rel="stylesheet" href="/editor.css" /> : null}
      {editor ? <script src="/editor.js" type="module" defer /> : null}
      {/* Same deal for the chart runtime: dashboard and store, nowhere else. */}
      {charts ? <script src="/charts.js" type="module" defer /> : null}
    </head>
    <body>
      <Ocean />
      {/* The rail's open state is a checkbox, so the menu works with JavaScript
          off and costs nothing to ship. It must precede .shell for the sibling
          selectors that drive the drawer and the hamburger morph. */}
      <input type="checkbox" id="rail-open" class="rail-cb" aria-label="Toggle navigation" />
      <div class="shell">
        <label class="scrim" for="rail-open" aria-hidden="true" />
        <Rail nav={nav} />
        <div class="stage">
          <div class="mobar">
            <Burger />
            <Brand />
          </div>
          <main class="wrap">{children}</main>
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
      <meta name="color-scheme" content="dark" />
      <title>{title}</title>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
      <link rel="stylesheet" href={FONTS} />
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </head>
    <body>
      <Ocean />
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
export const ComposeLayout: FC<
  PropsWithChildren<{
    title: string
    nav?: string
    action: string
    /** Endpoint the timed save posts to. Absent means no autosave on this page. */
    autosave?: string
    /** Endpoint the preview dialog posts to. */
    preview?: string
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
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <meta name="color-scheme" content="dark" />
      <meta name="theme-color" content="#050c22" />
      <title>{title} · Kōlea</title>
      <link rel="icon" href="/favicon.ico" sizes="any" />
      <link rel="icon" href="/favicon.png" type="image/png" />
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
      <link rel="stylesheet" href={FONTS} />
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <link rel="stylesheet" href="/editor.css" />
      <script src="/editor.js" type="module" defer />
    </head>
    <body>
      <Ocean />
      <input type="checkbox" id="rail-open" class="rail-cb" aria-label="Toggle navigation" />
      <div class="shell">
        <label class="scrim" for="rail-open" aria-hidden="true" />
        <Rail nav={nav} />
        <div class="stage compose-stage">
          <form
        method="post"
        action={action}
        class="compose"
        data-autosave={autosave}
        data-preview={preview}
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
              <aside class="compose-side">{side}</aside>
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
