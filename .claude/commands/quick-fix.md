---
description: Make a small, obvious fix directly on the current branch. No sprint, no PLAN, no stories.
argument-hint: <describe the fix>
model: claude-sonnet-4-6
---

# quick-fix

For the trivial stuff: a typo, a reversed condition, a dead `try/catch`, a
misnamed variable, a stray import. The kind of bug where opening
`/explore` → `/design` → `/plan` → `/build-loop` would be absurd.

## Scope

- IN: one-spot fixes that a competent engineer would commit straight to
  `main` without ceremony. Single concern. Usually < ~20 lines changed.
- OUT: anything that needs a design call, touches a public API contract,
  changes behavior across modules, or needs new tests beyond what already
  exists. If it smells like that, stop and suggest `/plan` or `/build-loop`.

## Argument

`$ARGUMENTS` describes the fix in the user's words (e.g. "remove the
unneeded try/catch in fetchUser", "fix the typo in the login button").
If empty, ask one short clarifying question.

## Loop

1. **Locate.** Find the exact site. If the description is ambiguous or
   matches multiple places, ask before guessing.
2. **Confirm it's actually small.** If reading the surrounding code reveals
   the fix is non-trivial (touches a class boundary, changes a contract,
   needs new branches of test coverage), **stop and escalate** — tell the
   user this isn't a quick-fix and suggest `/plan`.
3. **Consult skills selectively.** Only load a code-quality skill if the
   fix genuinely touches its territory:
   - `solid-principles` / `design-principles` / `gof-patterns`: only if the
     fix sits at a class or module boundary, or changes a control-flow
     pattern. Skip for typos, comments, log strings, dead code removal.
   - `agent-teams`: skip — quick-fixes are single-threaded by definition.
   - `typescript-best-practices`: consult if the fix involves types,
     `any`/`unknown`, null handling, or error shape.
4. **Apply the edit.** Use `Edit`, not `Write`. Match surrounding style.
5. **Verify.** Run the project's typecheck and tests if they're fast. If
   they're slow or absent, run the narrowest check that proves the fix
   (e.g. `tsc --noEmit` on the file, or the single related test).
6. **Report and ask before committing.** Show the diff summary and propose
   a one-line commit message. Do **not** commit unless the user says go —
   committing straight to `main` is a shared-state action.

## Commit message style

Imperative, lowercase, no body unless genuinely needed:

- `fix: remove unreachable try/catch in fetchUser`
- `fix: correct typo in login button label`
- `fix: invert empty-state condition in Sidebar`

## Hand off

One sentence: what changed, what you verified, awaiting commit confirmation
(or confirming the commit if the user pre-authorized).
