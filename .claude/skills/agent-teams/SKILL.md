---
name: agent-teams
description: >-
  How to orchestrate Claude Code's experimental Agent Teams — spawning
  teammates as separate sessions, delegating work to them, and waiting for
  results instead of doing the work yourself in the main thread. Use whenever a
  task should run as parallel/independent workstreams: multi-file refactors,
  reviewing or auditing many modules at once, exploring competing approaches or
  hypotheses, research from several angles, or any "do A, B, and C in parallel"
  / "spin up a team" / "have agents work on this" request. Also use to recall
  the enable flag, teammate-mode config, coordination tools (SendMessage, task
  list), hooks, and the delegate-don't-implement orchestration pattern, and to
  avoid the anti-pattern of running everything sequentially in the lead session.
---

# Agent Teams orchestration

Claude Code's experimental Agent Teams coordinates **multiple Claude Code
sessions**. The session that creates the team is the **lead** (you, here);
**teammates** are separate sessions with their own full context windows that
message each other directly and pull work off a shared task list.

This differs from **subagents** (the `Agent` tool): subagents run inside one
session and only report back to their parent. Teammates are peers — they
coordinate through a shared mailbox and task list, and self-claim work.

## The one rule this skill exists to enforce

**Delegate and wait. Do not implement the parallel work yourself in the lead
session.** When a task decomposes into independent streams, the lead's job is
to spawn teammates, assign/seed tasks, monitor, and synthesize — *not* to write
module A then module B then the tests sequentially. If you catch yourself doing
the work, stop and delegate it.

- ❌ Anti-pattern: "Write the auth module, then the API, then the tests" → lead
  does all three in order.
- ✅ Pattern: spawn 3 teammates (auth / API / tests), assign clear tasks, then
  **wait for all to finish before synthesizing**.

If asked to proceed and teammates aren't done: do not start doing their work —
wait, or steer them.

## Preflight — is it enabled?

Agent Teams is **off by default** and needs **Claude Code v2.1.32+**. It
requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (env or `settings.json`
`env`). If a request clearly wants a team but the feature may be off, **check
first and tell the user how to enable it** rather than silently falling back to
doing everything solo:

```json
// ~/.claude/settings.json
{
  "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" },
  "teammateMode": "auto"   // "auto" | "in-process" | "tmux"
}
```

`teammateMode`: `auto` (split panes if in tmux, else in-process), `in-process`
(cycle with Shift+Down), `tmux` (needs tmux/iTerm2; one pane per teammate).
Per-session override: `claude --teammate-mode in-process`. Teammate model is
set via `/config` → "Default teammate model" (does not inherit `/model`).

## How to spawn and run a team (what the lead does)

Spawn in natural language; name teammates so you can reference them later:

```text
Create an agent team to <goal>. Spawn:
- "<name-1>" to <scoped deliverable, own files>
- "<name-2>" to <scoped deliverable, own files>
- "<name-3>" to <scoped deliverable, own files>
Have them work in parallel. Wait for all to finish, then I'll synthesize.
```

- **Use a subagent definition as a teammate:** "Spawn a teammate using the
  `security-reviewer` agent type to audit the auth module." Its `tools`
  allowlist and `model` apply; its body is appended to the system prompt. Team
  coordination tools are always available regardless of `tools`. `skills` and
  `mcpServers` from the definition are **not** applied (teammates load those
  from project/user settings).
- **Approval gate:** "Require plan approval before they make changes." Teammate
  plans in read-only mode → sends plan to lead → lead approves/rejects.
- **Give context:** teammates do NOT inherit the lead's conversation. Put
  task-specific detail in the spawn prompt; rely on `CLAUDE.md` in their cwd.
- **Assignment:** either assign explicitly (`Assign the migration to
  @db-expert`) or let teammates self-claim the next unblocked task.

## Coordination tools (always available to teammates)

`SendMessage` (message a named teammate or the lead), `ListTeammates`,
`CreateTask`, `ListTasks`, `UpdateTaskStatus`, `GetTaskContext`. Task states:
`pending` → `in-progress` → `completed`; dependencies auto-unblock; claiming is
file-locked against races. Messages and idle notifications are delivered
automatically — **the lead does not poll**.

Navigation: **Shift+Down** cycle teammates · **Ctrl+T** task list · **Esc**
interrupt current turn.

## Quality gates (hooks in `settings.json`)

`TeammateIdle`, `TaskCreated`, `TaskCompleted` — exit code **2** to block the
action and send feedback (e.g. reject a task with no test coverage, keep an
idle teammate working).

## Sizing & boundaries

- 3–5 teammates for most work; >5–6 = coordination overhead.
- ~5–6 tasks per teammate; tasks self-contained with clear deliverables.
- **Each teammate owns separate files/modules** — concurrent edits to the same
  file overwrite each other.
- Avoid deep dependency chains (idle time). Good first uses: PR review, bug
  investigation, library research, competing approaches.

## Gotchas

- No nested teams; teammates can't spawn teammates. One team per lead at a
  time. Lead is fixed for the team's lifetime.
- `/resume` and `/rewind` don't restore in-process teammates.
- Task status can lag (teammate forgets to mark complete, blocking deps) —
  check `ListTasks` and fix manually if a team stalls.
- Pre-approve common ops in `/permissions` before spawning (teammates start
  with the lead's permission mode).
- **Cleanup runs from the lead only**, never a teammate. Clean up the team
  before starting another. Kill orphaned tmux sessions manually (`tmux ls` →
  `tmux kill-session -t <name>`).

## Reference

- `references/orchestration.md` — full verbatim config keys, spawn-prompt
  recipes, the delegate-vs-implement decision checklist, file/storage
  locations, and the limitations table.

Source: official docs — https://code.claude.com/docs/en/agent-teams
