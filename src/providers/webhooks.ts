/**
 * The port that POSTs a signed webhook to an operator's endpoint.
 *
 * `core/webhooks.ts` decides *whether* and *what* to send (SSRF policy,
 * signature, retries); this file only puts bytes on the wire and reports what
 * came back. Two adapters, picked by `WEBHOOK_TRANSPORT` in `Env`:
 *
 * - `fetch` (the default, and production): one `fetch` with
 *   `redirect: 'manual'`, so a 3xx can never bounce the request somewhere the
 *   URL check did not approve, a hard timeout, and only the head of the answer
 *   read, so a receiver cannot make a delivery read an endless body.
 * - `fake` (the test suite): never touches the network. Records each request
 *   and answers whatever the spec scripted, 200 otherwise.
 *
 * Name resolution is the platform's: a Worker cannot pin the address it
 * connects to, so the IP-literal half of the SSRF policy is enforced on the URL
 * and Cloudflare's own egress refuses private ranges.
 */

export interface WebhookRequest {
  url: string
  headers: Record<string, string>
  body: string
}

export type WebhookResponse =
  | { ok: true; status: number; body: string }
  | { ok: false; error: string }

export interface WebhookTransport {
  readonly name: string
  post(req: WebhookRequest): Promise<WebhookResponse>
}

/** Ten seconds, then give up on this attempt. A retry is cheaper than a hung tick. */
export const WEBHOOK_TIMEOUT_MS = 10_000
const KEEP_BYTES = 1_024

export const fetchTransport: WebhookTransport = {
  name: 'fetch',
  async post(req) {
    try {
      const res = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: req.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      })
      return { ok: true, status: res.status, body: await head(res) }
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      if (name === 'TimeoutError' || name === 'AbortError') {
        return { ok: false, error: `no answer within ${WEBHOOK_TIMEOUT_MS / 1000} seconds` }
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

/** The first KEEP_BYTES of a body, then stop reading and cancel the rest. */
async function head(res: Response): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < KEEP_BYTES) {
      const { done, value } = await reader.read()
      if (done || !value) break
      chunks.push(value)
      size += value.byteLength
    }
  } catch {
    /* a body that breaks mid-read still has a status worth keeping */
  } finally {
    reader.cancel().catch(() => {})
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(all.subarray(0, KEEP_BYTES))
}

/** A transport that records requests and answers from a script. Tests only. */
export class FakeWebhookTransport implements WebhookTransport {
  readonly name = 'fake'
  readonly requests: WebhookRequest[] = []
  private answer: (req: WebhookRequest) => WebhookResponse = () => ({
    ok: true,
    status: 200,
    body: 'ok',
  })

  /** Script every answer from now on. */
  respond(fn: (req: WebhookRequest) => WebhookResponse): void {
    this.answer = fn
  }

  async post(req: WebhookRequest): Promise<WebhookResponse> {
    this.requests.push(req)
    return this.answer(req)
  }
}

// One fake per Env object, so two specs' worlds never share a request log.
const fakes = new WeakMap<object, FakeWebhookTransport>()

export function fakeTransportFor(env: object): FakeWebhookTransport {
  let fake = fakes.get(env)
  if (!fake) {
    fake = new FakeWebhookTransport()
    fakes.set(env, fake)
  }
  return fake
}
