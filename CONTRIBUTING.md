# Contributing 🤝

Thanks for looking. Before you spend time on a patch, read the next paragraph — it
will save you some.

## What this project is

Kōlea is a **single-operator** mailer. It is not multi-tenant and it is not
going to become multi-tenant: there is no signup, no billing, no orgs, and no
per-account isolation anywhere in the schema. That is a deliberate scope decision,
not a missing feature. See [`docs/PROJECT.md`](docs/PROJECT.md).

It is published because the design is worth reading and the code is worth forking —
not because it is looking for feature requests. Fork it, run it, make it yours.

**Very welcome:** bug reports, correctness fixes, deliverability and email-client
rendering fixes, tests, docs corrections.

**Probably declined:** multi-tenancy, a visual drag-and-drop builder, self-run SMTP,
swapping Cloudflare for another platform, adding a frontend framework.

If you are unsure whether a change fits, open an issue before writing the code.

## Getting set up

```bash
bun install
bun run db:migrate     # applies migrations to the local D1 database
bun run dev            # http://localhost:8787
```

Then click **Seed demo data** on the dashboard. `EMAIL_PROVIDER=console` is the local
default, so nothing is capable of leaving your machine — rendered mail lands in the
in-app Outbox instead.

## Before you open a PR

```bash
bun run typecheck      # Worker and browser bundle, separately — must be clean
bun run smoke          # browser smoke test of the editor; needs `bun run dev` running
```

There is no server-side test suite yet. [`docs/SPEC.md`](docs/SPEC.md) is written as
numbered, testable requirements and is the reference for intended behavior — if you
change behavior, change the matching SPEC clause in the same PR.

## Conventions

- **TypeScript, strict.** No `any` where `unknown` and a narrow will do.
- **Conventional Commits** — `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`.
- **Schema changes go through Drizzle.** Edit `src/db/schema.ts`, then
  `bun run db:generate`. Never hand-write a migration that the generator should own.
- **Anything observable belongs in D1, not in a log line.** Workers logs expire in
  3–7 days; an audit trail that disappears is not an audit trail.
- **Comments explain *why*.** The codebase is heavy on rationale comments — the
  non-obvious constraint, the rejected alternative, the failure mode. Match that.

## The one rule that matters

**Consent is scoped.** Leaving one sequence must never remove someone from the
newsletter, and leaving the newsletter must never stop a sequence they opted into.
Only an explicit "unsubscribe from everything", a hard bounce, or a spam complaint
may write a global suppression.

This asymmetry is the reason the project exists and it is the easiest thing in the
codebase to break by accident. Any PR that touches `src/core/consent.ts`,
`src/core/sending.ts`, or `src/core/sequences.ts` should say in its description what
it does to each of the three scopes.

## Reporting a vulnerability

Don't open an issue — see [`SECURITY.md`](SECURITY.md).

## Conduct

Be decent, and argue with the code rather than the person who wrote it. The long
version is in [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
