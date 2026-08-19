# Build Plan

> Required by the `bdd-specs` skill. Put this at `/docs/PLAN.md`.
> Specs are not written until this is filled in and approved.

## 1. Goal

One paragraph: what is being built and why. What does success look like?

## 2. Scope

**In scope**
- …

**Out of scope (explicitly not building)**
- …

## 3. Features

List the discrete features. Each feature becomes one spec file
(`Feature: …`). Keep them behavioral, not technical.

| # | Feature | One-line behavior |
|---|---------|-------------------|
| 1 | …       | …                 |
| 2 | …       | …                 |

## 4. Domain model

The core types/entities and their key invariants (the rules the specs
must enforce).

- `EntityName` — fields, what makes it valid, what it can do.

## 5. Technical boundaries

- Runtime / package manager: (Bun? Node?)
- Test runner: auto-detected by the skill (bun:test for Bun, else Jest)
- External dependencies / services:
- Constraints (performance, security, compliance):

## 6. Open questions

- …
