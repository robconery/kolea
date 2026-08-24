# 📐 SPEC — Kōlea

> Owner: `/design`. Do not edit from other phases.
> Behavioral requirements — observable, testable. `/plan` slices these into stories.

Terms: **address** = an email string. **subscriber** = a row in `subscribers`.
**suppressed** = the address appears in `suppressions`. **message** = one intended
send to one address.

## 1. Subscribers

1.1 An address is stored lowercased and trimmed. Two signups differing only in case
are the same subscriber.

1.2 Importing a CSV creates subscribers for new addresses and updates name/attributes
for existing ones. It never duplicates an address and never resurrects an
`unsubscribed` subscriber to `active`.

1.3 An import reports, per row: created, updated, skipped-suppressed, invalid.
A malformed row does not abort the import.

1.4 A subscriber has exactly one status: `pending`, `active`, `unsubscribed`,
`bounced`, or `complained`.

1.5 Tags may be added to and removed from a subscriber. Removing a tag never deletes
the subscriber; deleting a tag removes it from all subscribers and does not delete them.

1.6 A segment is a filter over status and tags (include-any, exclude-any). Resolving a
segment for a **broadcast** returns only subscribers whose status is `active` and whose
address is not globally suppressed. Sequence eligibility is per 2.3–2.4, not this rule.

> ⚠️ TODO: double opt-in. If required, signup creates `pending` and only a confirmed
> click sets `active`; if not, signup creates `active` directly. Blocks 1.4 and 6.x.

## 2. Consent & suppression ⭐

Consent has three independent scopes: **one sequence**, **broadcasts**, **everything**.
Acting on a narrow scope must never escalate to a wider one.

2.1 Every send checks global suppression immediately before handing off to the provider.
A globally suppressed address is never sent to by any path.

2.2 A blocked send records a `messages` row with `status='suppressed'`. It is observable,
not silently dropped.

2.3 **Leaving a sequence removes the subscriber from that sequence only.** It writes a
`sequence_optouts` row, cancels that enrollment, and leaves the subscriber `active`. It
must not write a suppression, must not change `status`, and must not affect any other
sequence.

2.4 A subscriber who has left one sequence still receives broadcasts and every other
sequence they are enrolled in.

2.5 Unsubscribing from broadcasts sets `status='unsubscribed'` and `unsubscribed_at`.
Their sequence enrollments continue to run.

2.6 Only three things write a global suppression: an explicit "unsubscribe from
everything", a hard bounce, or a complaint.

2.7 A hard bounce suppresses the address (`hard_bounce`) and sets the subscriber to
`bounced`. A soft bounce does neither.

2.8 A complaint suppresses the address (`complaint`) and sets the subscriber to `complained`.

2.9 Re-subscribing to a sequence removes the opt-out row and is permitted at any time —
leaving a sequence is reversible, by the subscriber, from the preference center.

2.10 The operator can add and remove suppressions manually. Removing a suppression does
not change subscriber status.

## 2a. Preference center ⭐

2a.1 Every marketing email links to a preference center URL carrying the subscriber's
`unsub_token` and the scope it was sent from.

2a.2 The page shows: each sequence the subscriber is enrolled in with its own toggle, a
newsletter toggle, and a separate "unsubscribe from everything" action.

2a.3 Arriving from a sequence email, the action to leave **that** sequence is the primary,
pre-identified choice. Global unsubscribe is present but never the default.

2a.4 The page works without JavaScript and without a session — token only.

2a.5 It is idempotent: submitting the same choice twice produces the same state and no error.

2a.6 An unknown or revoked token shows a neutral message and reveals no subscriber data.

## 3. Broadcasts

3.1 A broadcast has a subject, a markdown body, and a segment. It can be saved as a
draft and edited freely while `status='draft'`.

3.2 A broadcast can be sent to a test address without affecting its status or creating
subscriber-visible records.

3.3 Scheduling sets `status='scheduled'` and `scheduled_at`. A scheduled broadcast can
be cancelled while it is still `scheduled`.

3.4 When a scheduled broadcast comes due, the system resolves the segment, writes one
`messages` row per recipient with `status='queued'`, sets the broadcast to `sending`,
and enqueues the work.

