# 📖 STORIES — Kōlea

> Owner: `/plan`. Do not edit from other phases.
>
> Canonical backlog, sliced from [`docs/SPEC.md`](SPEC.md). Consumed by the
> `bdd-specs` skill: each **Story** becomes a Feature (one spec file), each
> acceptance criterion becomes a Scenario, and each `Then` becomes one
> Specification with exactly one assertion.
>
> These stories describe behavior that is **already built**. They were written
> after the fact, from SPEC, to give the test suite something to be accountable
> to — so the suite reads as "here is what this product promises" rather than
> "here is what the code happens to do". Where a story and the code disagree,
> SPEC decides, and the disagreement is a bug report (CLAUDE.md).

## 🎭 The roles

There are only four, and the whole consent model turns on telling them apart.

| Role | Who | Reaches the system through |
|---|---|---|
| **the list owner** | Rob. One operator, no team, no other customers. | The admin console, behind Cloudflare Access |
| **a reader** | Somebody on the list. Never logs in, never has an account. | A link in an email: the preference center, tracking, downloads |
| **a consuming app** | Big Admin, a checkout, anything of Rob's that needs to mail somebody. | `POST /api/send` with a bearer key |
| **an agent** | Claude, over MCP. | `/mcp/:secret`, the same `core/` rules as everyone else |

## ✅ Definition of Ready

- Role, capability and value are all stated, and the "so that" is not hollow.
- Acceptance criteria are in Given/When/Then form and cover the happy path.
- The criterion names the SPEC clause it comes from, so the trail is walkable.

## ✅ Definition of Done

- Every acceptance criterion is an executable Scenario in `tests/specs/`.
- Sad-path criteria are covered too, in their own segregated Scenario blocks.
- At least one Scenario per Feature drives a **deployed entry point** —
  `worker.fetch`, `worker.scheduled` or `worker.queue` — not just an internal
  function (bdd-specs rule 7).
- `bun run typecheck` and `bun test` both pass.

---

## 🧑‍🤝‍🧑 Epic: the audience

Own the list outright: who is on it, what they are tagged, and who a given
mailing is actually for.

### STORY-001 — One address, one person

As **the list owner**,
I want an address to mean exactly one subscriber however it is typed,
so that **I never mail the same human twice or split their history in two**.

**Size:** S · **Status:** built · **SPEC:** 1.1, 1.4

**Acceptance criteria**

_Happy path:_

```
AC1 — stored normalized
  Given nobody on the list
  When  I add "  Ada@Example.COM  "
  Then  the stored address is "ada@example.com"

AC2 — case is not a new person
  Given "ada@example.com" is on the list
  When  I add "ADA@EXAMPLE.COM"
  Then  the list still holds one subscriber

AC3 — the second add updates rather than inserts
  Given "ada@example.com" is on the list with no name
  When  I add "ADA@EXAMPLE.COM" with the name "Ada Lovelace"
  Then  the outcome is reported as "updated"

AC4 — a new subscriber is active by default
  Given nobody on the list
  When  I add an address with no status given
  Then  their status is "active"

AC5 — a buyer on file is not a subscriber
  Given nobody on the list
  When  an address is added with status "pending"
  Then  their status is "pending"
```

_Sad path:_

```
AC6 — rejects a malformed address
  Given nobody on the list
  When  I add "not-an-address"
  Then  the outcome is "invalid"

AC7 — nothing is written for a malformed address
  Given nobody on the list
  When  I add "not-an-address"
  Then  the list is still empty
```

**Out of scope:** double opt-in — still an open question in SPEC §1.

---

### STORY-002 — Import a list without undoing anybody's choice

As **the list owner**,
I want to import a CSV that updates people already on file,
so that **I can bring a list across without duplicating anyone or resurrecting
somebody who left**.

**Size:** M · **Status:** built · **SPEC:** 1.2, 1.3

**Acceptance criteria**

_Happy path:_

```
AC1 — new rows are created
  Given an empty list
  When  I import a CSV of two new addresses
  Then  the report says 2 created

AC2 — existing rows are updated, not duplicated
  Given "ada@example.com" is on the list
  When  I import a CSV containing her address with a new name
  Then  the report says 1 updated

AC3 — the update lands
  Given the same import
  Then  her stored name is the one from the CSV

AC4 — tags in the CSV are applied
  Given an import whose rows carry a `tags` column
  Then  the named tag exists on the imported subscriber

AC5 — an unsubscribed person stays unsubscribed  ⭐
  Given "grace@example.com" has status "unsubscribed"
  When  an import includes her address
  Then  her status is still "unsubscribed"
```

