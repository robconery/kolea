// gap.md "More than one person" — several people on one install, each in a
// role (owner, admin, writer), invited by an owner or admin.
// Ported from Kōlea SPEC 4.3 (roles per membership; owner/admin manage keys,
// domains, members and integrations; the account always keeps an owner), 4.4
// (members are invited by email; invitations expire and are revocable) and 4.7
// (every action audited, refusals with the reason). Accounts are left out: one
// install is one team. Identity stays with Cloudflare Access (decision: no app
// passwords, codes, OAuth or passkeys), so every scenario signs a real RS256
// Access JWT and drives `worker.fetch` through the real verification.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, desc, eq } from 'drizzle-orm'
import type { AuditEntry, TeamMember } from '../../src/db/schema.ts'
import { auditEntries, broadcasts, sequences, teamMembers } from '../../src/db/schema.ts'
import { minimumRole } from '../../src/web/roles.ts'
import { aBroadcast, aSequence } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

const TEAM = 'team-spec.cloudflareaccess.com'
const AUD = 'team-spec-aud'

// ───────────────────────────────────────────── real, signed Access tokens

const b64url = (bytes: Uint8Array | string) =>
  btoa(typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')

let realFetch: typeof fetch
let signer: CryptoKey

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  signer = pair.privateKey
  const jwk = { ...((await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey), kid: 'team-k1' }
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === `https://${TEAM}/cdn-cgi/access/certs`) {
      return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } })
    }
    return await realFetch(input, init)
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
})

/** An Access JWT for `email` (or, with null, a service token that names nobody). */
async function tokenFor(email: string | null): Promise<string> {
  const head = b64url(JSON.stringify({ alg: 'RS256', kid: 'team-k1' }))
  const body = b64url(
    JSON.stringify({
      aud: [AUD],
      iss: `https://${TEAM}`,
      exp: Math.floor(Date.now() / 1000) + 600,
      ...(email ? { email } : { common_name: 'a-service-token' }),
    }),
  )
  const sig = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer, new TextEncoder().encode(`${head}.${body}`)),
  )
  return `${head}.${body}.${b64url(sig)}`
}

/** A Worker deployed the way production is: Access configured, no bypass. */
const guarded = () => createWorld({ DEV_AUTH_BYPASS: 'false', CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD })

