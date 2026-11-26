/**
 * How long a failed queue message waits before its next attempt.
 *
 * A retry with no delay is not a retry, it is the same failure again: the queue
 * redelivers within the second, the thing that was wrong is still wrong, and a
 * blip of a few seconds eats the whole retry budget and dead-letters mail that
 * was never bad. So every retry waits, and waits longer each time.
 */

/** The wait before the second attempt, at most. */
const BASE_SECONDS = 15
/** No computed wait is longer than this. */
const MAX_BACKOFF_SECONDS = 300
/** A provider may ask for longer than we would wait on our own; up to here we do as asked. */
const MAX_RETRY_AFTER_SECONDS = 900

export interface RetryDelayOptions {
  /** What the provider said to wait, if it said. Never undercut, only added to. */
  retryAfterSeconds?: number
  /**
   * A number in [0, 1). Pass one value for a whole batch so its messages come
   * back together as one batch — one provider request, not a hundred spread out.
   */
  jitter?: number
}

/**
 * Seconds to wait before attempt `attempt + 1`. `attempt` is the queue's own
 * count for the delivery that just failed, starting at 1.
 *
 * Exponential with jitter: between half and all of `15s × 2^(attempt-1)`,
 * capped at five minutes. The floor is what makes the retry budget mean time —
 * twelve retries are never less than about twenty minutes, whatever is rolled.
 * A provider's `retry-after` raises the wait and never lowers it.
 */
export function retryDelaySeconds(attempt: number, options: RetryDelayOptions = {}): number {
  const n = Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1
  const rolled = options.jitter ?? Math.random()
  const jitter = Number.isFinite(rolled) ? Math.min(Math.max(rolled, 0), 1) : 0

  const ceiling = Math.min(MAX_BACKOFF_SECONDS, BASE_SECONDS * 2 ** Math.min(n - 1, 30))
  const backoff = ceiling / 2 + (ceiling / 2) * jitter

  const asked = options.retryAfterSeconds
  if (asked === undefined || !Number.isFinite(asked) || asked <= 0) return Math.ceil(backoff)

  // Spread a little past the provider's mark too, so every consumer that was
  // told "one second" does not come back in the same one.
  const provider = Math.min(asked, MAX_RETRY_AFTER_SECONDS) + BASE_SECONDS * jitter
  return Math.ceil(Math.max(backoff, provider))
}