_Sad path:_

```
AC6 — a malformed row does not abort the import
  Given a CSV whose second row has an empty email cell
  When  I import it
  Then  the rows after the bad one are still created

AC7 — the bad row is counted
  Given the same import
  Then  the report counts 1 invalid

AC8 — a CSV with no email column imports nothing
  Given a CSV whose header has no `email` column
  When  I import it
  Then  the report says 0 created
```

**Out of scope:** the bulk-import path used for real migrations
(`scripts/import-kit.ts`), which deliberately bypasses `upsertSubscriber` —
see invariant 5.

---

### STORY-003 — Tag people, and untag them, without losing them

As **the list owner**,
I want tags to be freely addable and removable,
so that **I can segment the list without the tagging ever costing me a subscriber**.

**Size:** S · **Status:** built · **SPEC:** 1.5

**Acceptance criteria**

_Happy path:_

```
AC1 — a tag lands
  Given a subscriber and a tag
  When  I add the tag
  Then  the call reports 1 tag added

AC2 — adding the same tag twice is idempotent
  Given a subscriber already carrying the tag
  When  I add it again
  Then  the call reports 0 tags added

AC3 — removing a tag keeps the person
  Given a tagged subscriber
  When  I remove the tag
  Then  the subscriber still exists

AC4 — removing a tag removes only the tag
  Given the same removal
  Then  they no longer carry that tag
```

_Sad path:_

```
AC5 — untagging somebody who was never tagged is a no-op
  Given a subscriber with no tags
  When  I remove a tag from them
  Then  no activity is recorded for it
```

---

### STORY-004 — Send to a slice of the list, not all of it

As **the list owner**,
I want a segment to resolve to exactly the people a broadcast may go to,
so that **the count I am shown is the audience I actually mail**.

**Size:** M · **Status:** built · **SPEC:** 1.6

**Acceptance criteria**

_Happy path:_

```
AC1 — an empty rule is everyone active
  Given three active subscribers
  When  I resolve an empty rule
  Then  it returns 3 people

AC2 — include-any narrows to the tagged
  Given one of them tagged "customer"
  When  I resolve a rule including that tag
  Then  it returns 1 person

AC3 — exclude-any removes the tagged
  Given the same list
  When  I resolve a rule excluding that tag
  Then  it returns 2 people

AC4 — the count matches the resolution
  Given any rule
  When  I count it and resolve it
  Then  the two agree

AC5 — cursoring pages the audience
  Given three matching people
  When  I resolve with a limit of 2 and then from the last id
  Then  the second page returns the remaining person
```

_Sad path:_

```
AC6 — unsubscribed people are not in any segment
  Given a subscriber with status "unsubscribed"
  When  I resolve an empty rule
  Then  they are not in the result
```

**Out of scope:** purchase-history predicates (they read the commerce mirror,
which is a separate epic), and the segment-builder UI.

---

## ⭐ Epic: consent is scoped

The reason this project exists. Three independent scopes — one sequence, the
newsletter, everything — and a narrow action must never escalate to a wider one.
**Do not trust your priors about how ESPs work here.**

### STORY-005 — Leave one series and stay on everything else ⭐

As **a reader**,
I want to stop one email series without leaving the rest,
so that **saying "not this one" does not cost me the newsletter I actually wanted**.

**Size:** M · **Status:** built · **SPEC:** 2.3, 2.4, 2.9, 6.7

**Acceptance criteria**

_Happy path:_

```
AC1 — the opt-out is recorded
  Given a subscriber enrolled in the "onboarding" series
  When  they leave it
  Then  a sequence opt-out row exists for that pair

AC2 — that enrollment is cancelled
  Given the same departure
  Then  their onboarding enrollment is "cancelled"

AC3 — they stay active
  Given the same departure
  Then  their subscriber status is still "active"

AC4 — no suppression is written
  Given the same departure
  Then  the suppressions table is empty

AC5 — another series keeps running
  Given they were also enrolled in a second series
  When  they leave the first
  Then  the second enrollment is still "active"

AC6 — broadcasts still reach them
  Given the same departure
  When  a broadcast is sent to everyone active
  Then  they receive it

AC7 — the series they left does not
  Given the same departure
  When  the sequence tick runs
  Then  they are sent nothing from that series

AC8 — leaving is reversible by the reader
  Given they left the series
  When  they rejoin it
  Then  the opt-out row is gone
```

_Sad path:_

