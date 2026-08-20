import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { getDb } from '../db/index.ts'
import { subscribers, suppressions } from '../db/schema.ts'
import {
  leaveSequence,
  parseScope,
  preferencesFor,
  rejoinSequence,
  resubscribeBroadcasts,
  unsubscribeAll,
  unsubscribeBroadcasts,
} from '../core/consent.ts'
import { normalizeEmail } from '../core/ids.ts'
import type { Env } from '../types.ts'
import { PublicLayout } from './layout.tsx'

/**
 * ⭐ The preference center.
 *
 * The failure this project exists to fix: on Kit, one unsubscribe click removes
 * a person from everything, forever. Here the narrow action is the prominent
 * one, "leave everything" is a deliberate separate choice, and every decision is
 * reversible by the reader without talking to anyone.
 *
 * Public, token-only, no session, no JavaScript.
 */
export const prefs = new Hono<{ Bindings: Env }>()

async function loadByToken(env: Env, token: string) {
  const db = getDb(env)
  const sub = await db.select().from(subscribers).where(eq(subscribers.unsubToken, token)).get()
  return { db, sub }
}

const NotFound = () => (
  <PublicLayout title="Email preferences">
    <h1>Link not recognized</h1>
    <p class="lede">
      This preference link is no longer valid. If you're trying to stop receiving email, reply to
      any message and it'll be handled.
    </p>
  </PublicLayout>
)

prefs.get('/p/:token', async (c) => {
  const { db, sub } = await loadByToken(c.env, c.req.param('token'))
  if (!sub) return c.html(<NotFound />, 404)

  const scope = parseScope(c.req.query('scope'))
  const done = c.req.query('done')
  const rows = await preferencesFor(db, sub.id)
  const globallyOff = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(eq(suppressions.email, normalizeEmail(sub.email)))
    .get()

  const focusId = scope?.kind === 'sequence' ? scope.sequenceId : null
  const ordered = [...rows].sort((a, b) =>
    a.sequenceId === focusId ? -1 : b.sequenceId === focusId ? 1 : 0,
  )

  const messages: Record<string, string> = {
    left: "Done. You've been removed from that series. Everything else is untouched.",
    rejoined: "You're back on that series.",
    unsub_broadcast: "You're off the newsletter. Any series you joined will keep going.",
    resub_broadcast: "You're back on the newsletter.",
    all: "You've been unsubscribed from everything.",
  }

  return c.html(
    <PublicLayout title="Email preferences">
      <h1>Your email preferences</h1>
      <p class="lede">
        {sub.email}: choose exactly what you want. Leaving one series doesn't remove you from
        anything else.
      </p>

      {done && messages[done] ? <div class="flash">{messages[done]}</div> : null}

      {globallyOff ? (
        <div class="flash warn">
          You're currently unsubscribed from all email. Turn something back on below if you'd like.
        </div>
      ) : null}

      <form method="post" action={`/p/${sub.unsubToken}`}>
        {ordered.length > 0 ? (
          <>
            <h3 style="margin-bottom:6px">Series</h3>
            {ordered.map((r) => {
              const focused = r.sequenceId === focusId
              return (
                <div class={focused ? 'pref-item focus' : 'pref-item'}>
                  <div class="txt">
                    {focused ? <div class="tag-focus">You came here from this one</div> : null}
                    <div class="nm">{r.name}</div>
                    {r.description ? <div class="ds">{r.description}</div> : null}
                    {r.optedOut ? <div class="ds">Not receiving this.</div> : null}
                  </div>
                  {r.optedOut ? (
                    <button
                      class="btn sm"
                      name="action"
                      value={`rejoin:${r.sequenceId}`}
                      type="submit"
                    >
                      Rejoin
                    </button>
                  ) : (
                    <button
                      class={focused ? 'btn accent' : 'btn sm'}
                      name="action"
                      value={`leave:${r.sequenceId}`}
                      type="submit"
                    >
                      {focused ? 'Stop just this series' : 'Stop this'}
                    </button>
                  )}
                </div>
              )
            })}
          </>
        ) : null}

        <h3 style="margin:26px 0 6px">Newsletter</h3>
        <div class={scope?.kind === 'broadcast' ? 'pref-item focus' : 'pref-item'}>
          <div class="txt">
            {scope?.kind === 'broadcast' ? (
              <div class="tag-focus">You came here from this one</div>
            ) : null}
            <div class="nm">The newsletter</div>
            <div class="ds">Occasional broadcasts. Separate from any series above.</div>
          </div>
          {sub.status === 'unsubscribed' ? (
            <button class="btn sm" name="action" value="resub_broadcast" type="submit">
              Resubscribe
            </button>
          ) : (
            <button
              class={scope?.kind === 'broadcast' ? 'btn accent' : 'btn sm'}
              name="action"
              value="unsub_broadcast"
              type="submit"
            >
              Unsubscribe
            </button>
          )}
        </div>

        <div class="nuke">
          <p class="faint" style="margin-bottom:10px">
            Would rather not hear from us at all? This stops everything, including anything you
            join later.
          </p>
          <button class="btn" name="action" value="unsub_all" type="submit">
            Unsubscribe from everything
          </button>
        </div>
      </form>
    </PublicLayout>,
  )
})

prefs.post('/p/:token', async (c) => {
  const token = c.req.param('token')
  const { db, sub } = await loadByToken(c.env, token)
  if (!sub) return c.html(<NotFound />, 404)

  const form = await c.req.formData()
  const action = String(form.get('action') ?? '')
  let done = ''

  const leave = /^leave:(\d+)$/.exec(action)
  const rejoin = /^rejoin:(\d+)$/.exec(action)

  if (leave) {
    done = (await leaveSequence(db, sub.id, Number(leave[1]))) ? 'left' : ''
  } else if (rejoin) {
    await rejoinSequence(db, sub.id, Number(rejoin[1]))
    done = 'rejoined'
  } else if (action === 'unsub_broadcast') {
    await unsubscribeBroadcasts(db, sub.id)
    done = 'unsub_broadcast'
  } else if (action === 'resub_broadcast') {
    await resubscribeBroadcasts(db, sub.id)
    done = 'resub_broadcast'
  } else if (action === 'unsub_all') {
    await unsubscribeAll(db, sub.id, sub.email)
    done = 'all'
  }

  // POST-redirect-GET keeps it idempotent on refresh (SPEC 2a.5).
  return c.redirect(`/p/${token}?done=${done}`, 303)
})

/**
 * RFC 8058 one-click, used by mail clients' own unsubscribe button.
 * Acts on the NARROW scope the email was sent under — a sequence email's
 * one-click leaves that sequence, not the whole list.
 */
prefs.all('/p/:token/one-click', async (c) => {
  const token = c.req.param('token')
  const { db, sub } = await loadByToken(c.env, token)
  if (!sub) return c.html(<NotFound />, 404)

  const scope = parseScope(c.req.query('scope'))
  if (scope?.kind === 'sequence') {
    await leaveSequence(db, sub.id, scope.sequenceId)
    return c.redirect(`/p/${token}?done=left`, 303)
  }
  await unsubscribeBroadcasts(db, sub.id)
  return c.redirect(`/p/${token}?done=unsub_broadcast`, 303)
})
