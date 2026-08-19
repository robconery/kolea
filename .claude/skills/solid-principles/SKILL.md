---
name: solid-principles
description: >-
  SOLID object-oriented design principles for TypeScript projects. Use when
  designing or refactoring classes and modules, reviewing code for design
  smells (rigid, fragile, tightly coupled code), deciding how to split
  responsibilities or introduce abstractions, or answering "is this good OO
  design / which SOLID principle applies here" questions. Covers all five
  principles with idiomatic TypeScript before/after examples and guidance on
  when applying them helps and when it is over-engineering.
---

# SOLID Principles in TypeScript

Five principles of object-oriented design (Robert C. Martin) that keep code
flexible, testable, and resistant to rot — adapted to idiomatic TypeScript,
where interfaces, structural typing, union types, and plain functions often
satisfy a principle without ceremony.

## 🎯 Why: Design for Change

The goal of writing software is to be able to **change it safely**. SOLID
is the OO toolkit for that goal: SRP limits *what* changes when a reason
to change appears, OCP lets you extend without editing tested code, LSP
keeps substitutions safe, ISP keeps consumers from breaking on unrelated
changes, DIP lets you swap implementations without rewriting policy.
Every rule below earns its keep only if it shrinks the next diff.

## How to use this skill

1. Match the symptom in the decision guide below to a principle.
2. Open `references/principles.md` for the full before/after TypeScript
   example and the "when this is over-engineering" note for that principle.
3. Apply the smallest change that removes the actual pain. SOLID is a
   response to *demonstrated* change pressure, not a checklist to apply
   preemptively. A 30-line app does not need an interface per class.

## Reference file

- `references/principles.md` — all five principles (SRP, OCP, LSP, ISP, DIP)
  with motivation, a bad example, a refactor, TypeScript-specific notes, and
  when *not* to apply each.

## The five principles

| Letter | Principle | One-line intent |
|---|---|---|
| **S** | Single Responsibility | A class/module should have one reason to change. |
| **O** | Open/Closed | Open for extension, closed for modification. |
| **L** | Liskov Substitution | Subtypes must be usable wherever their base type is expected. |
| **I** | Interface Segregation | Many small client-specific interfaces beat one fat one. |
| **D** | Dependency Inversion | Depend on abstractions, not concretions. |

## Decision guide — symptom → principle

| You notice… | Apply | Letter |
|---|---|---|
| A class changes for unrelated reasons (DB + formatting + business rules) | Single Responsibility | S |
| Adding a new "type" means editing a growing `switch`/`if-else` | Open/Closed | O |
| A subclass throws on, no-ops, or weakens a method it inherited | Liskov Substitution | L |
| Implementers are forced to stub methods they don't use | Interface Segregation | I |
| Business logic imports a concrete DB/HTTP/SDK client directly | Dependency Inversion | D |
| Unit tests need a real database, network, or clock | Dependency Inversion | D |
| One change ripples across many unrelated files | Single Responsibility | S |
| `instanceof` chains decide behavior | Open/Closed (often Strategy/polymorphism) | O |

## TypeScript-specific guidance

- **Interfaces are free and structural.** You don't need a class to implement
  an `interface` explicitly — any object with the right shape satisfies it.
  This makes ISP and DIP cheap.
- **Prefer narrow function types over fat interfaces.** A dependency that is
  "something that can `save(user)`" can be `(user: User) => Promise<void>`,
  not a `Repository` interface — that is ISP and DIP in one move.
- **Union types + exhaustive `switch` is a valid OCP alternative.** When the
  set of variants is closed and known, a discriminated union with a
  `never`-checked switch is often clearer than a class hierarchy.
- **Constructor injection is the default DIP mechanism.** Pass collaborators
  in; let a composition root wire concretions. Avoid `new`-ing dependencies
  inside business logic.
- **Don't abstract on speculation.** Introduce an interface when you have a
  second implementation or a real testing need — not "just in case."
