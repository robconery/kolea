import { count, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { leaveSequence } from '../core/consent.ts'
import { createApiKey } from '../core/api-keys.ts'
import { slugify } from '../core/ids.ts'
import { enroll, tickSequences } from '../core/sequences.ts'
import { sendBroadcastNow, startBroadcast } from '../core/broadcasts.ts'
import { createSegment } from '../core/segments.ts'
import { drainQueued } from '../core/sending.ts'
import { findOrCreateTag, upsertSubscriber } from '../core/subscribers.ts'
import { getDb } from '../db/index.ts'
import {
  broadcasts,
  type DocNode,
  sequenceEnrollments,
  sequenceSteps,
  sequences,
  subscribers,
  tagRules,
} from '../db/schema.ts'
import type { Env } from '../types.ts'

export const seed = new Hono<{ Bindings: Env }>()

const PEOPLE: [string, string, string[]][] = [
  ['ada@example.com', 'Ada Lovelace', ['customer', 'ruby']],
  ['grace@example.com', 'Grace Hopper', ['customer']],
  ['alan@example.com', 'Alan Turing', ['ruby']],
  ['katherine@example.com', 'Katherine Johnson', ['customer', 'ruby']],
  ['margaret@example.com', 'Margaret Hamilton', ['customer']],
  ['linus@example.com', 'Linus Torvalds', []],
  ['barbara@example.com', 'Barbara Liskov', ['ruby']],
  ['donald@example.com', 'Donald Knuth', ['customer']],
  ['radia@example.com', 'Radia Perlman', []],
  ['ken@example.com', 'Ken Thompson', ['ruby']],
  ['jean@example.com', 'Jean Bartik', ['customer']],
  ['edsger@example.com', 'Edsger Dijkstra', []],
]

const ONBOARDING_STEPS: [string, string, number][] = [
  [
    'Welcome aboard',
    `Hi {{first_name}},

Thanks for picking up the course. Over the next few days I'll send you three short notes to get you moving.

First: [start here](https://example.com/start). It's about ten minutes.

Rob`,
    0,
  ],
  [
    'The part everyone skips',
    `{{first_name}}, most people skip the setup chapter and regret it around day three.

[Read it now](https://example.com/setup). It's short, I promise.

Rob`,
    2,
  ],
  [
    'One last thing',
    `That's the series done, {{first_name}}.

If you want more like this, the newsletter goes out most weeks. You're already on it.

Rob`,
    3,
  ],
]

const LAUNCH_STEPS: [string, string, number][] = [
  [
    "Something's coming",
    `Hi {{first_name}}, I'm opening the doors on the new workshop next week.

Nothing to do yet. Just a heads-up.

Rob`,
    0,
  ],
  [
    "It's open",
    `{{first_name}}, the workshop is live: [take a look](https://example.com/workshop).

Rob`,
    2,
  ],
]

const p = (...content: DocNode[]): DocNode => ({ type: 'paragraph', content })
const t = (text: string, ...marks: string[]): DocNode => ({
  type: 'text',
  text,
  ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}),
})

/** Seeded draft that exercises every block the email renderer knows about. */
const SHOWCASE_DOC: DocNode = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [t('Everything the editor can do')] },
    p(
      t('Hi '),
      { type: 'mergeTag', attrs: { field: 'first_name' } },
      t(', this paragraph has '),
      t('bold', 'bold'),
      t(', '),
      t('italic', 'italic'),
      t(', '),
      t('inline code', 'code'),
      t(', '),
      { type: 'text', text: 'a link', marks: [{ type: 'link', attrs: { href: 'https://example.com/post' } }] },
      t(' and '),
      t('a highlight', 'highlight'),
      t('.'),
    ),
    { type: 'heading', attrs: { level: 2 }, content: [t('Blocks')] },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [p(t('Drag the handle in the left margin to reorder me'))] },
        { type: 'listItem', content: [p(t("Press '/' on an empty line for the block menu"))] },
        { type: 'listItem', content: [p(t("Press '@' to insert a personalization field"))] },
      ],
    },
    {
      type: 'taskList',
      content: [
        {
          type: 'taskItem',
          attrs: { checked: true },
          content: [p(t('Checkboxes become glyphs in email'))],
        },
        { type: 'taskItem', attrs: { checked: false }, content: [p(t('Still to do'))] },
      ],
    },
    { type: 'blockquote', content: [p(t('Block quotes render with a left rule.'))] },
    {
      type: 'codeBlock',
      attrs: { language: 'ruby' },
      content: [
        {
          type: 'text',
          text: 'class Mailer\n  def deliver(subscriber)\n    puts "sending to #{subscriber.email}"\n  end\nend',
        },
      ],
    },
    { type: 'horizontalRule' },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', content: [p(t('Scope'))] },
            { type: 'tableHeader', content: [p(t('What leaving does'))] },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [p(t('One series'))] },
            { type: 'tableCell', content: [p(t('Stays on the list'))] },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [p(t('Everything'))] },
            { type: 'tableCell', content: [p(t('Fully suppressed'))] },
          ],
        },
      ],
    },
    {
      type: 'emailButton',
      attrs: { href: 'https://example.com/buy', background: '#1f6f5c', align: 'left' },
      content: [t('Read the whole thing')],
    },
    p(t('Drop an image anywhere in this editor and it uploads to R2 on the spot.')),
  ],
}

