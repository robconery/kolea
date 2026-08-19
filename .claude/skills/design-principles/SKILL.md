---
name: design-principles
description: >-
  General object-oriented design principles for TypeScript projects that are
  NOT part of SOLID or the Gang of Four patterns — coupling and cohesion
  (incl. connascence), DRY, YAGNI, KISS, separation of concerns, encapsulation
  / information hiding, Tell Don't Ask, Law of Demeter, composition over
  inheritance, program-to-an-interface, Command–Query Separation, Principle of
  Least Astonishment, and fail-fast. Use when designing or refactoring modules,
  reviewing code for coupling/duplication/leaky-abstraction smells, deciding
  whether an abstraction earns its keep, or answering "is this good design /
  which principle applies" questions that SOLID and GoF do not cover.
---

# Design Principles in TypeScript (beyond SOLID & GoF)

The design heuristics that predate and underpin SOLID: how to measure and
reduce coupling, maximize cohesion, avoid premature/false abstraction, and keep
objects in charge of their own data — adapted to idiomatic TypeScript.

## 🎯 Why: Design for Change

The goal of writing software is to be able to **change it safely**. Coupling
is the cost of the next change; cohesion is its locality. Tell-Don't-Ask,
Demeter, encapsulation, composition-over-inheritance — all of these exist
to shrink the blast radius of an edit. DRY and YAGNI cut both ways: too
little abstraction and a change ripples; too much and the seam is in the
wrong place. Pick the abstraction that makes the *next* diff small.

## Scope — how this differs from the other two skills

- **`solid-principles`** owns SRP, OCP, LSP, ISP, DIP. This skill does **not**
  re-explain those. Where a principle here is adjacent (Separation of Concerns
  ≈ SRP at the architecture level; Program-to-an-Interface ≈ DIP/ISP), the
  reference file states the distinction and defers to `solid-principles`.
- **`gof-patterns`** owns the 23 named patterns. This skill explains the
  *forces* (coupling, cohesion, Tell-Don't-Ask) that motivate those patterns
  but never re-documents a pattern. "Composition over inheritance" here is the
  general principle; the patterns that apply it (Strategy, Decorator) live in
  `gof-patterns`.

## How to use this skill

1. Match the symptom in the decision guide to a principle.
2. Open `references/principles.md` for that principle's full before/after
   TypeScript example and its "when this is over-engineering" note.
3. Apply the smallest change that removes real pain. These are heuristics that
   trade off against each other (DRY vs. coupling, YAGNI vs. extensibility) —
   resolve the conflict in favor of the code that is cheapest to change *now*.

## Reference file

- `references/principles.md` — all principles with intent, a smell, a bad
  example, a refactor, TypeScript-specific notes, and when *not* to apply.

## The principles

| Principle | One-line intent |
|---|---|
| **Coupling** (loose vs. tight) | Minimize what one module must know about another; measure it with connascence. |
| **Cohesion** | Group things that change together and are used together. |
| **DRY** | Every piece of *knowledge* has one authoritative representation. |
| **YAGNI** | Don't build it until a real requirement demands it. |
| **KISS** | Prefer the simplest design that works; complexity must be earned. |
| **Separation of Concerns** | Distinct concerns live in distinct, swappable layers/modules. |
| **Encapsulation / Information Hiding** | Hide representation; expose intent through behavior. |
| **Tell, Don't Ask** | Send objects commands; don't pull their state out to decide for them. |
| **Law of Demeter** | Talk only to immediate collaborators; don't navigate object graphs. |
| **Composition over Inheritance** | Assemble behavior from parts; reserve inheritance for true substitutability. |
| **Program to an Interface** | Depend on a role/contract, not a concrete class. |
| **Command–Query Separation** | A method either changes state or returns a value — not both. |
| **Principle of Least Astonishment** | Behavior should match the name and the caller's reasonable expectation. |
| **Fail Fast** | Reject invalid state at the boundary, loudly, before it propagates. |

## Decision guide — symptom → principle

| You notice… | Apply |
|---|---|
| Changing module A forces edits in B, C, D | Reduce **Coupling** (find the connascence) |
| A file groups unrelated helpers used by different callers | Improve **Cohesion** |
| The same business rule is encoded in three places | **DRY** |
| Two code paths look identical today but model different concepts | *Stop* applying DRY — see false-DRY note |
| An abstraction/config exists "for the future" with one caller | **YAGNI** |
| A clever generic/metaprogramming layer nobody can explain | **KISS** |
| HTTP, business rules, and SQL interleaved in one function | **Separation of Concerns** |
| Callers read an object's fields then mutate them back | **Tell, Don't Ask** / **Encapsulation** |
| `a.getB().getC().doThing()` train wrecks | **Law of Demeter** |
| A subclass inherits methods it must disable | **Composition over Inheritance** |
| Business logic `new`s a concrete client / imports an SDK directly | **Program to an Interface** (then see `solid-principles` DIP) |
| A getter mutates, or a "save" returns the thing it saved | **Command–Query Separation** |
| A function named `getUser` also creates one as a side effect | **Principle of Least Astonishment** |
| Invalid data is detected three layers deep, far from its source | **Fail Fast** |

## TypeScript-specific guidance

- **Connascence is the practical coupling metric.** Prefer connascence of
  *name* (shared identifier) over connascence of *type*, and both over
  connascence of *position* (argument order) — replace positional params with
  an options object. Keep stronger forms (meaning, algorithm, timing) local to
  one module. See the Coupling section.
- **`readonly`, `#private`, and accessor methods enforce encapsulation.** Use
  `#field` (true runtime privacy) over the `private` keyword when callers must
  not reach in; expose `readonly` views instead of mutable arrays/objects.
- **A narrow function type *is* an interface.** "Program to an interface"
  rarely needs a `class implements`; `type Notify = (e: Event) => void`
  decouples just as well with less ceremony.
- **`as const` + discriminated unions** make illegal states unrepresentable —
  the strongest form of Fail Fast (compile-time instead of runtime).
- **Tell-Don't-Ask conflicts with rich domain models exposed to React.** UI
  often legitimately needs to *ask* (render state). Apply Tell-Don't-Ask to
  domain/service code; let view models be data bags.
- **DRY is about knowledge, not characters.** Two functions with identical
  bodies that encode *different* decisions should stay separate; coupling them
  to save lines creates a change-amplifier. Rule of Three before extracting.
