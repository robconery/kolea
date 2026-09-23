# 🎨 Themes

The public site renders through a theme: Handlebars templates, run by Kōlea's own
parser and interpreter (`src/core/theme/`), because Workers forbid the `eval` that
Handlebars' compiler needs.

Two themes ship with Kōlea, compiled into the Worker by `bun run build:theme`
(`src/themes/builtin.gen.ts`). Each gets a row on the Themes screen, so it can be
previewed, switched on and configured like an upload, but never deleted.

| Theme | The idea | Type |
|---|---|---|
| 📖 `folio/` (default) | A printed book. Warm paper, one vermilion ink, a table of contents instead of a feed, chapters set like a trade paperback. | Source Serif 4 · Schibsted Grotesk |
| 📰 `signal/` | A magazine. Every topic owns a colour; stories flood in it; an asymmetric spread; big motion. | Bricolage Grotesque · Literata · Geist Mono |
| 🌆 `nightdrive/` | After dark. Neon in blues and violets on black, an SVG sunset with wireframe mountains and a grid floor that drives toward you, cards in a tilted cascade. | Unbounded · Geist · Martian Mono |

Both: cross-document view transitions, reveal-on-arrival (visible without JS, with a
failsafe if the script never loads), a scroll-driven reading bar, and everything off
under `prefers-reduced-motion`.

The template language is Ghost-compatible, so a Ghost theme usually installs as is.
The prompt for adapting one that doesn't is on the Themes screen.

## 🧭 URLs: fixed, no routes file

| URL | Template (first that exists) | Context |
|---|---|---|
| `/` · `/page/2` | `home` (page 1 only) → `index` | `posts`, `pagination` |
| `/<tag>` · `/<tag>/page/2` | `tag-<slug>` → `tag` → `index` | `tag`, `posts`, `pagination` |
| `/<tag>/<slug>` | `post-<slug>` → `post` | `post` |
| `/<slug>` | an untagged post, or a 301 to `/<tag>/<slug>` | `post` |
| `/author/<slug>` | `author-<slug>` → `author` → `index` | `author`, `posts`, `pagination` |
| `/search?q=` | `search` → a synthetic post in `page` → `post` | `query`, `posts`, `pagination` |
| `/subscribe` | `subscribe` → `page` → `post` | `post` |
| anything else | `error-404` → `error-4xx` → `error` | `statusCode`, `message` |

A post's **first tag is its primary tag, and the primary tag is its URL.** Bare
`/<slug>` links (every "read this online" link in sent mail) redirect forever.

## 🧩 What a theme sees

Ghost's names, so Ghost themes resolve: posts carry `title`, `url`, `html`,
`excerpt`, `feature_image`, `feature_image_caption`, `published_at`,
`reading_time`, `tags`, `primary_tag`, `authors`, `primary_author`. Data:
`@site`, `@custom` (from `package.json` → `config.custom`, editable on the Themes
screen), `@config.posts_per_page`.

Kōlea's additions:

- `@site.signup_action` (where a subscribe form posts), `@site.search_url`,
  `@site.author`, `@site.now`; each `@site.navigation` item carries a `hue`.
- Every tag has a `hue` (an OKLCH hue, stable for life), and every post a `hue`
  from its primary topic. Signal sets `style="--hue: {{hue}}"` and derives its colours.
  `hue_cool` is the same idea from blues and violets only; Nightdrive uses it.
- Listing pages number their posts: `{{number}}`, newest = total. Folio prints it.
- `{{kolea_head}}` prints the page's meta tags. Use it rather than `{{ghost_head}}`,
  which adds shims only Ghost themes need.

The full helper list and what's deliberately missing (paid members, tiers,
Portal, comments, static pages) is in the adaptation prompt:
`src/core/theme/adapt-prompt.ts`, also shown on the Themes screen.

## 🔌 Ghost features, rewired

- `<form data-members-form>` and `data-portal` links → Kōlea's own signup
  (`ghost_foot` injects a small script). Same consent path as every other signup.
- Search buttons (`data-ghost-search`) → `/search`.
- Sign-in / account buttons are hidden: there's no reader login.
- `{{#get}}` understands `id:-X`, `tag:x`, `tags:[a,b]`, `primary_tag:x`, joined
  with `+`. `featured:true` matches nothing. Max 10 per page render.
