export interface SendJob {
  messageId: number
}

export interface Env {
  DB: D1Database
  SEND_QUEUE?: Queue<SendJob>
  MEDIA: R2Bucket
  /** Lead-magnet files. Separate from MEDIA — nothing serves this bucket by key. */
  DOWNLOADS: R2Bucket
  ASSETS: Fetcher

  EMAIL_PROVIDER: string
  FROM_EMAIL: string
  FROM_NAME: string
  PUBLIC_URL: string

  /**
   * The public site's own origin, e.g. `https://a.bigmachine.io`.
   *
   * Hostname dispatch, not a path prefix: `worker.tsx` routes a request whose
   * host matches this to the public site app and everything else to the admin
   * app. That is what keeps the reader-facing site out from behind Cloudflare
   * Access, which guards the admin hostname as a whole.
   *
   * Unset means the public site does not exist — every request goes to the admin
   * app, and nothing is published anywhere. That is the default.
   *
   * Locally, set it to `http://site.localhost:8787`: `*.localhost` resolves to
   * 127.0.0.1, so one `wrangler dev` serves the console on `localhost:8787` and
   * the site on `site.localhost:8787` with no second process.
   */
  SITE_URL?: string
  /** Masthead and <title> suffix for the public site. */
  SITE_TITLE?: string
  /** One line under the masthead, and the feed + meta description. */
  SITE_TAGLINE?: string
  /** Byline and copyright name. Falls back to `FROM_NAME`. */
  SITE_AUTHOR?: string
  /**
   * Slug of the signup form the site's subscribe box posts to. Unset hides the
   * box entirely — consent has to land somewhere real or not be collected.
   */
  SITE_FORM_SLUG?: string

  /**
   * Where "send a preview" goes, and the only address it may ever go to.
   * Defaults to `FROM_EMAIL`, which is your own mailbox by definition.
   */
  PREVIEW_EMAIL?: string

  /** Local only. Bypasses the Cloudflare Access identity check. */
  DEV_AUTH_BYPASS?: string

  /** e.g. `you.cloudflareaccess.com`. Without it the admin console fails closed. */
  CF_ACCESS_TEAM_DOMAIN?: string
  /** The Access application's Audience (AUD) tag. Ties a token to *this* app. */
  CF_ACCESS_AUD?: string

  /**
   * Unsplash API access key, for the featured-image picker. A secret, not a var.
   * Unset means the picker is hidden — upload still works.
   */
  UNSPLASH_ACCESS_KEY?: string

  RESEND_API_KEY?: string
  RESEND_WEBHOOK_SECRET?: string

  /**
   * The unguessable path segment the MCP server answers on: `/mcp/<secret>`.
   * Unset means the endpoint 404s — MCP is off unless deliberately turned on.
   */
  MCP_PATH_SECRET?: string
  /** "true" lets MCP tools put mail on the wire. Anything else is a kill switch. */
  MCP_ALLOW_SEND?: string

  /** Restricted read key: charges, refunds, customers, products, prices. */
  STRIPE_SECRET_KEY?: string
  /**
   * `whsec_…` from the Stripe dashboard endpoint. Without it `/webhooks/stripe`
   * fails closed with a 503 — an endpoint that accepts unsigned bodies is an
   * endpoint anybody can post fake revenue to.
   */
  STRIPE_WEBHOOK_SECRET?: string
}
