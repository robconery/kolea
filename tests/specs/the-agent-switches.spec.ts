// gap.md "Agent send switch on screen" — agent sending is a setting in the admin
// SPEC 8.3. Ported from Kōlea SPEC 20.3 (`allow_agent_send`, off by default;
// the gated send tools) and Kōlea's `allow_agent_sensitive` switch.
//
// Two switches on Agents & keys (`/settings/agents`), stored in D1, both off
// until the operator turns them on:
//
// - **Agents may send mail.** Every MCP send tool asks `agentSendAllowed` in
//   `core/agents.ts`. Decision: `MCP_ALLOW_SEND="false"` is a hard override
//   that always wins; any other value, or none, lets the switch decide. The var
//   can take sending away and can never turn it on.
// - **Agents may make sensitive changes.** `subscriber_delete`,
//   `suppression_remove`, `subscriber_import_csv`, `sequence_rejoin_person`
//   (it overrides somebody's opt-out) and `apikey_create` ask
//   `agentSensitiveAllowed` first. Kōlea gates the first three (and webhooks,
//   which Big Mailer does not have); minting a key is added because a key is
//   lasting access an injected agent could carry out.
//
// Refusals are tool errors, so `defineTool` still writes them to `mcp_calls`
// as `denied`.
import { beforeAll, describe, expect, it } from 'bun:test'
import { and, count, eq } from 'drizzle-orm'
import { createApiKey } from '../../src/core/api-keys.ts'
import { leaveSequence, suppressAddress } from '../../src/core/consent.ts'
import { type McpCall, agentSettings, apiKeys, mcpCalls, sequenceOptouts, subscribers, suppressions } from '../../src/db/schema.ts'
import type { Env } from '../../src/types.ts'
import { aBroadcast, aPerson, aSequence } from '../support/factories.ts'
import { MCP_SECRET, type ToolCall, callTool } from '../support/mcp.ts'
import { createWorld, type World } from '../support/world.ts'

const ROB = 'rob@example.test'

function agentWorld(overrides: Partial<Env> = {}): World {
  return createWorld({ MCP_PATH_SECRET: MCP_SECRET, ...overrides })
}

async function anAgent(world: World): Promise<string> {
  return (await createApiKey(world.db, 'Claude', 'admin')).token
}

async function flip(world: World, which: 'send' | 'sensitive', value: 'on' | 'off') {
  return await world.post('/settings/agents/switches', { switch: which, value })
}

/** An agent asks for one test copy of a broadcast to Rob's own address. */
async function sendTest(world: World, token: string): Promise<ToolCall> {
  const id = await aBroadcast(world)
  return await callTool(world, token, 'broadcast_send_test', { id, to: ROB })
}

async function lastCall(world: World, tool: string): Promise<McpCall | undefined> {
  return await world.db.select().from(mcpCalls).where(eq(mcpCalls.tool, tool)).get()
}

