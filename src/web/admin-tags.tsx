import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { slugify } from '../core/ids.ts'
import {
  countSegment,
  createSegment,
  deleteSegment,
  describeRule,
  getSegment,
  listSegments,
  resolveSegment,
  updateSegment,
} from '../core/segments.ts'
import { findOrCreateTag } from '../core/subscribers.ts'
import {
  type TagRuleEvent,
  createTagRule,
  deleteTag,
  deleteTagRule,
  listTagRules,
  mergeTag,
  renameTag,
  setTagRuleActive,
  tagCounts,
} from '../core/tagging.ts'
import { getDb } from '../db/index.ts'
import { type SegmentRule, type Tag, broadcasts, sequences, tagRules, tags } from '../db/schema.ts'
import type { Env } from '../types.ts'
import { AudienceTabs, Flash, Layout, fmtDate } from './layout.tsx'

export const tagging = new Hono<{ Bindings: Env }>()

// ───────────────────────────────────────────────── tags

tagging.get('/tags', async (c) => {
  const db = getDb(c.env)
  const [all, counts, rules, bcs, seqs] = await Promise.all([
    db.select().from(tags).orderBy(asc(tags.name)).all(),
    tagCounts(db),
    listTagRules(db),
    db.select({ id: broadcasts.id, subject: broadcasts.subject }).from(broadcasts).orderBy(asc(broadcasts.subject)).all(),
    db.select({ id: sequences.id, name: sequences.name }).from(sequences).orderBy(asc(sequences.name)).all(),
  ])

  return c.html(
    <Layout title="Tags" nav="subs">
      <div class="head">
        <div>
          <h1>Tags &amp; automation</h1>
          <div class="sub">A tag is a fact you store about a person. Everything else reads them.</div>
        </div>
      </div>

      <AudienceTabs on="tags" />
      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-h">
          <h2>{all.length} tags</h2>
          <div class="actions">
            <form method="post" action="/tags" class="row" style="gap:6px;max-width:300px">
              <input type="text" name="name" placeholder="new tag" required style="min-width:0" />
              <button class="btn sm" style="flex:0 0 auto;min-width:0">
                Create
              </button>
            </form>
          </div>
        </div>
        <div class="card-b flush">
          {all.length === 0 ? (
            <div class="empty">
              <p>No tags yet.</p>
              <p class="faint">Tag someone from their page, or import a CSV with a `tags` column.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Tag</th>
                  <th class="num">People</th>
                  <th>Merge into</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {all.map((t) => (
                  <tr>
                    <td>
                      <form
                        method="post"
                        action={`/tags/${t.id}/rename`}
                        class="row"
                        style="gap:6px;max-width:300px"
                      >
                        <input type="text" name="name" value={t.name} style="min-width:0" />
                        <button class="btn sm" style="flex:0 0 auto;min-width:0">
                          Rename
                        </button>
                      </form>
                      <div class="faint mono">{t.slug}</div>
                    </td>
                    <td class="num">
                      <a href={`/subscribers?tag=${t.id}`}>{counts.get(t.id) ?? 0}</a>
                    </td>
                    <td>
                      {all.length < 2 ? (
                        <span class="faint">—</span>
                      ) : (
                        <form
                          method="post"
                          action={`/tags/${t.id}/merge`}
                          class="row"
                          style="gap:6px;max-width:300px"
                        >
                          <select name="into" style="min-width:0">
                            {all
                              .filter((o) => o.id !== t.id)
                              .map((o) => (
                                <option value={String(o.id)}>{o.name}</option>
                              ))}
                          </select>
                          <button class="btn sm" style="flex:0 0 auto;min-width:0">
                            Merge
                          </button>
                        </form>
                      )}
                    </td>
                    <td style="text-align:right">
                      <form method="post" action={`/tags/${t.id}/delete`}>
                        <button class="btn sm danger">Delete</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Auto-tagging rules</h2>
          <span class="pill">{rules.filter((r) => r.rule.isActive).length} active</span>
        </div>
        <div class="card-b">
          <div class="note">
            <strong>What someone does becomes a tag.</strong> And because a rule tags through the
            normal path, it can start a sequence: click the link → get tagged → get enrolled.
          </div>

          {rules.length === 0 ? null : (
            <table style="margin-bottom:18px">
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>When</th>
                  <th>Applies</th>
                  <th class="num">Fired</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rules.map(({ rule, tagName, broadcastSubject, sequenceName }) => (
                  <tr style={rule.isActive ? '' : 'opacity:.55'}>
                    <td style="font-weight:500">{rule.name}</td>
                    <td>
                      <div>
                        {rule.event}
                        {rule.urlContains ? (
                          <span class="faint"> of a link containing “{rule.urlContains}”</span>
                        ) : null}
                      </div>
                      <div class="faint">
                        {broadcastSubject
                          ? `in “${broadcastSubject}”`
                          : sequenceName
                            ? `in the “${sequenceName}” series`
                            : 'in any message'}
                      </div>
                    </td>
                    <td>
                      <span class="pill ok">{tagName}</span>
                    </td>
                    <td class="num">
                      {rule.appliedCount}
                      <div class="faint">{rule.lastAppliedAt ? fmtDate(rule.lastAppliedAt) : '—'}</div>
                    </td>
                    <td style="text-align:right;white-space:nowrap">
                      <form method="post" action={`/tag-rules/${rule.id}/toggle`} style="display:inline">
                        <button class="btn sm">{rule.isActive ? 'Pause' : 'Resume'}</button>
                      </form>{' '}
                      <form method="post" action={`/tag-rules/${rule.id}/delete`} style="display:inline">
                        <button class="btn sm danger">Delete</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <form method="post" action="/tag-rules">
            <div class="row">
              <div class="field">
                <label>Rule name</label>
                <input type="text" name="name" placeholder="Clicked the workshop link" required />
              </div>
              <div class="field">
                <label>When this happens</label>
                <select name="event">
                  <option value="click">They click a link</option>
                  <option value="open">They open the mail</option>
                  <option value="delivered">The mail is delivered</option>
                  <option value="bounce">It bounces</option>
                  <option value="complaint">They mark it as spam</option>
                </select>
              </div>
            </div>
            <div class="row">
              <div class="field">
                <label>In</label>
                <select name="scope">
                  <option value="">Any message</option>
                  {bcs.map((b) => (
                    <option value={`broadcast:${b.id}`}>Broadcast: {b.subject}</option>
                  ))}
                  {seqs.map((s) => (
                    <option value={`sequence:${s.id}`}>Series: {s.name}</option>
                  ))}
                </select>
              </div>
              <div class="field">
                <label>Only if the URL contains (clicks only)</label>
                <input type="text" name="urlContains" placeholder="/workshop" />
              </div>
              <div class="field">
                <label>Then tag them</label>
                <input type="text" name="tag" list="taglist" placeholder="workshop-interest" required />
                <datalist id="taglist">
                  {all.map((t) => (
                    <option value={t.name} />
                  ))}
                </datalist>
              </div>
            </div>
            <button class="btn primary">Add rule</button>
          </form>
        </div>
      </div>
    </Layout>,
  )
})

tagging.post('/tags', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const name = String(form.get('name') ?? '').trim()
  if (name) await findOrCreateTag(db, name)
  return c.redirect('/tags?flash=Tag created.')
})

tagging.post('/tags/:id/rename', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await c.req.formData()
  const result = await renameTag(db, id, String(form.get('name') ?? ''))
  if (!result.ok) return c.redirect(`/tags?flash=${encodeURIComponent(result.reason!)}&kind=warn`)
  return c.redirect('/tags?flash=Renamed.')
})

tagging.post('/tags/:id/merge', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const result = await mergeTag(db, Number(c.req.param('id')), Number(form.get('into')))
  if (!result.ok) return c.redirect(`/tags?flash=${encodeURIComponent(result.reason!)}&kind=warn`)
  const who = `${result.moved} ${result.moved === 1 ? 'person' : 'people'}`
  return c.redirect(`/tags?flash=${encodeURIComponent(`Merged — ${who} moved.`)}`)
})

tagging.post('/tags/:id/delete', async (c) => {
  const db = getDb(c.env)
  const result = await deleteTag(db, Number(c.req.param('id')))
  if (!result.ok) return c.redirect(`/tags?flash=${encodeURIComponent(result.reason!)}&kind=warn`)
  return c.redirect('/tags?flash=Tag deleted.')
})

// ───────────────────────────────────────────────── tag rules

tagging.post('/tag-rules', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()

  const scope = String(form.get('scope') ?? '')
  const result = await createTagRule(db, {
    name: String(form.get('name') ?? ''),
    tagName: String(form.get('tag') ?? ''),
    event: String(form.get('event') ?? 'click') as TagRuleEvent,
    broadcastId: scope.startsWith('broadcast:') ? Number(scope.slice(10)) : null,
    sequenceId: scope.startsWith('sequence:') ? Number(scope.slice(9)) : null,
    urlContains: String(form.get('urlContains') ?? ''),
  })
  if (!result.ok) return c.redirect(`/tags?flash=${encodeURIComponent(result.reason!)}&kind=warn`)

  return c.redirect('/tags?flash=Rule added. It applies to events from now on.')
})

tagging.post('/tag-rules/:id/toggle', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const rule = await db.select().from(tagRules).where(eq(tagRules.id, id)).get()
  if (!rule) return c.notFound()
  await setTagRuleActive(db, id, !rule.isActive)
  return c.redirect(`/tags?flash=${rule.isActive ? 'Rule paused.' : 'Rule resumed.'}`)
})

tagging.post('/tag-rules/:id/delete', async (c) => {
  const db = getDb(c.env)
  await deleteTagRule(db, Number(c.req.param('id')))
  return c.redirect('/tags?flash=Rule deleted.')
})

// ───────────────────────────────────────────────── segments

tagging.get('/segments', async (c) => {
  const db = getDb(c.env)
  const [rows, allTags] = await Promise.all([
    listSegments(db),
    db.select().from(tags).orderBy(asc(tags.name)).all(),
  ])
  const sized = await Promise.all(
    rows.map(async (s) => ({ ...s, size: await countSegment(db, s.rule) })),
  )

  return c.html(
    <Layout title="Segments" nav="subs">
      <div class="head">
        <div>
          <h1>Segments</h1>
          <div class="sub">Saved questions asked of your tags. Nothing is stored per person.</div>
        </div>
        <div class="actions">
          <a class="btn primary" href="/segments/new">
            New segment
          </a>
        </div>
      </div>

      <AudienceTabs on="segments" />
      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-b flush">
          {sized.length === 0 ? (
            <div class="empty">
              <p>No saved segments.</p>
              <p class="faint">Save one and it becomes pickable when you write a broadcast.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Segment</th>
                  <th>Rule</th>
                  <th class="num">People</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sized.map((s) => (
                  <tr>
                    <td>
                      <a href={`/segments/${s.id}`} style="font-weight:500">
                        {s.name}
                      </a>
                    </td>
                    <td class="faint">{describeRule(s.rule, allTags)}</td>
                    <td class="num">{s.size}</td>
                    <td style="text-align:right">
                      <form method="post" action={`/segments/${s.id}/delete`}>
                        <button class="btn sm danger">Delete</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Layout>,
  )
})

/** Read a rule off the segment form. Absent fields stay absent, never `[]`. */
function readRule(form: FormData): SegmentRule {
  const ids = (key: string) =>
    form
      .getAll(key)
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n > 0)
  const day = (key: string) => {
    const raw = String(form.get(key) ?? '').trim()
    if (!raw) return undefined
    const ms = Date.parse(raw)
    return Number.isFinite(ms) ? ms : undefined
  }

  const rule: SegmentRule = {}
  const include = ids('include')
  const exclude = ids('exclude')
  if (include.length) rule.includeTagIds = include
  if (exclude.length) rule.excludeTagIds = exclude
  if (include.length > 1 && form.get('match') === 'all') rule.match = 'all'
  const after = day('joinedAfter')
  const before = day('joinedBefore')
  if (after) rule.joinedAfter = after
  if (before) rule.joinedBefore = before
  return rule
}

const asDateValue = (ms?: number) => (ms ? new Date(ms).toISOString().slice(0, 10) : '')

const SegmentForm = ({
  action,
  name,
  rule,
  allTags,
}: {
  action: string
  name: string
  rule: SegmentRule
  allTags: Tag[]
}) => (
  <form method="post" action={action}>
    <div class="field">
      <label>Name</label>
      <input type="text" name="name" value={name} placeholder="Customers, not yet on Ruby" required />
    </div>
    <div class="row">
      <div class="field">
        <label>Tagged with</label>
        <select name="include" multiple size={Math.min(Math.max(allTags.length, 3), 8)}>
          {allTags.map((t) => (
            <option value={String(t.id)} selected={rule.includeTagIds?.includes(t.id)}>
              {t.name}
            </option>
          ))}
        </select>
        <p class="faint" style="margin:6px 0 0">
          <label style="display:inline;font-weight:400">
            <input
              type="radio"
              name="match"
              value="any"
              checked={rule.match !== 'all'}
              style="width:auto"
            />{' '}
            any of them
          </label>{' '}
          <label style="display:inline;font-weight:400;margin-left:10px">
            <input
              type="radio"
              name="match"
              value="all"
              checked={rule.match === 'all'}
              style="width:auto"
            />{' '}
            all of them
          </label>
        </p>
      </div>
      <div class="field">
        <label>But not tagged with</label>
        <select name="exclude" multiple size={Math.min(Math.max(allTags.length, 3), 8)}>
          {allTags.map((t) => (
            <option value={String(t.id)} selected={rule.excludeTagIds?.includes(t.id)}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label>Joined after</label>
        <input type="date" name="joinedAfter" value={asDateValue(rule.joinedAfter)} />
      </div>
      <div class="field">
        <label>Joined before</label>
        <input type="date" name="joinedBefore" value={asDateValue(rule.joinedBefore)} />
      </div>
    </div>
    <button class="btn primary">Save segment</button>
  </form>
)

tagging.get('/segments/new', async (c) => {
  const db = getDb(c.env)
  const allTags = await db.select().from(tags).orderBy(asc(tags.name)).all()

  return c.html(
    <Layout title="New segment" nav="subs">
      <div class="head">
        <h1>New segment</h1>
      </div>
      <AudienceTabs on="segments" />
      <div class="card">
        <div class="card-b">
          <div class="note">
            Unsubscribed, bounced and complained people are never in a segment — that's not a rule
            you get to write.
          </div>
          <SegmentForm action="/segments" name="" rule={{}} allTags={allTags} />
        </div>
      </div>
    </Layout>,
  )
})

tagging.post('/segments', async (c) => {
  const db = getDb(c.env)
  const form = await c.req.formData()
  const name = String(form.get('name') ?? '').trim()
  if (!name) return c.redirect('/segments?flash=A segment needs a name.&kind=warn')
  const id = await createSegment(db, name, readRule(form))
  return c.redirect(`/segments/${id}?flash=Segment saved.`)
})

tagging.get('/segments/:id', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const seg = await getSegment(db, id)
  if (!seg) return c.notFound()

  const allTags = await db.select().from(tags).orderBy(asc(tags.name)).all()
  const size = await countSegment(db, seg.rule)
  const sample = await resolveSegment(db, seg.rule, 0, 25)

  return c.html(
    <Layout title={seg.name} nav="subs">
      <div class="head">
        <div>
          <h1>{seg.name}</h1>
          <div class="sub">
            {describeRule(seg.rule, allTags)} · {size} {size === 1 ? 'person' : 'people'}
          </div>
        </div>
      </div>

      <AudienceTabs on="segments" />
      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      <div class="card">
        <div class="card-h">
          <h2>Rule</h2>
        </div>
        <div class="card-b">
          <SegmentForm action={`/segments/${id}`} name={seg.name} rule={seg.rule} allTags={allTags} />
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <h2>Who's in it</h2>
          <div class="actions">
            <span class="pill">{sample.length === size ? `all ${size}` : `first ${sample.length} of ${size}`}</span>
          </div>
        </div>
        <div class="card-b flush">
          {sample.length === 0 ? (
            <div class="empty">
              <p>Nobody matches this rule yet.</p>
            </div>
          ) : (
            <table>
              <tbody>
                {sample.map((s) => (
                  <tr>
                    <td>
                      <a href={`/subscribers/${s.id}`} class="mono">
                        {s.email}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Layout>,
  )
})

tagging.post('/segments/:id', async (c) => {
  const db = getDb(c.env)
  const id = Number(c.req.param('id'))
  const form = await c.req.formData()
  const name = String(form.get('name') ?? '').trim()
  if (!name) return c.redirect(`/segments/${id}?flash=A segment needs a name.&kind=warn`)

  await updateSegment(db, id, name, readRule(form))
  // Broadcasts copied this rule when they were composed; they keep what they had.
  return c.redirect(`/segments/${id}?flash=Saved. Broadcasts already composed keep their own copy.`)
})

tagging.post('/segments/:id/delete', async (c) => {
  const db = getDb(c.env)
  await deleteSegment(db, Number(c.req.param('id')))
  return c.redirect('/segments?flash=Segment deleted.')
})
