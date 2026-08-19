## What this changes

<!-- One or two sentences. What's different after this merges? -->

## Why

<!-- The problem, not the patch. Link an issue if there is one. -->

## Effect on the three consent scopes

<!--
  Required if this touches src/core/{consent,sending,sequences,broadcasts}.ts.
  Consent here is *scoped* — leaving one sequence must never remove someone from
  the newsletter, and only an explicit "leave everything", a hard bounce, or a
  complaint may write a global suppression.

  Write "none" if this change can't affect any of them.
-->

- **Sequence** (`sequence_optouts`):
- **Broadcast** (`subscribers.status`):
- **Global** (`suppressions`):

## Verification

- [ ] `bun run typecheck` is clean
- [ ] `bun run smoke` passes (if the editor or client bundle changed)
- [ ] Exercised locally against seeded data with `EMAIL_PROVIDER=console`
- [ ] `docs/SPEC.md` updated if observable behavior changed
- [ ] Migration generated with `bun run db:generate`, not hand-written (if the schema changed)

<!-- Say what you actually ran. "Sent a broadcast to the 12 seeded subscribers and
     confirmed the two who left sequence 2 still received it." -->

## Risk

<!--
  What breaks if this is wrong, and how would you notice? Sending code is
  irreversible in a way most code isn't — a bad broadcast can't be recalled, and
  a wrong PUBLIC_URL is baked into mail that's already delivered.
-->
