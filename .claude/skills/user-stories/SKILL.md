---
name: user-stories
description: Write, split, and refine agile/scrum user stories and acceptance criteria. Produces /docs/STORIES.md as the canonical backlog, formatted to feed directly into the bdd-specs skill (Story → Feature, Given/When/Then acceptance criteria → Scenario/Specification). Use this whenever the user wants to write a user story, capture requirements as stories, "groom" or "refine" a backlog, break an epic or feature into stories, split a story that is too big, write or tighten acceptance criteria, draft a Definition of Done, or turn a vague feature request or PRD into a structured backlog — even if they don't say the words "user story" or "scrum".
---

# User Stories

Turn product intent into a structured, testable backlog in `/docs/STORIES.md`. The
output is the *input* to the `bdd-specs` skill, so the structure here is not
cosmetic — it is a contract. Get the format right and stories flow into
executable specs and then code with no manual reshaping.

## The pipeline you sit in

```
product intent ──▶ [user-stories] ──▶ /docs/STORIES.md ──▶ [bdd-specs] ──▶ spec files ──▶ code
```

`bdd-specs` reads `/docs/STORIES.md` and `/docs/PLAN.md` and generates nested
specs: **Feature > Scenario > Specification**, where each Scenario arranges its
data once and every Specification makes exactly one assertion, happy paths first
and exhaustively, sad paths in their own block.

So map deliberately:

| Story artifact            | Becomes in bdd-specs        |
| ------------------------- | --------------------------- |
| One story                 | One Feature                 |
| One acceptance criterion  | One Scenario                |
| Given / When / Then steps | The Scenario's arrange / act / assert |
| Each distinct Then        | One Specification (one assertion) |
| Happy-path criteria       | Listed first, exhaustively  |
| Error / edge criteria     | A separate "sad path" group |

Write acceptance criteria as Given/When/Then from the start. That single habit
is what makes the handoff clean.

## Workflow

### 1. Establish context before writing

A story carries product knowledge the codebase does not. Do not invent the
role, the goal, or the value. If the user hands you a vague feature ("add
notifications"), interview rather than guess:

- **Who** is this for? (the role — be specific: "billing admin", not "user")
- **What** do they want to do?
- **Why** — what outcome or pain does it address? A story whose "so that" is
  hollow ("...so that I can use the feature") is usually a task, not a story.
- What does *done* look like? What must be observably true?
- What is explicitly **out of scope** for this story?

Ask the smallest number of questions that unblock you. If the user says "just
draft it and I'll correct it", do that — draft, mark assumptions with
`> ASSUMPTION:` lines, and let them react. Reacting is faster than specifying.

### 2. Write the story

Use the canonical form. Read `assets/STORIES.template.md` for the exact file
layout and copy its structure — it is what `bdd-specs` expects.

```
As a <specific role>,
I want <capability>,
so that <outcome / value>.
```

Then acceptance criteria, each as a self-contained scenario:

```
AC1 — <short name>
  Given <starting state>
  When  <action>
  Then  <single observable outcome>
```

Keep one outcome per `Then`. If you need "and also", that is a second
criterion (it will become a second Specification downstream). Cover the happy
path exhaustively first, then error and edge criteria under a clearly separated
heading.

### 3. Quality-gate every story with INVEST

Before considering a story done, check it against INVEST and the smells list in
`references/invest-and-quality.md`. The two failures worth catching every time:

- **Too big (not Small).** If you cannot enumerate its acceptance criteria, or
  it spans multiple roles/outcomes, split it — see the splitting patterns in
  the reference. Prefer vertical slices (a thin end-to-end capability) over
  horizontal ones ("build the API", "build the UI"), because a vertical slice
  is independently valuable and testable.
- **Not Testable.** If you cannot phrase the acceptance criteria as
  Given/When/Then with observable outcomes, the story is underspecified. That
  is a signal to go back to step 1, not to lower the bar.

### 4. Epics and decomposition

An epic is a container, not a big story. Represent it as a heading that groups
its child stories. Break an epic down only as far as the next sprint needs —
near-term stories fully fleshed with acceptance criteria, later ones left as
one-line placeholders. Over-decomposing a backlog that will change is waste
(YAGNI applies to backlogs too).

### 5. Definition of Ready / Definition of Done

These are team agreements, so confirm them with the user rather than asserting
house rules. Capture them once at the top of `STORIES.md` (the template has a
slot). Default starting points are in the reference file; offer them, don't
impose them.

## Scope boundaries

- **In scope:** writing stories, splitting/refining them, acceptance criteria,
  epic decomposition, Definition of Ready/Done, turning a PRD or feature
  request into a backlog.
- **Out of scope, say so plainly:** story-point estimation and sprint capacity
  planning are team rituals that depend on a specific team's history and
  velocity — a skill cannot do them credibly. Offer relative-size *flags*
  (S/M/L, or "this is too big, split it") instead of fabricated point numbers.
- **Hand off, don't overlap:** generating the executable specs from these
  stories is `bdd-specs`'s job. Architecture/implementation planning is the
  `Plan` agent's or `/docs/PLAN.md`'s job. Produce the backlog and point at the
  next step; don't do their work here.

## Output

Always write or update `/docs/STORIES.md`. If it does not exist, create it from
`assets/STORIES.template.md`. If it exists, merge — preserve story IDs already
in use (downstream specs may reference them) and append or amend rather than
rewriting wholesale. After writing, tell the user how many stories/epics the
file now holds and that it is ready for `bdd-specs`.
