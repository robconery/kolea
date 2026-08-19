---
name: typescript-best-practices
description: >-
  Idiomatic TypeScript conventions and best practices: strict compiler
  settings, type-level modeling (discriminated unions, branded/nominal types,
  `as const`/`satisfies`, exhaustiveness), `unknown` over `any`, immutability,
  error handling with a Result type, null/undefined hygiene, async/promise
  rules, module and naming conventions, and the project rule that every class
  exposes `toString()` and `toJSON()`. Use when writing new TypeScript, doing
  code review, setting up a tsconfig, modeling a domain type, or answering
  "what is the idiomatic TypeScript way to do this" questions. Ships ready-to-
  copy templates for value objects, entities, errors, Result, state machines,
  branded types, type guards, and a strict tsconfig.
---

# TypeScript Best Practices & Idioms

How to write TypeScript that the compiler can actually protect: model
illegal states out of existence, prefer narrow types over `any`, make
invariants explicit, and keep runtime behavior (serialization, equality,
errors) predictable.

## 🎯 Why: Design for Change

The goal of writing software is to be able to **change it safely**. Strict
types, discriminated unions, branded types, and `Result` errors turn the
compiler into a change-detector: when a shape moves, every caller lights
up. `any` and loose types are change-hiders — they make the next edit
*look* safe while it isn't. Idiomatic TS exists to keep the next refactor
mechanical instead of archaeological.

This skill is about *idioms and conventions*. For OO design pressure use
`solid-principles` and `design-principles`; for named patterns use
`gof-patterns`. This skill does not re-explain those.

## How to use this skill

1. Match the symptom in the decision guide to a rule.
2. Open `references/idioms.md` for that rule's full rationale, a bad
   example, the idiomatic refactor, and when *not* to apply it.
3. Copy the closest file from `templates/` and adapt it. The templates
   already encode the conventions below (strict types, `toString`/`toJSON`,
   exhaustiveness) so you start compliant instead of retrofitting.
4. Apply the smallest change that removes real pain. Strictness is earned
   by demonstrated bugs, not applied as ceremony — but the *defaults* here
   (strict tsconfig, no `any`, no floating promises) are non-negotiable
   because their failure mode is silent.

## Project rule: every class has `toString()` and `toJSON()`

This is a hard convention in this codebase, not a suggestion.

- **`toJSON()`** — returns a plain, serializable object. `JSON.stringify`
  calls it automatically, so logs, API responses, and persistence get a
  stable, intentional shape instead of leaking private fields, class
  internals, or `undefined`. Never return the instance itself.
- **`toString()`** — returns a short human-readable identifier for logs,
  error messages, and template literals (`` `order ${order}` ``). It is for
  humans; `toJSON()` is for machines. They are not interchangeable.

Why it is mandatory: without `toJSON()`, serialization is accidental — it
exposes whatever fields happen to be public today and breaks the moment a
private field is added. Without `toString()`, a class interpolated into a
string is `[object Object]`, which destroys logs and error context. Both
methods make the class's *external contract* explicit and decoupled from
its internal representation (information hiding). See
`references/tostring-tojson.md` for the full rationale, edge cases
(circular refs, `Date`, `bigint`, secrets redaction), and the
copy-ready pattern. Every template in `templates/` demonstrates it.

## Decision guide

| Symptom / question | Rule | Where |
|---|---|---|
| Reaching for `any` to silence the compiler | Use `unknown` + narrowing | idioms.md §1 |
| `enum Status { ... }` | Use a string-literal union or `as const` object | idioms.md §2 |
| Object can be in contradictory states | Model with a discriminated union | idioms.md §3 |
| Two `string` IDs got swapped at a call site | Brand the types (nominal) | idioms.md §4, templates/branded-type.ts |
| `switch` silently misses a new case | Exhaustiveness check with `never` | idioms.md §5 |
| Config object loses literal types | `as const` + `satisfies` | idioms.md §6 |
| Throwing for an expected, recoverable failure | Return a `Result<T, E>` | idioms.md §7, templates/result.ts |
| `catch (e)` then `e.message` | `unknown` catch + error narrowing | idioms.md §8, templates/app-error.ts |
| Mutable shared object mutated far away | `readonly` / `Readonly<T>` / freeze | idioms.md §9 |
| `null` vs `undefined` used interchangeably | Pick one convention; `?.`/`??` | idioms.md §10 |
| Floating promise / unhandled rejection | Always `await`; `void` deliberate fire-and-forget | idioms.md §11 |
| Hand-written `{ id: ..., name: ... }` derived from another type | Utility types (`Pick`/`Omit`/`Partial`) | idioms.md §12 |
| Validating external input by casting | Type guard / assertion function (or a schema lib) | idioms.md §13, templates/type-guards.ts |
| New class, modeling a domain value | Value object template | templates/value-object.ts |
| New class with identity/lifecycle | Entity template | templates/entity.ts |
| `interface` vs `type` vs `class` indecision | Decision rule | idioms.md §14 |

## Reference files

- `references/idioms.md` — every rule above with motivation, a bad
  example, the idiomatic refactor, TypeScript-specific notes, and when the
  rule is over-engineering.
- `references/tostring-tojson.md` — the mandatory `toString`/`toJSON`
  convention in depth: contract, edge cases, redaction, testing.

## Templates (copy and adapt)

| File | Use case |
|---|---|
| `templates/tsconfig.json` | Strict baseline compiler config |
| `templates/value-object.ts` | Immutable validated value (Money, Email) with factory, `equals`, `toString`/`toJSON` |
| `templates/entity.ts` | Domain entity with identity, lifecycle, `toString`/`toJSON` |
| `templates/result.ts` | `Result<T, E>` type + `ok`/`err`/`map`/`unwrap` helpers |
| `templates/app-error.ts` | Typed error base class + subclasses, serializable, with `toJSON`/`toString` |
| `templates/discriminated-union.ts` | State modeled as a tagged union with exhaustive handling |
| `templates/branded-type.ts` | Zero-cost nominal types and smart constructors |
| `templates/type-guards.ts` | User-defined type guards and assertion functions |

## Non-negotiable defaults

These are silent-failure rules; apply them everywhere from day one:

1. `strict: true` (and `noUncheckedIndexedAccess`) in tsconfig.
2. No `any` in committed code — `unknown` + narrowing instead.
3. No floating promises — `await` or explicit `void`.
4. Every class implements `toString()` and `toJSON()`.
5. Exported functions have explicit return types.
6. External/untrusted data is validated at the boundary, never cast.
