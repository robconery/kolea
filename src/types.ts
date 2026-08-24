export interface SendJob {
  messageId: number
}

export interface Env {
  DB: D1Database
  SEND_QUEUE?: Queue<SendJob>
  MEDIA: R2Bucket
  ASSETS: Fetcher

  EMAIL_PROVIDER: string
  FROM_EMAIL: string
  FROM_NAME: string
  PUBLIC_URL: string

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
