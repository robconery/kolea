/**
 * ⭐ Whether a hit on the open pixel was a machine, not a reader (Kōlea SPEC 11.2).
 *
 * Pure: decided from the request's user agent and address, and how soon after
 * the mail went out the hit came. Ported rule for rule from Kōlea's
 * `Tracking.MachineDetector`. Machines, in the order checked:
 *
 *   - `no_user_agent` — nothing identifies the client.
 *   - `known_agent` — privacy proxies and prefetchers (Yahoo's proxy), link
 *     scanners (Proofpoint, Mimecast, Barracuda, Microsoft Safe Links), preview
 *     bots and HTTP libraries.
 *   - `apple_privacy_proxy` — Apple Mail Privacy Protection fetches with a bare
 *     `Mozilla/5.0` agent, or from Apple's 17.0.0.0/8 network, whether or not
 *     the reader ever opens the mail.
 *   - `too_soon` — within a few seconds of sending. No person opens that fast;
 *     a scanner or a prefetcher does.
 *
 * Gmail's and Outlook's image proxies fetch when the reader opens the mail, so
 * they count as people.
 *
 * Only opens are judged. A click is a person deciding to go somewhere: the
 * scanners that follow links are real, but a click also moves campaign credit
 * and fires tag rules people rely on, and Big Mailer has always trusted it.
 */

export type MachineReason = 'no_user_agent' | 'known_agent' | 'apple_privacy_proxy' | 'too_soon'

export type Verdict = { machine: false } | { machine: true; reason: MachineReason }

/** Seconds after sending inside which no person opens a mail. Kōlea's figure. */
export const TOO_SOON_SECONDS = 3

const KNOWN_AGENTS = [
  'yahoomailproxy',
  'bot',
  'crawler',
  'spider',
  'preview',
  'proofpoint',
  'mimecast',
  'barracuda',
  'safelinks',
  'urldefense',
  'symantec',
  'messagelabs',
  'trendmicro',
  'fortiguard',
  'python-requests',
  'python-urllib',
  'curl/',
  'wget/',
  'go-http-client',
  'okhttp',
  'java/',
  'headlesschrome',
  'phantomjs',
  'facebookexternalhit',
  'slackbot',
]

export interface Hit {
  userAgent: string | null | undefined
  /** `CF-Connecting-IP` — the client's address as Cloudflare saw it. */
  ip: string | null | undefined
  /** When the mail went out. Null when unknown, which skips the timing check. */
  sentAt: Date | null
  /** When the hit arrived. */
  at: Date
}

export function classifyOpen(hit: Hit): Verdict {
  const agent = (hit.userAgent ?? '').trim().toLowerCase()

  if (agent === '') return { machine: true, reason: 'no_user_agent' }
  if (KNOWN_AGENTS.some((k) => agent.includes(k))) return { machine: true, reason: 'known_agent' }
  // Apple's relays send a bare agent no real client sends, and Apple's own
  // fetches come from its 17.0.0.0/8 network.
  if (agent === 'mozilla/5.0' || isAppleNetwork(hit.ip)) {
    return { machine: true, reason: 'apple_privacy_proxy' }
  }
  if (hit.sentAt && hit.at.getTime() - hit.sentAt.getTime() < TOO_SOON_SECONDS * 1000) {
    return { machine: true, reason: 'too_soon' }
  }
  return { machine: false }
}

/** 17.0.0.0/8, including the IPv4-mapped IPv6 form. */
function isAppleNetwork(ip: string | null | undefined): boolean {
  if (!ip) return false
  const v4 = ip.trim().replace(/^::ffff:/i, '')
  const first = v4.split('.')
  return first.length === 4 && first[0] === '17'
}
