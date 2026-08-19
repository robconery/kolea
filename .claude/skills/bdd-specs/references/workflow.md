# Story → Feature → Scenario → Specification, worked through

This is the mapping the skill applies. Read it before generating specs.

## The mapping

| Source artifact                         | Spec construct                    |
|-----------------------------------------|-----------------------------------|
| A user story in `STORIES.md`            | One `describe("Feature: …")` file |
| An acceptance criterion of that story   | One `describe("Scenario: …")`     |
| The "then …" of a criterion             | One `it("…")` with ONE `expect`   |
| All "given …" state for a criterion     | The Scenario's `beforeAll`        |
| A failure / edge "then"                 | An `it` in a *separate* sad-path Scenario |

## Worked example

Story from `/docs/STORIES.md`:

> **As a** customer
> **I want** to add items to a cart
> **So that** I can buy several things at once
>
> - Given an empty cart, when I add 2 widgets at $5, then the cart has 1
>   line item, the line totals $10, and the cart totals $10.
> - Given a cart with 1 widget, when I add 2 more widgets, then the cart
>   still has 1 line item and the quantity is 3.
> - Given an empty cart, when I add an item with quantity 0, then it is
>   rejected with a CartError.

Becomes:

- `Feature: a customer builds a shopping cart` (the story)
  - `Scenario: adding two widgets to an empty cart` (criterion 1)
    - `beforeAll`: new cart, add 2 widgets at $5
    - `it("has one line item")` — 1 assertion
    - `it("totals the line at $10")` — 1 assertion
    - `it("totals the cart at $10")` — 1 assertion
  - `Scenario: adding more of an existing item` (criterion 2)
    - `beforeAll`: cart with 1 widget, add 2 more
    - `it("still has one line item")` — 1 assertion
    - `it("has quantity three")` — 1 assertion
  - `Scenario: rejecting a zero quantity` (criterion 3 — SAD, separate block)
    - `beforeAll`: capture the failing call as a thunk
    - `it("throws a CartError")` — 1 assertion

Note how one criterion with three "then" clauses became three `it`s,
not one `it` with three `expect`s. That is the one-assertion rule.

## Exhaustiveness checklist (happy path)

Before declaring the happy path done, confirm a Scenario exists for:

- The nominal/typical case.
- Each boundary the domain model allows (empty, single, many, max).
- Each distinct success *outcome* the story's "so that" implies.
- Idempotent / repeated actions, if the domain supports them.
- Each query/derived value the feature exposes (one `it` each).

## Sad-path checklist (segregated blocks)

A separate Scenario for each:

- Each invariant in `PLAN.md`'s domain model that can be violated.
- Each validation rule (type, range, required, format).
- Each documented error / rejection in the story's failure cases.
- Conflict / not-found / unauthorized states, where applicable.

## Ordering rule

Within a Feature: every happy-path Scenario first, then every sad-path
Scenario. Never interleave. A reader scanning top-to-bottom should see
the intended behavior fully before seeing how it fails.

## Stop point

After generating the spec files, stop. Present them for review. Do not
write implementation code until the user approves the specs — the specs
are the design, and they are expected to fail first (red).