async function as(world: World, email: string | null, path: string, form?: Record<string, string>) {
  const token = await tokenFor(email)
  return await world.fetch(
    path,
    form
      ? {
          method: 'POST',
          headers: { 'cf-access-jwt-assertion': token, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(form),
        }
      : { headers: { 'cf-access-jwt-assertion': token } },
  )
}

const OWNER = 'owner@example.test'
const ADMIN = 'admin@example.test'
const WRITER = 'writer@example.test'

async function member(world: World, email: string): Promise<TeamMember | undefined> {
  return await world.db.select().from(teamMembers).where(eq(teamMembers.email, email)).get()
}

async function lastAudit(world: World): Promise<AuditEntry | undefined> {
  return await world.db.select().from(auditEntries).orderBy(desc(auditEntries.id)).get()
}

/** An install with an owner (the first arrival), an admin and a writer who have both arrived. */
async function aTeam(): Promise<World> {
  const world = guarded()
  await as(world, OWNER, '/')
  await as(world, OWNER, '/team/invite', { email: ADMIN, role: 'admin' })
  await as(world, OWNER, '/team/invite', { email: WRITER, role: 'writer' })
  await as(world, ADMIN, '/')
  await as(world, WRITER, '/')
  return world
}

describe('Feature: a team with roles', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: the first person through Access on an install with no team', () => {
    let world: World
    let status: number
    let row: TeamMember | undefined
    let audit: AuditEntry | undefined

    beforeAll(async () => {
      world = guarded()
      // An install upgraded from single-operator: data, but no team rows yet.
      await aBroadcast(world)
      status = (await as(world, 'Owner@Example.test', '/')).status
      row = await member(world, OWNER)
      audit = await lastAudit(world)
    })

    it('lets them in', () => {
      expect(status).toBe(200)
    })

    it('makes them the owner, under their address lowercased', () => {
      expect(row?.role).toBe('owner')
    })

    it('records them as joined', () => {
      expect(row?.joinedAt).toBeInstanceOf(Date)
    })

    it('puts the first owner in the audit trail', () => {
      expect(audit?.action).toBe('TEAM first owner')
    })
  })

  describe('Scenario: the owner invites a writer, who then arrives', () => {
    let world: World
    let inviteStatus: number
    let invited: TeamMember | undefined
    let arrival: number
    let joined: TeamMember | undefined

    beforeAll(async () => {
      world = guarded()
      await as(world, OWNER, '/')
      inviteStatus = (await as(world, OWNER, '/team/invite', { email: WRITER, role: 'writer' })).status
      invited = await member(world, WRITER)
      arrival = (await as(world, WRITER, '/')).status
      joined = await member(world, WRITER)
    })

    it('accepts the invitation', () => {
      expect(inviteStatus).toBe(302)
    })

    it('holds the invitation as not yet joined', () => {
      expect(invited?.joinedAt).toBeNull()
    })

    it('records who invited them', () => {
      expect(invited?.invitedBy).toBe(OWNER)
    })

    it('lets the writer in', () => {
      expect(arrival).toBe(200)
    })

    it('stamps them as joined on arrival', () => {
      expect(joined?.joinedAt).toBeInstanceOf(Date)
    })
  })

  describe('Scenario: a writer writes', () => {
    let world: World
    let draftId: number
    let created: number
    let createdSequence: number
    let edited: string | undefined
    let opened: number
    let stepAdded: number
    let audit: AuditEntry | undefined

    beforeAll(async () => {
      world = await aTeam()
      draftId = await aBroadcast(world)
      const seq = await aSequence(world, { active: false })
      created = (await as(world, WRITER, '/broadcasts', { subject: 'From the writer', body_md: 'Hi' })).status
      createdSequence = (await as(world, WRITER, '/sequences', { name: 'Welcome', trigger: 'manual' })).status
      await as(world, WRITER, `/broadcasts/${draftId}/edit`, { subject: 'Edited by the writer', audience: '' })
      edited = (await world.db.select().from(broadcasts).where(eq(broadcasts.id, draftId)).get())?.subject
      opened = (await as(world, WRITER, `/broadcasts/${draftId}`)).status
      stepAdded = (await as(world, WRITER, `/sequences/${seq.id}/steps`, { subject: 'Step two', body_md: 'Hello' }))
        .status
      audit = await lastAudit(world)
    })

    it('creates a draft broadcast', () => {
      expect(created).toBe(302)
    })

    it('creates a sequence', () => {
      expect(createdSequence).toBe(302)
    })

    it('edits a draft', () => {
      expect(edited).toBe('Edited by the writer')
    })

    it('opens a broadcast', () => {
      expect(opened).toBe(200)
    })

    it('adds a sequence step', () => {
      expect(stepAdded).toBe(302)
    })

    it('is recorded with their role', () => {
      expect(audit?.actorRole).toBe('writer')
    })
  })

  describe('Scenario: ⭐ a writer tries to change a live sequence', () => {
    // A changed step on a live sequence is mailed by the next tick with no
    // preflight; a changed trigger starts enrolling people.
    let world: World
    let liveEdit: number
    let pausedEdit: number

    beforeAll(async () => {
      world = await aTeam()
      const live = await aSequence(world, { name: 'Live one' })
      const paused = await aSequence(world, { name: 'Paused one', active: false })
      liveEdit = (await as(world, WRITER, `/sequences/${live.id}`, { name: 'Live one', trigger: 'subscribe' })).status
      pausedEdit = (await as(world, WRITER, `/sequences/${paused.id}`, { name: 'Paused one, renamed', trigger: 'manual' }))
        .status
    })

    it('is refused on the live one', () => {
      expect(liveEdit).toBe(403)
    })

    it('still works on a paused one', () => {
      expect(pausedEdit).not.toBe(403)
    })
  })

  describe('Scenario: an admin runs the install', () => {
    let world: World
    let settings: number
    let team: number
    let activated: boolean | undefined

    beforeAll(async () => {
      world = await aTeam()
      const seq = await aSequence(world, { active: false })
      settings = (await as(world, ADMIN, '/settings')).status
      team = (await as(world, ADMIN, '/team')).status
      await as(world, ADMIN, `/sequences/${seq.id}/toggle`, {})
      activated = (await world.db.select().from(sequences).where(eq(sequences.id, seq.id)).get())?.isActive
    })

    it('opens settings', () => {
      expect(settings).toBe(200)
    })

    it('opens the team screen', () => {
      expect(team).toBe(200)
    })

    it('switches a sequence on', () => {
      expect(activated).toBe(true)
    })
  })

  describe('Scenario: owners can be made, and unmade while another owner remains', () => {
    let world: World
    let promoted: TeamMember | undefined
    let demotedFirst: TeamMember | undefined

    beforeAll(async () => {
      world = await aTeam()
      const admin = (await member(world, ADMIN))!
      await as(world, OWNER, `/team/${admin.id}/role`, { role: 'owner' })
      promoted = await member(world, ADMIN)
      const owner = (await member(world, OWNER))!
      await as(world, ADMIN, `/team/${owner.id}/role`, { role: 'writer' })
      demotedFirst = await member(world, OWNER)
    })

    it('lets an owner make an admin an owner', () => {
      expect(promoted?.role).toBe('owner')
    })

    it('lets the new owner demote the old one', () => {
      expect(demotedFirst?.role).toBe('writer')
    })
  })

  // ───────────────────────────────────────────── refusals

  describe('Scenario: a writer reaches for what writers cannot do', () => {
    let world: World
    let draftId: number
    let seqId: number
    const statuses: Record<string, number> = {}
    let stillDraft: string | undefined
    let stillOff: boolean | undefined
    let audit: AuditEntry | undefined

    beforeAll(async () => {
      world = await aTeam()
      draftId = await aBroadcast(world)
      seqId = (await aSequence(world, { active: false })).id
      statuses.sendPage = (await as(world, WRITER, `/broadcasts/${draftId}/send`)).status
      statuses.send = (await as(world, WRITER, `/broadcasts/${draftId}/send`, { confirm: 'yes' })).status
      statuses.toggle = (await as(world, WRITER, `/sequences/${seqId}/toggle`, {})).status
      statuses.enroll = (await as(world, WRITER, `/sequences/${seqId}/enroll-all`, {})).status
      statuses.settings = (await as(world, WRITER, '/settings')).status
      statuses.keys = (await as(world, WRITER, '/settings/agents/keys', { name: 'mine' })).status
      statuses.webhooks = (await as(world, WRITER, '/webhooks', { url: 'https://example.test/hook' })).status
      statuses.domains = (await as(world, WRITER, '/domains', { domain: 'example.test' })).status
      statuses.team = (await as(world, WRITER, '/team')).status
      statuses.invite = (await as(world, WRITER, '/team/invite', { email: 'x@example.test', role: 'writer' })).status
      statuses.cleanup = (await as(world, WRITER, '/subscribers/clean-up', {})).status
      statuses.import = (await as(world, WRITER, '/imports', { source: 'kit' })).status
      statuses.unlisted = (await as(world, WRITER, '/a-route-nobody-listed')).status
      audit = await world.db
        .select()
        .from(auditEntries)
        .where(and(eq(auditEntries.actorId, WRITER), eq(auditEntries.action, 'POST /team/invite')))
        .get()
      stillDraft = (await world.db.select().from(broadcasts).where(eq(broadcasts.id, draftId)).get())?.status
      stillOff = (await world.db.select().from(sequences).where(eq(sequences.id, seqId)).get())?.isActive
    })

    it('refuses the send confirmation page', () => {
      expect(statuses.sendPage).toBe(403)
    })

    it('refuses sending a broadcast', () => {
      expect(statuses.send).toBe(403)
    })

    it('leaves the broadcast a draft', () => {
      expect(stillDraft).toBe('draft')
    })

    it('refuses switching a sequence on', () => {
      expect(statuses.toggle).toBe(403)
    })

    it('leaves the sequence off', () => {
      expect(stillOff).toBe(false)
    })

    it('refuses enrolling people', () => {
      expect(statuses.enroll).toBe(403)
    })

    it('refuses settings', () => {
      expect(statuses.settings).toBe(403)
    })

    it('refuses minting a key', () => {
      expect(statuses.keys).toBe(403)
    })

    it('refuses webhooks', () => {
      expect(statuses.webhooks).toBe(403)
    })

    it('refuses sending domains', () => {
      expect(statuses.domains).toBe(403)
    })

    it('refuses the team screen', () => {
      expect(statuses.team).toBe(403)
    })

    it('refuses inviting', () => {
      expect(statuses.invite).toBe(403)
    })

    it('refuses deleting people', () => {
      expect(statuses.cleanup).toBe(403)
    })

    it('refuses importing', () => {
      expect(statuses.import).toBe(403)
    })

    it('refuses a route the table does not list', () => {
      expect(statuses.unlisted).toBe(403)
    })

    it('records the refusal as denied', () => {
      expect(audit?.outcome).toBe('denied')
    })

    it('records the reason', () => {
      expect(audit?.detail).toBe('needs admin, signed in as writer')
    })
  })

  describe('Scenario: an admin reaches for an owner', () => {
    let world: World
    let ownerAfter: TeamMember | undefined
    let invitedOwner: TeamMember | undefined
    let location: string | null

    beforeAll(async () => {
      world = await aTeam()
      const owner = (await member(world, OWNER))!
      location = (await as(world, ADMIN, `/team/${owner.id}/role`, { role: 'writer' })).headers.get('location')
      await as(world, ADMIN, `/team/${owner.id}/remove`, {})
      ownerAfter = await member(world, OWNER)
      await as(world, ADMIN, '/team/invite', { email: 'another@example.test', role: 'owner' })
      invitedOwner = await member(world, 'another@example.test')
    })

    it('says why it was not changed', () => {
      expect(location).toContain('kind=warn')
    })

    it('leaves the owner an owner and on the team', () => {
      expect([ownerAfter?.role, ownerAfter?.removedAt]).toEqual(['owner', null])
    })

    it('cannot invite an owner', () => {
      expect(invitedOwner).toBeUndefined()
    })
  })

  describe('Scenario: the last owner tries to leave', () => {
    let world: World
    let demoteLocation: string | null
    let after: TeamMember | undefined

    beforeAll(async () => {
      world = await aTeam()
      const owner = (await member(world, OWNER))!
      demoteLocation = (await as(world, OWNER, `/team/${owner.id}/role`, { role: 'admin' })).headers.get('location')
      await as(world, OWNER, `/team/${owner.id}/remove`, {})
      after = await member(world, OWNER)
    })

    it('refuses the demotion, saying why', () => {
      expect(decodeURIComponent(demoteLocation ?? '')).toContain('the last owner cannot be demoted')
    })

    it('stays the owner, on the team', () => {
      expect([after?.role, after?.removedAt]).toEqual(['owner', null])
    })
  })

  describe('Scenario: somebody Access lets in who is not on the team', () => {
    let world: World
    let res: Response
    let body: string
    let row: TeamMember | undefined

    beforeAll(async () => {
      world = await aTeam()
      res = await as(world, 'stranger@example.test', '/')
      body = await res.text()
      row = await member(world, 'stranger@example.test')
    })

    it('is refused', () => {
      expect(res.status).toBe(403)
    })

    it('is told plainly why', () => {
      expect(body).toContain('nobody has invited it to the team')
    })

    it('does not become a member', () => {
      expect(row).toBeUndefined()
    })
  })

  describe('Scenario: a removed teammate comes back', () => {
    let world: World
    let status: number
    let draftId: number
    let edited: string | undefined

    beforeAll(async () => {
      world = await aTeam()
      draftId = await aBroadcast(world, { subject: 'Untouched' })
      const writer = (await member(world, WRITER))!
      await as(world, ADMIN, `/team/${writer.id}/remove`, {})
      status = (await as(world, WRITER, `/broadcasts/${draftId}/edit`, { subject: 'Changed', audience: '' })).status
      edited = (await world.db.select().from(broadcasts).where(eq(broadcasts.id, draftId)).get())?.subject
    })

    it('is refused on the next click', () => {
      expect(status).toBe(403)
    })

    it('changes nothing', () => {
      expect(edited).toBe('Untouched')
    })
  })

  describe('Scenario: an invitation older than seven days', () => {
    let status: number

    beforeAll(async () => {
      const world = guarded()
      await as(world, OWNER, '/')
      await as(world, OWNER, '/team/invite', { email: WRITER, role: 'writer' })
      await world.db
        .update(teamMembers)
        .set({ invitedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
        .where(eq(teamMembers.email, WRITER))
      status = (await as(world, WRITER, '/')).status
    })

    it('no longer lets them in', () => {
      expect(status).toBe(403)
    })
  })

  describe('Scenario: an Access token that names no email', () => {
    let status: number
    let rows: number

    beforeAll(async () => {
      const world = guarded()
      status = (await as(world, null, '/')).status
      rows = (await world.db.select().from(teamMembers).all()).length
    })

    it('is refused', () => {
      expect(status).toBe(403)
    })

    it('does not claim the empty install', () => {
      expect(rows).toBe(0)
    })
  })

  describe('Scenario: a non-member asks for the media list', () => {
    let status: number

    beforeAll(async () => {
      const world = await aTeam()
      status = (await as(world, 'stranger@example.test', '/api/media')).status
    })

    it('is refused', () => {
      expect(status).toBe(403)
    })
  })

  describe('Scenario: the route table, read directly', () => {
    it('needs an admin for a route nobody listed', () => {
      expect(minimumRole('GET', '/brand-new-screen')).toBe('admin')
    })

    it('never lets an encoded path borrow a writer rule', () => {
      expect(minimumRole('POST', '/broadcasts/1%2Fsend')).toBe('admin')
    })

    it('treats HEAD as GET', () => {
      expect(minimumRole('HEAD', '/broadcasts')).toBe('writer')
    })
  })
})