```
AC9 — an unknown sequence id is a no-op, not an error
  Given a subscriber
  When  they "leave" a sequence id that does not exist
  Then  the call reports false

AC10 — and writes nothing
  Given the same call
  Then  no opt-out row exists

AC11 — an opt-out survives re-enrollment attempts
  Given they left the series
  When  something tries to enroll them again
  Then  the outcome is "opted_out"
```

---

### STORY-006 — Leave the newsletter and keep the series I signed up for

As **a reader**,
I want unsubscribing from broadcasts to leave my sequences running,
so that **the course I paid for keeps arriving after I mute the newsletter**.

**Size:** S · **Status:** built · **SPEC:** 2.5, 6.7

**Acceptance criteria**

_Happy path:_

```
AC1 — status changes
  Given an active subscriber
  When  they unsubscribe from broadcasts
  Then  their status is "unsubscribed"

AC2 — the moment is recorded
  Given the same action
  Then  `unsubscribed_at` is set

AC3 — no suppression is written
  Given the same action
  Then  the suppressions table is empty

AC4 — sequence enrollments keep running
  Given they were enrolled in a series
  When  they unsubscribe from broadcasts
  Then  that enrollment is still "active"

AC5 — and the series still sends to them  ⭐
  Given the same state
  When  the sequence tick runs
  Then  they are sent the step

AC6 — broadcasts no longer reach them
  Given the same state
  When  a broadcast is dispatched
  Then  their message is recorded as suppressed rather than queued

AC7 — resubscribing restores them
  Given they unsubscribed
  When  they resubscribe
  Then  their status is "active" again
```

---

### STORY-007 — One deliberate action to stop everything

As **a reader**,
I want a single explicit choice that stops all email,
so that **I have a real escape hatch, and it is never the one I hit by accident**.

**Size:** M · **Status:** built · **SPEC:** 2.6, 6.7, 6.17

**Acceptance criteria**

_Happy path:_

```
AC1 — the address is suppressed
  Given an active subscriber
  When  they unsubscribe from everything
  Then  a suppression exists for their address with reason "unsubscribed_all"

AC2 — their status changes
  Given the same action
  Then  their status is "unsubscribed"

AC3 — every active enrollment is cancelled
  Given they were enrolled in two series
  When  they unsubscribe from everything
  Then  neither enrollment is "active"

AC4 — no path reaches them afterwards
  Given the same state
  When  a broadcast is dispatched to everyone
  Then  their message is recorded as suppressed

AC5 — nor does a sequence
  Given the same state
  When  the sequence tick runs
  Then  nothing is sent to them
```

_Sad path:_

```
AC6 — doing it twice is idempotent
  Given they already unsubscribed from everything
  When  they do it again
  Then  there is still exactly one suppression for their address
```

---

### STORY-008 — A dead address or a spam complaint stops the mail by itself

As **the list owner**,
I want hard bounces and complaints to suppress automatically,
so that **my sending reputation is not spent on addresses that cannot or will
not receive**.

**Size:** M · **Status:** built · **SPEC:** 2.1, 2.2, 2.7, 2.8, 5.1

**Acceptance criteria**

_Happy path:_

```
AC1 — a hard bounce suppresses
  Given a sent message to a subscriber
  When  the provider reports a hard bounce
  Then  a suppression exists with reason "hard_bounce"

AC2 — and marks the subscriber
  Given the same event
  Then  their status is "bounced"

AC3 — a complaint suppresses
  Given a sent message
  When  the provider reports a complaint
  Then  a suppression exists with reason "complaint"

AC4 — and marks the subscriber
  Given the same event
  Then  their status is "complained"

AC5 — a blocked send is observable, not silent  ⭐
  Given a suppressed address on the list
  When  a broadcast is dispatched
  Then  a message row exists for them with status "suppressed"

AC6 — and says why
  Given the same dispatch
  Then  its `suppressed_reason` is "suppressed"

AC7 — the operator can suppress by hand
  Given an address
  When  the operator suppresses it manually
  Then  a suppression exists with reason "manual"

AC8 — and lift it again
  Given a manual suppression
  When  the operator removes it
  Then  no suppression remains for that address
```

_Sad path:_

```
AC9 — a soft bounce suppresses nothing
  Given a sent message
  When  the provider reports a soft bounce
  Then  the suppressions table is empty

AC10 — and does not change the subscriber
  Given the same event
  Then  their status is still "active"

AC11 — lifting a suppression does not resurrect them
  Given a bounced subscriber whose suppression is removed
  Then  their status is still "bounced"
```

---

### STORY-009 — A preference center that works from an email link ⭐

