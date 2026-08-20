/**
 * The rollup rebuild, as plain SQL text.
 *
 * Lives on its own, importing nothing, because two very different callers need
 * exactly the same statements and must never drift apart: the Worker
 * (`core/purchases.ts`, via Drizzle) and the offline backfill
 * (`scripts/import-neon-purchases.ts`, via `wrangler d1 execute`). A rollup that
 * disagrees with itself depending on who rebuilt it is worse than no rollup.
 *
 * Wholesale rebuild, never an increment. `purchases` is a mirror — rows can be
 * corrected or vanish upstream, and a counter that was incremented for a row
 * that no longer exists is a number nobody can explain six months later.
 */
export const REBUILD_PURCHASE_STATS: string[] = [
  'DELETE FROM purchase_stats;',
  `INSERT INTO purchase_stats
     (email, order_count, lifetime_cents, confident_cents, first_at, last_at, computed_at)
   SELECT
     email,
     count(*),
     sum(amount_cents),
     sum(CASE WHEN confidence = 'high' THEN amount_cents ELSE 0 END),
     min(occurred_at),
     max(occurred_at),
     :now
   FROM purchases
   GROUP BY email;`,
]

/** The same statements with `:now` bound, for callers that cannot pass params. */
export function rebuildPurchaseStatsSql(nowMs: number): string[] {
  return REBUILD_PURCHASE_STATS.map((s) => s.replace(':now', String(nowMs)))
}