seed.post('/dev/seed', async (c) => {
  if (c.env.DEV_AUTH_BYPASS !== 'true') return c.text('Seeding is local-only.', 403)
  const db = getDb(c.env)

  const existing = await db.select({ n: count() }).from(subscribers).get()
  if ((existing?.n ?? 0) > 0) {
    return c.redirect('/?flash=Already seeded. Clear the database first.')
  }

  // Tags
  const tagIds = new Map<string, number>()
  for (const name of ['customer', 'ruby']) tagIds.set(name, await findOrCreateTag(db, name))

  // Sequences (created before subscribers so `subscribe`-triggered enrollment fires)
  const onboardingId = await makeSequence(
    db,
    'Ruby onboarding',
    'A short series for people who bought the course.',
    'tag_added',
    tagIds.get('ruby')!,
    ONBOARDING_STEPS,
  )
  const launchId = await makeSequence(
    db,
    'Workshop launch runway',
    'A few notes in the run-up to a new workshop.',
    'subscribe',
    null,
    LAUNCH_STEPS,
  )

  // People
  const ids: number[] = []
  for (const [email, name, tagNames] of PEOPLE) {
    const { id } = await upsertSubscriber(db, {
      email,
      name,
      source: 'seed',
      tagIds: tagNames.map((t) => tagIds.get(t)!).filter(Boolean),
    })
    if (id) ids.push(id)
  }

  // Make sure everyone is in the launch runway too, so there's something to leave.
  for (const id of ids) await enroll(db, launchId, id)

  // Send the first step of everything so the Outbox has real mail in it.
  // Drained synchronously: consent is re-checked at send time, so if the queue
  // delivered after the opt-outs below, those people would be correctly skipped
  // and the demo would show two suppressed messages instead of two happy ones.
  await tickSequences(c.env, db)
  await drainQueued(c.env, db)

  // ⭐ The demo that matters: two people leave ONE series and stay on the list.
  // The Consent screen and their subscriber pages show they're still active.
  if (ids[2]) await leaveSequence(db, ids[2], launchId)
  if (ids[5]) await leaveSequence(db, ids[5], launchId)

  // A sent broadcast, so stats aren't empty…
  const sentBroadcast = await db
    .insert(broadcasts)
    .values({
      subject: 'What I learned rewriting my mailer',
      bodyMd: `Hi {{first_name}},

I spent the weekend replacing my email provider. The short version: unsubscribing should not be all-or-nothing.

If you leave a series here, you stay on the list. That's the whole idea.

[The long version is on the blog](https://example.com/post).

Rob`,
      segment: {},
      status: 'draft',
      createdAt: new Date(),
    })
    .returning({ id: broadcasts.id })
  await startBroadcast(c.env, db, sentBroadcast[0]!.id)
  await drainQueued(c.env, db)
  // Run it once more: the first pass leaves the broadcast `sending` because the
  // messages were still queued at that moment. This flips it to `sent` now that
  // they've actually gone. (Cron would do the same on its next tick.)
  await sendBroadcastNow(c.env, db, sentBroadcast[0]!.id)

  // …and a draft that shows off the editor. Sequence steps below stay markdown
  // on purpose, so both the rich path and the legacy-conversion path are visible.
  await db.insert(broadcasts).values({
    subject: "Draft: everything the editor can do",
    bodyJson: SHOWCASE_DOC,
    bodyMd: '',
    segment: { includeTagIds: [tagIds.get('customer')!] },
    status: 'draft',
    createdAt: new Date(),
  })

  // A saved segment and a live auto-tag rule, so both screens have something
  // real on them. The rule is the interesting one: clicking the workshop link in
  // any mail tags you `workshop-interest` — and a `tag_added` sequence could
  // pick that up without another line of code.
  await createSegment(db, 'Customers, not yet on Ruby', {
    includeTagIds: [tagIds.get('customer')!],
    excludeTagIds: [tagIds.get('ruby')!],
  })

  await db.insert(tagRules).values({
    name: 'Clicked the workshop link',
    event: 'click',
    urlContains: '/workshop',
    tagId: await findOrCreateTag(db, 'workshop-interest'),
    isActive: true,
    createdAt: new Date(),
  })

  // An API key for the transactional endpoint, and an admin key for MCP. The
  // two are separate on purpose: a key that posts password resets has no
  // business rewriting sequences.
  const { token } = await createApiKey(db, 'Transactional (seed)', 'send')
  const { token: mcpToken } = await createApiKey(db, 'MCP (seed)', 'admin')

  const msg = `Seeded. Transactional key: ${token} · MCP admin key: ${mcpToken}`
  return c.redirect(`/?flash=${encodeURIComponent(msg)}`)
})

