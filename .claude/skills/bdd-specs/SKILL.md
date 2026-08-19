---
name: bdd-specs
description: >-
  Behavior-driven design: write executable specifications BEFORE any
  implementation code. Reads /docs/PLAN.md for the build plan and
  /docs/STORIES.md for user stories, and stops to ask for either if it is
  missing. Generates TypeScript spec files in nested blocks — Feature >
  Scenario > Specification — where each Scenario arranges all of its data
  in a beforeAll/beforeEach, every Specification makes exactly one
  assertion, happy-path specs come first and exhaustively, and sad-path
  specs live in their own separate blocks. Auto-detects the runner: bun:test
  if the project uses Bun, otherwise Jest. Use when starting a new project
  or feature, when asked to "spec out", "write the tests first", do BDD/TDD,
  or turn a plan or user stories into a test suite. Ships PLAN.md and
  STORIES.md scaffolds plus ready-to-copy bun:test and Jest spec templates.
---

# Behavior-Driven Design — Specifications First

Specifications are written **before** implementation. The spec is the
design artifact: it encodes the intended behavior from the plan and the
user stories, fails first, and is the definition of done. Do not write
implementation code under this skill until the specs exist and the user
has seen them.

## 🎯 Why: Design for Change

The goal of writing software is to be able to **change it safely**. Specs
are the safety net that makes change possible — without them, every edit
is a guess. One assertion per Specification means a failing spec names
exactly what broke; happy/sad-path separation means you can change one
behavior without re-reading the whole suite. The spec suite *is* the
change-budget for the codebase.

## The non-negotiable workflow

Run these gates **in order**. Do not skip ahead.

### 1. Require the plan

Look for the build plan at `/docs/PLAN.md` (also accept
`docs/PLAN.md`, `PLAN.md`, or an obvious `docs/plan.*`).

- **If it is missing:** stop. Ask the user to provide a `PLAN.md` in
  `/docs`. Offer to scaffold one from `templates/PLAN.md` and let them
  fill it in, or to draft it from their description and write it to
  `/docs/PLAN.md` for approval. Do not proceed to specs without an
  approved plan.
- **If it exists:** read it fully. It defines the features and the
  technical boundaries the specs must cover.

### 2. Require the user stories

Look for user stories at `/docs/STORIES.md` (also accept
`docs/STORIES.md`, `STORIES.md`).

- **If it is missing:** stop. Ask the user for the user stories. Offer
  to scaffold `templates/STORIES.md`, or to derive draft stories from
  `PLAN.md` and write them to `/docs/STORIES.md` for approval. Do not
  proceed without stories — they are the source of every Scenario.
- **If it exists:** read it fully. Each story maps to one Feature; each
  acceptance criterion / "so that" outcome maps to a Scenario.

### 3. Detect the test runner

Pick the runner from the project, do not ask:

- **Use `bun:test`** if any of these are true: `bun.lockb` or
  `bun.lock` exists, `bunfig.toml` exists, `package.json` scripts invoke
  `bun`, or the user explicitly says they use Bun. Import from
  `"bun:test"`. Run with `bun test`.
- **Otherwise use Jest.** Import from `"@jest/globals"`. Run with
  `npx jest` (or the project's `test` script).

State which runner you detected and why before generating files.

### 4. Generate the specs

For every story, produce a spec file built from the templates. Map
stories to features 1:1, write the file, then stop and let the user
review before any implementation.

## The spec structure (mandatory shape)

Three nested blocks, outer to inner: **Feature → Scenario →
Specification**.

```ts
describe("Feature: <name from a user story>", () => {
  describe("Scenario: <a concrete situation / acceptance criterion>", () => {
    // Arrange ALL data this scenario needs, once, here:
    let result: Cart;
    beforeAll(() => {
      const cart = new Cart();
      cart.add(item("widget", 2));
      result = cart;
    });

    // Specification = one `it` = exactly ONE assertion:
    it("has two line items", () => {
      expect(result.lineItems).toHaveLength(2);
    });

    it("totals the line items", () => {
      expect(result.total).toBe(20);
    });
  });
});
```

Hard rules — every generated file must obey all of them:

1. **Feature** is the outermost `describe`, titled `Feature: …` with a
   short human-readable name — **no story id in the title**. One feature
   per file, sourced from a user story. The file name is a readable
   kebab-case slug of the feature, also without a story-id prefix
   (e.g. `atomic-create-user-order-entitlements.spec.ts`). Put the story
   id in a single comment at the top of the file
   (e.g. `// STORY-007 — Atomic create of user, order, entitlements`) —
   that comment is the only place the id appears.
2. **Scenario** is a nested `describe`, titled `Scenario: …`. Every
   Scenario arranges **all** of its required data in a `beforeAll`
   (use `beforeEach` only if a spec mutates shared state). No
   arrange logic inside the `it` blocks.
3. **Specification** is an `it`. **Exactly one assertion per `it`.**
   No multiple `expect`s, no looped assertions. Need another
   assertion → another `it`.
4. **Happy path first, and exhaustive.** Cover every success outcome
   the story implies before any failure case. Be thorough, not
   minimal.
5. **Sad path is segregated.** Error, validation, and edge-case specs
   go in their own separate Scenario block(s) (e.g.
   `Scenario: rejecting invalid input`) — never interleaved with
   happy-path specs.
6. **TypeScript**, typed, no `any`. Imports come from the detected
   runner only.
7. **At least one Scenario per Feature exercises the deployed entry
   point.** Import the production export — the exported handler,
   `default.fetch`, the Hono app, the Next route file — not an internal
   function bypassing it. Drive side effects through fake **adapters**
   injected at the boundary (fake DB, fake email, fake storage), never by
   calling internals. If the only way to test a Feature is to bypass the
   export, the export is the bug. Unit-seam specs are fine *in addition*,
   but never *instead*. Mocks define test reality; only the entry-point
   spec defines production reality.

## Templates

Copy the file that matches the detected runner and adapt it — do not
hand-write the scaffold:

- `templates/feature.bun.spec.ts` — `bun:test` spec, full
  Feature/Scenario/Specification shape with happy + segregated sad
  paths.
- `templates/feature.jest.spec.ts` — identical structure for Jest.
- `templates/PLAN.md` — build-plan scaffold to hand the user when
  `/docs/PLAN.md` is missing.
- `templates/STORIES.md` — user-story scaffold (story + acceptance
  criteria) to hand the user when `/docs/STORIES.md` is missing.

See `references/workflow.md` for the story→feature→scenario mapping
worked through end to end, and the exhaustiveness checklist.
