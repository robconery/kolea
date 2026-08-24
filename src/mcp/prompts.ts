import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'

/**
 * Prompts are surfaced to a person as slash commands, not picked by the model.
 * Each one is a whole workflow — the sequence of tool calls that answers the
 * question properly, rather than the first tool whose name matched.
 */

const user = (text: string) => ({
  messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
})

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'weekly-review',
    {
      title: 'Weekly review',
      description: 'What the mailer did this week, and what needs attention.',
      argsSchema: z.object({
        days: z.string().optional().describe('Window in days, default 7'),
      }),
    },
    ({ days }) =>
      user(
        [
          `Give me a review of the last ${days ?? 7} days of Kōlea.`,
          '',
          'Work through these, then write the summary:',
          '1. `stats_overview` for the window — list growth, sends, open and click rates, revenue.',
          '2. `broadcast_list` — what went out, and `broadcast_stats` on each one that did.',
          '3. `message_list` with status "failed" and status "suppressed" — anything not landing?',
          '4. `sequence_list` — are the live ones actually sending, or is something enrolled but idle?',
          '5. `revenue_by_campaign` and `sales_unattributed` — where is the money, and what is uncredited?',
          '6. `health` — provider, queue backlog, anything stuck.',
          '',
          'Lead with the two or three things that need a decision. Numbers second.',
          'Say plainly if something looks broken; do not soften it.',
        ].join('\n'),
      ),
  )

  server.registerPrompt(
    'launch-campaign',
    {
      title: 'Set up a campaign',
      description: 'Build a campaign end to end: campaign, form, sequence, announcement broadcast.',
      argsSchema: z.object({
        name: z.string().describe('What is being launched'),
        goal: z.string().optional().describe('Revenue target, e.g. "$5000"'),
      }),
    },
    ({ name, goal }) =>
      user(
        [
          `Set up a campaign for: ${name}.${goal ? ` Revenue goal: ${goal}.` : ''}`,
          '',
          'Read `kolea://conventions` first if you have not this session.',
          '',
          'Then propose — do not create yet — a plan covering:',
          '- the campaign itself (`campaign_create`)',
          '- a signup form pointing at it, and which tags it should apply (`form_create`)',
          '- a welcome/nurture sequence: how many steps, what each says, the delay between them',
          '- an announcement broadcast, and who it should go to (`segment_preview` the audience first)',
          '',
          'Show me the plan with the actual subject lines and audience sizes. Once I approve it,',
          'build it — but leave the sequence paused and the broadcast as a draft.',
          'I will run the preflights myself.',
        ].join('\n'),
      ),
  )

  server.registerPrompt(
    'reconcile-stripe',
    {
      title: 'Reconcile Stripe',
      description: 'Pull Stripe charges, credit them to campaigns, and fix what the heuristic missed.',
      argsSchema: z.object({
        since: z.string().optional().describe('ISO date; defaults to the last sync cursor'),
      }),
    },
    ({ since }) =>
      user(
        [
          `Reconcile Stripe against campaigns${since ? ` since ${since}` : ''}.`,
          '',
          '1. `sync_runs_list` — when did this last run, and did it succeed?',
          `2. \`stripe_sync_preview\`${since ? `({ since: "${since}" })` : ''} — show me what it would do before it does it.`,
          '3. If the preview looks right, `stripe_sync_run`.',
          '4. `sales_unattributed` — for each one, look at the buyer’s touch history and say which',
          '   campaign it probably belongs to, and how confident you are.',
          '5. Propose the `sale_attribute` calls. Do not run them until I say so — that tool',
          '   rewrites stored revenue history.',
          '',
          'Flag anything that looks like a duplicate charge or a refund that did not land.',
        ].join('\n'),
      ),
  )

  server.registerPrompt(
    'draft-broadcast',
    {
      title: 'Draft a broadcast',
      description: 'Write and stage a broadcast, without sending it.',
      argsSchema: z.object({
        topic: z.string().describe('What it is about'),
        audience: z.string().optional().describe('Who it should reach, in plain words'),
      }),
    },
    ({ topic, audience }) =>
      user(
        [
          `Draft a broadcast about: ${topic}.`,
          audience ? `Audience: ${audience}.` : 'Ask me who it should go to before you build the audience.',
          '',
          'Write it in my voice — use the `rob-writing` skill if it is available.',
          'Check `kolea://merge-tags` before using any {{tag}}.',
          '',
          'Then:',
          '- `tag_list` and `segment_list` to see what exists',
          '- `segment_preview` the audience so I can see the real number before anything is created',
          '- `broadcast_create` as a draft',
          '- `broadcast_preflight` and show me the output',
          '',
          'Stop there. I will decide whether to send.',
        ].join('\n'),
      ),
  )
}
