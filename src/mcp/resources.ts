import type { McpServer } from '@modelcontextprotocol/server'
import type { Ctx } from './kit.ts'

/**
 * ⭐ The one page an agent has to read before it touches consent.
 *
 * Every mailer models "unsubscribed" as one global flag; this one does not, and
 * an agent that assumes the usual shape will cheerfully stop somebody's paid
 * onboarding because they left the newsletter. Stating the asymmetry plainly is
 * cheaper than catching it in every tool description.
 */
const CONVENTIONS = `# Kōlea conventions

## Consent is scoped, and that is the whole point

Three independent mechanisms. Confusing them is the most damaging mistake available here.

| Mechanism | Where | Stops | Does NOT stop |
|---|---|---|---|
| \`subscribers.status = 'unsubscribed'\` | subscriber row | broadcasts | sequences, transactional |
| \`sequence_optouts\` row | (subscriber, sequence) | that one sequence | broadcasts, other sequences, transactional |
| \`suppressions\` row | keyed by **address**, not person | everything marketing | transactional, unless the reason is hard_bounce or complaint |

Consequences worth holding onto:

- Somebody who left the newsletter still gets the onboarding series they signed up for.
- Leaving a sequence is a *standing preference*. \`sequence_enroll\` refuses anyone who left,
  and no operator action overrides that — only the subscriber can rejoin, from the
  preference center.
- Receipts and password resets are not marketing. An unsubscribe never blocks one.
- To stop mailing somebody, use \`suppression_add\`. \`subscriber_delete\` is for erasure
  requests and destroys their history, their messages and their purchases.

## Money

Integer cents, always. Never floats — revenue reports are read by a person who will notice.

A refund **flips the existing sale row** rather than adding an offsetting negative one. So a
refunded sale stops counting; it does not subtract. Summing without filtering on status
double-counts the reversal.

## Attribution

\`attributions\` is a ledger, one row per (person, campaign, source) — not a single overwritten
column. First-touch and last-touch are both just an ORDER BY away, so the attribution model is
never baked in.

A sale's campaign is resolved **once, at ingest**, from the buyer's most recent touch, and then
frozen. Re-running attribution later must not silently rewrite last quarter's numbers. That is
why \`sale_attribute\` exists as its own deliberate, audited tool.

## Broadcast audiences

A broadcast **copies** the segment rule when it is created. \`segment_id\` on a broadcast is
provenance only ("built from: Customers") and is never read at send time. Editing a saved
segment next month cannot rewrite who a sent broadcast went to.

## Sending

Irreversible sends go through preflight: \`broadcast_preflight\` → \`broadcast_send\`, and
\`sequence_preflight\` → \`sequence_activate\`. The token is single-use, expires in 10 minutes,
and is invalidated by any edit to the content or audience. There is no way around it, and there
should not be one.

## Observability

Cloudflare Workers logs are retained for 3–7 days, so **anything worth knowing is a row in D1**,
not a log line: \`mcp_calls\`, \`sync_runs\`, \`events\`, \`messages.suppressed_reason\`,
\`tag_rules.applied_count\`. When asked what happened, query — don't guess.

## Platform limits that bite

- D1 allows **1,000 queries per Worker invocation**. Loops over people are paged for this reason.
- Large broadcasts materialize recipients across several cron ticks and resume from a cursor.
`

const MERGE_TAGS = `# Merge tags

Supported in both a subject line and a body:

| Tag | Renders |
|---|---|
| \`{{name}}\` | The subscriber's name, or "there" when unknown |
| \`{{first_name}}\` | First word of their name, or "there" |
| \`{{email}}\` | Their address |

Anything else is **not substituted**. An unknown \`{{plan_name}}\` is delivered to the reader
verbatim, braces and all — it does not error, and it does not blank out.

\`broadcast_preflight\` lists unknown tags in its \`warnings\`, and that warning is the only
thing between a typo and a subscriber reading "Your {{plan_name}} plan". Check the preflight
output before sending, every time.
`

export function registerResources(server: McpServer, ctx: Ctx): void {
  server.registerResource(
    'conventions',
    'kolea://conventions',
    {
      title: 'Kōlea conventions',
      description:
        'How consent, money, attribution and sending actually work here. Read this before changing anything.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: CONVENTIONS }] }),
  )

  server.registerResource(
    'merge-tags',
    'kolea://merge-tags',
    {
      title: 'Merge tags',
      description: 'Which {{tags}} the email renderer understands.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: MERGE_TAGS }] }),
  )

  server.registerResource(
    'schema',
    'kolea://schema',
    {
      title: 'Database schema',
      description: 'Live SQLite DDL for every table. Read this before writing a db_query.',
      mimeType: 'text/plain',
    },
    async (uri) => {
      // Read from sqlite_master rather than shipping a copy: a schema doc that
      // drifts from the database is worse than no schema doc.
      const result = await ctx.env.DB.prepare(
        "select sql from sqlite_master where type in ('table','index') and name not like 'sqlite_%' and name not like '_cf_%' and sql is not null order by type desc, name",
      ).all<{ sql: string }>()

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/plain',
            text: result.results.map((r) => `${r.sql};`).join('\n\n'),
          },
        ],
      }
    },
  )

  server.registerResource(
    'stats',
    'kolea://stats/overview',
    {
      title: 'Live overview',
      description: 'Current list size, 30-day sends and engagement, revenue.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const since = Date.now() - 30 * 24 * 60 * 60 * 1000
      const audience = await ctx.env.DB.prepare(
        'select status, count(*) as n from subscribers group by status',
      ).all()
      const sends = await ctx.env.DB.prepare(
        'select status, count(*) as n from messages where created_at >= ?1 group by status',
      )
        .bind(since)
        .all()
      const engagement = await ctx.env.DB.prepare(
        'select type, count(*) as n from events where occurred_at >= ?1 group by type',
      )
        .bind(since)
        .all()

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                generatedAt: new Date().toISOString(),
                windowDays: 30,
                audience: audience.results,
                messages: sends.results,
                engagement: engagement.results,
                provider: ctx.env.EMAIL_PROVIDER,
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )
}
