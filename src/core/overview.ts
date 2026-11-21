import { count, eq, gte } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { broadcasts, campaigns, events, messages, sequences, subscribers } from '../db/schema.ts'
import { type RevenueTotals, revenueTotals } from './sales.ts'

const DAY_MS = 24 * 60 * 60 * 1000

export interface Overview {
  windowDays: number
  audience: Record<string, number>
  messages: Record<string, number>
  engagement: Record<string, number | string>
  revenue: RevenueTotals[]
  liveSequences: number
  activeCampaigns: number
  draftBroadcasts: number
}

/**
 * The whole mailer at a glance over a window: list size by status, sends and
 * engagement, revenue, live sequences and campaigns. Seven grouped queries,
 * whatever the size of the list. Shared by MCP `stats_overview` and
 * `GET /api/v1/stats`.
 */
export async function statsOverview(db: Db, days = 30): Promise<Overview> {
  const window = Math.min(Math.max(Math.floor(days), 1), 365)
  const since = new Date(Date.now() - window * DAY_MS)

  const [byStatus, sends, engagement, liveSequences, activeCampaigns, totals, drafts] =
    await Promise.all([
      db.select({ status: subscribers.status, n: count() }).from(subscribers).groupBy(subscribers.status).all(),
      db
        .select({ status: messages.status, n: count() })
        .from(messages)
        .where(gte(messages.createdAt, since))
        .groupBy(messages.status)
        .all(),
      db
        .select({ type: events.type, machine: events.machine, n: count() })
        .from(events)
        .where(gte(events.occurredAt, since))
        .groupBy(events.type, events.machine)
        .all(),
      db.select({ n: count() }).from(sequences).where(eq(sequences.isActive, true)).get(),
      db.select({ n: count() }).from(campaigns).where(eq(campaigns.status, 'active')).get(),
      revenueTotals(db, since.getTime()),
      db.select({ n: count() }).from(broadcasts).where(eq(broadcasts.status, 'draft')).get(),
    ])

  const sent = sends.find((s) => s.status === 'sent')?.n ?? 0
  // Reader opens only; machine opens (Apple MPP, scanners) are counted apart.
  const opens = engagement.find((e) => e.type === 'open' && !e.machine)?.n ?? 0
  const machineOpens = engagement.find((e) => e.type === 'open' && e.machine)?.n ?? 0
  const clicks = engagement.find((e) => e.type === 'click')?.n ?? 0
  const pct = (n: number) => (sent ? `${Math.round((n / sent) * 100)}%` : 'n/a')

  return {
    windowDays: window,
    audience: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    messages: Object.fromEntries(sends.map((r) => [r.status, r.n])),
    engagement: {
      ...Object.fromEntries(engagement.filter((r) => !r.machine).map((r) => [r.type, r.n])),
      machineOpens,
      // Rates against `sent`, not against delivered — the mailer only knows
      // it handed the message over, and pretending otherwise inflates them.
      openRate: pct(opens),
      clickRate: pct(clicks),
    },
    revenue: totals,
    liveSequences: liveSequences?.n ?? 0,
    activeCampaigns: activeCampaigns?.n ?? 0,
    draftBroadcasts: drafts?.n ?? 0,
  }
}
