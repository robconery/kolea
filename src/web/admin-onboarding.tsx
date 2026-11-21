import type { FC } from 'hono/jsx'
import { Hono } from 'hono'
import {
  createFirstBroadcast,
  declineStep,
  DECLINABLE,
  makeWelcome,
  onboardingProgress,
  type Progress,
  setDismissed,
  skipStep,
  type Step,
  type StepState,
  undoStep,
  WELCOMES,
} from '../core/onboarding.ts'
import { getDb } from '../db/index.ts'
import type { OnboardingStepId } from '../db/schema.ts'
import type { Env } from '../types.ts'
import { Flash, Layout } from './layout.tsx'

/**
 * First-run onboarding (Kōlea SPEC 21.4): a checklist on the dashboard and a
 * page at `/onboarding`. Thin: every rule is in `core/onboarding.ts`. Each step
 * links to the screen that owns it; only the welcome sequence and the first
 * broadcast have an inline form, because each is one choice or one line. Nothing
 * here sends mail or turns anything on.
 */
export const onboardingAdmin = new Hono<{ Bindings: Env }>()

const back = (path: string, msg: string, kind?: 'warn') =>
  `${path}?flash=${encodeURIComponent(msg)}${kind ? `&kind=${kind}` : ''}`

/** Where a form came from, so a dashboard action lands back on the dashboard. */
const returnTo = (raw: unknown) => (raw === '/' ? '/' : '/onboarding')

interface StepCopy {
  title: string
  /** One line: what this step is, and what happens. */
  what: string
  href: string
  cta: string
}

const COPY: Record<OnboardingStepId, StepCopy> = {
  sender: {
    title: 'Your name and from address',
    what: 'Who your mail says it is from. Every send reads it from FROM_NAME and FROM_EMAIL.',
    href: '/onboarding#sender',
    cta: 'See how to change it',
  },
  domain: {
    title: 'Your sending domain',
    what: 'Add the domain your mail comes from and put its DNS records in place, so inboxes trust it.',
    href: '/domains',
    cta: 'Set up the domain',
  },
  site: {
    title: 'Your public site',
    what: 'A title, a tagline and a short bio for the front page readers land on.',
    href: '/site',
    cta: 'Fill in the profile',
  },
  audience: {
    title: 'Bring your list, or start one',
    what: 'Import from Kit, Ghost, Mailchimp, Drip or a CSV, or make a signup form.',
    href: '/imports',
    cta: 'Import a list',
  },
  welcome: {
    title: 'A welcome sequence',
    what: 'The mails a new reader gets after they join. Made from a template, paused until you write it and turn it on.',
    href: '/onboarding#welcome',
    cta: 'Pick a welcome',
  },
  broadcast: {
    title: 'Your first broadcast',
    what: 'Start a draft. Nothing is sent from here; you send it from the composer when it is ready.',
    href: '/onboarding#broadcast',
    cta: 'Start a draft',
  },
}

const PILL: Record<StepState, { cls: string; label: string }> = {
  done: { cls: 'pill ok', label: 'done' },
  waiting: { cls: 'pill warn', label: 'waiting on DNS' },
  skipped: { cls: 'pill', label: 'later' },
  declined: { cls: 'pill', label: 'not wanted' },
  todo: { cls: 'pill', label: 'to do' },
}

const settledCount = (p: Progress) =>
  p.steps.filter((s) => s.state === 'done' || s.state === 'waiting' || s.state === 'declined').length

/** One checklist line: the step, its state, and the action that fits it. */
const StepRow: FC<{ step: Step; from: '/' | '/onboarding'; current: boolean }> = ({ step, from, current }) => {
  const copy = COPY[step.id]
  const pill = PILL[step.state]
  const open = step.state === 'todo' || step.state === 'skipped'
  return (
    <li class={`ob-step${current ? ' here' : ''}`} data-step={step.id} data-state={step.state}>
      <div class="ob-main">
        <div class="ob-title">
          <strong>{copy.title}</strong> <span class={pill.cls}>{pill.label}</span>
          {step.choice ? <span class="faint"> by {step.choice === 'form' ? 'a form' : 'an import'}</span> : null}
        </div>
        <div class="faint">{copy.what}</div>
      </div>
      <div class="ob-actions">
        {open || step.state === 'waiting' ? (
          <a class={`btn sm${current ? ' primary' : ''}`} href={step.state === 'waiting' ? '/domains' : copy.href}>
            {step.state === 'waiting' ? 'Check the records' : copy.cta}
          </a>
        ) : null}
        {step.id === 'audience' && open ? (
          <a class="btn sm" href="/forms/new">
            Make a form
          </a>
        ) : null}
        {step.state === 'todo' ? (
          <form method="post" action={`/onboarding/${step.id}/skip`}>
            <input type="hidden" name="from" value={from} />
            <button class="btn sm">Later</button>
          </form>
        ) : null}
        {step.state === 'todo' && DECLINABLE.includes(step.id) ? (
          <form method="post" action={`/onboarding/${step.id}/decline`}>
            <input type="hidden" name="from" value={from} />
            <button class="btn sm">I don't want one</button>
          </form>
        ) : null}
        {step.state === 'skipped' || step.state === 'declined' ? (
          <form method="post" action={`/onboarding/${step.id}/undo`}>
            <input type="hidden" name="from" value={from} />
            <button class="btn sm">Undo</button>
          </form>
        ) : null}
      </div>
    </li>
  )
}

