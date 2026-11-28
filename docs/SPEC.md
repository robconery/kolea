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

### 1a. Double opt-in

1.7 A signup form may require confirmation (double opt-in). The setting is per form. A
form made in the app asks for confirmation unless told otherwise, and saving another
field of a form never changes it. A form that does not ask signs people up on submit.

1.8 A submit to a confirming form creates a new subscriber as `pending` and leaves an
existing subscriber exactly as they are. It sends one confirmation mail and starts
nothing else: no tags, no sequence, no reply, no campaign touch.

1.9 Opening the confirmation link changes nothing. Pressing the button on that page
confirms: a `pending` subscriber becomes `active` with `confirmed_at` set, subscribe
sequences fire, the form's tags are added, and the form's sequence and reply go out.
Pressing it a second time changes nothing and sends nothing.

1.10 Confirming never returns an `unsubscribed` subscriber to `active`. They get what the
form promised (its tags, sequence and file) and stay off the newsletter.

1.11 At most one confirmation goes to an address for the same form in ten minutes, and at
most three to an address in 24 hours across all forms. A submit while a confirmation is
still open reuses the same link.

1.12 A confirmation is not sent to a globally suppressed, `bounced` or `complained`
address, and the blocked message is recorded per 2.2. A link works for seven days. An
expired link changes nothing, and an unknown link finds nothing.

1.13 Until the click, no other signup and no import moves a `pending` subscriber who has
an open confirmation to `active`.

### 1b. Custom fields

1.14 A custom field has a key, a label and a type: text, number, date or boolean. The key
is fixed at creation and matches `^[a-z][a-z0-9_]{0,62}$`. A key that is already taken,
or that a built-in merge tag already answers to, is refused. Renaming changes the label
only.

1.15 A value is stored only under a key a field defines, and only when it casts to that
field's type. Leaving a value blank on the subscriber's screen clears it.

1.16 A segment may test custom fields with `equals`, `not_equals`, `contains`,
`greater_than`, `less_than`, `is_set` and `is_not_set`. Every condition must hold. A
condition naming an unknown key, an operator that does not suit the type, or a value
that does not cast is refused when the segment is saved.

1.17 A stored condition that cannot be compiled safely matches nobody. The count shown
for a segment with field conditions equals the audience it resolves to.

1.18 `{{key}}` in a message resolves to the reader's value, escaped. `{{key|fallback}}`
resolves to the fallback when the reader has no value, and `{{key}}` with no value and
no fallback renders nothing.

1.19 A field cannot be deleted while a saved segment or an unsent broadcast still tests
it. Deleting a field removes its values from every subscriber.

1.20 A CSV import fills a field from a column named by the field's key or label. A cell
that does not cast is reported with its row and field per 1.3, the rest of the row is
still imported, and an empty cell never clears a stored value.

1.21 A signup form may carry field values. A key that is no field is ignored, a value
that does not fit its type is dropped, and the signup still succeeds.

### 1c. List clean-up

1.22 A clean-up prunes the groups the operator picks: `never_engaged` (active, sent at
least three mails, no open or click in the chosen window), `unsubscribed`, `bounced`
(bounced or complained) and `unconfirmed` (pending for more than 30 days). A plan with
no group is refused.

1.23 Nobody who has bought something or has mail queued is pruned. Each person is checked
again when their page is deleted, and anyone who no longer qualifies is skipped.

1.24 The plan records exactly who it covers. The backup CSV holds exactly those people,
and the delete runs only after the operator confirms the count. The clean-up is kept as
a record with how many were planned, deleted and skipped.

1.25 Importing a clean-up's backup brings an unconfirmed person back `pending` and a
leaver back `unsubscribed`, never `active`. A CSV `status` column can only narrow the
status of a subscriber already on the list.

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

2.11 A clean-up (1.22) keeps consent past the deletion. A bounced or complained address
keeps its suppression. The address of a pruned subscriber who had left the newsletter
keeps a `pruned` marker, which is broadcast-scoped: it blocks broadcasts to that address
and makes a later import bring it back `unsubscribed`. It does not block sequence mail,
transactional mail or a confirmation. A pruned subscriber who never engaged or never
confirmed keeps nothing.

2.12 The person signing up again themselves (a form submit, a confirmation click, the
preference center) removes a `pruned` marker, and no other suppression.