As **a reader**,
I want to manage exactly what I get from a link in the mail,
so that **I can turn off the one thing I do not want without an account, a
login, or a conversation**.

**Size:** L · **Status:** built · **SPEC:** 2a.1–2a.6, 9.3

**Acceptance criteria**

_Happy path:_

```
AC1 — the page opens on the token alone
  Given a subscriber's unsubscribe token
  When  I GET /p/<token>
  Then  the response is 200

AC2 — it names the person
  Given the same request
  Then  the page shows their email address

AC3 — it lists the series they are in
  Given they are enrolled in "onboarding"
  When  I open the page
  Then  the page shows "onboarding"

AC4 — arriving from a series highlights that series  ⭐
  Given a link carrying scope=sequence:<id>
  When  I open it
  Then  the page offers "Stop just this series"

AC5 — global unsubscribe is present but not the default
  Given the same page
  Then  it also offers "Unsubscribe from everything"

AC6 — leaving one series works without JavaScript
  Given the page
  When  I POST action=leave:<id> as a plain form
  Then  the response redirects (303)

AC7 — and the reader stays active
  Given the same post
  Then  their status is still "active"

AC8 — it is idempotent
  Given they already left that series
  When  the same form is posted again
  Then  there is still exactly one opt-out row

AC9 — the newsletter can be turned off from the same page
  Given the page
  When  I post action=unsub_broadcast
  Then  their status is "unsubscribed"

AC10 — and back on
  Given an unsubscribed reader
  When  I post action=resub_broadcast
  Then  their status is "active"

AC11 — one-click honours the narrow scope  ⭐ (RFC 8058)
  Given a one-click URL carrying scope=sequence:<id>
  When  a mail client POSTs it
  Then  only that enrollment is cancelled

AC12 — one-click without a sequence scope leaves the newsletter
  Given a one-click URL with scope=broadcast
  When  a mail client POSTs it
  Then  their status is "unsubscribed"
```

_Sad path:_

```
AC13 — an unknown token 404s
  Given a token nobody holds
  When  I open /p/<token>
  Then  the response is 404

AC14 — and reveals nothing
  Given the same request
  Then  the page contains no email address

AC15 — an unrecognized action changes nothing
  Given a valid token
  When  I post action=nonsense
  Then  their status is unchanged
```

---

## 📣 Epic: broadcasts

### STORY-010 — Write a broadcast, send it, and know it went

As **the list owner**,
I want to draft a broadcast and send it to a segment,
so that **the newsletter goes out and I can see exactly who it reached**.

**Size:** L · **Status:** built · **SPEC:** 3.1, 3.4–3.7, 5.5

**Acceptance criteria**

_Happy path:_

```
AC1 — a new broadcast is a draft
  Given nothing
  When  I create a broadcast
  Then  its status is "draft"

AC2 — a draft is freely editable
  Given a draft
  When  I change the subject
  Then  the change is saved

AC3 — sending materializes one message per recipient
  Given three active subscribers
  When  I send the broadcast
  Then  three messages exist for it

AC4 — each carries the subject
  Given the same send
  Then  a recipient's mail has that subject

AC5 — everybody gets their own copy
  Given the same send
  Then  three mails were handed to the provider

AC6 — the broadcast finishes as sent
  Given the same send
  Then  its status is "sent"

AC7 — recipients are resolved once, at dispatch  ⭐
  Given the broadcast has been sent
  When  a new subscriber joins afterwards and the send is driven again
  Then  no message exists for the newcomer

AC8 — dispatching twice never duplicates a recipient
  Given a sent broadcast
  When  the send is driven again
  Then  each subscriber still has exactly one message

AC9 — stats report what happened
  Given the same send
  Then  the stats show 3 sent
```

_Sad path:_

```
AC10 — a sent broadcast cannot be edited
  Given a sent broadcast
  When  I try to update it
  Then  the call is refused

AC11 — a mid-send broadcast cannot be deleted
  Given a broadcast in "sending"
  When  I try to delete it
  Then  the call is refused
```

---

### STORY-011 — Schedule a broadcast and be able to call it off

As **the list owner**,
I want to park a broadcast for later and cancel it before it goes,
so that **I can write on Sunday, send on Tuesday, and still change my mind on
Monday**.

**Size:** M · **Status:** built · **SPEC:** 3.3, 3.4

**Acceptance criteria**

_Happy path:_

