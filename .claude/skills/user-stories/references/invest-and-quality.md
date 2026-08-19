# INVEST, story smells, and splitting

Read this when quality-gating a story (workflow step 3) or when a story is too
big and needs splitting (step 4).

## INVEST checklist

Run each story past these. Each is a question; a "no" is a fix-it signal, not
necessarily a blocker — judgement applies.

- **Independent** — Can it be built and shipped without depending on another
  unfinished story? Hidden ordering dependencies make a backlog brittle. Some
  coupling is unavoidable; minimize it, don't pretend it away.
- **Negotiable** — Is it a statement of *need*, leaving room for the team to
  decide *how*? A story that prescribes implementation ("add a Redis cache")
  has smuggled in a solution. Re-state it as the need.
- **Valuable** — Is the value visible to a user or customer? "Refactor the auth
  module" is a task. "As a returning user I can stay logged in for 30 days so I
  don't re-enter credentials daily" is valuable. Tech work that enables a story
  belongs *inside* that story, not as its own user story.
- **Estimable** — Does the team have enough understanding to size it at all? If
  not, the gap is usually unknown scope — surface the unknown as a spike or a
  clarifying question rather than guessing.
- **Small** — Can its acceptance criteria be enumerated, and would it fit
  comfortably in a single sprint? If you cannot list the criteria, it is an
  epic wearing a story's clothes. Split it.
- **Testable** — Can every acceptance criterion be written as Given/When/Then
  with an observable outcome? If a criterion is "the UI feels fast", it is not
  testable as written — quantify it ("responds within 200ms") or drop it.

## Common smells

- **Hollow value.** "...so that I can use the feature." The "so that" must name
  a real outcome. If it can't, question whether the story should exist.
- **Task masquerading as a story.** No role, or the role is "the developer",
  and the value is internal. Fine as a task under a story; not a user story.
- **Conjunction story.** Title or capability contains "and". Usually two
  stories. Split on the "and".
- **Solution-first.** Names a technology or design instead of a need. Restate
  as the need; let the design be negotiable.
- **Unfalsifiable acceptance criteria.** "Works correctly", "handles errors
  gracefully". Replace with specific Given/When/Then cases — one per distinct
  behavior, because each becomes one downstream assertion.
- **Multi-outcome `Then`.** A criterion whose `Then` has "and". Split into two
  criteria; downstream each `Then` is one Specification.

## Splitting patterns (for stories that are too big)

Prefer **vertical slices** — each slice is thin but goes end to end and is
independently valuable and testable. Avoid horizontal slices ("do the API",
then "do the UI"): neither half is shippable value alone.

Useful split axes, roughly in order of how often they work:

1. **Workflow steps** — slice a long flow into the first valuable step, then
   subsequent steps. (Checkout: "pay with saved card" before "add new card".)
2. **Business rule variations** — happy path as one story, each significant
   rule/exception as its own. (Discounts: standard price first, then promo
   codes, then bulk pricing.)
3. **Happy vs. unhappy path** — core success first; validation, errors, and
   recovery as follow-on stories.
4. **Data variations** — one input type/format first, others later. (Import CSV
   before import XLSX.)
5. **CRUD boundaries** — "view X" is often valuable before "edit X".
6. **Effort/optimization split** — a deliberately naive version that delivers
   value, then a story to make it fast/scalable. (Search: exact-match before
   fuzzy ranking.)
7. **Defer the hard part** — ship the 80% case; carve the gnarly 20% (the
   special account type, the legacy format) into its own story so it doesn't
   hold the rest hostage.

A good split leaves every resulting story still passing INVEST — especially
Valuable and Testable. If a slice has no user-visible value, you split
horizontally; try a different axis.

## Definition of Ready / Done defaults

Offer these as starting points; they are team agreements, so let the user
adjust. Capture the agreed version at the top of `STORIES.md`.

**Ready (default):** role/capability/value all present and non-hollow;
Given/When/Then acceptance criteria covering the happy path; out-of-scope
stated; passes INVEST (notably Small + Testable).

**Done (default):** all acceptance criteria pass as executable specs; sad-path
criteria covered, not just happy path; plus whatever the team adds (peer
review, docs updated, behind a flag, deployed to staging, etc.).