2.13 An unsubscribe reported by the provider (the provider's own unsubscribe list) is
applied as 2.5: `unsubscribed`, no suppression, sequences untouched.

2.14 An unsubscribe recorded for a person by the operator, an agent or the API is
broadcast-scoped per 2.5. Only `active` and `pending` subscribers move; a `bounced` or
`complained` subscriber is left as they are.

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

3.5 The audience is fixed **once**, at dispatch. Nobody who becomes a subscriber after the
send starts receives that broadcast, however long the send takes. The segment and consent
are still read as each page of recipients is written: a subscriber who already existed
and joins the segment mid-send is reached, and one who leaves it is not.

3.6 Dispatching the same broadcast twice never produces two messages for one subscriber.

3.7 A broadcast becomes `sent` when no `queued` messages remain for it.

3.8 A send interrupted mid-flight resumes without re-sending any message already `sent`.

3.9 Every message carries a working unsubscribe link unique to that subscriber.

3.10 A broadcast closes in the pass that reaches its last recipient when no `queued`
message remains. Otherwise a later pass closes it, once the queue has emptied.

3.11 A `queued` message that nothing is coming for does not hold its broadcast open.
Once every recipient has a message, one that no consumer has touched is handed to the
queue again after ten minutes, and one a consumer did touch (it carries an error or a
claim) after two hours. A message the provider accepted is never handed over again, and
neither is one the provider was asked for (4.5a): two hours after the provider was asked
with no answer recorded, it becomes `failed` with an error starting `outcome unknown`, so
the broadcast can close and the operator sees it (4.13).

3.12 A cancelled broadcast can be resumed. Resuming mails nobody who already has it.

3.13 A page of recipients that stopped after writing its messages but before handing them
to the queue hands them over itself when it runs again. The walk moves past a page only
once that page's messages are on the queue.

3.14 Pressing Send never ends in an error page for a send that started. If the send stops
part-way through the first pages, the operator is told it is under way and will carry on
by itself, and the minutely cron continues it from where it stopped. If the send cannot
be confirmed as started at all, the operator is told that, and that nothing went out from
that press.

3.15 A link a reader cannot open is caught before a broadcast goes out. Such a link is
one whose host is `localhost` or under `.localhost`, a loopback address (`127.0.0.0/8`,
`::1`), `0.0.0.0`, a private IPv4 range (`10/8`, `172.16/12`, `192.168/16`), a name under
`.local`, `.test`, `.internal` or `.example`, or a name with no dot at all; or one whose
scheme is not `http`, `https`, `mailto` or `tel`. Links are read from the editor's
document (text links, buttons, linked images) and from the markdown body. Relative links,
`#anchors` and merge tags are not judged. The send confirmation lists each such link with
the reason, and the send goes ahead only with a separate "send anyway" confirmation; a
send posted without it sends nothing and shows the screen again. Sending or scheduling
through MCP or the REST API is refused, naming the links, unless the call says
`allow_dev_links: true`; the broadcast preflight lists them as `devLinks`. A broadcast
without such links sends exactly as before. Saving a sequence step that has one warns,
naming it, and saves.

## 4. Sending & delivery

4.1 Each message is sent individually through the configured provider. One failure
never blocks or re-sends the rest of its batch.

4.2 A provider call that fails transiently is retried. After the configured maximum,
the message is `failed` with the error recorded, and it lands in the dead-letter queue.

4.3 A successful send records the provider name, the provider's message id, and `sent_at`.

4.4 Swapping the provider requires no change to broadcasts, sequences, subscribers,
or the transactional API — only configuration.

### 4a. The send claim

4.5 A message is claimed before the provider is called, in one conditional write that
only a `queued`, unclaimed message can match. Two consumers given the same message send
it once. The one that did not get the claim sends nothing and its job is retried.

4.6 Every recorded result releases the claim in the same write that records the result.
A batch that fails before any result is recorded releases its claims at once, so the
queue's retry can claim them.

4.7 Mail the provider accepted whose result could not be written keeps its claim until it
is recorded `sent`. The acceptance is carried on the queue as a job that only records and
never sends, and a send job for the same message redelivered in between sends nothing.

4.5a Immediately before the provider is called, every message in the batch is marked as
asked (`provider_called_at`), in one conditional write that only the holder of the claim
can match. Only marked messages are sent. The mark is cleared only when the provider's
answer was "not taken" (a refusal worth retrying, or a batch that threw before any
request could have left) or when the operator sends the message again (4.11, 4.13).

4.8 A claim older than ten minutes is free again, unless the message is marked as asked
(4.5a). A marked message is never claimed again by anything automatic, however old its
claim: it is settled by its record, by a provider webhook that names it (5.14), or as
`outcome unknown` when the queue gives up on it (4.2) or the broadcast sweep reaches it
(3.11).

### 4b. Mail that did not go

4.9 A failure where the provider may already have the mail (the connection dropped after
the request left, or a success came back with no id) is recorded `failed` with an error
starting `outcome unknown`. It is never retried automatically. A batch request that got no
answer at all is asked again once, at once, as the identical request under the identical
idempotency key; only if that gets no answer either is the outcome unknown. The provider
saying the same request is still in flight, or a success that names no id for one of the
mails, is `outcome unknown` too. A message the queue gives up on after the provider was
asked for it records `outcome unknown` ahead of the give-up.

4.10 When the provider reports that it accepted a mail and then gave up on it for good,
other than for a dead mailbox, the message changes from `sent` to `failed` with the
provider's reason. No consent changes. A temporary failure leaves it `sent`.

4.11 Failed mail the provider never accepted is listed for the operator and can be sent
again. Sending again moves a message from `failed` to `queued` once, never touches a
`sent` message, and re-checks consent per 2.1.

4.12 Not offered for sending again: the failed messages of a cancelled broadcast (3.12 is
the way back), a failed sequence step for someone no longer in that sequence or while the
sequence is paused, and mail the `console` provider rendered. Each is still counted on
the screen.

4.13 Mail under 4.9 and 4.10 is listed apart and never sent in bulk. Each message can be
sent again once, singly, after the operator confirms they checked the provider.

4.14 A form reply that failed can be sent again from the form: once per person, only to
people still on the list, and never to anyone whose reply has since gone or may have
gone.

### 4c. Sending domains

4.15 Adding a sending domain shows the DNS records the provider wants (DKIM, SPF, the
return path) and a recommended DMARC record. Refused: a name that is a CNAME, the public
site's own host, a free mailbox provider's domain, a name that is not a domain, and a
domain already added.

4.16 A domain is `verified` only when every required record answers in DNS and the
provider says it will send for it. DMARC is recommended, not required.

4.17 A domain's status moves only `pending → verified | failed`, `verified → failed` and
`failed → verified`. A check that cannot reach DNS or the provider changes nothing.

4.18 One click adds the missing records to Cloudflare DNS. It never edits or replaces an
existing record: an SPF or DMARC record of the operator's own is kept and reported.
A refused token creates nothing, and with no token configured the button is not offered.

4.19 Sending from a domain that is not verified is warned at the send confirmation, not
blocked.

4.20 The minutely cron checks a domain that is due, after the mail.

## 5. Tracking

5.1 A delivery, bounce, complaint, open, or click writes an `events` row linked to its
message. Nothing observable exists only in logs.

5.2 A provider webhook with an invalid or missing signature is rejected and recorded.

5.2a A provider webhook that passed its signature check but could not be applied right now
(the database refused) is answered 503, never 401 or 406, so the provider delivers it
again. Applying the same webhook again later changes nothing that was already applied
(5.3).

5.3 Webhooks are idempotent: the same provider event delivered twice produces one event row.

5.4 A click redirects to the original URL, recording the event. Tracking failure must
never prevent the redirect. The one exception is a link fixed after the send (5.15).

5.5 Per broadcast, the operator can see: sent, delivered, opened, clicked, bounced,
complained, unsubscribed.

5.6 An open fetched by a machine is still recorded, flagged as a machine open with the
reason. A machine open is any of: no user agent, a known scanner or prefetcher, Apple
Mail Privacy Protection, or a fetch within three seconds of sending. The pixel is served
either way.

5.7 A machine open is left out of every count of readers and fires no tag rule. Per
broadcast it is reported beside `opened`, never added to it.

5.8 Clicks are never judged as machine. An image proxy that fetches when the reader
opens the mail (Gmail's) counts as a reader.

5.9 With `TRACKING_HOST` set, new mail's open pixel and tracked links use the first host
listed. The preference center link stays on the console's host. A value naming the
public site's host or the console's host is ignored.

5.10 Every host listed in `TRACKING_HOST`, and the console's host, keep answering the
open and click routes, so mail sent before a change still tracks and redirects.

5.11 A tracking host serves the open and click routes and nothing else. Every other path
on it is not found, including the console, the API, MCP and the preference center.

5.12 A provider webhook is verified with that provider's own signing secret. For Mailgun:
a missing or invalid signature, or one more than 24 hours old, is rejected and nothing
from it is applied, and with no signing key configured the webhook is refused.

5.13 Finding the message a provider webhook is about never reads the whole `messages`
table: both the provider's id and our own message id are looked up by index.

5.14 Mail sent through a provider that echoes caller metadata in its webhooks (Resend's
tags) carries its own message id. A webhook naming a message id uses that message only if
its provider id equals the webhook's, or it has no provider id yet and the provider was
asked for it (4.5a). Otherwise the message is found by the provider's id, as if no id had
been named. In the second case the webhook stands in for the record that never landed:
the message gets the provider's id, and one still `queued`, or `failed` as `outcome
unknown`, becomes `sent`.

5.15 A link in a broadcast that has gone out (`sent`, or `cancelled` part-way) can be
fixed. A fix names the link as it was mailed and the corrected link, which must be
`http` or `https` and pass 3.15. From then on a tracked click on the old link in any copy
of that broadcast redirects to the corrected link; the click event records the link as
mailed (`url`) and where the reader was sent (`fixed_to`), and a click tag rule's
URL filter matches either. Finding the fix is one indexed lookup; if it fails, the click
redirects to the link as written. Fixing also rewrites the link in the stored body,
keeping the as-mailed copy the first time, so the published post and any resumed send
carry the corrected link. Fixing a link already fixed re-points every earlier fix that led
to it. Removing a fix sends clicks to the link as mailed again and leaves the body as it
is. Only a link in the broadcast (as mailed, as it stands, or clicked from it) can be
fixed. Fixing sends nothing. Untracked links (click tracking off, unsubscribe and download
links, the plain-text part) cannot be redirected.

> ⚠️ TODO: per-subscriber engagement history vs. per-campaign aggregate only. Schema
> supports both; this decides UI scope.

## 6. Sequences

6.1 A sequence is an ordered list of steps, each with a delay relative to the previous.

6.2 A sequence triggers on subscribe, on a tag being added, or manually.

6.3 A subscriber is enrolled in a given sequence at most once. A `cancelled` or
`completed` enrollment still counts: no trigger, chain, or exit re-enrolls them.

6.4 Only active sequences enroll. Deactivating a sequence stops future enrollment and
halts pending steps for existing enrollments.

6.5 A due step sends exactly one message to the enrolled subscriber and advances the
enrollment to the next step.

6.6 Completing the last step sets the enrollment `completed`.

6.7 Leaving one sequence cancels only that enrollment. A **global** unsubscribe cancels
all active enrollments; a **broadcast** unsubscribe cancels none.

6.9 Every sequence email's unsubscribe link is scoped to that sequence (per 2a.3).

6.8 Editing a sequence does not retroactively re-send steps already delivered.

### 6a. Leaving a sequence, and what happens next

6.10 A sequence may name one **next sequence**. When a subscriber is sent the last step,
they are enrolled in the next sequence in the same tick, subject to every rule that
governs enrollment: 6.3, 6.4, sequence opt-outs (2.3), and 6.14.

6.11 Chaining happens only at the moment the last step is sent. Setting or changing the
next sequence never enrolls anyone who finished earlier. An enrollment that completes
because its step or subscriber was deleted does not chain.

6.12 A sequence cannot name itself as its next sequence or as the target of an exit.
A longer loop is permitted and is inert, per 6.3.

6.13 A sequence may have **exits**, each a tag with an optional target sequence. When
that tag is added to a subscriber with an active enrollment, the enrollment is
`cancelled`, the reason is recorded, and they are enrolled in the target if one is set
and it is active. A subscriber with no active enrollment is unaffected, and is not
enrolled in the target.

6.14 A subscriber holding any of a sequence's exit tags is refused enrollment in it, by
every enrollment path.

6.15 An exit is not an opt-out. It writes no sequence opt-out, no suppression, and no
status change, and it touches no other sequence.

6.16 A tag cannot be both the trigger tag and an exit tag of the same sequence.

6.17 Opt-out, global unsubscribe, hard bounce, and complaint end an enrollment
regardless of configuration (6.7, section 2). No exit or chain setting can disable them.

6.18 Every cancelled enrollment records why: `sequence_optout`, `suppressed`,
`status:<status>`, `exit_tag`, or `purchase`.

6.19 The sequence editor states, on one screen, where finishers go, which tags pull
people out and where each leads, the exits that always apply, and which sequences feed
into this one.

### 6b. The send window

6.20 A sequence may have a send window: a start and an end time of day, read in the
install's one time zone (UTC until one is chosen). The start is inclusive and the end
exclusive. A start after the end runs past midnight. A sequence with no window sends at
any hour.

6.21 A step that comes due outside the window is neither skipped nor sent early. The
enrollment stays on that step, its next run moves to the window's next opening, and the
tick that runs then sends it.

6.22 The window is read in local time on both sides of a daylight saving change: a window
that opens at 09:00 opens at 09:00 local the day the clocks move.

6.23 A window with only one end, a window that starts and ends at the same minute, a
time that is not a time, and a time zone the runtime does not know are each refused.

## 7. Transactional API

7.1 `POST /api/send` accepts a recipient and either a subject and body or a stored
template with its variables (7.8), and requires a bearer token matching an unrevoked key.

7.2 A missing, malformed, unknown, or revoked token is rejected with 401 and no mail is sent.

7.3 A request carrying an idempotency key that was already used returns the original
result and does not send a second message.

7.4 A transactional send is suppression-checked (per 2.1) and recorded as a `messages`
row with `kind='transactional'`.

7.5 The endpoint responds once the message is durably accepted — it does not block on
provider delivery.

7.6 A malformed request is rejected with a message naming the problem field.

7.7 Every API key use updates `last_used_at`. Keys can be created and revoked by the operator.

### 7a. Stored templates

7.8 A request may name a stored template by its slug and supply `variables`, instead of a
subject and body. A request carrying both a body and a template is rejected, naming both
fields.

7.9 Variables are filled when the request is accepted, and the filled subject and body
are stored on the message with the template's slug. Editing or deleting the template
afterwards changes nothing already accepted, and a replayed idempotency key (7.3) still
returns the original.

7.10 A request that leaves out a variable the template uses is refused with 422, naming
every missing variable. Nothing is recorded, nobody is added, nothing is sent.

7.11 A request naming a template that does not exist, or one that is switched off, is
refused with 422 and nothing is sent.

7.12 A variable's value is text. Markup in it is escaped in the HTML part, and a merge tag
inside a value is not expanded. A request may not supply `first_name`, `name` or `email`
as variables: those come from the recipient.

7.13 A `subject` on the request replaces the template's. A template's slug is set when it
is created and never changes when it is renamed.

### 7b. Keys and the REST API

7.14 A key has one scope. `send` reaches `POST /api/send` and `POST /api/sales` only.
`read` reaches the GET endpoints of `/api/v1` only. `admin` reaches everything, and is
the only scope MCP accepts. `send` is the default.

7.15 `/api/v1` covers subscribers, tags, segments, forms, broadcasts, sequences,
templates, posts, topics, the site, sales and stats. Success is `{ "data": … }`; a list
adds `page`, `per_page` and `has_more`. Every refusal is
`{ "error": { "code", "message", "field"? } }`, naming the field at fault when there is
one.

7.16 `GET /api/v1/openapi.json` describes every endpoint as OpenAPI 3.1 and needs no key.

7.17 A request with no key or a revoked key is answered 401. A `read` key that tries to
write is answered 403. A `send` key reaches nothing in `/api/v1`.

7.18 Each key may make 120 requests a minute on `/api/v1`. Over that the answer is 429
with `Retry-After`.

7.19 Sending a broadcast and activating a sequence through the API each need the token
their preflight endpoint returned: single use, and refused after any edit to what was
previewed.

7.20 The API's send, schedule, resume and activate endpoints are refused while agent
sending is off (8.15), and erasing a subscriber is refused while sensitive changes are
off (8.16).

7.21 Unsubscribing through the API is broadcast-scoped per 2.14. No endpoint creates a
subscriber as `unsubscribed`.

7.22 Creating one `active` subscriber through the API is a signup and fires subscribe
sequences. Creating a `pending` one starts nothing.

7.23 No API response carries a subscriber's `unsub_token`.

## 8. Admin console & access

8.1 All admin routes sit behind Cloudflare Access. The application holds no password.

8.2 Routes on the console's host that need no Access session are exactly: the preference
center and the testimonial form, signup forms and their confirmation links, tracking
open/click, download links, served media, provider and Stripe webhooks, the
key-authenticated API (`/api/*`), MCP (`/mcp/<secret>` and `/mcp`), and the OAuth
discovery, registration, token and revocation endpoints. Each carries its own credential
or holds no private data. Everything else requires Access, including the OAuth consent
page.

8.3 The operator can: manage subscribers and tags, compose/schedule/cancel broadcasts,
view broadcast stats, manage sequences, manage suppressions, and manage API keys.

### 8a. The team

8.4 A person on the console holds one role: `owner`, `admin` or `writer`. Cloudflare
Access says who they are; the role says what they may do. The first Access-verified
person to reach an install with no team becomes its owner.

8.5 Once a team exists, an Access-verified address that is not on it is refused with a
reason and does not become a member. An Access token that names no email is refused.

8.6 An owner or admin invites an address in a role. An invitation is accepted on the
invitee's first visit and stops working after seven days. A removed member is refused on
their next request.

8.7 A writer can create and edit drafts, posts and sequence steps on a paused sequence.
A writer cannot send, schedule, activate or enroll, change a live sequence, change the
audience, import, or reach settings, keys, webhooks, sending domains or the team. A
console route with no rule of its own needs an admin.

8.8 An admin can do everything except manage an owner. The last owner cannot be removed
or demoted.

8.9 A state-changing request to the console that a browser says came from another site
is refused.

### 8b. The audit trail and the log

8.10 Every write to the console and every write through a key-authenticated endpoint is
recorded with who made it (the Access-verified email and role, or the key), what it was,
what it was done to, and whether it went through, was refused or failed. A refusal keeps
its reason. A read is not recorded.

8.11 The audit trail stores a few allowlisted fields of a request, never the whole body,
and never a token, key or password.

8.12 Every MCP tool call is recorded with its outcome (`ok`, `denied` or `error`),
refusals included.

8.13 The Logs page shows what happened over the last 90 days in plain words, newest
first, and can be narrowed by type, by category and by text. Older events are not shown.
It pages by cursor with no line repeated and none lost. An unknown type or a cursor the
log did not hand out is refused.

8.14 The log is searchable over MCP, and text a subscriber wrote is returned marked as
untrusted.

### 8c. What an agent may do

8.15 Two switches decide what agents may do: **agents may send mail** and **agents may
make sensitive changes**. Both are off until the operator turns them on, and only the
console screen can change them. While sending is off, every MCP tool that puts mail on
the wire is refused and the refusal is recorded. `MCP_ALLOW_SEND="false"` in the Worker
config forces sending off whatever the switch says; any other value cannot turn it on.

8.16 While sensitive changes are off, an agent is refused: deleting a subscriber,
removing a suppression, importing a CSV, undoing a subscriber's sequence opt-out, minting
an API key, and creating, changing or deleting a webhook endpoint. The two switches are
independent.

8.17 A new API key's token is shown once, on the page that answers its creation, and only
its hash is stored. A key needs a name, and an unknown scope is refused. A revoked key is
refused on its next request, on the API and on MCP alike, and its row is kept.

### 8d. Getting set up

8.18 A fresh install shows a checklist: sender, sending domain, public site, audience,
welcome sequence, first broadcast. Each step's state is read from the real state of the
install. The operator can put a step off, can decline only the public site, and can
dismiss the checklist from the dashboard.

8.19 The checklist never sends mail and never activates anything. The welcome sequence it
makes is paused, and the first broadcast it makes is a draft.

## 9. Non-functional

9.1 A 25,000-recipient broadcast completes without manual intervention. ⚠️ TODO: target
wall-clock — this sets provider rate-limit and batching requirements.

9.2 No Worker invocation exceeds D1's 1,000-query-per-invocation limit at any list size.

9.3 The unsubscribe path works without JavaScript and without a session.

9.4 Deleting a subscriber removes their tags, enrollments, messages, and events, but
leaves any suppression in place.

9.5 Monthly running cost stays materially below the current ESP bill at 25k subscribers
sending weekly. ⚠️ TODO: the actual figure to beat.

9.6 The jobs of one minutely tick share one query budget under 9.2, mail first: a due
broadcast, then the sequence tick, then sending-domain checks, webhook deliveries, one
import page and Ghostwriter takes. A job that does not fit waits for the next minute.

9.7 A sequence tick that fails is recorded, and does not stop the broadcast, the
domain check, the webhook deliveries or the import in the same minute.

9.8 No statement binds more than D1's 100 parameters at any list size.

## 10. Importing from another tool

10.1 An import from Kit, Ghost, Mailchimp or Drip is started with that tool's API key.
The key is proved with one request before the run is queued, and a refused key queues
nothing. Only one import runs at a time.

10.2 A run reads one page per minutely tick and stores where it is, so the next tick
continues from the same place. A minute with a broadcast to push reads no import page.

10.3 A person new to the list arrives with the status the other tool recorded. A state
the importer cannot read imports nobody.

10.4 For a subscriber already on the list an import can only narrow consent: `active` or
`pending` may become `unsubscribed`, `bounced` or `complained`, and nobody is returned
to `active` (per 1.2). They gain the other tool's tags, and a name if they had none.

10.5 An address suppressed here is not added, and its suppression is left as it was.

10.6 An opt-out arrives at the reach the other tool gave it. A Kit, Mailchimp or Drip
unsubscribe arrives `unsubscribed` with a global suppression. A Ghost member who turned
the newsletter off arrives `unsubscribed` with no suppression. A bounce or complaint
arrives suppressed as one.

10.7 An import enrolls nobody in any sequence, fires no tag-started sequence, and queues
no mail.

10.8 Mail the other tool sent arrives as `sent` broadcasts with their send time, not
published, with the tool's totals kept as imported totals. Drafts and scheduled mail are
left behind.

10.9 Sequences arrive switched off with a manual start.

10.10 Running the same import again creates no person, broadcast or sequence a second
time.

10.11 The API key is never shown back, and is erased when the run completes, fails or is
cancelled.

10.12 A failed page is tried again on a later tick. Three failed pages in a row, or a key
the tool refuses, fail the run with a reason. A run can be cancelled between pages, and
what it already wrote stays. A completed, failed or cancelled run never moves again.

10.13 Imported mail is stored as Markdown. No tag and no `javascript:` link from the
other tool's HTML survives.

## 11. Members and Premium

11.1 A member is a subscriber who has signed in on the public site. Signing in, signing
out and paying never change a subscriber's status, a suppression or an opt-out.

11.2 Asking for a sign-in link gives the same answer whether or not the address is a
subscriber. An unknown address creates no subscriber and is mailed nothing.

11.3 The link is transactional mail per 7.4: an `unsubscribed` subscriber still gets it,
and a hard-bounced or complained address does not, with the block recorded.

11.4 A link works for twenty minutes and once. Opening it shows a page and spends
nothing; only the button on that page signs in.

11.5 At most five links are mailed to one address in an hour. Requests over that are
recorded and not mailed.

11.6 The link's token is stored only as a hash, and never on the message. The session
cookie is `HttpOnly` and `SameSite=Lax`, and `Secure` on an https site. Signing out
revokes the session.

11.7 A sign-in form posted from another site is refused. Without `MEMBER_SESSION_SECRET`
the site says signing in is not available.

11.8 A published post is `public`, `members` or `premium`. A reader who may not read it
sees its title, its hand-written excerpt and a way to sign in or upgrade that names the
post. A signed-in member reads `members` posts; a Premium member reads everything.

11.9 A gated post's body leaves by no other door: no excerpt is derived from it, the feed
and the archive carry the teaser only, search does not match its body, and its page is
never held by a shared cache. Gating a post that was public drops the excerpt derived
from its body.

11.10 Premium is one level with a monthly and a yearly price, each picked from the
synced Stripe catalog. A price that does not bill at that interval is refused.

11.11 A Premium checkout is recorded before Stripe is asked, with the post the reader
came from.

11.12 Premium is granted only by a signature-verified checkout completion whose Stripe
session matches the recorded checkout. The return page grants nothing. An unsigned
webhook, or one naming a checkout with a different session, grants nothing.

11.13 A buyer the list has never seen is created `pending` and mailed nothing. An
existing subscriber's status is unchanged by paying.

11.14 A subscriber holds at most one live subscription. A member who already has one is
not sent to a second Checkout, and a second completed checkout is recorded as paid twice
for the operator to refund.

11.15 A subscription moves only `active ↔ past_due`, and from either to `canceled`, which
is final. An event older than the newest one applied changes nothing. Premium posts are
closed to a member whose subscription is past due or canceled.

11.16 Each paid invoice is recorded as one sale, once, however many times the event is
delivered.

## 12. Store and sales history

12.1 The operator puts a synced Stripe product on sale at one of its one-time prices. A
recurring price is refused. The offer has a page at `/offers/<slug>`.

12.2 Buy names the offer, never a price. The price is the listed one and the quantity is
one. An offer that is not on sale is refused without asking Stripe, and an offer whose
price was archived in Stripe is taken down.

12.3 A checkout is recorded before Stripe is asked. It records the post the reader came
from when that post is published; any other value records no post and the sale goes
ahead.

12.4 A completed checkout books one sale by the same rules as every other Stripe sale,
once per charge, and records the converting post on the sale. No mail is sent.

12.5 A completed session carrying another checkout's token completes nothing. The return
page only reads.

12.6 A Buy posted from another site is refused. One IP may start at most twenty
checkouts an hour.

12.7 Past sales can be imported from a CSV. Only a campaign named on the line is
credited: no attribution is inferred from the buyer's later activity.

12.8 A sales import mails nobody, enrolls nobody and emits no webhook. A buyer who is
not on the list is created `pending`, and an existing subscriber's status is unchanged.

12.9 Amounts are read as text into integer cents, never through a float. A line that cannot be booked is refused with its reason and the rest are still
booked. Lines past the per-upload cap are reported as refused, not dropped.

12.10 Uploading the same file twice books nothing the second time.

## 13. Testimonials, topics and media

13.1 `{{testimonial_link}}` in a marketing mail becomes the reader's own link to a
testimonial form. In transactional mail it resolves to nothing, and on a published post
it points at the public wall.

13.2 A testimonial arrives `pending`. The wall shows only testimonials the operator
approved and the writer allowed to be published. The operator cannot approve one the
writer did not allow. The writer's address never appears on the wall.

13.3 A name is required and at most 80 characters, the text is 10 to 2,000 characters,
and one subscriber may submit three in a day. An unknown link finds nothing, and a post
from another site is refused. Deleting a subscriber deletes their testimonials.

13.4 A topic has a name, a description and a front-page shelf the operator can edit. Its
slug never changes. Renaming a topic to another topic's name is refused. Editing a topic
never touches a subscriber tag of the same name.

13.5 The media library lists every uploaded image, newest first, in pages. Deleting an
image that a broadcast, post or sequence step still shows is refused, naming where,
unless the operator confirms.

## 14. Outbound webhooks

14.1 The operator subscribes a URL to events: `subscribed`, `unsubscribed`, `bounced`,
`complained`, `purchased`, `published`. An endpoint hears only the events it picked, and
a switched-off endpoint hears nothing.

14.2 Only a public https URL is accepted, checked when it is saved and again before
every delivery. A redirect is never followed.

14.3 Reporting an event sends nothing by itself and cannot fail or delay the change it
reports. The next minutely tick delivers it.

14.4 Each delivery is signed with the endpoint's secret in a `Kolea-Signature` header and
carries an event id shared by every endpoint's copy. The secret is shown once, when the
endpoint is created.

14.5 A fact is reported once per endpoint, even when the provider replays the webhook
that caused it. A post going up is reported when it is published, not each time it is
saved.

14.6 Leaving one sequence is not reported as `unsubscribed`. An `unsubscribed` event says
whether it was the newsletter or everything.

14.7 A bulk import, of people or of sales, reports nothing.

14.8 A failed delivery is retried with a growing wait, up to eight attempts, then marked
`failed` and kept, and the operator can redeliver it. An endpoint whose deliveries keep
failing is switched off with the reason recorded.

14.9 A delivery never carries a subscriber's `unsub_token`, and money is integer cents.

## 15. Adding Kōlea to an agent by URL

15.1 `/mcp` answers a request with no token with 401 and names where to sign in. The
discovery documents are public and offer client registration, the authorization code
flow with PKCE S256 only, refresh tokens and revocation.

15.2 A client registers itself with no secret. A redirect URI must be https, or http to
the local machine, with no fragment. Registering grants nothing.

15.3 The operator approves a client on a consent page behind Cloudflare Access, which
shows the client's name and where the code will be sent. An approval posted from another
site is refused. A request for a redirect URI the client did not register is shown as an
error and never redirected to.

15.4 A connection is read-only unless the operator ticks "Allow changes". A read-only
connection is refused every tool that changes anything, and the refusal is recorded.
With changes allowed it has what an admin key has, under the same switches (8.15, 8.16)
and preflight tokens.

15.5 An authorization code works once, for two minutes, for the client and redirect URI
it was issued to, with the matching PKCE verifier. Every other attempt is refused as
`invalid_grant`. A code presented a second time revokes what the first redemption issued.

15.6 An access token works for an hour. A refresh token works once and returns a new
pair. An old refresh token presented again ends the whole connection.

15.7 Tokens are stored only as hashes. The operator can disconnect an app, and a client
can revoke its own token; either ends the connection at once.

15.8 The path-secret door with an admin key keeps working alongside.

## 16. Writing help

16.1 No helper sends, schedules, publishes or activates anything. Each returns a draft
or a review for a person to read.

16.2 Every model call is checked against the monthly budget before it is made and
recorded afterwards. With no usable key the helpers are off and say so.

16.3 The operator chooses which key pays: the install's key or their own OpenRouter,
Anthropic or OpenAI key. A stored key is encrypted, is refused without
`AI_KEY_ENCRYPTION_SECRET`, and only its last four characters are ever shown again.
Choosing a model the paying key cannot serve is refused. A stored key that can no
longer be read turns the helpers off; it never falls back to another key unasked.

16.4 The Ghostwriter writes one mail from a topic and the writer's notes. Text that reads
as instructions to the model is refused before anything is spent. Its output carries no
markup, no link to a host the writer did not give, and no merge tag the writer did not
use other than `{{first_name}}`.

16.5 A take is written beside an existing sequence, across cron ticks, and changes
nothing in the sequence. A take's mail reaches its step only when the operator uses it,
only while the sequence is paused, and it carries a placeholder the sequence cannot go
live with. Using one can be undone, which puts the step's own words back.

16.6 The reader council reviews a draft and changes nothing in it. No subscriber data is
sent to the model. A quote the council attributes to the draft is kept only if the draft
contains it. Every review is kept.

16.7 Launch Studio walks one launch through seven steps in order and refuses to skip
ahead. It makes a campaign and a paused sequence, and sends nothing.
