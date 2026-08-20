import { Hono } from 'hono'
import type { Env } from '../types.ts'
import { Layout } from './layout.tsx'

export const help = new Hono<{ Bindings: Env }>()

/**
 * The manual, in the app.
 *
 * It reads `PUBLIC_URL` out of the environment so every URL and curl on the page
 * is the real one for wherever this is running — copy-pasteable in dev and in
 * production, with no "replace this with your domain" step.
 */

const Code = ({ children }: { children: string }) => (
  <pre
    class="mono"
    style="background:#f6f5f3;padding:14px;border-radius:8px;overflow:auto;font-size:13px;line-height:1.5"
  >
    {children}
  </pre>
)

help.get('/help', (c) => {
  const base = c.env.PUBLIC_URL

  return c.html(
    <Layout title="Help" nav="help">
      <div class="head">
        <div>
          <h1>How this works</h1>
          <div class="sub">Everything you need to run it, on one page.</div>
        </div>
      </div>

      <div class="note">
        <strong>The one idea worth holding.</strong> Consent has three scopes and a narrow choice
        never escalates to a wide one. Leaving <em>one series</em> writes a single row and touches
        nothing else. Leaving <em>the newsletter</em> stops broadcasts only. A{' '}
        <em>suppression</em> stops everything, forever. Kit collapses all three into one button. That's why this exists.
      </div>

      {/* ─────────────────────────────── getting people in */}

      <div class="card">
        <div class="card-h">
          <h2>1 · Getting people in</h2>
        </div>
        <div class="card-b">
          <p class="muted">
            Three ways: a <strong>form</strong> posted from your own site, a{' '}
            <strong>CSV import</strong>, or adding somebody by hand.
          </p>

          <h3 style="margin:18px 0 6px;font-size:15px">Forms</h3>
          <p class="muted">
            A form is a named POST endpoint: no embed script, no hosted landing page. Create one at{' '}
            <a href="/forms">Campaigns → Forms</a>, then paste this anywhere you can put HTML:
          </p>
          <Code>{`<form action="${base}/f/YOUR-SLUG" method="post">
  <input type="email" name="email" required>
  <input type="text" name="name">
  <!-- spam trap: hidden, humans never fill it in -->
  <div style="position:absolute;left:-9999px" aria-hidden="true">
    <input type="text" name="website" tabindex="-1" autocomplete="off">
  </div>
  <button type="submit">Subscribe</button>
</form>`}</Code>
          <p class="muted">Or post JSON from a client component and stay on the page:</p>
          <Code>{`await fetch('${base}/f/YOUR-SLUG', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, name })
})
// → { ok: true, message: "...", enrolled: true }`}</Code>

          <table style="margin-top:14px">
            <tbody>
              <tr>
                <td style="font-weight:500;width:30%">It answers in kind</td>
                <td class="muted">
                  A browser form gets a redirect (or a thank-you page); JSON gets JSON. CORS is open;
                  there's nothing here to read back.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">Each form can</td>
                <td class="muted">
                  apply tags, start a sequence, credit a campaign, and redirect somewhere on success.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">
                  The <span class="mono">website</span> field
                </td>
                <td class="muted">
                  is a honeypot. A bot fills it → the response looks like success and{' '}
                  <em>nothing is written</em>.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">Submitting twice</td>
                <td class="muted">
                  is identical to submitting once. Every effect is idempotent, so impatient
                  double-clicks and network retries are safe.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">Redirects</td>
                <td class="muted">
                  only ever use the URL configured on the form, never one posted in the body, which
                  would make every form an open redirect.
                </td>
              </tr>
            </tbody>
          </table>

          <p class="faint" style="margin-top:14px">
            Open <span class="mono">{base}/f/YOUR-SLUG</span> in a browser to get a bare working form
            you can test with before wiring up your own markup.
          </p>
        </div>
      </div>

      {/* ─────────────────────────────── sending */}

      <div class="card">
        <div class="card-h">
          <h2>2 · Sending mail</h2>
        </div>
        <div class="card-b">
          <table>
            <tbody>
              <tr>
                <td style="font-weight:500;width:22%">
                  <a href="/broadcasts">Broadcasts</a>
                </td>
                <td class="muted">
                  One-off mail to a segment. Compose, pick who gets it, send. A draft is editable;
                  once it's sending it isn't, because that would change who it reaches halfway
                  through. Big sends materialize across several cron ticks; D1 allows ~1,000 queries
                  per invocation.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">
                  <a href="/sequences">Sequences</a>
                </td>
                <td class="muted">
                  A drip. Steps fire N days after the previous one; <span class="mono">0</span>{' '}
                  means immediately, which is what a first step usually wants. Triggered by{' '}
                  <em>subscribe</em>, by a <em>tag being added</em>, or manually (which is what a form
                  uses). A sequence must be <strong>active</strong> or nothing sends; people still
                  enroll, they just wait.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">Transactional</td>
                <td class="muted">
                  Receipts and password resets from your other apps, via the API below. Suppression
                  is still enforced, every send is recorded, and recipients are never enrolled in
                  anything.
                </td>
              </tr>
            </tbody>
          </table>

          <div class="note" style="margin-top:16px">
            Consent is re-checked <strong>at the moment of sending</strong>, not at enrollment. Somebody
            who leaves a series after being enrolled never receives the next step.
          </div>
        </div>
      </div>

      {/* ─────────────────────────────── automation */}

      <div class="card">
        <div class="card-h">
          <h2>3 · Tags, rules and segments</h2>
        </div>
        <div class="card-b">
          <table>
            <tbody>
              <tr>
                <td style="font-weight:500;width:22%">
                  <a href="/tags">Tags</a>
                </td>
                <td class="muted">Facts you store about a person. Everything else reads them.</td>
              </tr>
              <tr>
                <td style="font-weight:500">
                  <a href="/tags">Tag rules</a>
                </td>
                <td class="muted">
                  The only automation in here. "When this happens, tag them": one flat row per rule,
                  no conditions to nest and no DSL to learn.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">
                  <a href="/segments">Segments</a>
                </td>
                <td class="muted">
                  Saved questions asked of your tags. Nothing is stored per person. Picking a segment
                  for a broadcast <em>copies</em> its rule, so editing the segment next month can't
                  rewrite who a sent broadcast went to.
                </td>
              </tr>
            </tbody>
          </table>

          <div class="note" style="margin-top:16px">
            <strong>The chain is the feature.</strong> Rules tag through the normal path, so:{' '}
            <em>click a link → get tagged → get enrolled in a sequence</em>. A sale applying a tag
            does exactly the same thing.
          </div>

          {/* ── how a rule works */}

          <h3 style="margin:24px 0 6px;font-size:15px">What a rule is</h3>
          <p class="muted">
            Every rule is one sentence with four blanks, and the form on{' '}
            <a href="/tags">Tags</a> is just those blanks:
          </p>
          <Code>{`When  <event>   happens
in    <a broadcast | a series | any message>
and   the clicked URL contains <text>      ← clicks only, optional
then  tag them <tag>`}</Code>

          <table style="margin-top:14px">
            <tbody>
              <tr>
                <td style="font-weight:500;width:26%">Rule name</td>
                <td class="muted">
                  For you, in the rules table. Write it as the thing that happened:{' '}
                  <em>“Clicked the workshop link”</em>, because that's what you'll be reading when
                  you wonder where a tag came from.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">When this happens</td>
                <td class="muted">
                  <span class="mono">click</span> · <span class="mono">open</span> ·{' '}
                  <span class="mono">delivered</span> · <span class="mono">bounce</span> ·{' '}
                  <span class="mono">complaint</span>. One event per rule. A failed send is never
                  taggable; that's your problem, not something the reader did.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">In</td>
                <td class="muted">
                  Scope. <strong>Any message</strong> watches everything you send;
                  a broadcast or a series narrows it. A series-scoped rule matches{' '}
                  <em>any step</em> of that series, not a particular one.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">Only if the URL contains</td>
                <td class="muted">
                  Case-insensitive substring of the clicked link: <span class="mono">/workshop</span>{' '}
                  catches every link to it. Set it on a non-click event and it's dropped on save,
                  because it could only ever match nothing.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">Then tag them</td>
                <td class="muted">
                  Type a name. An existing tag is reused, a new one is created on the spot; you
                  don't have to make the tag first.
                </td>
              </tr>
            </tbody>
          </table>

          <h3 style="margin:22px 0 6px;font-size:15px">What happens when one fires</h3>
          <table>
            <tbody>
              <tr>
                <td style="font-weight:500;width:26%">Immediately</td>
                <td class="muted">
                  Rules run inline on the open pixel and the click redirect, so the tag is there
                  before the reader's browser has finished following the link. Nothing is queued.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">Every match applies</td>
                <td class="muted">
                  There's no priority or first-wins. Three rules that all match one click apply all
                  three tags.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">Once per person</td>
                <td class="muted">
                  Tagging is idempotent. Somebody who clicks five times gets tagged once, the{' '}
                  <strong>Fired</strong> counter moves once, and a{' '}
                  <span class="mono">tag_added</span> sequence starts once.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">It can start a series</td>
                <td class="muted">
                  Because it tags through the normal path. If an active sequence is triggered by that
                  tag, they're enrolled. The chain stops there: a rule can't tag its way into
                  another rule, so there's no cascade to reason about.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">It never breaks the mail</td>
                <td class="muted">
                  A rule that throws is swallowed; the event is still recorded, the redirect still
                  redirects. Tracking is worth more than tagging.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">Replays are safe</td>
                <td class="muted">
                  A provider webhook delivered twice loses on <span class="mono">dedupe_key</span>{' '}
                  and the rules don't run again.
                </td>
              </tr>
            </tbody>
          </table>

          <h3 style="margin:22px 0 6px;font-size:15px">Worth knowing before you rely on one</h3>
          <table>
            <tbody>
              <tr>
                <td style="font-weight:500;width:26%">Not retroactive</td>
                <td class="muted">
                  A rule only sees events after you save it. Add it <em>before</em> the broadcast
                  goes out, not after you notice people clicking.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">Tag on clicks, not opens</td>
                <td class="muted">
                  Apple Mail Privacy Protection and corporate scanners open mail nobody read. An{' '}
                  <span class="mono">open</span> rule will tag people who never saw it. Clicks are
                  intent; opens are weather.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">Locally</td>
                <td class="muted">
                  With <span class="mono">EMAIL_PROVIDER=console</span> there's no provider, so{' '}
                  <span class="mono">delivered</span>, <span class="mono">bounce</span> and{' '}
                  <span class="mono">complaint</span> never arrive. Open and click still work;
                  follow the links in the <a href="/outbox">Outbox</a>.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">Pause, don't delete</td>
                <td class="muted">
                  <strong>Pause</strong> stops a rule and keeps its history;{' '}
                  <strong>Delete</strong> takes the counter with it. Deleting the broadcast or series
                  a rule is scoped to deletes the rule too.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">Tags in use are protected</td>
                <td class="muted">
                  A tag can't be deleted while a rule or a sequence trigger depends on it; you're
                  told what's holding it. <strong>Merging</strong> two tags repoints the rules,
                  triggers and segments at the survivor, so cleaning up{' '}
                  <span class="mono">Customer</span> vs <span class="mono">customers</span> doesn't
                  quietly break targeting.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">Untagging is instant everywhere</td>
                <td class="muted">
                  Segments are questions, not stored lists; remove a tag and every segment is
                  already correct on the next send. Nothing needs recalculating.
                </td>
              </tr>
            </tbody>
          </table>

          <h3 style="margin:22px 0 6px;font-size:15px">Three that earn their keep</h3>
          <table>
            <tbody>
              <tr>
                <td style="font-weight:500;width:26%">Interest → drip</td>
                <td class="muted">
                  <em>click</em> · any message · URL contains{' '}
                  <span class="mono">/workshop</span> → tag <span class="mono">workshop-interest</span>
                  . Point a <span class="mono">tag_added</span> sequence at that tag and the pitch
                  runs itself.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">Cold list hygiene</td>
                <td class="muted">
                  <em>click</em> · any message → tag <span class="mono">engaged</span>. Now
                  “everyone who hasn't clicked anything in a year” is a segment that excludes it.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">Series completion</td>
                <td class="muted">
                  <em>click</em> · in the onboarding series → tag{' '}
                  <span class="mono">onboarded</span>, then exclude that tag from the next nudge.
                </td>
              </tr>
            </tbody>
          </table>

          <h3 style="margin:22px 0 6px;font-size:15px">What rules deliberately don't do</h3>
          <p class="muted">
            Rules only ever <strong>add</strong> a tag off the back of a mail event. There's no
            remove-tag action, nothing fires when a tag is <em>removed</em>, and a rule can't read
            anything about the person, only what they just did. That's a floor, not an oversight:
            one flat table stays readable, and it can't loop.
          </p>
          <table>
            <tbody>
              <tr>
                <td style="font-weight:500;width:26%">Stop selling to a buyer</td>
                <td class="muted">
                  Use <span class="mono">end_sequence</span> on{' '}
                  <span class="mono">POST /api/sales</span> (below), or end the enrollment from their
                  page. A purchase cancelling a pitch is the one case worth wiring, and it's already
                  wired.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">Tag from your own app</td>
                <td class="muted">
                  Anything you can decide in code (a signup, a plan change, a refund) should tag
                  through the API rather than be inferred from mail behaviour. Tags applied that way
                  start sequences exactly like a rule's do.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">Everything else</td>
                <td class="muted">
                  Is a segment. If the question is “who is this person”, ask it at send time instead
                  of maintaining it as state.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* ─────────────────────────────── money */}

      <div class="card">
        <div class="card-h">
          <h2>4 · Campaigns, attribution and money</h2>
        </div>
        <div class="card-b">
          <p class="muted">
            A <a href="/campaigns">campaign</a> is a named push: a launch, a book, a course. It's a
            label with a ledger, not a container: broadcasts, sequences and forms opt into one, and
            sales are credited to one. Deleting a campaign drops the label and its history, never the
            mail and never the money.
          </p>

          <h3 style="margin:18px 0 6px;font-size:15px">How somebody gets attributed</h3>
          <p class="muted">
            Every arrival is recorded as a <strong>touch</strong>: one row per person, per campaign,
            per source, so both first-touch and last-touch are always answerable. You never have to
            pick an attribution model up front. A touch is written when:
          </p>
          <table>
            <tbody>
              <tr>
                <td style="font-weight:500;width:22%">
                  <span class="pill">form</span>
                </td>
                <td class="muted">they submit a form that names a campaign</td>
              </tr>
              <tr>
                <td style="font-weight:500">
                  <span class="pill">broadcast</span> <span class="pill">sequence</span>
                </td>
                <td class="muted">
                  they <strong>click</strong> a link in mail belonging to a campaign. Opens
                  deliberately don't count; image proxies and preview panes would hand credit to
                  whoever mailed most recently.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">
                  <span class="pill">manual</span>
                </td>
                <td class="muted">a sale names a campaign you had no touch for</td>
              </tr>
            </tbody>
          </table>
          <p class="faint" style="margin-top:10px">
            A person's page shows their whole ledger, with first and last touch marked.
          </p>

          <h3 style="margin:22px 0 6px;font-size:15px">Recording a sale</h3>
          <Code>{`curl -X POST ${base}/api/sales \\
  -H 'Authorization: Bearer <key>' \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"buyer@example.com",
       "amount_cents":4900,
       "product":"The Imposter Handbook",
       "external_id":"ch_3Qx...",
       "tags":["customer"],
       "end_sequence":"launch-drip"}'`}</Code>

          <table>
            <tbody>
              <tr>
                <td style="font-weight:500;width:28%">
                  <span class="mono">amount_cents</span>
                </td>
                <td class="muted">
                  Integer cents, required. <span class="mono">amount</span> (dollars) also works if
                  your checkout only speaks that.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">
                  <span class="mono">external_id</span>
                </td>
                <td class="muted">
                  Your charge or order id. Makes the call <strong>idempotent</strong>: replaying it
                  returns the original sale instead of double-counting revenue. Send it.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">
                  <span class="mono">campaign</span>
                </td>
                <td class="muted">
                  Optional. Credit resolves <strong>explicit → last touch → nothing</strong>, and the
                  response tells you which rule applied. An unknown slug still records the sale and
                  returns a warning; a typo never loses money.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">
                  <span class="mono">tags</span>
                </td>
                <td class="muted">
                  Applied through the normal path, so a purchase can start a{' '}
                  <span class="mono">tag_added</span> sequence: bought → tagged → onboarded.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">
                  <span class="mono">end_sequence</span>
                </td>
                <td class="muted">
                  Cancels their active enrollment: stop selling somebody the thing they just bought.
                  It doesn't record an opt-out; that's their choice to make, not a purchase's.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">Refunds</td>
                <td class="muted">
                  Re-post the same <span class="mono">external_id</span> with{' '}
                  <span class="mono">"status":"refunded"</span> and it flips the original row. A
                  refunded sale stops counting toward revenue; it doesn't subtract.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">Buyers</td>
                <td class="muted">
                  are created if unknown, but never get <em>subscribe</em>-triggered sequences. A
                  purchase isn't a newsletter signup; post-purchase mail comes from the tags.
                </td>
              </tr>
            </tbody>
          </table>
          <p class="faint">
            <a href="/sales">Sales</a> also has a form for recording one by hand.
          </p>
        </div>
      </div>

      {/* ─────────────────────────────── api reference */}

      <div class="card">
        <div class="card-h">
          <h2>5 · Every endpoint</h2>
        </div>
        <div class="card-b flush">
          <table>
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Auth</th>
                <th>What it's for</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td class="mono">POST /f/:slug</td>
                <td>
                  <span class="pill ok">public</span>
                </td>
                <td class="muted">Form signup. Form-encoded or JSON.</td>
              </tr>
              <tr>
                <td class="mono">POST /api/sales</td>
                <td>
                  <span class="pill warn">bearer</span>
                </td>
                <td class="muted">Record money against a person.</td>
              </tr>
              <tr>
                <td class="mono">POST /api/send</td>
                <td>
                  <span class="pill warn">bearer</span>
                </td>
                <td class="muted">
                  Transactional mail. Takes <span class="mono">idempotency_key</span>.
                </td>
              </tr>
              <tr>
                <td class="mono">POST /webhooks/resend</td>
                <td>
                  <span class="pill warn">signed</span>
                </td>
                <td class="muted">Delivery, bounce and complaint events from the provider.</td>
              </tr>
              <tr>
                <td class="mono">GET /p/:token</td>
                <td>
                  <span class="pill ok">public</span>
                </td>
                <td class="muted">A subscriber's preference center, scoped per series.</td>
              </tr>
              <tr>
                <td class="mono">GET /t/open/:id.gif · /t/click/:id</td>
                <td>
                  <span class="pill ok">public</span>
                </td>
                <td class="muted">Open and click tracking. Everything else is operator-only.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="card-b">
          <p class="faint">
            Bearer keys live in the <span class="mono">api_keys</span> table; only the hash is
            stored, so a leaked database can't be used to post as you. ⚠️ There's no key-management
            UI yet.
          </p>
        </div>
      </div>

      {/* ─────────────────────────────── running it */}

      <div class="card">
        <div class="card-h">
          <h2>6 · Running it</h2>
        </div>
        <div class="card-b">
          <table>
            <tbody>
              <tr>
                <td style="font-weight:500;width:26%">
                  <a href="/outbox">Outbox</a>
                </td>
                <td class="muted">
                  With <span class="mono">EMAIL_PROVIDER=console</span> mail is written here and
                  never sent. Read it exactly as it would arrive, including the footer, whose
                  unsubscribe link is scoped to whatever the message was sent under.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">Run sequences now</td>
                <td class="muted">
                  On the <a href="/">dashboard</a>. Advances due steps without waiting on the cron.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">Fast-forward the clock</td>
                <td class="muted">
                  Pulls every pending step forward to now, so you can play a 5-day drip in 5 seconds.
                  Local only.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">Seed / reset</td>
                <td class="muted">Demo data: people, live series, a sent broadcast. Local only.</td>
              </tr>
              <tr>
                <td style="font-weight:500">Cron</td>
                <td class="muted">
                  Ticks every minute: advance sequences, then push scheduled broadcasts along. Both
                  are resumable and idempotent, so a missed or doubled tick is harmless.
                </td>
              </tr>
              <tr>
                <td style="font-weight:500">Schema changes</td>
                <td class="muted">
                  <span class="mono">bun run db:generate</span> then{' '}
                  <span class="mono">bun run db:migrate</span>.
                </td>
              </tr>
            </tbody>
          </table>

          <div class="note" style="margin-top:16px">
            <strong>Anything you need to observe must be a row in D1.</strong> Workers logs are gone
            within a week, which is why rules, forms and sends all carry their own counters.
          </div>
        </div>
      </div>

      <p class="faint" style="margin-bottom:40px">
        Current provider: <span class="mono">{c.env.EMAIL_PROVIDER}</span> · from{' '}
        <span class="mono">
          {c.env.FROM_NAME} &lt;{c.env.FROM_EMAIL}&gt;
        </span>{' '}
        · admin auth{' '}
        <span class="mono">
          {c.env.DEV_AUTH_BYPASS === 'true' ? 'DEV BYPASS (local only)' : 'Cloudflare Access'}
        </span>
        . More in <a href="/settings">Settings</a>.
      </p>
    </Layout>,
  )
})
