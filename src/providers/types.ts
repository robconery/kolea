export interface OutgoingEmail {
  /**
   * Opaque caller correlation handle, echoed nowhere and interpreted by nobody
   * here. It exists so a batch result can be matched back to whatever the caller
   * was tracking without this file learning what that is.
   */
  ref: number
  to: string
  fromEmail: string
  fromName: string
  subject: string
  html: string
  text: string
  /** RFC 8058 one-click unsubscribe target. Scoped to where the reader came from. */
  listUnsubscribeUrl?: string
}

export type SendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; error: string; retryable: boolean }

export interface ProviderEvent {
  providerMessageId: string
  type: 'delivered' | 'open' | 'click' | 'bounce' | 'complaint' | 'failed'
  occurredAt: Date
  /** Hard bounces suppress the address; soft bounces do not. */
  hardBounce?: boolean
  meta?: Record<string, unknown>
  dedupeKey?: string
}

/**
 * The seam that protects us from the project's #1 risk.
 *
 * Deliverability is the thing most likely to sink big-mailer, so swapping the
 * sending provider must cost one file. Nothing outside `providers/` may name a
 * vendor, and nothing here may know about broadcasts, sequences, or consent.
 */
export interface EmailProvider {
  readonly name: string
  send(email: OutgoingEmail): Promise<SendResult>
  /**
   * Send many at once. Returns one result per input, in input order.
   *
   * Providers rate-limit on API *requests*, so this is the difference between a
   * 15,000-email broadcast taking 25 minutes and taking seconds. Implementations
   * chunk internally to whatever their own per-call ceiling is.
   */
  sendBatch(emails: OutgoingEmail[]): Promise<SendResult[]>
  /** Verify + parse a provider webhook. Returns [] if it isn't ours to handle. */
  parseWebhook(request: Request, secret: string | undefined): Promise<ProviderEvent[]>
}
