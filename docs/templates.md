# 🎨 Templates: altering a theme, and making your own

The public site renders through a **theme**: a folder of Handlebars templates plus
CSS, JS and images. Nobody is expected to write one by hand. The workflow is:
describe what you want to Claude, give it this document, get a folder back, zip it,
upload it.

> 💡 **This file is the spec.** Paste it (or attach it) whenever you ask Claude to
> build or change a theme. Everything a theme can see and do is in here.

---

## 🗺️ Where themes live

| Kind | Templates | Assets (CSS, JS, fonts, images) | Settings & "is it live?" | Can you delete it? |
|---|---|---|---|---|
| **Built-in**: Folio, Signal, Nightdrive | Compiled into the Worker from `themes/<name>/` in the repo | Same: served from the Worker | A row in D1 `themes` (flagged `builtin`) | ❌ Ships with Kōlea |
| **Uploaded**: anything you install | D1 `theme_files` (one row per `.hbs` / `package.json` / locale file) | R2 `MEDIA` bucket, under `themes/<id>/assets/…` | A row in D1 `themes` | ✅ From the Themes screen |

- Exactly one theme is live. If nothing is marked live, **Folio** renders. Deleting
  the live theme drops the site back to Folio, never to a blank page.
- Built-in themes can't be edited from the admin. To change one, either **copy it
  and upload the copy** (below), or edit it in the repo and redeploy.
- The engine lives in `src/core/theme/`: our own Handlebars parser and
  interpreter (Workers forbid the `eval` that real Handlebars needs).

---

## 🚀 The short version

