/**
 * The prompt for adapting a Ghost theme to Kōlea — shown on the Themes screen
 * for the operator to copy into Claude (or any capable model) along with the
 * theme's files.
 *
 * Most Ghost themes install and render without it. This is for the rest: the
 * ones built around paid membership, Portal, or helpers Kōlea doesn't have.
 * Kept in code rather than only in docs so the screen and `themes/README.md`
 * can't drift apart — the README quotes this.
 */
export const ADAPT_GHOST_THEME_PROMPT = `You are adapting a Ghost CMS theme so it runs on Kōlea, a self-hosted newsletter + blog that renders Ghost-style Handlebars themes. Change as little as possible; keep the design exactly as it is.

## What Kōlea supports (leave these alone)
- Templates: default.hbs (layout via {{!< default}}), index.hbs, post.hbs (both required), home.hbs, page.hbs, tag.hbs, tag-{slug}.hbs, author.hbs, post-{slug}.hbs, error.hbs, error-404.hbs, error-4xx.hbs, partials/**/*.hbs. Optional Kōlea extras: search.hbs (root: query, posts, pagination) and subscribe.hbs.
- Handlebars: {{x}}, {{{x}}}, blocks, {{else}}, {{else if}}, {{^x}}, partials with context and hash, block params (as |x|), subexpressions, ../ and @root, whitespace control (~).
- Helpers: if, unless, each, with, lookup, foreach (limit/from/to/columns, @index/@number/@first/@last/@odd/@even/@rowStart/@rowEnd), is, has (tag/author/slug/id/any/all/number/index), match (=, !=, <, >, <=, >=, ~, ~^, ~$), get ("posts" | "tags" | "authors"; filter supports id:-X, tag:x, tags:[a,b], primary_tag:x joined with +), prev_post/next_post (in="primary_tag"), title, content, excerpt (words/characters), url (absolute), date (moment formats, timeago), img_url, reading_time, tags, authors, plural, navigation (uses partials/navigation.hbs when present), pagination (uses partials/pagination.hbs when present), page_url, asset, body_class, post_class, ghost_head, ghost_foot, meta_title, meta_description, link, link_class, concat, encode, split, t (reads locales/en.json), contentFor/block, color_to_rgba, contrast_text_color, readable_url, search.
- Data: @site (title, description, url, icon, accent_color, locale, navigation, secondary_navigation, members_enabled, allow_self_signup — plus Kōlea's signup_action, search_url, author), @custom (from package.json config.custom), @config.posts_per_page, @page.show_title_and_feature_image. Posts have Ghost's fields: title, slug, url, html, excerpt, custom_excerpt, feature_image, feature_image_caption, published_at, reading_time, tags, primary_tag, authors, primary_author.
- URLs: a post lives at /{primary_tag}/{slug} (or /{slug} if untagged); a tag's archive is /{tag}; pages are /page/2 and /{tag}/page/2. Never hard-code /tag/ or /blog/ prefixes — use {{url}}.

## What Kōlea does NOT have — adapt these
1. Paid membership, tiers, prices, Portal account/sign-in, comments, recommendations, pages (static pages), featured posts, multiple authors. Their helpers render nothing and @member is always null.
   - Remove or simplify blocks that only make sense for paid members: tier cards, pricing tables, "upgrade" CTAs, account links, member-only content gates ({{#if access}} is always true).
   - Keep free "Subscribe" calls to action. Kōlea wires any <form data-members-form> (with an input[data-members-email]) and any data-portal="signup" link to its own signup — but a plain form is better:
       {{#if @site.signup_action}}<form method="post" action="{{@site.signup_action}}"><input type="email" name="email" required><button>Subscribe</button></form>{{/if}}
   - Remove "Sign in" / account buttons.
2. Search: Ghost uses a JS popup. Kōlea has a real /search page. Point search buttons/links at /search (a <form action="/search"> with input name="q" is ideal).
3. {{#get}} with filters beyond the list above: rewrite to a supported filter or drop the section. "featured:true" returns nothing — replace featured sections with the latest posts.
4. routes.yaml and collections: not supported and not needed. Delete routes.yaml. Replace any links to custom collection URLs with tag URLs.
5. Any helper not in the list above: replace it with a supported equivalent or remove the call.

## Output
- Return every changed file in full, with its path. Do not return unchanged files.
- Then list, briefly, what you removed and why.
- Do not change CSS unless a removed element leaves a broken layout.
`
