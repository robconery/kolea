# 🧭 A tour of Kōlea

What every screen is for, the words the app uses, how it measures, and the editor.
The app also carries its own manual at **System → Help** (`/help`), with every URL and
`curl` filled in for wherever you are running it.

## 🎯 Try the thing it's for

1. **Subscribers** → pick someone → **Open their preference center**
2. Add `?scope=sequence:2` to that URL. This is what a link inside a sequence email
   looks like.
3. Hit **Stop just this series**
4. Go back to their subscriber page: still `active`, still on the newsletter, out of
   exactly one series
5. **Consent** shows everyone who left a single series versus the (empty) list of
   people gone entirely

Send a broadcast afterwards and they'll still receive it. That's the whole argument.

Sequence delays are in **days**, and the first step defaults to 0 (arrives on join)
while later steps default to 1. Which means a seeded series won't finish while you
watch it, so the dashboard has **Fast-forward the clock** (local only): it pulls every
pending step to now and runs a tick. Use it and you'll watch step 2 skip the people
who left that series.

---

## 🧭 A tour of the console

Everything in the left rail, top to bottom, and what it's for. There's also a manual
built into the app at **System → Help** (`/help`), with every URL and `curl` already
filled in for wherever you're running it.

### 🏠 Dashboard

Where the list stands today: readers on the site against mail going out, the last send
and its score, who's on the list, who left what, and what's in draft. The **Consent, by scope** panel is the one to look at. It separates people who
left one series from people who left everything. Locally, it's also where **Seed demo
data**, **Fast-forward the clock** and **Reset data** live.

### 👥 Audience

| Screen | What it's for |
|---|---|
| **Subscribers** | Everyone you know about. Open anyone to see their tags, their sequences, every mail they got and what they did with it, and a link to their preference center exactly as they'd see it. CSV import is here too. |
| **Tags & automation** | Tags are facts you store about people. *Automation* is tag rules: "clicked this link → tag them", and a tag can start a sequence. That chain (click, tag, enroll) is how someone who shows interest gets the follow-up without you doing anything. |
| **Segments** | Saved questions about the list ("tagged `customer`, not tagged `ruby`, joined this year"). A broadcast goes to a segment. The count you see is the count the send will produce, from the same function. |

### ✉️ Mail

| Screen | What it's for |
|---|---|
| **Broadcasts** | One-off mail to a segment: the newsletter. Write it in the block editor, send yourself a test, then send it. (An agent can schedule one through MCP; the admin has no date picker yet.) The **Web** panel beside the editor decides whether it also goes up as a post on your public site, and holds its excerpt, featured image and topics. |
| **Sequences** | Drip series: a list of steps with a delay in days between them, started by a form, a tag or a signup. People can leave one series without leaving anything else. A sequence is created paused; activating it is a deliberate click. |
| **Templates** | Starting points for a sequence: staples like a welcome series, launches, funnels. With AI help switched on, "Make it yours" drafts the whole series for you to rewrite. |
| **Outbox** | Every mail rendered while `EMAIL_PROVIDER=console`, exactly as it would have gone out: footer, merge tags, tracking links. Locally this is where all mail goes. In production it's your kill switch's landing pad. |

### 📊 Analytics