```
AC1 — scheduling parks it
  Given a draft
  When  I schedule it for tomorrow
  Then  its status is "scheduled"

AC2 — the time is recorded
  Given the same action
  Then  `scheduled_at` is that time

AC3 — nothing is sent before it is due
  Given a broadcast scheduled for tomorrow
  When  the cron tick runs now
  Then  no mail has been sent

AC4 — a due broadcast is picked up by the tick  ⭐
  Given a broadcast whose scheduled time has passed
  When  the cron tick runs
  Then  its recipients are mailed

AC5 — cancelling stops it
  Given a scheduled broadcast
  When  I cancel it
  Then  its status is "cancelled"

AC6 — a cancelled broadcast is never picked up
  Given a cancelled broadcast whose time has passed
  When  the cron tick runs
  Then  no mail has been sent
```

_Sad path:_

```
AC7 — a time in the past is refused
  Given a draft
  When  I schedule it for yesterday
  Then  the call is refused

AC8 — a draft has nothing to cancel
  Given a draft
  When  I cancel it
  Then  the call is refused
```

---

### STORY-012 — An interrupted send resumes without mailing anyone twice

As **the list owner**,
I want a send that died halfway to pick up where it left off,
so that **a crash costs me a minute, not my reputation**.

**Size:** M · **Status:** built · **SPEC:** 3.6, 3.8, 4.1, 4.3

**Acceptance criteria**

_Happy path:_

```
AC1 — an already-sent message is skipped
  Given a message already marked sent
  When  it is sent again
  Then  the outcome is "skipped"

AC2 — and no second copy goes out
  Given the same replay
  Then  the provider was handed nothing

AC3 — a successful send records the provider
  Given a queued message
  When  it is sent
  Then  the row carries the provider name

AC4 — and the provider's id
  Given the same send
  Then  the row carries a provider message id

AC5 — and when it went
  Given the same send
  Then  `sent_at` is set

AC6 — one bad recipient does not stop the batch
  Given three queued messages, one of them to a suppressed address
  When  the batch is sent
  Then  the other two are sent

AC7 — the blocked one is recorded, not dropped
  Given the same batch
  Then  the third message's status is "suppressed"

AC8 — a queue batch acks each message on its own result
  Given a batch of two queued messages
  When  the queue consumer runs
  Then  both are acked
```

_Sad path:_

```
AC9 — the dead-letter queue never sends
  Given a queued message
  When  it arrives on the -dlq queue
  Then  no mail is sent

AC10 — it is recorded as failed instead
  Given the same delivery
  Then  the message status is "failed"
```

---

### STORY-013 — Every mail carries a way out that fits its scope

As **a reader**,
I want the unsubscribe link in a mail to match what that mail actually is,
so that **leaving a drip series does not silently take the newsletter with it**.

**Size:** M · **Status:** built · **SPEC:** 3.9, 2a.1–2a.3, 6.9, 7.4

**Acceptance criteria**

_Happy path:_

```
AC1 — a broadcast carries a preference link with the reader's own token
  Given a sent broadcast
  Then  the mail body contains /p/<their token>

AC2 — the link is unique to the reader
  Given two recipients
  Then  their two mails carry different tokens

AC3 — a broadcast's footer names the newsletter
  Given a sent broadcast
  Then  the footer offers to unsubscribe from the newsletter

AC4 — a sequence mail's link is scoped to that sequence  ⭐
  Given a sent sequence step
  Then  the link carries scope=sequence:<id>

AC5 — and the footer offers the narrow action
  Given the same mail
  Then  it reads "Stop just this series"

AC6 — and names the series
  Given the same mail
  Then  the footer names the sequence

AC7 — transactional mail carries no unsubscribe footer  ⭐
  Given a transactional send
  Then  the mail contains no preference link
```

_Sad path:_

```
AC8 — the unsubscribe link is never click-tracked
  Given any marketing mail
  Then  no /t/click/ URL wraps the preference link
```

---

## 📈 Epic: tracking

### STORY-014 — See what happened to a mailing, without trusting a log file

As **the list owner**,
I want opens, clicks and provider events recorded as rows,
so that **I can still answer "what happened?" next quarter**.

**Size:** M · **Status:** built · **SPEC:** 5.1, 5.3, 5.4, 5.5

**Acceptance criteria**

_Happy path:_

```
AC1 — the open pixel records an event
  Given a sent message
  When  its tracking pixel is fetched
  Then  an "open" event exists for it

AC2 — the pixel is still a GIF
  Given the same request
  Then  the response content type is image/gif

AC3 — a click records an event
  Given a sent message
  When  the click URL is followed
  Then  a "click" event exists for it

AC4 — a click redirects to the original URL
  Given the same request
  Then  the response is a 302 to that URL

AC5 — provider events are idempotent
  Given a delivery event already applied
  When  the same event is delivered again
  Then  only one event row exists

AC6 — stats roll the events up
  Given a broadcast with one open
  Then  its stats report 1 opened
```

