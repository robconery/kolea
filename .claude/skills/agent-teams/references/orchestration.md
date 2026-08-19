# Agent Teams — full reference

Source of truth: https://code.claude.com/docs/en/agent-teams (experimental).

## Decision checklist — should this be a team?

Run this before starting any non-trivial task. If ≥2 boxes are true, spawn a
team; do not do the work serially in the lead.

- [ ] The work splits into 2+ streams that can progress independently.
- [ ] Streams touch **different** files/modules (no shared-file write
      contention).
- [ ] Each stream has a clear, self-contained deliverable.
- [ ] Total work is large enough that serial execution wastes wall-clock time,
      OR the value is in **parallel/competing perspectives** (review, research,
      devil's advocate, multiple hypotheses).

If a team is warranted but you find yourself editing files directly: **stop**,
spawn the team, and convert what you were about to do into task assignments.

When NOT to use a team: a single linear change, tightly coupled edits to one
file, or anything where coordination overhead exceeds the parallelism gained —
use the `Agent` tool (subagents) or just do it inline.

## Subagents vs. Agent Teams

| | Subagents (`Agent` tool) | Agent Teams |
|---|---|---|
| Topology | Parent → child, child reports back | Peers + a lead |
| Context | Child summarizes to parent | Independent full sessions |
| Comms | One-shot result | `SendMessage` mailbox, shared task list |
| Work pickup | Assigned by parent | Self-claim from task list |
| Nesting | Parent spawns children | No nested teams |
| Use for | Scoped lookup/research/one task | Sustained parallel multi-stream work |

## Enable / config (verbatim)

- Env var: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` = `1`
- Version: Claude Code **v2.1.32+** (`claude --version`)
- `settings.json` keys: `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`,
  `teammateMode` (`"auto"` | `"in-process"` | `"tmux"`)
- CLI flag: `claude --teammate-mode in-process`
- Model: `/config` → **"Default teammate model"** (else leader's model;
  teammates do NOT inherit `/model`)
- Split panes need tmux or iTerm2 — not VS Code terminal, Windows Terminal, or
  Ghostty.

## Storage / file locations

- `~/.claude/teams/{team-name}/config.json` — `members` array (name, agent ID,
  agent type). Claude-managed; do not hand-edit.
- `~/.claude/tasks/{team-name}/` — shared task list storage.

## Coordination tools

Always available to every teammate, even if a subagent definition's `tools`
allowlist is restrictive:

- `SendMessage` — message a named teammate or the lead.
- `ListTeammates` — active teammates.
- `CreateTask` — add to the shared task list.
- `ListTasks` — all tasks + status.
- `UpdateTaskStatus` — mark in-progress / completed.
- `GetTaskContext` — context for a specific task.

Mechanics: states `pending → in-progress → completed`; dependency-blocked tasks
auto-unblock when deps complete; claiming uses file locks against races;
messages + idle notifications delivered automatically (lead never polls).

## Keyboard

- **Shift+Down** — cycle teammates ↔ lead (in-process)
- **Enter** — view a teammate's full session
- **Escape** — interrupt current agent's turn
- **Ctrl+T** — toggle task list

## Hooks (quality gates, in `settings.json`)

- `TeammateIdle` — fires before a teammate goes idle. Exit `2` → send feedback,
  keep it working.
- `TaskCreated` — fires on task creation. Exit `2` → block + feedback.
- `TaskCompleted` — fires on completion. Exit `2` → block + feedback.

Example (reject tasks lacking test coverage), referenced from settings.json:

```bash
if ! grep -q "test" <<< "$TASK_DESCRIPTION"; then
  echo "All tasks must include test coverage"
  exit 2
fi
```

## Spawn-prompt recipes

Parallel build (independent files):

```text
Create an agent team to implement the notifications feature. Spawn:
- "model-dev": write src/notifications/model.ts (types + persistence). Tests in
  the same dir. Do not touch src/api or src/web.
- "api-dev": write src/api/notifications.ts (endpoints). Depends on model-dev's
  types — claim only after the model task is complete.
- "web-dev": write src/web/NotificationBell.tsx. Mock the API client.
Work in parallel respecting the dependency. Wait for all, then I synthesize.
```

Parallel review (read-only, competing lenses):

```text
Create an agent team to review PR #142. Spawn:
- "security-reviewer" — auth, input validation, secrets
- "perf-reviewer" — hot paths, N+1s, allocations
- "test-reviewer" — coverage and edge cases
Each reports findings via SendMessage to me. No code changes.
```

Architecture / research (divergent perspectives):

```text
Create an agent team to evaluate moving from REST to tRPC. Spawn:
- "advocate" — strongest case for the migration
- "skeptic" — risks, migration cost, what breaks
- "pragmatist" — incremental path if we did it
Have them debate via SendMessage, then summarize to me.
```

With a subagent definition + approval gate:

```text
Spawn a teammate using the security-reviewer agent type to audit src/auth.
Require plan approval before any changes.
```

Steering an under-delegating lead (say this to yourself or the user prompts it):

> Wait for your teammates to complete their tasks before proceeding.

## Sizing heuristics

- 3–5 teammates typical; >5–6 → coordination overhead dominates.
- ~5–6 tasks per teammate. Too small → coordination overhead; too large → no
  check-ins, wasted effort on wrong approach.
- Prefer shallow dependency graphs; deep chains create idle teammates.
- Best early use cases: PR review, bug investigation, library research,
  competing-approach exploration — clear boundaries, low write contention.

## Limitations (experimental)

| Limitation | Consequence / mitigation |
|---|---|
| No nested teams | Only the lead spawns teammates. |
| One team per lead | Clean up before creating another. |
| Fixed lead | Can't promote a teammate; lead is lead for the team's life. |
| `/resume` & `/rewind` | Don't restore in-process teammates; lead may message ghosts. |
| Task status lag | Teammates may not mark complete → deps stuck. Check `ListTasks`, fix manually. |
| Slow shutdown | Teammates finish current request/tool call before exiting. |
| Permissions at spawn | All start with lead's permission mode; adjust per-teammate after. |
| Same-file edits | Concurrent writers overwrite each other — partition files. |
| Error stalls | A teammate may stop instead of recovering — instruct it or spawn a replacement. |
| Cleanup | Run from the lead only; never from a teammate. |
| Orphaned tmux | `tmux ls` → `tmux kill-session -t <name>`. |
| Token cost | Scales with active teammates — materially higher than one session. |
