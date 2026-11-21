/**
 * The importer port: what every "bring my list over from <tool>" adapter speaks.
 *
 * An adapter knows one tool's API and nothing about our tables. It checks what
 * the operator typed (`prepare`), proves the key works with one request
 * (`verify`), names its phases in order (`phases`), and reads ONE page of one
 * phase at a time (`fetchPage`), turning the tool's JSON into the records below.
 * The cursor is the tool's own (a Kit `end_cursor`, a Ghost page number, an
 * offset) — opaque to everyone else, stored on the `import_runs` row, so a run
 * resumes on the exact page it stopped at.
 *
 * Every write rule (consent never widens, nothing fires a sequence, content
 * arrives inert) lives once in `core/importers/writer.ts`. Nothing
 * tool-specific crosses this line, which is what lets four tools share it.
 *
 * Imports nothing above `providers/`.
 */

/** Kōlea's status for a person, as the other tool's state means it. */
export type ImportedStatus = 'active' | 'pending' | 'unsubscribed' | 'bounced' | 'complained'

/** The address-wide opt-out the other tool recorded, at the reach it really had. */
export type ImportedSuppression = 'unsubscribed_all' | 'hard_bounce' | 'complaint'

export interface ImportedSubscriber {
  kind: 'subscriber'
  email: string
  /**
   * Null when the tool used a state we do not know. Then nobody is imported:
   * no consent is ever assumed from a word we cannot read (SPEC 1.2).
   */
  status: ImportedStatus | null
  /** The tool's own word, for the report. */
  rawStatus: string
  /**
   * Only where the tool's opt-out really meant every mail. Ghost's newsletter
   * toggle does not; Kit's, Mailchimp's and Drip's unsubscribes do. Carrying a
   * narrow opt-out over as a wide one, or the reverse, changes what a person
   * chose (ARCHITECTURE invariants 1–2).
   */
  suppression: ImportedSuppression | null
  name: string | null
  subscribedAt: number | null
  unsubscribedAt: number | null
  confirmedAt: number | null
  attributes: Record<string, string>
  tags: string[]
}

export interface ImportedTag {
  kind: 'tag'
  name: string
}

/** One tag on one person, for tools that list taggings apart from people (Kit). */
export interface ImportedTagging {
  kind: 'tagging'
  email: string
  tag: string
}

/** The numbers the other tool reported for a send it made. */
export interface ImportedTotals {
  recipients: number
  opened: number
  clicked: number
  unsubscribed: number
}

/**
 * A mail the other tool sent (or, for Ghost, a post). `sent: false` is a draft
 * or a scheduled mail that never went out — the writer leaves those behind and
 * counts them, so nothing that was not on the wire ever lands as history.
 */
export interface ImportedBroadcast {
  kind: 'broadcast'
  sourceId: string
  subject: string
  sent: boolean
  html: string | null
  excerpt: string | null
  sentAt: number | null
  createdAt: number | null
  totals: ImportedTotals | null
  /** Ghost: the URL slug, kept so the post's address survives a later publish. */
  slug: string | null
  featureImage: string | null
  featured: boolean
}

export interface ImportedStep {
  subject: string
  html: string | null
  delayDays: number
  /** The tool said hours (or more than a year) and the delay was rounded. */
  rounded: boolean
}

export interface ImportedSequence {
  kind: 'sequence'
  sourceId: string
  name: string
  createdAt: number | null
  steps: ImportedStep[]
}

/** Something the tool held that did not come over, counted for the report. */
export interface ImportedNote {
  kind: 'note'
  key: string
  count: number
  message: string
}

export type ImportedRecord =
  | ImportedSubscriber
  | ImportedTag
  | ImportedTagging
  | ImportedBroadcast
  | ImportedSequence
  | ImportedNote

export interface ImportPage {
  records: ImportedRecord[]
  /** The cursor of the next page in this phase; null when the phase is done. */
  next: string | null
}

/** `fetch`, or a binding that answers like it (`Env.IMPORT_HTTP`). */
export type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>

export interface SourceConnection {
  /** Safe to show: a Ghost URL, a Mailchimp list id, a Drip account id. */
  settings: Record<string, string>
  /** Secret: the API key. Never shown, cleared when the run ends. */
  credentials: Record<string, string>
  http: HttpFetch
}

export interface PreparedConnection {
  settings: Record<string, string>
  credentials: Record<string, string>
}

/**
 * Why a source call failed, in words a person can act on. `auth` and `invalid`
 * are permanent — retrying a wrong key three times is not resilience. The rest
 * are worth a retry on the next tick.
 */
export class SourceError extends Error {
  constructor(
    readonly reason: 'invalid' | 'auth' | 'not_found' | 'unavailable' | 'error',
    message: string,
  ) {
    super(message)
  }

  get permanent(): boolean {
    return this.reason === 'invalid' || this.reason === 'auth'
  }
}

export interface ImportSource {
  readonly id: 'kit' | 'ghost' | 'mailchimp' | 'drip'
  readonly label: string
  /** The form fields the operator fills in, in order. `secret` ones are never shown back. */
  readonly fields: { name: string; label: string; secret: boolean; hint?: string }[]
  /** Checks what was typed without touching the network. Throws `SourceError('invalid')`. */
  prepare(params: Record<string, string>): PreparedConnection
  /** One request that proves the connection works before anything is queued. */
  verify(conn: SourceConnection): Promise<void>
  /** The phases of a run, in order. */
  phases(conn: Pick<SourceConnection, 'settings'>): string[]
  /** One page of `phase` from `cursor` (null for the first page). */
  fetchPage(conn: SourceConnection, phase: string, cursor: string | null): Promise<ImportPage>
}