Read-only, all of it. No screen here can send or change anything. See
[Measurement](#-measurement) below for the reasoning behind each one.

| Screen | The question it answers |
|---|---|
| **Overview** | Is the list healthy, and is the writing good? Two separate dials, because they need opposite fixes. |
| **Activity** | What happened, in order: signups, tags, enrollments, opt-outs, purchases. The only screen that shows events rather than totals. |
| **Sequences** | Which series people finish, where they drop off, and what each one earned. |
| **Broadcasts** | Every send scored against *your own* median, not an industry number. |
| **Contribution** | Which mail actually moved a goal. |
| **List health** | Growth, engagement, churn, delivery and money, each with a sentence on what to do. |

### 💳 Money

These fill in once Stripe is connected. Without it they're empty, and everything
else works fine.

| Screen | What it's for |
|---|---|
| **Campaigns** | A named push ("spring launch") that broadcasts, sequences and forms can belong to. A click on campaign mail counts as a *touch*, and a sale after a touch is credited to it. |
| **Forms** | Signup endpoints. A form is a URL you post a plain HTML `<form>` to, from any site. It can tag people, start a sequence, and hand over a file (a lead magnet) by email. Every file also has a direct link you can send to anybody yourself. |
| **Sales** | Every Stripe charge, and which mail gets the credit. Anything with no click in the window is `direct`, which is usually the honest answer. |
| **Purchase mail** | What a buyer is sent after they buy, per product. Sending it is a button you press on a sale; the webhook never mails anyone by itself. |
| **Goals** | Targets over a named period: "30 cohort signups in Q2". |
| **Conversions** | The events counted against goals. One per sale, the first matching kind wins. |
| **Store** (overview, offers, customers, segment ideas) | What sells and who buys it. *Segment ideas* proposes audiences from what people actually bought, sized with the same count a send would use. |

### ⚙️ System

| Screen | What it's for |
|---|---|
| **Profile** | Who the public site is about: name, photo, short bio, the /about page, social links. Themes read it; switching themes never loses it. |
| **Themes** | How the public site looks. Three built-in (Folio, Signal, Nightdrive), or install a zip. Preview against your real posts, then switch. See [`docs/templates.md`](templates.md) to make your own. |
| **Consent** | Everyone who left a single series, set side by side with everyone who left entirely. |
| **Settings** | Which provider is live, the `PUBLIC_URL` baked into mail, and how to call the transactional API. Check it after every deploy. |
| **Help** | The in-app manual. |

### 🌐 Pages your readers see

None of these are behind your login. They can't be, or the mail you've already sent
stops working.

| Path | What it is |
|---|---|
| `/p/…` | The preference center. The unsubscribe link in every mail lands here, with the *narrow* choice first. |
| `/f/<slug>` | Where your signup forms post. |
| `/d/…` | Lead-magnet downloads. The link itself is the permission. |
| `/t/…` | Open pixels and click redirects. |
| `/media/…` | Images inside your mail. |
| Your site host | The public blog, if you turned it on. |

---

## 📖 The words used here

| Word | Means |
|---|---|
| **Broadcast** | One piece of mail to a segment, sent once. Also a post, if you publish it. |
| **Sequence** / **step** | A drip series, and one mail in it. Delays are whole days. |
| **Enrollment** | One person's progress through one sequence. |
| **Segment** | A saved rule that picks people. Evaluated at send time. |
| **Tag** / **tag rule** | A label on a person / an "when X happens, tag them" automation. |
| **Form** | A public URL that turns a POST into a subscriber, with consent recorded. |
| **Lead magnet** | A file a form hands over. Lives in its own bucket, and leaves by a per-person link in the reply or by the form's one direct link, which you hand out yourself and can reset. |
| **Campaign** / **touch** | A named push / a click on its mail, which is what earns it credit for a sale. |
| **Conversion** / **goal** | Something that happened (a sale, a signup) / a target you set for a period. |
| **Opt-out** | Leaving *one* sequence. Everything else carries on. |
| **Unsubscribed** | Leaving the newsletter (broadcasts). Series you joined carry on. Permanent: no import brings you back. |
| **Suppression** | Off everything, forever. Written by "unsubscribe from everything", a hard bounce, or a spam complaint. |
| **Transactional** | Receipts and downloads sent by your other apps through `/api/send`. Ignores marketing consent; blocked only by a suppression. |
| **Provider** | What puts mail on the wire. `resend` for real, `console` for the Outbox. |
| **Kill switch** | Setting `EMAIL_PROVIDER=console`. Mail renders into the Outbox instead of going out. |
| **Preflight** | The one-time token an agent must fetch before it can send, which any edit invalidates. |
| **Signal** | The 0 to 100 score for a send, the same scale for broadcasts and sequences. |
| **Operator** | You. There's exactly one, and Cloudflare Access is what knows it's you. |

---

## 📊 Measurement

An ESP will happily show you an open rate and let you draw your own conclusions. The
five screens under **Analytics** exist because a mailing list is the one asset here you
cannot inspect by looking at it: you can read every broadcast you ever wrote and still
have no idea whether the list is healthy, and no amount of staring at a sequence tells
you which mail in it loses people.

![One sequence, step by step: how many got each mail, how many opened it, how many clicked, and where people fell out](img/sequence-report.png)

<sub>The step waterfall for one sequence, on demo data. Retention is measured against **step one**, never
against the previous step. Chained ratios hide a slow bleed across six mails behind six
unremarkable-looking numbers.</sub>

| Screen | The question |
|---|---|
| **Overview** | Two dials: the health of the list, and the median score of the writing. A healthy list carrying weak sends and a weak list carrying great sends look identical on any single number, and they want opposite responses. |
| **Sequences** | Every series ranked, with the two things a rate can't tell you: who finishes, and what it earned. Flags series switched off with people still inside them. |
| **Broadcasts** | Every send scored against **your own median**, which is the only benchmark that survives contact with reality. |
| **Contribution** | Which mail actually moved a goal: by channel, and by the individual broadcast or sequence that earned the credit. |
| **List health** | Growth, engagement, churn, delivery and money, each with the sentence saying what to do about it. |

Every figure on these screens carries the two integers underneath it, because a rate
with no denominator is how dashboards mislead people who trust them. **Nothing here
writes**: no forms, no POST routes, by construction. An analytics page that can send
mail is one misclick from mailing the whole list.

```bash
bun scripts/seed-analytics-demo.ts     # local only, and there is no --remote flag
```

That seeds a world worth looking at: demo people spread over a year, two live sequences
with real message and event history, imported broadcasts, conversions and a couple of
goals. `--clean` removes every row of it again.

---

## ✍️ The editor

Block-style rich text, TipTap v3, vanilla (no React). Open the seeded draft
**"Draft: everything the editor can do"** to see the lot.

- `/` on a line → block menu: headings, lists, checklist, quote, code, table, toggle,
  divider, image, YouTube, CTA button
- `@` → personalization fields as real nodes, so `first_name` can't be misspelled
- Drag the handle in the left margin to reorder; shift-select spans multiple blocks
- Drop or paste an image anywhere → uploads to R2, inserts when the URL returns
- Code blocks are syntax-highlighted (15 languages, incl. Ruby, Elixir, TS, SQL)
- Select text for the bubble menu; select a **button** and the bubble menu becomes its
  URL and colour picker

**Buttons and merge tags are custom nodes** built specifically for email. A CTA renders
as a nested table, and every style is inlined. A merge tag is a node rather than raw
`{{first_name}}` text, because a typo in raw text mails "Hi {{frist_name}}" to the
entire list.

Bodies are stored as TipTap JSON in `body_json`. Legacy markdown in `body_md` still
renders and is converted the moment you open it in the editor. Nothing is migrated in
bulk, because a bulk migration that goes wrong takes the archive with it.

The client bundle is ~226KB gzipped and loads only on the two screens that compose
mail. Everything else in the admin console is server-rendered with zero JavaScript.

There's a browser smoke test (`bun run smoke`, 33 checks) driving real Chromium,
because a renamed extension option fails silently in the browser and the body field
just never saves. Nothing server-side can catch that.

---

[Back to the README](../README.md)