async function makeSequence(
  db: ReturnType<typeof getDb>,
  name: string,
  description: string,
  trigger: 'subscribe' | 'tag_added' | 'manual',
  triggerTagId: number | null,
  steps: [string, string, number][],
): Promise<number> {
  const inserted = await db
    .insert(sequences)
    .values({
      slug: slugify(name),
      name,
      description,
      trigger,
      triggerTagId,
      isActive: true,
      createdAt: new Date(),
    })
    .returning({ id: sequences.id })

  const id = inserted[0]!.id
  let position = 1
  for (const [subject, body, delayDays] of steps) {
    await db.insert(sequenceSteps).values({
      sequenceId: id,
      position,
      // First step is 0 (arrives on join); later steps are days apart. Use
      // "Fast-forward the clock" on the dashboard to watch it play out locally.
      delayDays,
      subject,
      bodyMd: body,
    })
    position++
  }
  return id
}

/**
 * Pull every pending sequence step forward to now, then run a tick.
 *
 * Delays are in days, so without this a multi-step sequence can't be exercised
 * locally without waiting until tomorrow. Local-only: it rewrites `next_run_at`,
 * which would be falsifying send history anywhere real.
 */
seed.post('/dev/fast-forward', async (c) => {
  if (c.env.DEV_AUTH_BYPASS !== 'true') return c.text('Fast-forward is local-only.', 403)
  const db = getDb(c.env)

  const now = new Date()
  await db
    .update(sequenceEnrollments)
    .set({ nextRunAt: now })
    .where(eq(sequenceEnrollments.status, 'active'))

  const sent = await tickSequences(c.env, db)
  await drainQueued(c.env, db)

  const msg =
    sent === 0
      ? 'Clock advanced: no steps were due (every active enrollment may be finished).'
      : `Clock advanced: ${sent} step${sent === 1 ? '' : 's'} sent. Check the Outbox.`
  return c.redirect(`/?flash=${encodeURIComponent(msg)}`)
})

seed.post('/dev/reset', async (c) => {
  if (c.env.DEV_AUTH_BYPASS !== 'true') return c.text('Reset is local-only.', 403)
  const db = getDb(c.env)
  // Order matters only where FKs are enforced; deleting parents last is safe either way.
  for (const table of ['events', 'dev_outbox', 'messages', 'sequence_optouts', 'sequence_enrollments', 'sequence_steps', 'sequences', 'tag_rules', 'broadcasts', 'segments', 'subscriber_tags', 'subscribers', 'tags', 'suppressions', 'api_keys']) {
    await c.env.DB.prepare(`delete from ${table}`).run()
  }
  // Reset autoincrement so a reseed produces the same ids every time — otherwise
  // links and bookmarks from the previous run point at rows that no longer exist.
  await c.env.DB.prepare('delete from sqlite_sequence').run().catch(() => {})
  await db.select({ n: count() }).from(subscribers).get()
  return c.redirect('/?flash=Database cleared.')
})