**To change a theme:**
1. Copy the theme's folder (`themes/nightdrive/`, say) somewhere new.
2. Change `"name"` in its `package.json` (e.g. `"nightdrive-rob"`). Built-in names are reserved.
3. Ask Claude for the change, giving it this document and the files (see [prompts](#-prompts-for-claude)).
4. Zip the folder so `package.json` sits at the root of the zip (a single wrapping folder is fine too).
5. Admin → **Themes** → *Install a theme* → upload the zip.
6. Click **Preview**. If it looks right, click **Use this**.

**To make a new one:** the same steps, but start from the [new-theme prompt](#-make-a-new-theme)
instead of a copy.

**To undo:** click **Use this** on the previous theme. Switching is instant, and
public pages are cached for 60 seconds.

---

## 📁 Anatomy of a theme

```
my-theme/
├── package.json          ← required: name, version, settings
├── default.hbs           ← the layout: <html>, <head>, header, footer, {{{body}}}
├── index.hbs             ← required: the archive at /writing (and / when there's no home.hbs)
├── post.hbs              ← required: one post
├── home.hbs              ← the front page: a landing page for the writer (see below)
├── about.hbs             ← optional: /about, the long bio (falls back to page.hbs)
├── tag.hbs               ← optional: a topic's archive (falls back to index.hbs)
├── tag-<slug>.hbs        ← optional: one specific topic
├── author.hbs            ← optional (falls back to index.hbs)
├── post-<slug>.hbs       ← optional: one specific post
├── page.hbs              ← optional: /subscribe and search fall back to it
├── search.hbs            ← optional: the /search page
├── subscribe.hbs         ← optional: the /subscribe page
├── error.hbs             ← optional: 404 and 500 (also error-404.hbs, error-4xx.hbs)
├── partials/             ← optional: reusable pieces, e.g. partials/card.hbs → {{> card}}
│   └── icons/logo.hbs    ←   nested partials are named by path: {{> "icons/logo"}}
├── locales/en.json       ← optional: strings for {{t "…"}}
└── assets/               ← CSS, JS, fonts, images, served at /assets/…
    ├── theme.css
    └── theme.js
```

**What the installer keeps:** every `.hbs` file, `package.json`, `locales/*.json`,
and everything under `assets/`. Anything else (README, build tooling, lockfiles,
`node_modules`) is ignored.

**Limits:** zip ≤ 25 MB, unpacked ≤ 60 MB, ≤ 1,500 files. **Every template must
parse** or the upload is refused and nothing changes. The error names the file
and line.

### `package.json`

```json
{
  "name": "my-theme",
  "version": "1.0.0",
  "description": "One sentence, shown on the Themes screen.",
  "config": {
    "posts_per_page": 12,
    "custom": {
      "show_hero": { "type": "boolean", "default": true, "description": "Big header on the front page." },
      "accent":    { "type": "color",   "default": "#7c5cff" },
      "layout":    { "type": "select",  "options": ["Grid", "List"], "default": "Grid" },
      "strapline": { "type": "text",    "default": "" }
    }
  }
}
```

- `name`: letters, numbers, dashes. **Uploading the same name again replaces the theme.**
  `folio`, `signal` and `nightdrive` are reserved.
- `posts_per_page`: 1–50.
- `custom`: each entry becomes a field on the theme's **Settings** screen, and its
  value reaches templates as `@custom.<key>`. Types: `boolean`, `select` (with
  `options`), `color`, `text`, `image` (a URL). Optional `group` and `description`.

---

## 🧭 URLs and which template renders them

There is no routes file. The URL scheme is fixed:

| URL | Template (first one that exists wins) | What the template gets |
|---|---|---|
| `/` | `home` (a theme without one gets page 1 of `index`) | `start_here`, `shelves`, `latest`, `post_count` |
| `/writing` · `/writing/page/2` | `index` | `posts`, `pagination` |
| `/about` | `about` → `page` → `post`; 404 when there's no long bio | `post` (the long bio as `{{content}}`) |
| `/<topic>` · `/<topic>/page/2` | `tag-<slug>` → `tag` → `index` | `tag`, `posts`, `pagination` |
| `/<topic>/<slug>` | `post-<slug>` → `post` | `post` |
| `/<slug>` | an untagged post; a tagged one 301s to `/<topic>/<slug>` | `post` |
| `/author/<slug>` | `author-<slug>` → `author` → `index` | `author`, `posts`, `pagination` |
| `/search?q=` | `search` → a generated page in `page` → `post` | `query`, `posts`, `pagination` |
| `/subscribe` | `subscribe` → a generated page in `page` → `post` | `post` |
| anything else | `error-404` → `error-4xx` → `error` | `statusCode`, `message` |

The old archive URLs (`/page/2`, `/?page=2`) redirect to `/writing/page/2`. A post's
**first tag is its topic**, and the topic is its URL. `/feed.xml`,
`/sitemap.xml` and `/robots.txt` are generated by Kōlea, not the theme.

**Layouts.** A page template starts with `{{!< default}}`. It renders first; its
output is then passed to `default.hbs` as `{{{body}}}`.

---

## 🧩 What a template can see

### Everywhere: `@site`, `@custom`, `@config`

| Value | What it is |
|---|---|
| `@site.title`, `@site.description` | The site's name and tagline (Site screen, falling back to the `SITE_*` settings) |
| `@site.url` | The site's origin, e.g. `https://a.bigmachine.io` |
| `@site.author` | The author's name |
| `@site.navigation` | Home, Writing, About (when there's a long bio), then the busiest topics: each has `label`, `url`, `hue`, `hue_cool` |
| `@site.signup_action` | Where a subscribe form posts. **Empty when signups are off; always check it** |
| `@site.search_url` | `/search` |
| `@site.writing_url`, `@site.about_url` | `/writing`, and `/about` (empty when there's no long bio) |
| `@site.topics` | Just the busiest topics, without Home, Writing and About |
| `@site.logo` | Logo URL from the Site screen, or empty |
| `@site.now` | The current time, e.g. for `{{date @site.now format="YYYY"}}` |
| `@site.locale` | `en` |
| `@custom.<key>` | This theme's settings (from `package.json`) |
| `@config.posts_per_page` | From `package.json` |

### The writer: `@author`

Set on the admin's **Site** screen. Available on every page.

| Value | What it is |
|---|---|
| `@author.name` | The writer's name |
| `@author.photo` | Photo URL, or empty |
| `@author.short_bio` | A few sentences, plain text |
| `@author.short_bio_html` | The same, as `<p>` paragraphs. Print with `{{@author.short_bio_html}}` |
| `@author.url` | `/about` when there's a long bio, otherwise empty. Link to it only when set |
| `@author.social` | Links: each has `label` and `url` |

### The front page: `home.hbs`

The front page sells the person who writes the site. It gets these, and **each is
empty unless the operator has set it up**, so every section must be wrapped in an
`{{#if}}` and a brand-new site shows only the hero and the signup.

| Value | What it is |
|---|---|
| `start_here` | Posts marked **Featured** on their Publishing screen, newest first |
| `shelves` | One per topic ticked "show on the front page": each has `tag` and `posts` (its three newest) |
| `latest` | The six newest posts. Use it as a fallback when there's no `start_here` and no `shelves` |
| `post_count` | How many posts are published; link to `/writing` for all of them |

A front page, in order: **the hero with the signup form in it** (above the fold),
the author (`@author`), `start_here`, `shelves`, the fallback `latest`, a link to
`/writing`, and a closing signup. The built-in themes' `home.hbs` files are the
reference.

### A post (`post`, and each item in `posts`)

| Field | Notes |
|---|---|
| `title`, `slug`, `url` | `url` is the canonical path, e.g. `/ai/my-post` |
| `excerpt` | Plain text. Use `{{excerpt words="30"}}` to trim |
| `feature_image` | URL or empty. Use `{{img_url feature_image}}` |
| `feature_image_caption` | HTML (the photo credit). Prints as-is |
| `published_at` | ISO date. Use `{{date format="…"}}` |
| `reading_time` | Minutes. Use `{{reading_time}}` |
| `tags`, `primary_tag` | Each tag: `name`, `slug`, `url`, `description`, `hue`, `hue_cool`, `count.posts` |
| `primary_author`, `authors` | `name`, `slug`, `url` |
| `number` | Position in the archive, newest = total (listings only) |
| `hue`, `hue_cool` | The primary topic's colour (see below) |
| `share_x_url` | A ready-made "post this on X" link |
| `id` | For `{{#get}}` filters like `id:-{{id}}` |
| The body | `{{content}}` inside `{{#post}}…{{/post}}` |

### Listings: `pagination`

`page`, `pages`, `total`, `limit`, `prev`, `next` (numbers, or empty at either end).
`{{pagination}}` renders `partials/pagination.hbs` if you have one, otherwise a plain default.
Use `{{page_url next}}` to build links.

### Topic colours

Every topic gets a colour hue for life, handed to templates as a number for OKLCH:

- `hue`: from a full palette (reds through violets). Signal uses it.
- `hue_cool`: blues and violets only. Nightdrive uses it.

The pattern: set it on an element, derive colours in CSS.

```hbs
<article class="card" style="--h: {{hue_cool}}">…</article>
```
```css
.card { background: oklch(20% 0.07 var(--h)); }
.card .chip { color: oklch(80% 0.16 var(--h)); }
```

---

## 🛠️ Helpers

The syntax is Handlebars: `{{value}}` escapes, `{{{value}}}` prints raw HTML,
`{{#block}}…{{else}}…{{/block}}`, `{{> partial}}`, `../` for the parent context,
`@index`/`@first`/`@last` in loops, `{{~` / `~}}` trim whitespace.

| Helper | Example |
|---|---|
| **Page furniture** | |
| `kolea_head` | `{{kolea_head}}` in `<head>`: title meta, canonical, Open Graph, feed link. **Always include it.** |
| `meta_title` | `<title>{{meta_title}}</title>` |
| `asset` | `<link rel="stylesheet" href="{{asset "theme.css"}}">`: cache-busted URL to `assets/theme.css` |
| `body_class` | `<body class="{{body_class}}">`: e.g. `home-template`, `post-template tag-ai` |
| `post_class` | `<article class="{{post_class}}">` |
| **Logic** | |
| `if` / `unless` | `{{#if feature_image}}…{{else}}…{{/if}}` |
| `is` | `{{#is "home"}}…{{/is}}`: contexts are `home`, `index`, `paged`, `post`, `page`, `tag`, `author`, `search`, `error` |
| `match` | `{{#match @custom.layout "Grid"}}…{{/match}}`, `{{#match number ">" 3}}`: also `!=`, `<`, `<=`, `>=`, `~` (contains) |
| `has` | `{{#has tag="ai"}}`, `{{#has any="feature_image, excerpt"}}`, `{{#has number="nth:3"}}` |
| **Loops** | |
| `foreach` | `{{#foreach posts limit="3" from="2"}}{{@number}}. {{title}}{{/foreach}}`: gives `@index`, `@number`, `@first`, `@last`, `@odd`, `@even` |
| `each` | Plain Handlebars loop; `{{#each posts as |p i|}}` |
| `split` | `{{#foreach (split title separator=" ")}}<span>{{this}}</span>{{/foreach}}` |
| **Content** | |
| `content` | `{{content}}`: the post body as HTML |
| `excerpt` | `{{excerpt words="30"}}` or `characters="140"` |
| `title`, `url` | `{{title}}`, `{{url}}`, `{{url absolute="true"}}` |
| `date` | `{{date format="D MMM YYYY"}}`, `{{date published_at format="YYYY-MM-DD"}}`, `{{date timeago=true}}` |
| `img_url` | `{{img_url feature_image}}` (sizes are accepted and ignored for now) |
| `reading_time` | `{{reading_time minute="1 min" minutes="% min"}}` |
| `plural` | `{{plural pagination.total empty="Nothing" singular="% post" plural="% posts"}}` |
| `tags` | `{{tags separator=", "}}`: linked topic names |
| `navigation` | `{{navigation}}`, or loop `@site.navigation` yourself for full control |
| `link_class` | `class="{{link_class for=url class="nav" activeClass="is-here"}}"` |
| `pagination`, `page_url` | See above |
| **Data** | |
| `get` | `{{#get "posts" filter="primary_tag:{{primary_tag.slug}}+id:-{{id}}" limit="3" as |more|}}{{#foreach more}}…{{/foreach}}{{/get}}` |
| `prev_post` / `next_post` | `{{#prev_post}}<a href="{{url}}">{{title}}</a>{{/prev_post}}`, `in="primary_tag"` to stay in the topic |
| **Other** | |
| `contentFor` / `block` | Push a snippet from a page into a slot in `default.hbs` |
| `concat`, `encode`, `t` | String join, URL-encode, translate via `locales/en.json` |

**`{{#get}}`** understands filters `id:-X`, `tag:x`, `tags:[a,b]`, `primary_tag:x`, joined with `+`,
and resources `"posts"`, `"tags"`, `"authors"`. At most 100 items, and at most **10 `{{#get}}`
calls per page**; any beyond that return nothing.

**Unknown helpers render nothing** rather than breaking the page. The upload
tells you which ones a theme used.

---

## ✅ Rules every theme must follow

These keep a theme safe for readers and for the list. Tell Claude about them (the prompts below already do).

1. **`{{kolea_head}}` in `<head>`.** It carries the canonical URL, social previews and the feed link.
2. **The signup is at the top of the front page**, in the hero, not only at the bottom.
3. **Subscribe forms post to `@site.signup_action`**, with the address in a field named `email`
   (and optionally `name`). Wrap them in `{{#if @site.signup_action}}`. This sends signups
   through Kōlea's normal consent path. Never post anywhere else, and never collect addresses in JS.
4. **Readable with JavaScript off.** If content is hidden for a reveal animation, hide it only
   under a `.js` class set in `<head>`, and include a failsafe that shows everything if the
   script never runs. The built-in themes do this; copy their pattern.
5. **Respect `prefers-reduced-motion`.** All animation off.
6. **No trackers, no third-party scripts** beyond fonts. The list is owned; the reading is too.
7. **Assets via `{{asset}}`** so they are cache-busted on every upload.
8. **Every page type renders**, including the error page, search with no results, a
   topic with one post, a post with no image, and a front page with nothing set up.
   Most archives have no images.

---

## 🤖 Prompts for Claude

### ✏️ Change an existing theme

Give Claude the theme's files and this document, then:

```text
I'm changing a Kōlea theme. The theme's files are attached, and docs/templates.md
(attached) is the complete spec for what templates can use.

The change I want: <describe it: what you see now, what you want instead, and
which pages it affects (front page, posts, topic pages, search, error)>.

Rules:
- Keep everything else exactly as it is.
- Set "name" in package.json to "<new-name>" and bump "version".
- Follow the "Rules every theme must follow" section.
- Only use helpers and data listed in the spec.

Return every changed file in full, with its path, then a one-line list of what changed.
```

### 🆕 Make a new theme

```text
Build me a new theme for Kōlea, my self-hosted newsletter and blog. docs/templates.md
(attached) is the complete spec: templates, data, helpers and rules.

The feel: <three words, plus references: "like Stripe Press", "like a 70s
concert poster", "like a terminal">.
Light or dark: <and why, e.g. "people read it at night">.
Colour: <restrained with one accent / one bold colour everywhere / a colour per topic>.
Type: <any fonts you love or hate>.
The front page should be: <a list, a grid, one big story, a table of contents…>.
Readers are: <who, and how they read>.

Deliver a folder named "<theme-name>" containing package.json, default.hbs,
home.hbs (the front page, a landing page for me), index.hbs (the archive), post.hbs,
about.hbs, tag.hbs, search.hbs, subscribe.hbs, error.hbs, any partials,
and assets/ with one CSS file and at most one small JS file. Include two or three
useful settings in package.json.

Rules:
- Follow the "Rules every theme must follow" section exactly.
- Handle posts with no feature image gracefully; most have none.
- Work well on phones.
- Only use helpers and data listed in the spec.

Return every file in full, with its path.
```

Then zip the folder and upload it. If the upload refuses a template, paste the
error back to Claude; it names the file and line.

### 👻 Bringing a theme from Ghost

The template language is compatible, so many Ghost themes install as they are.
When one doesn't, the Themes screen has a ready-made prompt under *Bringing a
theme from Ghost?* (it lives in `src/core/theme/adapt-prompt.ts`).

---

## 🧪 Trying it out

- **Preview** renders the front page with a theme that isn't live; *a post* in the
  preview banner shows the newest post. Links in a preview go to the real site.
- After **Use this**, public pages can take up to 60 seconds to change (they are
  cached). Add `?x=1` to a URL to see the change immediately.
- Theme settings are on the theme's **Settings →** link. Saving busts every asset URL.

### Changing a built-in theme in the repo

For the operator with the codebase: built-ins live in `themes/<name>/`. Edit, then
`bun run build:theme` (it also runs as part of `dev` and `deploy`) and redeploy.
`tests/specs/theming-the-public-site.spec.ts` covers what must keep working.

---

## ⚠️ Gotchas

- **`{{value}}` vs `{{{value}}}`.** Double braces escape HTML. Only `{{content}}`,
  `{{{body}}}` and helpers that return HTML should print raw.
- **Nothing is inherited implicitly.** Inside `{{#foreach posts}}`, `title` means the
  post's title; reach outward with `../` or `@root`.
- **A block on a value** (`{{#post}}…{{/post}}`, `{{#primary_tag}}…{{/primary_tag}}`)
  renders once with that value as the context, or not at all when it's empty.
- **Topic names can't shadow fixed URLs.** A topic called "Search" gets the slug
  `search-tag`; the same goes for `about`, `writing`, `author`, `page` and the rest.
- **No export button yet.** Keep the zip you uploaded; the admin can't hand it back.
- **Fonts** load from Google Fonts in the built-ins. Anything else is up to the theme,
  under `assets/`.
