/**
 * Custom fields: the screen that names them (Kōlea SPEC 7.2).
 *
 * Thin over `core/fields.ts` — every rule (key shape, reserved keys, the
 * refusal to delete a field a segment still asks about) lives there.
 */
import { Hono } from 'hono'
import {
  FIELD_TYPES,
  createField,
  deleteField,
  fieldUsage,
  listFields,
  renameField,
} from '../core/fields.ts'
import { getDb } from '../db/index.ts'
import type { Env } from '../types.ts'
import { AudienceTabs, Flash, Layout } from './layout.tsx'

export const fieldsAdmin = new Hono<{ Bindings: Env }>()

const TYPE_HELP: Record<(typeof FIELD_TYPES)[number], string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  boolean: 'Yes / no',
}

const back = (msg: string, warn = false) =>
  `/fields?flash=${encodeURIComponent(msg)}${warn ? '&kind=warn' : ''}`

fieldsAdmin.get('/fields', async (c) => {
  const db = getDb(c.env)
  const fields = await listFields(db)
  const usage = await Promise.all(fields.map((f) => fieldUsage(db, f.key)))

  return c.html(
    <Layout title="Custom fields" nav="fields">
      <div class="head">
        <div>
          <h1>Custom fields</h1>
          <div class="sub">
            Facts a person carries — a plan, a renewal date, a seat count. Ask about them in a
            segment, or drop them into mail as <span class="mono">{'{{key}}'}</span>.
          </div>
        </div>
      </div>

      <AudienceTabs on="fields" />
      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-h">
          <h2>New field</h2>
        </div>
        <div class="card-b">
          <form method="post" action="/fields">
            <div class="row">
              <div class="field">
                <label>Name</label>
                <input type="text" name="label" placeholder="Plan" required maxlength={100} />
              </div>
              <div class="field">
                <label>Key</label>
                <input
                  type="text"
                  name="key"
                  placeholder="made from the name"
                  pattern="[a-z][a-z0-9_]{0,62}"
                  class="mono"
                />
              </div>
              <div class="field">
                <label>Type</label>
                <select name="type">
                  {FIELD_TYPES.map((t) => (
                    <option value={t}>{TYPE_HELP[t]}</option>
                  ))}
                </select>
              </div>
            </div>
            <p class="faint" style="margin:0 0 12px">
              The key is the merge tag and the CSV column, and it never changes once made, so
              segments and mail that use it keep working. The name can change any time.
            </p>
            <button class="btn primary">Add field</button>
          </form>
        </div>
      </div>

      <div class="card">
        <div class="card-b flush">
          {fields.length === 0 ? (
            <div class="empty">
              <p>No custom fields yet.</p>
              <p class="faint">
                Importing a CSV fills any column whose header matches a field's key.
              </p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Merge tag</th>
                  <th>Type</th>
                  <th>Used by</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {fields.map((f, i) => {
                  const u = usage[i]!
                  const users = u.segments.length + u.broadcasts.length
                  return (
                    <tr>
                      <td>
                        <form
                          method="post"
                          action={`/fields/${f.id}`}
                          style="display:flex;gap:6px;align-items:center"
                        >
                          <input
                            type="text"
                            name="label"
                            value={f.label}
                            required
                            maxlength={100}
                            style="width:200px;min-width:0"
                          />
                          <button class="btn sm">Rename</button>
                        </form>
                      </td>
                      <td class="mono">{`{{${f.key}}}`}</td>
                      <td>
                        <span class="pill">{TYPE_HELP[f.type]}</span>
                      </td>
                      <td class="faint">
                        {users === 0
                          ? '-'
                          : [
                              ...u.segments.map((n) => `segment “${n}”`),
                              ...u.broadcasts.map((n) => `broadcast “${n}”`),
                            ].join(', ')}
                      </td>
                      <td style="text-align:right">
                        <form method="post" action={`/fields/${f.id}/delete`}>
                          <button
                            class="btn sm danger"
                            disabled={users > 0}
                            title={
                              users > 0
                                ? 'Still used by a segment or an unsent broadcast'
                                : 'Deletes the field and every value of it'
                            }
                          >
                            Delete
                          </button>
                        </form>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Layout>,
  )
})

fieldsAdmin.post('/fields', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const result = await createField(db, {
    label: String(form.get('label') ?? ''),
    key: String(form.get('key') ?? ''),
    type: String(form.get('type') ?? 'text'),
  })
  return c.redirect(
    result.ok ? back(`Added “${result.field.label}” as {{${result.field.key}}}.`) : back(result.error, true),
  )
})

fieldsAdmin.post('/fields/:id', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const result = await renameField(db, Number(c.req.param('id')), String(form.get('label') ?? ''))
  return c.redirect(result.ok ? back('Renamed. The key and its merge tag are unchanged.') : back(result.error, true))
})

fieldsAdmin.post('/fields/:id/delete', async (c) => {
  const db = getDb(c.env)
  const result = await deleteField(db, Number(c.req.param('id')))
  return c.redirect(
    result.ok ? back(`Deleted {{${result.key}}} and every value of it.`) : back(result.error, true),
  )
})

/**
 * The field list for the composer's merge-tag picker. Behind the same operator
 * gate as every admin screen; key, label and type only — no values.
 */
fieldsAdmin.get('/fields.json', async (c) => {
  const fields = await listFields(getDb(c.env))
  return c.json(fields.map((f) => ({ key: f.key, label: f.label, type: f.type })))
})
