/**
 * ⭐ D1's 1,000-queries-per-invocation cap, shared out across one cron tick.
 *
 * The minutely tick runs the sequence drip, a broadcast's pages and the
 * webhook deliveries in ONE Worker invocation, and D1 counts every statement
 * of all of them against the same 1,000. Each of those used to size itself as
 * if it had the invocation alone (200 enrollments ≈ 1,400 queries, four
 * broadcast pages ≈ 900), so a busy minute died partway through with mail
 * half-sent. A dead tick is worse than a slow one: everything here resumes
 * next minute, so the fix is to do less per minute, never to risk the cap.
 *
 * The accounting is deliberately coarse: each job knows roughly what one unit
 * of its work costs (an enrollment, a page, a delivery) and takes as many
 * units as fit. Estimates are upper bounds, and 100 queries of the cap are
 * held back for the small fixed costs nobody counts (the due-broadcast
 * lookup, a domain check, an import page).
 */
export const CRON_QUERY_BUDGET = 900

/** What is left of the invocation's queries. Jobs read it, take, and spend. */
export class QueryBudget {
  constructor(public remaining: number = CRON_QUERY_BUDGET) {}

  /** How many units costing `each` fit after `overhead`, capped at `max`. */
  fits(each: number, max: number, overhead = 0): number {
    return Math.max(0, Math.min(max, Math.floor((this.remaining - overhead) / each)))
  }

  spend(queries: number): void {
    this.remaining = Math.max(0, this.remaining - queries)
  }
}
