import type { Db } from '../db/index.ts'
import { devOutbox } from '../db/schema.ts'
import type { DomainIdentity, EmailProvider, OutgoingEmail, ProviderDomain, SendResult } from './types.ts'

/**
 * Local-development provider. Writes fully rendered mail to `dev_outbox` instead
 * of sending it, so the Outbox screen shows exactly what would have gone out —
 * including the scoped unsubscribe footer. Nothing leaves the machine.
 */
export class ConsoleProvider implements EmailProvider {
  readonly name = 'console'
  readonly domains: DomainIdentity = consoleDomains

  constructor(private readonly db: Db) {}

  async send(email: OutgoingEmail): Promise<SendResult> {
    const [result] = await this.sendBatch([email])
    return result ?? { ok: false, error: 'console provider wrote nothing', retryable: false }
  }

  async sendBatch(emails: OutgoingEmail[]): Promise<SendResult[]> {
    const now = new Date()
    // D1 caps bound parameters at 100 per query; `dev_outbox` binds 7 per row.
    for (let i = 0; i < emails.length; i += 14) {
      await this.db.insert(devOutbox).values(
        emails.slice(i, i + 14).map((email) => ({
          messageId: email.ref,
          toEmail: email.to,
          fromEmail: email.fromEmail,
          subject: email.subject,
          html: email.html,
          text: email.text,
          createdAt: now,
        })),
      )
    }
    return emails.map((email) => ({ ok: true, providerMessageId: `console-${email.ref}` }))
  }

  async parseWebhook(): Promise<[]> {
    return []
  }
}

/**
 * The console provider's domains "API": the same shape of records Resend asks
 * for (a DKIM key, a return-path MX and TXT on `send.<domain>`), on obviously
 * local values, and always willing to send. Nothing leaves the machine, so the
 * verdict on a domain locally is the DNS check's alone — which, with
 * `DNS_RESOLVER=fake`, is whatever one-click setup or a spec put there.
 */
export const consoleDomains: DomainIdentity = {
  async register(name) {
    return { ok: true, domain: consoleDomain(name) }
  },
  async verify(name) {
    return { ok: true, domain: consoleDomain(name) }
  },
}

function consoleDomain(name: string): ProviderDomain {
  return {
    id: `console-${name}`,
    state: 'active',
    records: [
      { purpose: 'dkim', type: 'TXT', name: `kolea._domainkey.${name}`, value: `p=CONSOLE-DKIM-KEY-FOR-${name.toUpperCase()}` },
      { purpose: 'return_path', type: 'MX', name: `send.${name}`, value: 'feedback.console.invalid', priority: 10 },
      { purpose: 'return_path', type: 'TXT', name: `send.${name}`, value: 'v=spf1 include:spf.console.invalid ~all' },
    ],
  }
}