_Sad path:_

```
AC7 — a click for an unknown message still redirects  ⭐
  Given a message id that does not exist
  When  the click URL is followed
  Then  the response is still a 302 to the original URL

AC8 — a pixel for an unknown message still returns an image
  Given the same
  Then  the response is 200

AC9 — a click with no target is not found
  Given a click URL with no `u` parameter
  Then  the response is 404
```

---

## 🔁 Epic: sequences

### STORY-015 — Drip a series, one step at a time

As **the list owner**,
I want a sequence to send its steps in order, on a delay,
so that **somebody who joins today gets the same welcome the last person did**.

**Size:** L · **Status:** built · **SPEC:** 6.1–6.6, 6.8

**Acceptance criteria**

_Happy path:_

```
AC1 — subscribing enrolls into an active subscribe-triggered sequence
  Given an active sequence triggered on subscribe
  When  somebody joins the list
  Then  they have an active enrollment

AC2 — the first due step sends exactly one mail
  Given that enrollment, due now
  When  the tick runs
  Then  they are sent one mail

AC3 — it is the first step's subject
  Given the same tick
  Then  the mail's subject is step one's

AC4 — the enrollment advances
  Given the same tick
  Then  its next step is step two

AC5 — a later step is not due yet
  Given step two has a one-day delay
  When  the tick runs again immediately
  Then  no second mail is sent

AC6 — the last step completes the enrollment
  Given the enrollment is on the final step and due
  When  the tick runs
  Then  the enrollment is "completed"

AC7 — a step is never sent twice
  Given a step already sent to somebody
  When  the tick is replayed
  Then  they still have exactly one message for that step

AC8 — a tag trigger enrolls
  Given an active sequence triggered by a tag
  When  that tag is added to somebody
  Then  they have an active enrollment
```

_Sad path:_

```
AC9 — an inactive sequence enrolls nobody
  Given an inactive subscribe-triggered sequence
  When  somebody joins
  Then  they have no enrollment

AC10 — deactivating halts pending steps
  Given an active enrollment due now
  When  the sequence is deactivated and the tick runs
  Then  nothing is sent

AC11 — nobody is enrolled twice
  Given somebody already enrolled
  When  enrollment is attempted again
  Then  the outcome is "already"

AC12 — a completed enrollment still counts as enrolled  ⭐
  Given somebody who finished the sequence
  When  enrollment is attempted again
  Then  the outcome is "already"

AC13 — activation is refused with no steps
  Given a sequence with no steps
  When  I activate it
  Then  the call is refused

AC14 — activation is refused while template placeholders remain
  Given a step whose body still contains [[ write this ]]
  When  I activate it
  Then  the call is refused
```

---

### STORY-016 — Send finishers straight into the next series

As **the list owner**,
I want a sequence to hand its finishers to another one,
so that **onboarding can roll into the newsletter pitch without me moving
people by hand**.

**Size:** M · **Status:** built · **SPEC:** 6.10–6.12

**Acceptance criteria**

_Happy path:_

```
AC1 — finishing the last step enrolls into the next sequence
  Given sequence A names B as its next, both active
  When  the tick sends A's last step
  Then  the subscriber has an active enrollment in B

AC2 — it happens in the same tick
  Given the same tick
  Then  A's enrollment is "completed" too

AC3 — the chain respects opt-outs  ⭐
  Given the subscriber had already opted out of B
  When  they finish A
  Then  they have no enrollment in B

AC4 — the chain respects B being paused
  Given B is inactive
  When  they finish A
  Then  they have no enrollment in B

AC5 — the chain respects exit tags
  Given the subscriber holds one of B's exit tags
  When  they finish A
  Then  they have no enrollment in B
```

_Sad path:_

```
AC6 — linking an old sequence never mails historical finishers  ⭐
  Given somebody completed A last month
  When  A is pointed at B and the tick runs
  Then  they have no enrollment in B

AC7 — a sequence cannot lead into itself
  Given sequence A
  When  I set A's next sequence to A
  Then  the call is refused

AC8 — an accidental completion does not chain
  Given an enrollment whose next step was deleted
  When  the tick completes it
  Then  they have no enrollment in B
```

---

### STORY-017 — Pull somebody out of a pitch when they buy

As **the list owner**,
I want a tag to end a sequence and optionally start another,
so that **the moment someone buys, the pitch stops and onboarding starts**.

