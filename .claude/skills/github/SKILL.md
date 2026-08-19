---
name: github
description: >-
  GitHub workflow conventions: writing clear conventional commits, opening
  detailed issues and PRs via the `gh` CLI, and choosing trunk-based vs
  short-lived branch flow based on the size of the change. Use whenever the
  user wants to commit, branch, push, open an issue, open a PR, or asks
  how to structure any of those. Keep it light — direct, detailed messages,
  no ceremony.
---

# GitHub workflow

The point: write commits, issues, and PRs that read clearly weeks later.
Be direct, be specific, skip the filler.

## Branching — when to branch, when not

**Trunk-based (commit straight to `main`)** when:
- Single-file or single-concept fix.
- Typo, doc tweak, version bump, comment, lint fix.
- Test-only addition that doesn't change behavior.
- Anything that takes one commit and reviews itself in 30 seconds.

**Short-lived branch** when:
- More than ~2 commits expected.
- New feature or capability, even a small one.
- Schema/migration change.
- Anything that could break `main` for someone else.
- A spec / plan task that has its own id (e.g. `T052` from `docs/PLAN.md`).

Branch naming: `<type>/<short-slug>` — type is one of
`feat`, `fix`, `chore`, `docs`, `refactor`, `test`. Examples:

```
feat/order-fulfillment-tx
fix/signature-verify-header-case
chore/bump-drizzle
```

Keep branches short-lived. Open the PR early, even as draft.

## Commits — Conventional Commits, kept honest

Format:

```
<type>(<optional scope>): <imperative summary, lower-case, no period>

<body — what changed and why, wrapped at ~72 cols>

<footer — refs, breaking changes>
```

**Types:** `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`,
`build`, `ci`, `revert`.

**Summary line rules:**
- 50 chars or fewer when possible, hard cap 72.
- Imperative mood (`add`, not `added`/`adds`).
- No trailing period.
- Scope is optional; use it when there's an obvious area
  (`feat(webhook): …`, `fix(db): …`).

**Body rules:**
- Always include one if the change isn't self-evident from the diff.
- Explain **what** changed and **why** — never restate the diff line by
  line. Mention trade-offs or alternatives rejected if relevant.
- One blank line between summary and body.
- Reference issues with `Refs #123` or `Closes #123`.

**Footers:**
- `Closes #N` to auto-close an issue on merge.
- `BREAKING CHANGE: <what breaks, how to migrate>` for breakages.
- `Co-Authored-By:` lines when pairing.

**Example — good:**

```
feat(webhook): ack fast and defer fulfillment via waitUntil

Providers retry on slow acks. Cold-start latency plus downstream
work in-request risks tripping the timeout, so the handler now:

  1. verifies the signature
  2. inserts the pings row
  3. returns 200
  4. runs fulfillment in ctx.waitUntil

The pings insert stays before the outer try/catch so an error path
always has a row to mark.

Refs STORY-003
```

**Example — bad (don't):**

- `fix stuff`
- `WIP`
- `Update webhook.ts` (says nothing the diff doesn't)
- `Added some changes and refactored a couple of things` (vague +
  past tense)

## Issues — `gh issue create`

A useful issue answers: **what's wrong / what's wanted, what's the
context, what does done look like.**

Body template:

```markdown
## Context
<one paragraph: where this came from, why it matters, link to story id
or spec section if relevant>

## What we want
<the concrete change or behavior — bulleted is fine>

## Acceptance criteria
- [ ] <observable outcome 1>
- [ ] <observable outcome 2>

## Notes
<optional — links, screenshots, related PRs, anything that helps the
person picking this up>
```

Command:

```bash
gh issue create \
  --title "feat(webhook): defer fulfillment via waitUntil" \
  --body "$(cat <<'EOF'
## Context
...
EOF
)"
```

Add labels if the repo uses them (`--label bug`, `--label good-first-issue`).
Add an assignee if known (`--assignee @me`).

## Pull requests — `gh pr create`

A useful PR answers: **what changed, why, how to verify, what could
go wrong.**

Body template:

```markdown
## Summary
- <bullet 1 — the headline change>
- <bullet 2 — the next>
- <bullet 3 — caveats / non-changes>

## Why
<one paragraph: the motivation. Link the story or issue.>

## How to verify
- [ ] <step 1 — a concrete check, ideally a command>
- [ ] <step 2>
- [ ] <step 3>

## Risk / rollback
<what could go wrong, how to revert. "low risk, revert via git revert"
is fine when true.>

Closes #<issue-number, if any>
```

Command (always use a HEREDOC for the body — preserves formatting):

```bash
gh pr create \
  --title "feat(webhook): defer fulfillment via waitUntil" \
  --body "$(cat <<'EOF'
## Summary
- Ack-fast handler returns 200 in <200ms
- Fulfillment moved to ctx.waitUntil
- pings row inserted before any try/catch

## Why
Cold-start + downstream calls risked tripping the provider's webhook timeout.

## How to verify
- [ ] `bun test tests/fast-ack-deferred-fulfillment.spec.ts`
- [ ] Replay a sample webhook event against the local handler

## Risk / rollback
Low — revert via `git revert`. No schema change.

Closes #12
EOF
)"
```

Notes:
- Title follows Conventional Commits, same as a commit summary.
- If the branch isn't pushed, push it first: `git push -u origin HEAD`.
- For draft PRs: `--draft`.
- For PRs targeting a non-default base: `--base <branch>`.

## Sanity rules

- Don't push to `main` with `--force`. Ever.
- Don't `--no-verify` to skip hooks unless explicitly asked.
- Never commit secrets — re-check the diff for `.env`, tokens, keys.
- Never commit large binaries or `node_modules/` — confirm `.gitignore`
  covers them.
- If `git status` shows untracked files you didn't expect, investigate
  before staging — could be the user's WIP.
