# User Stories

> Canonical backlog. Consumed by the `bdd-specs` skill: each Story below
> becomes a Feature, each acceptance criterion becomes a Scenario, and each
> `Then` becomes one Specification (one assertion). Keep acceptance criteria in
> Given/When/Then form so the handoff stays mechanical.

## Definition of Ready

A story is ready to be picked up when:

- The role, capability, and value are all stated and non-hollow.
- Acceptance criteria exist, in Given/When/Then form, covering the happy path.
- Out-of-scope notes make the boundary explicit.
- It is small enough that its criteria can be enumerated (passes INVEST).

## Definition of Done

A story is done when:

- All acceptance criteria pass as executable specs (via `bdd-specs`).
- Edge/error criteria are covered, not just the happy path.
- _(team-specific additions: review, docs, deploy gate, etc.)_

---

## Epic: <epic name>

_One-line description of the outcome this epic delivers and for whom._

### STORY-001 — <short title>

As a **<specific role>**,
I want **<capability>**,
so that **<outcome / value>**.

**Size:** S | M | L  ·  **Status:** ready | drafting | blocked

**Acceptance criteria**

_Happy path (cover exhaustively, first):_

```
AC1 — <short name of the behavior>
  Given <starting state / preconditions>
  When  <the single action>
  Then  <one observable outcome>

AC2 — <short name>
  Given <...>
  When  <...>
  Then  <one observable outcome>
```

_Sad path (errors, edges, invalid input — kept separate on purpose):_

```
AC3 — <short name, e.g. "rejects empty input">
  Given <...>
  When  <...>
  Then  <one observable failure outcome>
```

**Out of scope:** <what this story deliberately does not cover>

**Notes:** <links, open questions, `> ASSUMPTION:` lines to confirm>

---

### STORY-002 — <short title>

_(placeholder — to be refined before it is picked up)_

---

## Epic: <next epic>

_..._
