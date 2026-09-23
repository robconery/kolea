/**
 * The data a theme sees — Ghost's shapes, because Ghost themes are the ones
 * that exist. Field names are snake_case to match: a theme written for Ghost
 * says `{{feature_image}}` and `{{primary_tag.slug}}`, and those have to resolve
 * here without the theme being rewritten.
 *
 * Kōlea's own additions live on `@site` (`signup_action`, `search_url`) and are
 * documented in `themes/README.md`.
 */

export interface GhostTag {
  id: string
  name: string
  slug: string
  description: string | null
  url: string
  feature_image: string | null
  visibility: 'public'
  accent_color: string | null
  meta_title: string | null
  meta_description: string | null
  count: { posts: number }
  /** Kōlea: a stable OKLCH hue for this topic, so a theme can give every topic its own colour. */
  hue: number
}

export interface GhostAuthor {
  id: string
  name: string
  slug: string
  url: string
  profile_image: string | null
  cover_image: string | null
  bio: string | null
  website: string | null
  location: string | null
  twitter: string | null
  facebook: string | null
  meta_title: string | null
  meta_description: string | null
  count: { posts: number }
}

export interface GhostPost {
  id: string
  uuid: string
  title: string
  slug: string
  /** Rendered lazily — a getter, so a card listing never renders twelve bodies. */
  html: string
  excerpt: string
  custom_excerpt: string | null
  url: string
  feature_image: string | null
  feature_image_alt: string | null
  /** HTML (the Unsplash credit), so it arrives as a SafeString. */
  feature_image_caption: unknown
  featured: boolean
  page: boolean
  visibility: 'public'
  access: boolean
  comments: boolean
  published_at: string
  updated_at: string
  created_at: string
  reading_time: number
  tags: GhostTag[]
  primary_tag: GhostTag | null
  authors: GhostAuthor[]
  primary_author: GhostAuthor
  meta_title: string | null
  meta_description: string | null
  og_image: string | null
  twitter_image: string | null
  /** Kōlea: the numeric id, for `{{#get}}` filters that say `id:-{{id}}`. */
  broadcast_id: number
  /** Kōlea: the primary topic's hue, or one derived from the slug when untagged. */
  hue: number
  /** Kōlea: the post's position in the whole archive, oldest = 1. Set on listings only. */
  number?: number
}

export interface Pagination {
  page: number
  limit: number
  pages: number
  total: number
  next: number | null
  prev: number | null
}

/** Everything `{{ghost_head}}` needs to describe the page. */
export interface PageMeta {
  title: string
  description: string | null
  canonical: string
  image: string | null
  type: 'website' | 'article'
  publishedAt: string | null
  noindex: boolean
}

export interface GetQuery {
  limit: number
  filter: string
  order: string
  page: number
}

/**
 * What helpers reach for beyond template data. Built per request by
 * `core/theme/site.ts`; helpers never touch the database directly.
 */
export interface ThemeServices {
  origin: string
  /** The request path, for `link_class` and `navigation`'s current item. */
  path: string
  /** The URL of page `n` of the current listing — `/page/2`, `/ai/page/2`. */
  pageUrl(n: number): string
  /** `home`, `index`, `paged`, `post`, `tag`, `author`, `error` — for `{{#is}}` and `body_class`. */
  contexts: string[]
  meta: PageMeta
  assetUrl(path: string): string
  /** Where the signup form posts, or null when the site has no signup. */
  signupAction: string | null
  hasPartial(name: string): boolean
  /** `{{#get}}` — posts, tags or authors, filtered by a subset of Ghost's NQL. */
  get(resource: string, query: GetQuery): Promise<{ items: unknown[]; pagination: Pagination }>
  /** `{{#prev_post}}` / `{{#next_post}}`. */
  adjacent(post: GhostPost, direction: 'prev' | 'next', inPrimaryTag: boolean): Promise<GhostPost | null>
  /** Theme strings for `{{t}}`, from `locales/<lang>.json` when the theme ships one. */
  translate(key: string): string
}