const STYLE = `
.ob-list{list-style:none;margin:0;padding:0}
.ob-step{display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:14px 0;border-top:1px solid var(--hairline)}
.ob-step:first-child{border-top:0}
.ob-step[data-state=done] .ob-title strong,.ob-step[data-state=declined] .ob-title strong{color:var(--faint)}
.ob-step.here .ob-title strong{color:var(--ink)}
.ob-main{flex:1;min-width:240px}
.ob-title{margin-bottom:2px}
.ob-actions{display:flex;gap:8px;flex-wrap:wrap}
.ob-actions form{margin:0}
.ob-welcomes{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin:12px 0}
.ob-welcomes label{display:block;padding:14px;border-radius:12px;box-shadow:inset 0 0 0 1px var(--hairline);cursor:pointer}
.ob-welcomes input{margin-right:6px}
`

/** The checklist card. The dashboard shows it until every step is settled or it is dismissed. */
export const OnboardingCard: FC<{ progress: Progress; from: '/' | '/onboarding' }> = ({ progress, from }) => (
  <div class="card" id="onboarding">
    <style>{STYLE}</style>
    <div class="card-h">
      <h2>Get set up</h2>
      <span class="faint">
        {settledCount(progress)} of {progress.steps.length} done
      </span>
      <div class="actions">
        {from === '/' ? (
          <a class="btn sm" href="/onboarding">
            Open the checklist
          </a>
        ) : null}
        <form method="post" action="/onboarding/dismiss">
          <input type="hidden" name="from" value={from} />
          <button class="btn sm" title="Hide this from the dashboard. /onboarding still has it.">
            Dismiss
          </button>
        </form>
      </div>
    </div>
    <div class="card-b">
      <ol class="ob-list">
        {progress.steps.map((s) => (
          <StepRow step={s} from={from} current={s.id === progress.current} />
        ))}
      </ol>
    </div>
  </div>
)

// ───────────────────────────────────────────────── the page

