import { Hono } from 'hono'
import {
  SALE_IMPORT_MAX_BYTES,
  SALE_IMPORT_ROW_LIMIT,
  type SaleImportReport,
  importSales,
} from '../core/sale-import.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { CampaignTabs, Layout } from './layout.tsx'

/**
 * Sales history import: a CSV of past sales into the `sales` ledger. Thin on
 * purpose; every rule (no mail, no attribution guessing, cents without floats,
 * idempotency) lives in `core/sale-import.ts`.
 */
export const saleImportAdmin = new Hono<{ Bindings: Env }>()

const SAMPLE = `email,amount,currency,date,product,external_id,campaign
ada@example.com,49.00,usd,2021-03-04,The Field Guide,gumroad-1234,
grace@example.com,1299.00,usd,2022-11-25,Course bundle,,black-friday-2022`

const Page = ({ report }: { report?: SaleImportReport }) => (
  <Layout title="Import sales" nav="simport">
    <div class="head">
      <div>
        <h1>Import sales</h1>
        <div class="sub">Past sales, so revenue covers the years before Stripe was connected.</div>
      </div>
    </div>

    <CampaignTabs on="sales" />

    {report ? <Report report={report} /> : null}

    <div class="card">
      <div class="card-b">
        <div class="note">
          Needs a header row with <span class="mono">email</span>, <span class="mono">amount</span>{' '}
          (like <span class="mono">12.34</span>), <span class="mono">currency</span> and{' '}
          <span class="mono">date</span> (<span class="mono">YYYY-MM-DD</span>). Optional:{' '}
          <span class="mono">product</span>, <span class="mono">external_id</span>,{' '}
          <span class="mono">campaign</span> (a campaign slug). Up to {SALE_IMPORT_ROW_LIMIT} lines a
          file; upload the same file twice and nothing is booked twice.
        </div>
        <p class="faint">
          An import never sends mail: no thank-you, no tags, no sequences. Buyers who are not on the
          list are kept on file as <span class="mono">pending</span> and get no broadcasts. Only a
          campaign named on the line gets the credit.
        </p>
        <form method="post" action="/sales/import" enctype="multipart/form-data">
          <div class="field">
            <label>CSV file</label>
            <input type="file" name="file" accept=".csv,text/csv" required />
          </div>
          <button class="btn primary">Import</button>
        </form>
        <pre class="mono code">{SAMPLE}</pre>
      </div>
    </div>
  </Layout>
)

const Report = ({ report }: { report: SaleImportReport }) => (
  <div class="card">
    <div class="card-h">
      <h2>
        {report.error
          ? 'Nothing imported'
          : `${report.created} created, ${report.duplicate} duplicate, ${report.invalid} invalid`}
      </h2>
    </div>
    <div class="card-b flush">
      {report.error ? (
        <div class="empty">
          <p>{report.error}</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th class="num">Line</th>
              <th>Email</th>
              <th>Result</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {report.lines.map((l) => (
              <tr>
                <td class="num">{l.line}</td>
                <td class="mono">{l.email}</td>
                <td>
                  <span class={`pill ${l.outcome === 'invalid' ? 'warn' : ''}`}>{l.outcome}</span>
                </td>
                <td class="faint">{l.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  </div>
)

saleImportAdmin.get('/sales/import', (c) => c.html(<Page />))

saleImportAdmin.post('/sales/import', async (c) => {
  const form = await c.req.formData()
  const file = form.get('file')
  let csv = ''
  if (file && typeof file !== 'string') {
    if (file.size > SALE_IMPORT_MAX_BYTES) {
      return c.html(<Page report={{ created: 0, duplicate: 0, invalid: 0, lines: [], error: 'That file is larger than 1 MB.' }} />, 400)
    }
    csv = await file.text()
  } else if (typeof file === 'string') {
    csv = file
  }
  const report = await importSales(getDb(c.env), csv)
  return c.html(<Page report={report} />, report.error ? 400 : 200)
})
