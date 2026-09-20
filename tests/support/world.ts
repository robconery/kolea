/**
 * The world a specification runs in.
 *
 * One call to `createWorld()` gives a spec a migrated database, a complete
 * `Env`, and the three real Worker entry points — `fetch`, `scheduled` and
 * `queue` — wired to it. Nothing in `src/` is stubbed: the domain, the routers,
 * the renderer and the console email provider are the production ones.
 *
 * The only fakes are at the platform boundary, which is exactly where
 * `docs/ARCHITECTURE.md` says the adapters belong:
 *
 * | Binding      | Fake                          | Why |
 * |--------------|-------------------------------|-----|
 * | `DB`         | SQLite via `support/d1.ts`    | D1 is SQLite. Real SQL, real FKs. |
 * | `SEND_QUEUE` | **absent**                    | `dispatch()` falls back to sending inline, so a spec never has to wait for a queue. That fallback is production code (`core/sending.ts`), not a test hook. |
 * | `MEDIA`/`DOWNLOADS` | in-memory buckets      | R2 holds bytes; no rule lives there. |
 * | `ASSETS`     | 404 fetcher                   | Static assets are Cloudflare's, not ours. |
 * | mail         | `EMAIL_PROVIDER=console`      | The kill switch (CLAUDE.md). Mail lands in `dev_outbox` and the spec reads it. |
 *
 * ⚠️ `EMAIL_PROVIDER` is `console` here and must stay that way. A spec that
 * flips it to `resend` would need `RESEND_API_KEY`, and the only thing standing
 * between a test suite and thirteen thousand real inboxes is that nothing in
 * this file can reach the wire.
 */
import { drizzle } from 'drizzle-orm/d1'
import type { Db } from '../../src/db/index.ts'
import * as schema from '../../src/db/schema.ts'
import { devOutbox } from '../../src/db/schema.ts'
import type { Env, SendJob } from '../../src/types.ts'
import worker from '../../src/worker.tsx'
import { freshD1 } from './d1.ts'
import { migrate } from './migrate.ts'

/** The origin every link in a rendered email is built against. */
export const PUBLIC_URL = 'https://mail.example.test'

export interface World {
  env: Env
  db: Db
  /**
   * Drive the Worker's `fetch` handler — the deployed entry point, not a router
   * imported from underneath it (bdd-specs rule 7).
   *
   * Background work started with `waitUntil` is *not* awaited, because the
   * transactional API deliberately answers before the provider does (SPEC 7.5).
   * Call `settle()` when a spec needs that work finished.
   */
  fetch(path: string, init?: RequestInit): Promise<Response>
  /** Same, for a form post — the shape every public page actually submits. */
  post(path: string, form: Record<string, string>): Promise<Response>
  /** Run the minutely cron: sequence ticks plus scheduled broadcast pages. */
  tick(): Promise<void>
  /** Await everything handed to `waitUntil`, including work it started itself. */
  settle(): Promise<void>
  /** Everything the console provider "sent", newest last. */
  outbox(): Promise<schema.DevOutboxItem[]>
  /** The single mail sent to an address. Throws if there is not exactly one. */
  mailTo(email: string): Promise<schema.DevOutboxItem>
}

/** An R2 bucket that keeps bytes in a Map. Enough for the upload paths. */
function fakeBucket(): R2Bucket {
  const store = new Map<string, Uint8Array>()
  return {
    async put(key: string, value: ArrayBuffer | Uint8Array) {
      store.set(key, new Uint8Array(value as ArrayBuffer))
      return { key } as never
    },
    async get(key: string) {
      const bytes = store.get(key)
      if (!bytes) return null
      return {
        // `new Response(bytes).body` rather than a Blob: `BlobPart` is a DOM
        // type and workerd's type set does not have it.
        body: new Response(bytes as unknown as BodyInit).body,
        arrayBuffer: async () => bytes.buffer,
        writeHttpMetadata() {},
      } as never
    },
    async delete(key: string | string[]) {
      for (const k of Array.isArray(key) ? key : [key]) store.delete(k)
    },
    async head(key: string) {
      return store.has(key) ? ({ key } as never) : null
    },
    async list() {
      return { objects: [...store.keys()].map((key) => ({ key })), truncated: false } as never
    },
  } as unknown as R2Bucket
}

export function createWorld(overrides: Partial<Env> = {}): World {
  const d1 = freshD1()
  migrate(d1)

  const tasks: Promise<unknown>[] = []

  const env: Env = {
    DB: d1,
    MEDIA: fakeBucket(),
    DOWNLOADS: fakeBucket(),
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) } as unknown as Fetcher,

    EMAIL_PROVIDER: 'console',
    FROM_EMAIL: 'rob@example.test',
    FROM_NAME: 'Rob',
    PUBLIC_URL,
    PREVIEW_EMAIL: 'rob@example.test',

    // The admin console is behind Cloudflare Access in production. A spec that
    // wants to prove the gate exists creates its own world without this.
    DEV_AUTH_BYPASS: 'true',

    ...overrides,
  }

  const db = drizzle(env.DB, { schema }) as unknown as Db

  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      tasks.push(promise)
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext

  const settle = async () => {
    // Draining rather than iterating: a task may queue another task.
    while (tasks.length > 0) await Promise.all(tasks.splice(0, tasks.length))
  }

  return {
    env,
    db,

    async fetch(path, init) {
      const url = path.startsWith('http') ? path : `${PUBLIC_URL}${path}`
      return await worker.fetch(new Request(url, init), env, ctx)
    },

    async post(path, form) {
      const body = new URLSearchParams(form)
      return await this.fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      })
    },

    async tick() {
      await worker.scheduled({ cron: '*/1 * * * *' } as ScheduledController, env, ctx)
      await settle()
    },

    settle,

    async outbox() {
      return await db.select().from(devOutbox).orderBy(devOutbox.id).all()
    },

    async mailTo(email) {
      const all = await this.outbox()
      const mine = all.filter((m) => m.toEmail === email)
      if (mine.length !== 1) {
        throw new Error(
          `Expected exactly one mail to ${email}, found ${mine.length}: ` +
            `${mine.map((m) => m.subject).join(' | ') || '(none)'}`,
        )
      }
      return mine[0]!
    },
  }
}

/** Convenience for the queue-consumer specs: one batch of message ids. */
export function sendBatchOf(messageIds: number[], queue = 'big-mailer-send') {
  const acked: number[] = []
  const retried: number[] = []
  const batch = {
    queue,
    messages: messageIds.map((messageId) => ({
      id: `msg-${messageId}`,
      timestamp: new Date(),
      body: { messageId } as SendJob,
      attempts: 1,
      ack: () => acked.push(messageId),
      retry: () => retried.push(messageId),
    })),
    retryAll: () => retried.push(...messageIds),
    ackAll: () => acked.push(...messageIds),
  }
  return { batch: batch as unknown as MessageBatch<SendJob>, acked, retried }
}