onboardingAdmin.get('/onboarding', async (c) => {
  const db = getDb(c.env)
  const p = await onboardingProgress(c.env, db)
  const { fromName, fromEmail } = p.facts
  const sender = p.steps.find((s) => s.id === 'sender')!
  const welcome = p.steps.find((s) => s.id === 'welcome')!
  const broadcast = p.steps.find((s) => s.id === 'broadcast')!

  return c.html(
    <Layout title="Get set up" nav="setup">
      <div class="head">
        <div>
          <div class="eyebrow">First run</div>
          <h1>Get set up</h1>
          <div class="sub">
            Six steps, any order, each on the screen that owns it. Nothing here sends mail or turns anything on.
          </div>
        </div>
        <div class="actions">
          {p.dismissed ? (
            <form method="post" action="/onboarding/show">
              <button class="btn">Show it on the dashboard again</button>
            </form>
          ) : null}
        </div>
      </div>

      <Flash msg={c.req.query('flash')} kind={c.req.query('kind')} />

      {p.finished ? (
        <div class="note">
          <strong>All set.</strong> Before your first real send: send a test to yourself, click its unsubscribe link
          and check you see the narrow choice first, add a postal address to your footer, and tighten DMARC from{' '}
          <span class="mono">p=none</span> after a week of clean sending.
        </div>
      ) : null}

      <OnboardingCard progress={p} from="/onboarding" />

      <div class="card" id="sender">
        <div class="card-h">
          <h2>Your name and from address</h2>
          <span class={PILL[sender.state].cls}>{PILL[sender.state].label}</span>
        </div>
        <div class="card-b">
          <p>
            Mail goes out as{' '}
            <span class="mono">
              {fromName || '(no FROM_NAME)'} &lt;{fromEmail || 'no FROM_EMAIL'}&gt;
            </span>
            .
          </p>
          <p class="faint">
            These are the <span class="mono">FROM_NAME</span> and <span class="mono">FROM_EMAIL</span> variables in{' '}
            <span class="mono">wrangler.jsonc</span>, read by every send. To change them, edit both the top-level{' '}
            <span class="mono">vars</span> and <span class="mono">env.production.vars</span>, then deploy. Use an
            address on your sending domain, and one that reaches you: replies land there.
          </p>
        </div>
      </div>

      <div class="card" id="welcome">
        <div class="card-h">
          <h2>A welcome sequence</h2>
          <span class={PILL[welcome.state].cls}>{PILL[welcome.state].label}</span>
          <div class="actions">
            <a class="btn sm" href="/sequences/templates">
              All templates
            </a>
          </div>
        </div>
        <div class="card-b">
          {welcome.state === 'done' ? (
            <p>
              A sequence already starts when someone joins. <a href="/sequences">See your sequences</a>.
            </p>
          ) : (
            <form method="post" action="/onboarding/welcome">
              <p class="faint">
                Pick a shape. It lands paused, starts on subscribe once you turn it on, and cannot be turned on until
                every <span class="mono">[[ placeholder ]]</span> is written.
              </p>
              <div class="ob-welcomes">
                {WELCOMES.map((w, i) => (
                  <label>
                    <input type="radio" name="template" value={w.template} checked={i === 0} />
                    <strong>{w.name}</strong>
                    <div class="faint">{w.feel}</div>
                    <div class="faint">{w.pickIf}</div>
                  </label>
                ))}
              </div>
              <button class="btn primary">Make it, paused</button>
            </form>
          )}
        </div>
      </div>

      <div class="card" id="broadcast">
        <div class="card-h">
          <h2>Your first broadcast</h2>
          <span class={PILL[broadcast.state].cls}>{PILL[broadcast.state].label}</span>
        </div>
        <div class="card-b">
          {broadcast.state === 'done' ? (
            <p>
              You have a broadcast. <a href="/broadcasts">See them all</a>.
            </p>
          ) : (
            <form method="post" action="/onboarding/broadcast">
              <p class="faint">Give it a subject and you land in the composer with a draft. Nothing is sent.</p>
              <input type="text" name="subject" placeholder="Hello, and what to expect" required />{' '}
              <button class="btn primary">Start the draft</button>
            </form>
          )}
        </div>
      </div>
    </Layout>,
  )
})

// ───────────────────────────────────────────────── actions

onboardingAdmin.post('/onboarding/dismiss', async (c) => {
  const form = await c.req.formData()
  await setDismissed(getDb(c.env), true)
  return c.redirect(
    returnTo(form.get('from')) === '/'
      ? back('/', 'Checklist hidden. It is still at /onboarding.')
      : back('/onboarding', 'Hidden from the dashboard.'),
  )
})

onboardingAdmin.post('/onboarding/show', async (c) => {
  await setDismissed(getDb(c.env), false)
  return c.redirect(back('/onboarding', 'The checklist is back on the dashboard.'))
})

onboardingAdmin.post('/onboarding/welcome', async (c) => {
  const form = await c.req.formData()
  const made = await makeWelcome(getDb(c.env), String(form.get('template') ?? ''))
  if (!made.ok) return c.redirect(back('/onboarding', made.reason, 'warn'))
  return c.redirect(back(`/sequences/${made.id}`, 'Welcome sequence made, paused. Write each mail, then turn it on.'))
})

onboardingAdmin.post('/onboarding/broadcast', async (c) => {
  const form = await c.req.formData()
  const made = await createFirstBroadcast(getDb(c.env), String(form.get('subject') ?? ''))
  if (!made.ok) return c.redirect(back('/onboarding', made.reason, 'warn'))
  return c.redirect(back(`/broadcasts/${made.id}`, 'Draft started. It sends only when you send it.'))
})

const ACTIONS = { skip: skipStep, decline: declineStep, undo: undoStep } as const

onboardingAdmin.post('/onboarding/:step/:action{skip|decline|undo}', async (c) => {
  const form = await c.req.formData()
  const to = returnTo(form.get('from'))
  const act = ACTIONS[c.req.param('action') as keyof typeof ACTIONS]
  const done = await act(getDb(c.env), c.req.param('step'))
  if (!done.ok) return c.redirect(back(to, done.reason, 'warn'))
  return c.redirect(to === '/' ? '/#onboarding' : '/onboarding')
})
