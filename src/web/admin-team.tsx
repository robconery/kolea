import { type Context, Hono } from 'hono'
import {
  type Actor,
  changeRole,
  grantableRoles,
  INVITE_DAYS,
  invite,
  isRole,
  listTeam,
  manages,
  removeMember,
  stateOf,
} from '../core/team.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { Flash, Layout } from './layout.tsx'
import { roleOf } from './roles.ts'

/**
 * Team: who may use this console, and as what.
 *
 * Admin and up, by the default of the route table in `web/roles.ts`. Every rule
 * (who may grant which role, the last owner) is in `core/team.ts`; this file
 * reads a form and redirects with what happened.
 *
 * Signing in is Cloudflare Access's job. Inviting someone here gives them a role
 * for when they arrive; it does not let them through Access, and it sends no
 * mail. The screen says both, because the first thing an invitee will hit
 * otherwise is the Access login page with no way past it.
 */
export const teamAdmin = new Hono<{ Bindings: Env }>()

const ROLE_HELP = {
  owner: 'Everything, including other owners.',
  admin: 'Everything except managing owners: sending, settings, keys, agents, webhooks, domains, imports, the team.',
  writer: 'Writes and edits broadcasts, posts and sequences. Cannot send, schedule, switch a sequence on, or change settings.',
} as const

function actorOf(c: Context): Actor {
  return {
    email: (c.get('operatorEmail' as never) as unknown as string | null | undefined) ?? null,
    role: roleOf(c) ?? 'writer',
  }
}

const back = (msg: string, warn = false) => `/team?flash=${encodeURIComponent(msg)}${warn ? '&kind=warn' : ''}`

teamAdmin.get('/team', async (c) => {
  const db = getDb(c.env)
  const me = actorOf(c)
  const team = await listTeam(db)
  const grantable = grantableRoles(me.role)
  const now = new Date()
  const consoleUrl = new URL(c.req.url).origin

  return c.html(
    <Layout title="Team" nav="team">
      <div class="head">
        <div>
          <h1>Team</h1>
          <div class="sub">
            The people who can use this console, and what each can do. You are{' '}
            {me.email ? <code>{me.email}</code> : 'the local developer'}, {me.role === 'admin' ? 'an' : 'a'} {me.role}.
          </div>
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-h">
          <h2>On the team</h2>
          <span class="pill">{team.length}</span>
        </div>
        <div class="card-b">
          <table>
            <thead>
              <tr>
                <th>Address</th>
                <th>Role</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {team.map((m) => {
                const state = stateOf(m, now)
                const mine = manages(me.role, m.role)
                const form = `role-${m.id}`
                return (
                  <tr>
                    <td class="mono">
                      {m.email}
                      {m.email === me.email ? <span class="faint"> (you)</span> : null}
                    </td>
                    <td>
                      {mine ? (
                        <>
                          <form id={form} method="post" action={`/team/${m.id}/role`} />
                          <select name="role" form={form} aria-label={`Role for ${m.email}`}>
                            {grantable.map((r) => (
                              <option value={r} selected={r === m.role}>
                                {r}
                              </option>
                            ))}
                          </select>{' '}
                          <button class="btn sm" form={form}>
                            Change
                          </button>
                        </>
                      ) : (
                        m.role
                      )}
                    </td>
                    <td>
                      {state === 'member' && m.joinedAt ? (
                        <span class="faint">joined {m.joinedAt.toISOString().slice(0, 10)}</span>
                      ) : state === 'expired' ? (
                        <span class="pill">invitation expired</span>
                      ) : (
                        <span class="pill">invited {m.invitedAt.toISOString().slice(0, 10)}</span>
                      )}
                    </td>
                    <td>
                      {mine ? (
                        <form method="post" action={`/team/${m.id}/remove`}>
                          <button class="btn sm danger">{state === 'member' ? 'Remove' : 'Withdraw'}</button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p class="faint" style="margin:14px 0 0">
            There is always at least one owner: the last one cannot be removed or made anything else. Removing someone
            takes effect on their next click.
          </p>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Invite someone</h2>
        </div>
        <div class="card-b">
          <form method="post" action="/team/invite" style="display:flex;gap:10px;flex-wrap:wrap;align-items:end">
            <label>
              Email
              <input type="email" name="email" required maxlength={200} placeholder="name@example.com" />
            </label>
            <label>
              Role
              <select name="role">
                {grantable.map((r) => (
                  <option value={r} selected={r === 'writer'}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <button class="btn primary">Invite</button>
          </form>
          <ul class="faint" style="margin:14px 0 0">
            {grantable.map((r) => (
              <li>
                <strong>{r}</strong>: {ROLE_HELP[r]}
              </li>
            ))}
          </ul>
          <p style="margin:14px 0 0">
            <strong>They also have to be allowed by Cloudflare Access.</strong> An invitation gives the address a role
            here; it does not get them past Access. Add the address (or a group it is in) to the Access policy for
            this console, then send them <code>{consoleUrl}</code> yourself. Kōlea sends no invitation mail. They sign
            in with whatever Access offers (an emailed code, GitHub, Google, a passkey) and land as their role. An
            invitation lasts {INVITE_DAYS} days.
          </p>
        </div>
      </div>
    </Layout>,
  )
})

teamAdmin.post('/team/invite', async (c) => {
  const form = await c.req.formData()
  const role = String(form.get('role') ?? '')
  if (!isRole(role)) return c.redirect(back('Pick a role.', true))
  const r = await invite(getDb(c.env), actorOf(c), String(form.get('email') ?? ''), role)
  if (!r.ok) return c.redirect(back(`Not invited: ${r.reason}.`, true))
  return c.redirect(
    back(`Invited ${r.member.email} as ${r.member.role}. Make sure your Access policy lets them in, then send them the link.`),
  )
})

teamAdmin.post('/team/:id/role', async (c) => {
  const form = await c.req.formData()
  const role = String(form.get('role') ?? '')
  if (!isRole(role)) return c.redirect(back('Pick a role.', true))
  const r = await changeRole(getDb(c.env), actorOf(c), Number(c.req.param('id')), role)
  if (!r.ok) return c.redirect(back(`Not changed: ${r.reason}.`, true))
  return c.redirect(back(`${r.member.email} is now ${r.member.role === 'writer' ? 'a' : 'an'} ${r.member.role}.`))
})

teamAdmin.post('/team/:id/remove', async (c) => {
  const r = await removeMember(getDb(c.env), actorOf(c), Number(c.req.param('id')))
  if (!r.ok) return c.redirect(back(`Not removed: ${r.reason}.`, true))
  return c.redirect(back(`${r.member.email} is off the team.`))
})
