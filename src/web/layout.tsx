import type { FC, PropsWithChildren } from 'hono/jsx'
import { mdToDoc } from '../core/md-to-doc.ts'
import type { Campaign, DocNode } from '../db/schema.ts'

/**
 * The look: "Abyssal".
 *
 * A dashboard you sit in front of for hours should feel like somewhere, not like
 * a form. This one is a dive — deep water at the bottom of the page, sunlight
 * raking down from above, and the working surfaces floating in it like coral:
 * lit from within, edged in a bright hairline, never flat on the background.
 *
 * Rules that keep it fast on a Worker with no framework:
 *   · One stylesheet, inlined. No CSS build, no utility runtime.
 *   · Animation is `transform` and `opacity` only — never width/height/top/left.
 *   · `backdrop-filter` lives on fixed furniture (the rail, the mobile bar) and
 *     never on scrolling content, where it would repaint every frame.
 *   · The ocean is one fixed, `pointer-events:none` layer behind everything.
 *   · Entrances are a staggered CSS keyframe on load. Zero JavaScript.
 */
export const CSS = `
@layer base, ocean, shell, surface, controls, data, motion;

@layer base {
:root{
  /* depth */
  --abyss:#03060f; --deep:#050c22; --mid:#08142f; --shelf:#0b1c3d;
  /* light */
  --cyan:#22d3ee; --azure:#3b82f6; --indigo:#6366f1; --violet:#a855f7;
  --aqua:#2dd4bf; --rose:#fb7185;
  --beam:linear-gradient(120deg,#22d3ee 0%,#60a5fa 38%,#a855f7 100%);
  --beam-soft:linear-gradient(120deg,rgba(34,211,238,.22),rgba(168,85,247,.20));
  /* ink */
  --ink:#eaf3ff; --muted:#9db2d4; --faint:#6d84a8;
  --line:rgba(148,190,255,.13); --line-2:rgba(148,190,255,.075);
  --glass:rgba(255,255,255,.045);
  --accent:#5eead4;
  --radius:20px;
  --sans:'Plus Jakarta Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;
  --display:'Sora',var(--sans);
  --serif:'Instrument Serif',ui-serif,Georgia,serif;
  --mono:'JetBrains Mono',ui-monospace,SFMono-Regular,'SF Mono',Menlo,monospace;
  /* the only easing curves in the building */
  --spring:cubic-bezier(.32,.72,0,1);
  --glide:cubic-bezier(.22,1,.36,1);
  --rail-w:266px;
}
*{box-sizing:border-box}
html{scrollbar-color:rgba(148,190,255,.22) transparent}
body{margin:0;background:var(--abyss);color:var(--ink);
  font:15px/1.6 var(--sans);letter-spacing:-.005em;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
::selection{background:rgba(34,211,238,.28);color:#fff}
a{color:#7dd3fc;text-decoration:none;transition:color .35s var(--glide)}
a:hover{color:#a5f3fc}
h1,h2,h3{margin:0;font-weight:600;letter-spacing:-.02em}
h1{font:400 clamp(30px,3.6vw,42px)/1.06 var(--serif);letter-spacing:-.015em;
  background:linear-gradient(178deg,#ffffff 8%,#a8c6ee 92%);
  -webkit-background-clip:text;background-clip:text;color:transparent}
h2{font:600 15.5px/1.3 var(--display);letter-spacing:-.01em;color:#dce9ff}
h3{font:600 10.5px/1 var(--display);text-transform:uppercase;letter-spacing:.19em;color:var(--faint)}
p{margin:0 0 12px}
hr{border:0;height:1px;background:var(--line-2);margin:22px 0}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:rgba(148,190,255,.18);border-radius:99px;
  border:3px solid transparent;background-clip:content-box}
::-webkit-scrollbar-thumb:hover{background:rgba(148,190,255,.32);background-clip:content-box}
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

.rail{position:fixed;top:16px;bottom:16px;left:16px;width:var(--rail-w);z-index:40;
  padding:6px;border-radius:30px;
  background:linear-gradient(158deg,rgba(255,255,255,.18),rgba(255,255,255,.03) 45%,rgba(125,211,252,.13));
  box-shadow:0 40px 80px -40px rgba(0,0,0,.95),0 0 0 1px rgba(255,255,255,.04);
  transition:transform .6s var(--spring)}
.rail-in{height:100%;border-radius:24px;display:flex;flex-direction:column;
  padding:22px 14px 14px;overflow:hidden;
  background:linear-gradient(168deg,rgba(11,28,61,.92),rgba(5,12,34,.96) 60%,rgba(8,20,47,.94));
  -webkit-backdrop-filter:blur(28px) saturate(150%);backdrop-filter:blur(28px) saturate(150%);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.10),inset 0 -70px 90px -60px rgba(34,211,238,.30)}

.brand{display:flex;align-items:center;gap:11px;padding:0 8px 20px;color:var(--ink)}
.brand:hover{color:var(--ink)}
.brand .sigil{width:34px;height:34px;flex:0 0 auto;border-radius:12px;display:grid;place-items:center;
  background:var(--beam);box-shadow:0 6px 20px -6px rgba(34,211,238,.85),inset 0 1px 0 rgba(255,255,255,.5);
  transition:transform .6s var(--spring)}
.brand:hover .sigil{transform:rotate(-8deg) scale(1.06)}
.brand .wm{font:400 20px/1 var(--serif);letter-spacing:.005em}
.brand .wm i{font-style:normal;background:var(--beam);-webkit-background-clip:text;
  background-clip:text;color:transparent}
.brand .wm em{display:block;font:500 8.5px/1 var(--display);font-style:normal;
  text-transform:uppercase;letter-spacing:.28em;color:var(--faint);margin-top:5px}

.rail nav{display:flex;flex-direction:column;gap:2px;overflow-y:auto;flex:1;
  margin:0 -4px;padding:0 4px;scrollbar-width:thin}
.rail .grp{padding:16px 12px 7px;font:600 9.5px/1 var(--display);text-transform:uppercase;
  letter-spacing:.22em;color:rgba(109,132,168,.85)}
.rail .grp:first-child{padding-top:2px}
.rail nav a{position:relative;display:flex;align-items:center;gap:11px;padding:9px 12px;
  border-radius:13px;color:rgba(196,216,244,.72);font:500 14px/1 var(--sans);
  transition:color .4s var(--glide),background-color .4s var(--glide),transform .5s var(--spring)}
.rail nav a svg{width:17px;height:17px;flex:0 0 auto;opacity:.62;
  transition:opacity .4s var(--glide),transform .5s var(--spring)}
.rail nav a:hover{background:rgba(255,255,255,.055);color:#fff;transform:translateX(3px)}
.rail nav a:hover svg{opacity:1;transform:scale(1.08)}
.rail nav a.on{color:#fff;background:var(--beam-soft);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.16),0 10px 26px -18px rgba(34,211,238,.9)}
.rail nav a.on svg{opacity:1;color:#7dd3fc}
.rail nav a.on::before{content:'';position:absolute;left:-5px;top:50%;width:3px;height:17px;
  border-radius:9px;background:var(--beam);transform:translateY(-50%);
  box-shadow:0 0 14px 1px rgba(34,211,238,.9)}
.rail nav a .badge{margin-left:auto;font:600 10px/1 var(--display);letter-spacing:.04em;
  padding:4px 7px;border-radius:99px;background:rgba(255,255,255,.07);color:var(--muted)}

.rail-foot{margin-top:14px;padding:13px 12px 4px;border-top:1px solid var(--line-2);
  font:500 10.5px/1.5 var(--display);letter-spacing:.1em;text-transform:uppercase;color:var(--faint);
  display:flex;align-items:center;gap:8px}
.pulse{width:6px;height:6px;border-radius:50%;background:var(--aqua);flex:0 0 auto;
  box-shadow:0 0 0 0 rgba(45,212,191,.65);animation:pulse 3.4s var(--glide) infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(45,212,191,.6)}
  70%{box-shadow:0 0 0 8px rgba(45,212,191,0)}100%{box-shadow:0 0 0 0 rgba(45,212,191,0)}}

.stage{margin-left:calc(var(--rail-w) + 30px);min-height:100dvh}
.wrap{max-width:1240px;margin:0 auto;padding:44px 40px 120px}

/* Mobile furniture — hidden entirely on the desktop layout. */
.mobar{display:none}
.scrim{display:none}

@media (max-width:1080px){
  .rail{transform:translateX(calc(-100% - 20px));width:min(300px,84vw)}
  .rail-cb:checked ~ .shell .rail{transform:none}
  .stage{margin-left:0}
  .wrap{padding:18px 16px 96px;max-width:none}
  .mobar{display:flex;position:sticky;top:0;z-index:30;align-items:center;gap:12px;
    padding:10px 14px;margin:0 0 6px;
    background:linear-gradient(180deg,rgba(5,12,34,.88),rgba(5,12,34,.55));
    -webkit-backdrop-filter:blur(22px) saturate(150%);backdrop-filter:blur(22px) saturate(150%);
    border-bottom:1px solid var(--line-2)}
  .burger{width:40px;height:40px;border-radius:14px;display:grid;place-items:center;cursor:pointer;
    background:rgba(255,255,255,.06);box-shadow:inset 0 1px 0 rgba(255,255,255,.12)}
  .burger span{position:relative;display:block;width:17px;height:2px}
  .burger i{position:absolute;left:0;top:0;display:block;width:17px;height:2px;border-radius:2px;
    background:var(--ink);transition:transform .5s var(--spring)}
  .burger i:first-child{transform:translateY(-4px)}
  .burger i:last-child{transform:translateY(4px)}
  .rail-cb:checked ~ .shell .burger i:first-child{transform:translateY(0) rotate(45deg)}
  .rail-cb:checked ~ .shell .burger i:last-child{transform:translateY(0) rotate(-45deg)}
  .scrim{display:block;position:fixed;inset:0;z-index:35;opacity:0;pointer-events:none;
    background:rgba(3,6,15,.68);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);
    transition:opacity .5s var(--glide)}
  .rail-cb:checked ~ .shell .scrim{opacity:1;pointer-events:auto}
}
@media (max-width:1080px){.hide-sm{display:none}}
}

/* ─────────────────────────────────────────────────────── the surfaces */
@layer surface {
.head{display:flex;align-items:flex-end;gap:20px;margin:0 0 30px;flex-wrap:wrap}
.head .sub{color:var(--muted);font-size:14px;margin-top:9px;max-width:64ch}
.head .actions{margin-left:auto;display:flex;gap:9px;align-items:center;flex-wrap:wrap}
.eyebrow{display:inline-flex;align-items:center;gap:7px;margin-bottom:13px;
  padding:5px 11px 5px 8px;border-radius:99px;background:rgba(255,255,255,.05);
  border:1px solid var(--line);font:600 9.5px/1 var(--display);
  text-transform:uppercase;letter-spacing:.2em;color:#a5c4ea}
.eyebrow::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--beam);
  box-shadow:0 0 10px 1px rgba(34,211,238,.9)}

/* The double bezel: an outer tray of lit glass, an inner plate that sits in it.
   Built with a pseudo-element so the existing .card-h / .card-b markup is
   untouched — the plate is painted at inset 6px and the children float on it. */
.card{position:relative;margin-bottom:24px;padding:6px;border-radius:28px;
  background:linear-gradient(158deg,rgba(255,255,255,.15),rgba(255,255,255,.025) 42%,rgba(125,211,252,.10));
  box-shadow:0 34px 70px -38px rgba(0,0,0,.92),0 1px 2px rgba(0,0,0,.35);
  transition:box-shadow .7s var(--glide),transform .7s var(--spring)}
.card::before{content:'';position:absolute;inset:6px;border-radius:22px;z-index:0;
  background:linear-gradient(168deg,rgba(13,30,63,.86),rgba(6,14,36,.92) 58%,rgba(10,23,52,.88));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.10),inset 0 0 0 1px rgba(148,190,255,.055),
    inset 0 -80px 110px -70px rgba(34,211,238,.26)}
.card>*{position:relative;z-index:1}
.card:hover{box-shadow:0 40px 84px -38px rgba(0,0,0,.95),0 0 44px -22px rgba(56,189,248,.30)}
.card-h{padding:17px 22px 15px;display:flex;align-items:center;gap:14px;
  border-bottom:1px solid var(--line-2)}
.card-h .actions{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.card-b{padding:22px}
.card-b.flush{padding:0;border-radius:0 0 22px 22px;overflow:hidden}

/* Asymmetric grid. Twelve columns on the desktop layout, one everywhere else —
   a half-width card on a phone is not a layout, it is a squint. */
.bento{display:grid;grid-template-columns:repeat(12,1fr);gap:24px;margin-bottom:24px;align-items:stretch}
.bento>.card{margin-bottom:0;height:100%;display:flex;flex-direction:column}
.bento>.card>.card-b{flex:1}
.col-4{grid-column:span 4}.col-5{grid-column:span 5}.col-6{grid-column:span 6}
.col-7{grid-column:span 7}.col-8{grid-column:span 8}.col-12{grid-column:span 12}
@media (max-width:1180px){.bento{grid-template-columns:1fr;gap:20px}
  .bento>*{grid-column:auto!important}}

/* Feature card: same tray, brighter water inside. For the one thing that matters. */
.card.feature::before{background:
  radial-gradient(120% 130% at 8% 0%,rgba(34,211,238,.20),transparent 58%),
  radial-gradient(110% 120% at 100% 100%,rgba(168,85,247,.20),transparent 60%),
  linear-gradient(168deg,rgba(15,34,72,.90),rgba(7,16,40,.94))}

.tabs{display:inline-flex;gap:3px;margin:-8px 0 26px;padding:4px;border-radius:99px;flex-wrap:wrap;
  background:rgba(255,255,255,.04);border:1px solid var(--line)}
.tabs a{padding:7px 15px;border-radius:99px;font:500 13.5px/1 var(--sans);color:var(--muted);
  transition:color .4s var(--glide),background-color .4s var(--glide)}
.tabs a:hover{color:var(--ink);background:rgba(255,255,255,.05)}
.tabs a.on{color:#04121f;background:var(--beam);font-weight:600;
  box-shadow:0 8px 22px -12px rgba(34,211,238,.95),inset 0 1px 0 rgba(255,255,255,.45)}

.note{position:relative;border-radius:18px;padding:15px 18px 15px 20px;font-size:13.5px;
  color:#cfe2ff;margin-bottom:20px;overflow:hidden;
  background:linear-gradient(120deg,rgba(34,211,238,.10),rgba(99,102,241,.09));
  box-shadow:inset 0 0 0 1px rgba(148,190,255,.14)}
.note::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--beam)}
.note strong{color:#fff;font-weight:600}
.note a{border-bottom:1px solid rgba(125,211,252,.35)}

.flash{border-radius:18px;padding:14px 18px;margin-bottom:22px;font-size:14px;color:#d7fff6;
  background:linear-gradient(120deg,rgba(45,212,191,.16),rgba(34,211,238,.10));
  box-shadow:inset 0 0 0 1px rgba(94,234,212,.26),0 18px 40px -30px rgba(45,212,191,.8)}
.flash.warn{color:#f0dcff;background:linear-gradient(120deg,rgba(168,85,247,.18),rgba(99,102,241,.12));
  box-shadow:inset 0 0 0 1px rgba(196,132,252,.30)}

.empty{padding:56px 22px;text-align:center;color:var(--faint)}
.empty p{margin:0 0 6px}
.empty p:first-child{color:var(--muted);font-size:15px}

pre.code,.card pre{background:rgba(2,8,23,.55);padding:16px 18px;border-radius:16px;overflow:auto;
  font:13px/1.6 var(--mono);color:#bfe3ff;box-shadow:inset 0 0 0 1px rgba(148,190,255,.11)}

.mailview{border-radius:20px;overflow:hidden;background:rgba(2,8,23,.5);
  box-shadow:inset 0 0 0 1px rgba(148,190,255,.13)}
.mailview iframe{width:100%;height:560px;border:0;display:block;background:#f6f5f3}
.mailhead{padding:14px 18px;border-bottom:1px solid var(--line-2);font-size:13px;color:var(--muted)}
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
  background:rgba(255,255,255,.06);color:var(--ink);
  box-shadow:inset 0 0 0 1px rgba(148,190,255,.18),inset 0 1px 0 rgba(255,255,255,.10);
  transition:transform .45s var(--spring),background-color .45s var(--glide),box-shadow .45s var(--glide),color .45s var(--glide)}
.btn:hover{background:rgba(255,255,255,.11);color:#fff;transform:translateY(-1px)}
.btn:active{transform:scale(.975)}
.btn:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
.btn.primary{background:var(--beam);color:#03121f;
  box-shadow:0 12px 30px -14px rgba(56,189,248,.95),inset 0 1px 0 rgba(255,255,255,.45)}
.btn.primary:hover{color:#03121f;transform:translateY(-1px);
  box-shadow:0 18px 40px -14px rgba(56,189,248,1),inset 0 1px 0 rgba(255,255,255,.55)}
.btn.accent{background:linear-gradient(120deg,#2dd4bf,#22d3ee);color:#032420;
  box-shadow:0 12px 30px -14px rgba(45,212,191,.9),inset 0 1px 0 rgba(255,255,255,.4)}
.btn.danger{color:#ffc4cd;box-shadow:inset 0 0 0 1px rgba(251,113,133,.34)}
.btn.danger:hover{background:rgba(251,113,133,.16);color:#ffdde2}
.btn.sm{padding:6px 12px;font-size:12px}
.btn .chip{display:grid;place-items:center;width:22px;height:22px;margin:-4px -8px -4px 2px;
  border-radius:99px;background:rgba(0,0,0,.16);
  transition:transform .5s var(--spring),background-color .4s var(--glide)}
.btn:hover .chip{transform:translate(2px,-1px) scale(1.08);background:rgba(0,0,0,.24)}
.btn:not(.primary):not(.accent) .chip{background:rgba(255,255,255,.10)}

.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:99px;
  font:600 11.5px/1.35 var(--display);letter-spacing:.01em;
  background:rgba(255,255,255,.06);color:var(--muted);
  box-shadow:inset 0 0 0 1px rgba(148,190,255,.14)}
.pill.ok{background:rgba(45,212,191,.14);color:#7fecd8;box-shadow:inset 0 0 0 1px rgba(45,212,191,.3)}
.pill.warn{background:rgba(168,85,247,.16);color:#e0bbff;box-shadow:inset 0 0 0 1px rgba(168,85,247,.32)}
.pill.bad{background:rgba(251,113,133,.15);color:#ffb3bf;box-shadow:inset 0 0 0 1px rgba(251,113,133,.32)}

label{display:block;font:600 11px/1 var(--display);text-transform:uppercase;letter-spacing:.13em;
  margin-bottom:9px;color:var(--faint)}
input[type=text],input[type=email],input[type=number],input[type=password],
input[type=search],input[type=url],input[type=date],input[type=datetime-local],
textarea,select{
  width:100%;padding:11px 14px;border:0;border-radius:14px;color:var(--ink);
  background:rgba(2,8,23,.45);font:14px var(--sans);
  box-shadow:inset 0 0 0 1px rgba(148,190,255,.15);
  transition:box-shadow .4s var(--glide),background-color .4s var(--glide)}
input::placeholder,textarea::placeholder{color:rgba(109,132,168,.7)}
textarea{font:13px/1.65 var(--mono);resize:vertical;min-height:200px}
select{appearance:none;cursor:pointer;padding-right:38px;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%239db2d4' stroke-width='1.4' stroke-linecap='round'%3E%3Cpath d='M6 9.5l6 5.5 6-5.5'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 12px center;background-size:16px}
select[multiple]{appearance:none;background-image:none;padding:8px;font-size:13px}
option{background:#0a1730;color:var(--ink)}
input:hover,textarea:hover,select:hover{background:rgba(2,8,23,.6)}
input:focus,textarea:focus,select:focus{outline:0;background:rgba(2,8,23,.7);
  box-shadow:inset 0 0 0 1px rgba(34,211,238,.65),0 0 0 4px rgba(34,211,238,.13)}
input[type=checkbox],input[type=radio]{appearance:none;-webkit-appearance:none;
  width:17px;height:17px;flex:0 0 auto;margin:0;cursor:pointer;border-radius:6px;
  background:rgba(2,8,23,.5);box-shadow:inset 0 0 0 1px rgba(148,190,255,.28);
  transition:background-color .3s var(--glide),box-shadow .3s var(--glide),transform .35s var(--spring)}
input[type=radio]{border-radius:50%}
input[type=checkbox]:hover,input[type=radio]:hover{box-shadow:inset 0 0 0 1px rgba(34,211,238,.7)}
input[type=checkbox]:checked,input[type=radio]:checked{background:var(--beam);
  box-shadow:0 0 14px -4px rgba(34,211,238,.9),inset 0 1px 0 rgba(255,255,255,.4)}
input[type=checkbox]:checked::after{content:'';display:block;width:100%;height:100%;
  background:no-repeat center/11px url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23041423' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12.5l4.5 4.5L19 7'/%3E%3C/svg%3E")}
input[type=radio]:checked::after{content:'';display:block;width:100%;height:100%;
  background:radial-gradient(circle at 50% 50%,#041423 0 30%,transparent 32%)}
input[type=checkbox]:focus-visible,input[type=radio]:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
.field{margin-bottom:20px}
.row{display:flex;gap:16px;flex-wrap:wrap}
.row>*{flex:1;min-width:210px}
}

/* ──────────────────────────────────────────────────────────── the data */
@layer data {
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(134px,1fr));gap:10px;padding:6px}
/* Money is wide: "$1,254,107.10" is a lot of glyphs. These rows are always
   five KPIs, so they get five explicit tracks that may be narrower than their
   contents' natural width — auto-fit would measure the widest figure and drop
   to four, orphaning the fifth on a row of its own. */
.stats.money{grid-template-columns:repeat(5,minmax(0,1fr));padding:0}
.stats.money .stat{padding:16px}
.stats.money .stat .n{font-size:clamp(19px,1.7vw,24px);letter-spacing:-.04em;white-space:nowrap}
@media (max-width:1180px){.stats.money{grid-template-columns:repeat(auto-fit,minmax(168px,1fr))}}
.card-b.flush .stats{padding:14px}
.stat{position:relative;padding:17px 18px 16px;border-radius:18px;overflow:hidden;
  background:linear-gradient(165deg,rgba(255,255,255,.055),rgba(255,255,255,.015));
  box-shadow:inset 0 0 0 1px rgba(148,190,255,.11),inset 0 1px 0 rgba(255,255,255,.07);
  transition:transform .6s var(--spring),box-shadow .6s var(--glide)}
.stat::after{content:'';position:absolute;left:18px;right:18px;top:0;height:1.5px;border-radius:0 0 3px 3px;
  background:var(--beam);opacity:.35;transition:opacity .6s var(--glide)}
.stat:hover{transform:translateY(-3px);
  box-shadow:inset 0 0 0 1px rgba(148,190,255,.22),0 22px 40px -26px rgba(34,211,238,.7)}
.stat:hover::after{opacity:1}
.stat .n{font:600 30px/1 var(--display);font-variant-numeric:tabular-nums;letter-spacing:-.035em;
  color:#f2f8ff;text-shadow:0 0 26px rgba(125,211,252,.28)}
.stat .l{font:600 10px/1.3 var(--display);color:var(--faint);margin-top:9px;
  text-transform:uppercase;letter-spacing:.17em}
.stat .h,.stat .hint{font-size:12px;color:var(--muted);margin-top:6px}
.stat.hi::after{opacity:1}
.stat.hi .n{background:linear-gradient(120deg,#5eead4,#22d3ee 55%,#818cf8);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  filter:drop-shadow(0 0 18px rgba(34,211,238,.45))}

table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font:600 9.5px/1 var(--display);text-transform:uppercase;letter-spacing:.18em;
  color:var(--faint);padding:14px 22px;border-bottom:1px solid var(--line-2);white-space:nowrap}
td{padding:14px 22px;border-bottom:1px solid var(--line-2);vertical-align:middle;color:#d5e4fb}
tr:last-child td{border-bottom:0}
tbody tr{transition:background-color .35s var(--glide)}
tbody tr:hover{background:linear-gradient(90deg,rgba(34,211,238,.075),rgba(168,85,247,.045) 70%,transparent)}
tbody tr.sel{background:linear-gradient(90deg,rgba(34,211,238,.14),rgba(168,85,247,.08) 70%,transparent);
  box-shadow:inset 2px 0 0 #22d3ee}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
td.tick,th.tick{width:38px;padding-right:0}
td b,td strong{color:#fff;font-weight:600}
td a{color:#dbe9ff}
td a:hover{color:#7dd3fc}
td a .faint{color:var(--faint)}

.meter{height:6px;border-radius:99px;overflow:hidden;margin-top:8px;
  background:rgba(148,190,255,.12)}
.meter>i{display:block;height:100%;border-radius:99px;background:var(--beam);
  box-shadow:0 0 12px rgba(56,189,248,.55)}

.chart{width:100%;min-height:60px;position:relative}
.chart-wait{position:absolute;inset:0;border-radius:16px;overflow:hidden;
  background:linear-gradient(100deg,rgba(148,190,255,.05),rgba(148,190,255,.10),rgba(148,190,255,.05));
  background-size:200% 100%;animation:shimmer 1.6s var(--glide) infinite}
@keyframes shimmer{from{background-position:120% 0}to{background-position:-120% 0}}
.chart.is-live{animation:surface-in .8s var(--spring) both}
.ct-row{display:flex;align-items:center;gap:9px;padding:9px 14px 11px;
  font:600 13px/1 var(--display);color:var(--ink)}
.ct-dot{width:8px;height:8px;border-radius:3px;flex:0 0 auto}
.ct-val{font-variant-numeric:tabular-nums}
.apexcharts-canvas{margin:0 auto}
.apexcharts-gridline{stroke-opacity:1}
.chart-legend{display:flex;flex-wrap:wrap;gap:8px 20px;margin-top:14px}
.chart-legend span{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;color:var(--muted)}
.apexcharts-tooltip{background:rgba(8,20,47,.94)!important;border:0!important;
  border-radius:14px!important;box-shadow:0 24px 50px -22px rgba(0,0,0,.9),
  inset 0 0 0 1px rgba(148,190,255,.22)!important;color:var(--ink)!important;
  -webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);font-family:var(--sans)!important}
.apexcharts-tooltip-title{background:rgba(148,190,255,.08)!important;border:0!important;
  font:600 11px/1 var(--display)!important;letter-spacing:.12em!important;text-transform:uppercase;
  color:var(--faint)!important;padding:10px 14px!important}
.apexcharts-tooltip-series-group{padding:6px 14px 10px!important}
.apexcharts-xaxistooltip,.apexcharts-yaxistooltip{display:none!important}
.apexcharts-legend-text{color:var(--muted)!important;font-family:var(--sans)!important}
}

/* ─────────────────────────────────────────────────────── choreography */
@layer motion {
/* Nothing arrives statically. Where the browser can drive it from scroll
   position it does; everywhere else it is a staggered entrance on load. */
@keyframes surface-in{from{opacity:0;transform:translate3d(0,26px,0) scale(.985);filter:blur(6px)}
  to{opacity:1;transform:none;filter:blur(0)}}
.head,.card,.tabs,.note,.flash,.reveal{animation:surface-in .9s var(--spring) both}
.head{animation-delay:.02s}
.card:nth-of-type(1){animation-delay:.08s}
.card:nth-of-type(2){animation-delay:.15s}
.card:nth-of-type(3){animation-delay:.22s}
.card:nth-of-type(4){animation-delay:.29s}
.card:nth-of-type(n+5){animation-delay:.34s}
/* Deliberately not a view() scroll timeline: a card taller than the viewport
   never finishes its entry range, so a long table would sit there half-faded
   and blurred forever. A staggered entrance always completes. */
.rail{animation:rail-in 1s var(--spring) both}
@keyframes rail-in{from{opacity:0;transform:translate3d(-24px,0,0)}to{opacity:1;transform:none}}
@media (max-width:1080px){.rail{animation:none}}

@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;
    transition-duration:.001ms!important}
  .rays,.rays-b,.caustic,.mote{display:none}
}
}

/* ────────────────────────────────────────────── public preference page */
@layer surface {
.prefs{max-width:600px;margin:0 auto;padding:min(12vh,110px) 20px 90px;position:relative;z-index:2}
.prefs h1{font-size:clamp(28px,6vw,38px);margin-bottom:12px}
.prefs .lede{color:var(--muted);margin-bottom:30px;font-size:15.5px}
/* The form is the card here — the whole page is one decision surface, so it
   gets the tray-and-plate treatment without a wrapper element to hang it on. */
.prefs form{position:relative;padding:6px 6px 8px;border-radius:28px;
  background:linear-gradient(158deg,rgba(255,255,255,.15),rgba(255,255,255,.025) 42%,rgba(125,211,252,.10));
  box-shadow:0 34px 70px -38px rgba(0,0,0,.92);
  animation:surface-in .9s var(--spring) both;animation-delay:.1s}
.prefs form::before{content:'';position:absolute;inset:6px;border-radius:22px;z-index:0;
  background:linear-gradient(168deg,rgba(13,30,63,.88),rgba(6,14,36,.93));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.10),inset 0 0 0 1px rgba(148,190,255,.055),
    inset 0 -80px 110px -70px rgba(34,211,238,.22)}
.prefs form>*{position:relative;z-index:1;margin-left:22px;margin-right:22px}
.prefs form h3:first-child{margin-top:20px}
.prefs h1,.prefs .lede,.prefs .flash{animation:surface-in .9s var(--spring) both}
.pref-item{display:flex;gap:15px;align-items:flex-start;padding:18px 0;
  border-bottom:1px solid var(--line-2)}
.pref-item:last-of-type{border-bottom:0}
.pref-item .txt{flex:1}
.pref-item .nm{font-weight:600;font-size:15px;color:#fff}
.pref-item .ds{font-size:13px;color:var(--muted);margin-top:4px}
.pref-item.focus{margin:0 -16px;padding:18px 16px;border-radius:16px;border-bottom:0;
  background:linear-gradient(120deg,rgba(34,211,238,.12),rgba(168,85,247,.10));
  box-shadow:inset 0 0 0 1px rgba(148,190,255,.2)}
.tag-focus{display:inline-block;font:600 9.5px/1 var(--display);text-transform:uppercase;
  letter-spacing:.2em;color:#a5f3fc;background:rgba(34,211,238,.14);padding:5px 9px;
  border-radius:99px;margin-bottom:8px}
/* No rule of its own: the last preference row already draws one, and .nuke is
   a div too, so :last-of-type never fires on that row and you get two. */
.nuke{margin-top:6px;padding-top:22px;padding-bottom:8px}
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
  camp: 'M12 3.6a8.4 8.4 0 1 0 0 16.8 8.4 8.4 0 0 0 0-16.8Zm0 4.6a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Zm0 3.3a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1Z',
  store: 'M5.6 8.2h12.8l1 11.4H4.6l1-11.4Zm3.4 0V6.4a3 3 0 0 1 6 0v1.8',
  cons: 'M12 3.6 5.6 6.2v5.4c0 4 2.6 7.2 6.4 8.8 3.8-1.6 6.4-4.8 6.4-8.8V6.2L12 3.6Zm-2.7 8.5 2 2 3.5-4.1',
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
  { grp: 'Mail' },
  { href: '/broadcasts', key: 'bc', label: 'Broadcasts' },
  { href: '/sequences', key: 'seq', label: 'Sequences' },
  { href: '/outbox', key: 'out', label: 'Outbox' },
  { grp: 'Money' },
  { href: '/campaigns', key: 'camp', label: 'Campaigns' },
  { href: '/store', key: 'store', label: 'Store' },
  { grp: 'System' },
  { href: '/consent', key: 'cons', label: 'Consent' },
  { href: '/settings', key: 'set', label: 'Settings' },
  { href: '/help', key: 'help', label: 'Help' },
]

const FONTS =
  'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Sora:wght@400;500;600;700&display=swap'

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
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#04121f" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 8.5c1.8-2 3.6-2 5.4 0s3.6 2 5.4 0 3.6-2 5.4 0M3 14c1.8-2 3.6-2 5.4 0s3.6 2 5.4 0 3.6-2 5.4 0M3 19.5c1.8-2 3.6-2 5.4 0" />
      </svg>
    </span>
    <span class="wm">
      big<i>·</i>mailer
      <em>owned list</em>
    </span>
  </a>
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
      <title>{title} · big-mailer</title>
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
        <div class="stage">
          <div class="mobar">
            <label class="burger" for="rail-open" title="Menu">
              <span>
                <i />
                <i />
              </span>
            </label>
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
 * Sub-navigation for the storefront.
 *
 * Its own rail slot rather than a fourth audience tab: this is the customer
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
      <p class="faint" style="margin:10px 0 0">
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