**Size:** M · **Status:** built · **SPEC:** 6.13–6.16, 6.18

**Acceptance criteria**

_Happy path:_

```
AC1 — the exit tag cancels the enrollment
  Given an active enrollment in a sequence with an exit on "customer"
  When  the "customer" tag is added
  Then  the enrollment is "cancelled"

AC2 — the reason is recorded  ⭐
  Given the same exit
  Then  the cancellation reason is "exit_tag"

AC3 — the follow-on sequence is joined
  Given the exit names a target sequence
  When  the tag is added
  Then  they have an active enrollment in the target

AC4 — an exit is not an opt-out  ⭐
  Given the same exit
  Then  no sequence opt-out row exists

AC5 — and writes no suppression
  Given the same exit
  Then  the suppressions table is empty

AC6 — and does not change their status
  Given the same exit
  Then  their status is still "active"

AC7 — and touches no other sequence
  Given they were also in an unrelated series
  When  the exit fires
  Then  that enrollment is still "active"

AC8 — holding an exit tag refuses enrollment at the door  ⭐
  Given somebody already tagged "customer"
  When  enrollment in that sequence is attempted
  Then  the outcome is "has_exit_tag"
```

_Sad path:_

```
AC9 — somebody with no active enrollment is unaffected
  Given somebody never enrolled
  When  the exit tag is added
  Then  they have no enrollment in the target either

AC10 — a tag cannot both start and end the same sequence
  Given a sequence triggered by "customer"
  When  I add an exit on "customer"
  Then  the call is refused

AC11 — an exit cannot lead back into its own sequence
  Given sequence A
  When  I add an exit on A pointing at A
  Then  the call is refused
```

---

### STORY-018 — Consent always wins over configuration

As **a reader**,
I want opting out, bouncing or complaining to end a series whatever it is
configured to do,
so that **no automation setting can keep mail coming after I have said stop**.

**Size:** M · **Status:** built · **SPEC:** 6.17, 2.1, 6.18

**Acceptance criteria**

_Happy path:_

```
AC1 — consent is re-checked at send, not at enrollment  ⭐
  Given an enrollment due now
  When  the address is suppressed and the tick runs
  Then  nothing is sent to them

AC2 — the enrollment is cancelled
  Given the same tick
  Then  the enrollment is "cancelled"

AC3 — a bounced subscriber's series stops
  Given a due enrollment for a subscriber with status "bounced"
  When  the tick runs
  Then  nothing is sent to them

AC4 — an unsubscribed-from-broadcasts subscriber's series continues  ⭐
  Given a due enrollment for a subscriber with status "unsubscribed"
  When  the tick runs
  Then  they are sent the step
```

---

## 🔌 Epic: the transactional API

### STORY-019 — Let my other apps send mail through Kōlea

As **a consuming app**,
I want to POST a message with a bearer key and get an id back,
so that **order receipts and download links go out through the same system that
owns suppression and history**.

**Size:** L · **Status:** built · **SPEC:** 7.1–7.7, 2.1, 9.3

**Acceptance criteria**

_Happy path:_

```
AC1 — a valid request is accepted
  Given a live API key
  When  I POST a recipient, subject and body
  Then  the response is 202

AC2 — it returns the message id
  Given the same request
  Then  the body carries an id

AC3 — it answers before the provider does
  Given the same request
  Then  the reported status is "queued"

AC4 — the mail goes out once the background work settles
  Given the same request
  Then  the recipient has one mail

AC5 — it is recorded as transactional
  Given the same request
  Then  the message kind is "transactional"

AC6 — an unknown recipient is created quietly
  Given an address not on the list
  When  I send to it
  Then  a subscriber exists with status "pending"

AC7 — and is not marketed to  ⭐
  Given an active subscribe-triggered sequence
  When  a transactional send creates the recipient
  Then  they have no enrollment

AC8 — a replayed idempotency key returns the original
  Given a request already sent with key "k1"
  When  the same key is posted again
  Then  the response carries the original message id

AC9 — and sends nothing further
  Given the same replay
  Then  the recipient still has exactly one mail

AC10 — key use is recorded
  Given any authorized request
  Then  the key's `last_used_at` is set

AC11 — an unsubscribed reader still gets their receipt  ⭐
  Given a subscriber who unsubscribed from everything
  When  a transactional message is sent to them
  Then  they receive it
```

_Sad path:_