describe('Feature: the operator decides on screen what agents may do', () => {
  // ───────────────────────────────────────────── happy path

  describe('Scenario: Rob turns agent sending on', () => {
    let world: World
    let response: Response
    let page: string
    let call: ToolCall

    beforeAll(async () => {
      world = agentWorld()
      await aPerson(world, { email: ROB, triggerSubscribeSequences: false })
      const token = await anAgent(world)
      response = await flip(world, 'send', 'on')
      page = await (await world.fetch('/settings/agents')).text()
      call = await sendTest(world, token)
      await world.settle()
    })

    it('goes back to the screen', () => {
      expect(response.headers.get('location')).toStartWith('/settings/agents')
    })

    it('stores the switch in the database', async () => {
      const row = await world.db.select().from(agentSettings).get()
      expect(row?.allowSend).toBe(true)
    })

    it('shows the switch on', () => {
      expect(page).toContain('data-switch="send">on</span>')
    })

    it('lets an agent send', () => {
      expect(call.result?.isError).toBeUndefined()
    })

    it('puts the mail in the outbox', async () => {
      expect(await world.outbox()).toHaveLength(1)
    })
  })

  describe('Scenario: Rob turns agent sending back off', () => {
    let world: World
    let call: ToolCall

    beforeAll(async () => {
      world = agentWorld()
      await aPerson(world, { email: ROB, triggerSubscribeSequences: false })
      const token = await anAgent(world)
      await flip(world, 'send', 'on')
      await flip(world, 'send', 'off')
      call = await sendTest(world, token)
      await world.settle()
    })

    it('refuses the next send at once, with no redeploy', () => {
      expect(call.result?.isError).toBe(true)
    })

    it('sends nothing', async () => {
      expect(await world.outbox()).toHaveLength(0)
    })
  })

  describe('Scenario: Rob allows sensitive changes', () => {
    let world: World
    let call: ToolCall
    let left: number | undefined

    beforeAll(async () => {
      world = agentWorld()
      const person = await aPerson(world, { triggerSubscribeSequences: false })
      const token = await anAgent(world)
      await flip(world, 'sensitive', 'on')
      call = await callTool(world, token, 'subscriber_delete', {
        id: person.id,
        confirm_email: person.email,
      })
      left = (await world.db.select({ n: count() }).from(subscribers).get())?.n
    })

    it('lets an agent delete a person', () => {
      expect(call.result?.isError).toBeUndefined()
    })

    it('deletes them', () => {
      expect(left).toBe(0)
    })
  })

  // ───────────────────────────────────────────── sad path

  describe('Scenario: nobody has touched the switches', () => {
    let world: World
    let call: ToolCall
    let audit: McpCall | undefined
    let page: string

    beforeAll(async () => {
      world = agentWorld()
      await aPerson(world, { email: ROB, triggerSubscribeSequences: false })
      call = await sendTest(world, await anAgent(world))
      await world.settle()
      audit = await lastCall(world, 'broadcast_send_test')
      page = await (await world.fetch('/settings/agents')).text()
    })

    it('⭐ refuses an agent send', () => {
      expect(call.result?.isError).toBe(true)
    })

    it('tells the agent where the switch is', () => {
      expect(call.text).toContain('Agents & keys')
    })

    it('⭐ sends nothing', async () => {
      expect(await world.outbox()).toHaveLength(0)
    })

    it('still writes the refusal to the audit log', () => {
      expect(audit?.outcome).toBe('denied')
    })

    it('shows both switches off', () => {
      expect(page.includes('data-switch="send">off') && page.includes('data-switch="sensitive">off')).toBe(true)
    })
  })

  describe('Scenario: the Worker config forces sending off while the switch is on', () => {
    let world: World
    let call: ToolCall
    let page: string

    beforeAll(async () => {
      world = agentWorld({ MCP_ALLOW_SEND: 'false' })
      await aPerson(world, { email: ROB, triggerSubscribeSequences: false })
      const token = await anAgent(world)
      await flip(world, 'send', 'on')
      call = await sendTest(world, token)
      await world.settle()
      page = await (await world.fetch('/settings/agents')).text()
    })

    it('⭐ refuses the send — the var wins', () => {
      expect(call.result?.isError).toBe(true)
    })

    it('names the var, so the agent does not send Rob to the switch', () => {
      expect(call.text).toContain('MCP_ALLOW_SEND')
    })

    it('sends nothing', async () => {
      expect(await world.outbox()).toHaveLength(0)
    })

    it('says on screen that the config overrides the switch', () => {
      expect(page).toContain('forced off')
    })
  })

  describe('Scenario: the Worker config says "true" but the switch is off', () => {
    let world: World
    let call: ToolCall

    beforeAll(async () => {
      world = agentWorld({ MCP_ALLOW_SEND: 'true' })
      await aPerson(world, { email: ROB, triggerSubscribeSequences: false })
      call = await sendTest(world, await anAgent(world))
      await world.settle()
    })

    it('⭐ still refuses — the var can take sending away, never turn it on', () => {
      expect(call.result?.isError).toBe(true)
    })
  })

  describe('Scenario: an agent tries a sensitive change while the switch is off', () => {
    let world: World
    let deleted: ToolCall
    let unsuppressed: ToolCall
    let imported: ToolCall
    let minted: ToolCall
    let audit: McpCall | undefined

    beforeAll(async () => {
      world = agentWorld()
      const person = await aPerson(world, { triggerSubscribeSequences: false })
      await suppressAddress(world.db, 'complainer@example.test', 'complaint')
      const token = await anAgent(world)

      deleted = await callTool(world, token, 'subscriber_delete', {
        id: person.id,
        confirm_email: person.email,
      })
      unsuppressed = await callTool(world, token, 'suppression_remove', {
        email: 'complainer@example.test',
      })
      imported = await callTool(world, token, 'subscriber_import_csv', {
        csv: 'email\nnew-person@example.test',
      })
      minted = await callTool(world, token, 'apikey_create', { name: 'Exfil', scope: 'admin' })
      audit = await lastCall(world, 'suppression_remove')
    })

    it('refuses the delete', () => {
      expect(deleted.result?.isError).toBe(true)
    })

    it('keeps the person', async () => {
      const n = (await world.db.select({ n: count() }).from(subscribers).get())?.n
      expect(n).toBe(1)
    })

    it('⭐ refuses lifting a suppression', () => {
      expect(unsuppressed.result?.isError).toBe(true)
    })

    it('⭐ keeps the suppression', async () => {
      const row = await world.db
        .select()
        .from(suppressions)
        .where(eq(suppressions.email, 'complainer@example.test'))
        .get()
      expect(row).toBeDefined()
    })

    it('refuses the import', () => {
      expect(imported.result?.isError).toBe(true)
    })

    it('imports nobody', async () => {
      const row = await world.db
        .select()
        .from(subscribers)
        .where(eq(subscribers.email, 'new-person@example.test'))
        .get()
      expect(row).toBeUndefined()
    })

    it('refuses minting a key', () => {
      expect(minted.result?.isError).toBe(true)
    })

    it('mints no key', async () => {
      const row = await world.db.select().from(apiKeys).where(eq(apiKeys.name, 'Exfil')).get()
      expect(row).toBeUndefined()
    })

    it('tells the agent where the switch is', () => {
      expect(unsuppressed.text).toContain('Agents & keys')
    })

    it('writes the refusal to the audit log', () => {
      expect(audit?.outcome).toBe('denied')
    })
  })

  describe('Scenario: an agent tries to undo somebody\'s sequence opt-out', () => {
    // ⭐ Leaving a series is the person's standing choice; only they undo it.
    // The operator side doing it is a sensitive change, off by default.
    let world: World
    let refused: ToolCall
    let optedOutAfterRefusal: boolean
    let allowed: ToolCall
    let optedOutAfterAllowed: boolean

    beforeAll(async () => {
      world = agentWorld()
      const person = await aPerson(world, { triggerSubscribeSequences: false })
      const seq = await aSequence(world)
      await leaveSequence(world.db, person.id, seq.id)
      const token = await anAgent(world)
      const optedOut = async () =>
        Boolean(await world.db.select().from(sequenceOptouts).where(eq(sequenceOptouts.subscriberId, person.id)).get())

      refused = await callTool(world, token, 'sequence_rejoin_person', { sequence_id: seq.id, subscriber_id: person.id })
      optedOutAfterRefusal = await optedOut()
      await flip(world, 'sensitive', 'on')
      allowed = await callTool(world, token, 'sequence_rejoin_person', { sequence_id: seq.id, subscriber_id: person.id })
      optedOutAfterAllowed = await optedOut()
    })

    it('is refused while sensitive changes are off', () => {
      expect(refused.result?.isError).toBe(true)
    })

    it('⭐ keeps their opt-out', () => {
      expect(optedOutAfterRefusal).toBe(true)
    })

    it('works once the operator allows sensitive changes', () => {
      expect(allowed.result?.isError).toBeFalsy()
    })

    it('says it overrode their choice', () => {
      expect(allowed.text).toContain('overrode their choice')
    })

    it('removes the opt-out then', () => {
      expect(optedOutAfterAllowed).toBe(false)
    })
  })

  describe('Scenario: sensitive changes are on, but sending is not', () => {
    let world: World
    let call: ToolCall

    beforeAll(async () => {
      world = agentWorld()
      await aPerson(world, { email: ROB, triggerSubscribeSequences: false })
      const token = await anAgent(world)
      await flip(world, 'sensitive', 'on')
      call = await sendTest(world, token)
      await world.settle()
    })

    it('keeps the two switches apart', () => {
      expect(call.result?.isError).toBe(true)
    })
  })

  describe('Scenario: a forged switch value', () => {
    let world: World
    let response: Response
    let rows: number | undefined

    beforeAll(async () => {
      world = agentWorld()
      response = await world.post('/settings/agents/switches', { switch: 'everything', value: 'on' })
      rows = (await world.db.select({ n: count() }).from(agentSettings).get())?.n
    })

    it('goes back with a warning', () => {
      expect(response.headers.get('location')).toContain('kind=warn')
    })

    it('changes nothing', () => {
      expect(rows).toBe(0)
    })
  })

  describe('Scenario: somebody without an Access session posts to the switch', () => {
    let world: World
    let status: number
    let rows: number | undefined

    beforeAll(async () => {
      world = agentWorld({
        DEV_AUTH_BYPASS: undefined,
        CF_ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
        CF_ACCESS_AUD: 'an-audience-tag',
      })
      status = (await flip(world, 'send', 'on')).status
      rows = (
        await world.db
          .select({ n: count() })
          .from(agentSettings)
          .where(and(eq(agentSettings.id, 1), eq(agentSettings.allowSend, true)))
          .get()
      )?.n
    })

    it('is turned away', () => {
      expect(status).toBe(403)
    })

    it('leaves sending off', () => {
      expect(rows).toBe(0)
    })
  })
})