3.5 Recipient resolution happens **once**, at dispatch. Subscribers added after dispatch
do not receive that broadcast.

3.6 Dispatching the same broadcast twice never produces two messages for one subscriber.

3.7 A broadcast becomes `sent` when no `queued` messages remain for it.

3.8 A send interrupted mid-flight resumes without re-sending any message already `sent`.

3.9 Every message carries a working unsubscribe link unique to that subscriber.

## 4. Sending & delivery

4.1 Each message is sent individually through the configured provider. One failure
never blocks or re-sends the rest of its batch.

4.2 A provider call that fails transiently is retried. After the configured maximum,
the message is `failed` with the error recorded, and it lands in the dead-letter queue.

4.3 A successful send records the provider name, the provider's message id, and `sent_at`.

4.4 Swapping the provider requires no change to broadcasts, sequences, subscribers,
or the transactional API — only configuration.

## 5. Tracking

5.1 A delivery, bounce, complaint, open, or click writes an `events` row linked to its
message. Nothing observable exists only in logs.

5.2 A provider webhook with an invalid or missing signature is rejected and recorded.

5.3 Webhooks are idempotent: the same provider event delivered twice produces one event row.

5.4 A click redirects to the original URL, recording the event. Tracking failure must
never prevent the redirect.

5.5 Per broadcast, the operator can see: sent, delivered, opened, clicked, bounced,
complained, unsubscribed.

> ⚠️ TODO: per-subscriber engagement history vs. per-campaign aggregate only. Schema
> supports both; this decides UI scope.

## 6. Sequences

6.1 A sequence is an ordered list of steps, each with a delay relative to the previous.

6.2 A sequence triggers on subscribe, on a tag being added, or manually.

6.3 A subscriber is enrolled in a given sequence at most once.

6.4 Only active sequences enroll. Deactivating a sequence stops future enrollment and
halts pending steps for existing enrollments.

6.5 A due step sends exactly one message to the enrolled subscriber and advances the
enrollment to the next step.

6.6 Completing the last step sets the enrollment `completed`.

6.7 Leaving one sequence cancels only that enrollment. A **global** unsubscribe cancels
all active enrollments; a **broadcast** unsubscribe cancels none.

6.9 Every sequence email's unsubscribe link is scoped to that sequence (per 2a.3).

6.8 Editing a sequence does not retroactively re-send steps already delivered.

## 7. Transactional API

7.1 `POST /api/send` accepts a recipient, subject, and body, and requires a bearer token
matching an unrevoked key.

7.2 A missing, malformed, unknown, or revoked token is rejected with 401 and no mail is sent.

7.3 A request carrying an idempotency key that was already used returns the original
result and does not send a second message.

7.4 A transactional send is suppression-checked (per 2.1) and recorded as a `messages`
row with `kind='transactional'`.

7.5 The endpoint responds once the message is durably accepted — it does not block on
provider delivery.

7.6 A malformed request is rejected with a message naming the problem field.

7.7 Every API key use updates `last_used_at`. Keys can be created and revoked by the operator.

## 8. Admin console & access

8.1 All admin routes sit behind Cloudflare Access. The application holds no password.

8.2 Public unauthenticated routes are exactly: unsubscribe, signup, tracking open/click,
and provider webhooks. Everything else requires Access.

8.3 The operator can: manage subscribers and tags, compose/schedule/cancel broadcasts,
view broadcast stats, manage sequences, manage suppressions, and manage API keys.

## 9. Non-functional

9.1 A 25,000-recipient broadcast completes without manual intervention. ⚠️ TODO: target
wall-clock — this sets provider rate-limit and batching requirements.

9.2 No Worker invocation exceeds D1's 1,000-query-per-invocation limit at any list size.

9.3 The unsubscribe path works without JavaScript and without a session.

9.4 Deleting a subscriber removes their tags, enrollments, messages, and events, but
leaves any suppression in place.

9.5 Monthly running cost stays materially below the current ESP bill at 25k subscribers
sending weekly. ⚠️ TODO: the actual figure to beat.