```
AC12 — no token is rejected
  Given no Authorization header
  When  I POST
  Then  the response is 401

AC13 — an unknown token is rejected
  Given a token nobody minted
  Then  the response is 401

AC14 — a revoked token is rejected
  Given a key that has been revoked
  Then  the response is 401

AC15 — an unauthorized request sends nothing
  Given any rejected request
  Then  nothing was mailed

AC16 — a missing recipient names the field
  Given an authorized request with no `to`
  Then  the response is 400 and mentions `to`

AC17 — a malformed recipient is rejected
  Given `to` of "nope"
  Then  the response is 400

AC18 — a missing subject names the field
  Given no `subject`
  Then  the response is 400 and mentions `subject`

AC19 — a missing body names the field
  Given no `body`
  Then  the response is 400 and mentions `body`

AC20 — a non-JSON body is rejected
  Given a body that is not JSON
  Then  the response is 400

AC21 — a hard-bounced address is not sent to  ⭐
  Given an address suppressed as a hard bounce
  When  a transactional message is sent to it
  Then  the message is recorded as suppressed
```

---

## 🔐 Epic: the console

### STORY-020 — The admin console is not on the public internet

As **the list owner**,
I want every admin route to sit behind Cloudflare Access,
so that **the list cannot be read or mailed by anyone who finds the hostname**.

**Size:** S · **Status:** built · **SPEC:** 8.1, 8.2

**Acceptance criteria**

_Happy path:_

```
AC1 — the preference center is public
  Given no credentials
  When  I GET /p/<token>
  Then  the response is not 403

AC2 — the tracking pixel is public
  Given no credentials
  When  I GET a tracking pixel
  Then  the response is not 403

AC3 — the signup endpoint is public
  Given no credentials
  When  I POST /subscribe
  Then  the response is not 403

AC4 — the transactional API is public but bearer-guarded
  Given no credentials
  When  I POST /api/send
  Then  the response is 401, not 403
```

_Sad path:_

```
AC5 — the dashboard is guarded
  Given no Access token and no dev bypass
  When  I GET /
  Then  the response is 403

AC6 — the subscriber list is guarded
  Given the same
  When  I GET /subscribers
  Then  the response is 403

AC7 — a misconfigured Worker fails closed  ⭐
  Given Access is not configured at all
  When  I GET /
  Then  the response is 403

AC8 — presence of the header proves nothing
  Given a fabricated Cf-Access-Jwt-Assertion header
  When  I GET /
  Then  the response is 403
```

---

## 🖥 Epic: the operator's screens (UI)

Driven by Playwright against a real browser and a real `wrangler dev`, because
these are the behaviours that only exist once HTML meets a browser. See
`tests/ui/`.

### STORY-021 — The preference center reads clearly to a person

As **a reader**,
I want the preference page to make the narrow choice obvious,
so that **I pick "stop this series" rather than "stop everything" by mistake**.

**Size:** M · **Status:** built · **SPEC:** 2a.2–2a.4, 9.3

```
AC1 — arriving from a series, that series is presented first
AC2 — its button reads "Stop just this series"
AC3 — "Unsubscribe from everything" is present and is not the primary control
AC4 — clicking the narrow action confirms only that series was affected
AC5 — the newsletter is still shown as subscribed afterwards
AC6 — the whole flow completes with JavaScript disabled
```

### STORY-022 — The composer saves what I wrote

As **the list owner**,
I want the rich editor to persist everything it shows,
so that **a renamed extension option cannot silently eat my draft**.

**Size:** M · **Status:** built (`bun run smoke`) · **SPEC:** 3.1

```
AC1 — typing syncs into the hidden body field as TipTap JSON
AC2 — the toolbar renders
AC3 — a saved draft reopens with its body intact
```

### STORY-023 — The sequence editor says where people go

As **the list owner**,
I want one screen that states where finishers go, which tags pull people out
and where each leads,
so that **I can see the whole flow without reading the database**.

**Size:** M · **Status:** built · **SPEC:** 6.19

```
AC1 — the editor names the next sequence
AC2 — it lists each exit tag and its target
AC3 — it lists the sequences that feed into this one
AC4 — it states the endings that always apply
```

---

## 📌 Not sliced yet

Deliberately left out of this pass — they are either open questions in SPEC or
have no behavior to test yet:

- Double opt-in (SPEC §1 TODO).
- Per-subscriber engagement history UI (SPEC §5 TODO).
- The commerce mirror, Stripe reconciliation and revenue attribution — a real
  epic of its own, and the money path deserves its own careful slicing.
- Non-functional targets (SPEC §9.1, §9.5) — they need a load harness and a
  cost model, not a spec file.
