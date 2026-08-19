import type { Db } from '../db/index.ts'
import { devOutbox } from '../db/schema.ts'
import type { EmailProvider, OutgoingEmail, SendResult } from './types.ts'

/**
 * Local-development provider. Writes fully rendered mail to `dev_outbox` instead
 * of sending it, so the Outbox screen shows exactly what would have gone out —
 * including the scoped unsubscribe footer. Nothing leaves the machine.
 */
export class ConsoleProvider implements EmailProvider {
  readonly name = 'console'

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
