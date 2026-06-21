# ADR-0003 — Hermes Agent: Autonomous Project Manager

**Date:** 2026-06-22
**Status:** Accepted
**Related:** ADR-0001 (silent death), ADR-0002 (memory leak), ADR-0003 (this)

## Context

`claude-bridge` has historically been a 1-shot bridge: David mentions `@bot`
in a Discord channel, the bot spawns Claude Code, the response streams back,
and the thread goes idle. Each mention is a fresh task with no memory of
what came before.

For non-trivial development work — building a complete CLI app, refactoring
a subsystem across multiple files, running tests until green — this model
breaks down:
- David has to decompose the goal into N messages himself
- David has to track which steps succeeded
- David has to babysit long-running tasks
- There is no "project" concept; only individual @bot invocations

The `hermes-developer-profile` directory (created 2026-06-06) already
explored a similar idea for a single-developer hermes assistant with
`dev-task-state.md` as the persistent state. We build on that mental model
but adapt it to the Discord-bridge context.

## Decision

Add a **three-tier autonomous agent** to `claude-bridge`:

```
        David (董事長) — sets direction, approves direction changes
              ↓ /project start "<goal>"
        Hermes Agent (PM) — plans, tracks, judges
              ↓ invokes runViaSdk() per task
        Claude Code (工程師) — writes code, runs tests
              ↓
        Deliverable → David (via Discord thread)
```

Hermes runs **inside the claude-bridge process** as a new module
(`src/hermes/`). It uses the same Discord client, the same SDK runner,
and the same SessionStore as the existing 1-shot path. The two modes
coexist:

- **Manual mode (existing)**: David mentions `@bot` directly.
- **Auto mode (new)**: David types `/project start "goal"` to spin up
  a long-lived project thread that Hermes drives autonomously.

### State persistence

Each project = one directory under `<hermesDir>/projects/<projectId>/`:

```
state.json     # machine-readable, atomic-rewritten on every transition
plan.md        # human-readable plan, written once after LLM planning
journal.log    # append-only decision log (more detailed than state.journal)
artifacts/     # placeholder for completed-project deliverable manifests
```

`state.json` uses write-to-tmp + rename for atomicity so a bot crash
mid-write cannot corrupt state. The on-disk directory is the **only**
source of truth — we do **not** store Hermes state in `sessions.db`
(SQLite). This was a deliberate choice from David's three options:
"Standalone (本地狀態檔)".

### The orchestrator state machine

```
   planning ──► executing ──► judging ──► done | failed | killed
      │            │  ▲           │
      │            ▼  │           │
      │         (judge verdict    │
      │          "needs_more")    │
      │                           │
      └──── failed / killed ◄─────┘
```

- **planning**: Hermes (LLM call) decomposes the goal into 3-10 tasks.
- **executing**: For each task with satisfied `dependsOn`, Hermes calls
  `runViaSdk()` to invoke Claude Code. On error, the task is retried up
  to `maxAttemptsPerTask` (default 3); after that, the project is
  marked `failed` and David is notified.
- **judging**: When all tasks are done, Hermes (LLM call) self-assesses
  whether the goal is met. Verdicts: `done`, `needs_more` (with new
  tasks appended), or `stuck` (escalate).

### Model selection

Hermes's own planner and judge calls use **`claude-haiku-4-5`** by
default (configurable via `HERMES_MODEL`). These calls run in a hot
loop (once per project start + once per judge pass), so we use a
cheaper model. The actual code-writing is done by Claude Code via the
existing `runViaSdk()`, which uses the default `claude-sonnet-4-6`.

### Safety caps (per project)

| Cap | Default | Env var |
|-----|---------|---------|
| Max iterations | 20 | `HERMES_MAX_ITERATIONS` |
| Max cost (cents) | 500 ($5.00) | `HERMES_MAX_COST_USD` |
| Max wall-clock (hours) | 4 | `HERMES_MAX_WALL_HOURS` |
| Max attempts per task | 3 | `HERMES_MAX_ATTEMPTS_PER_TASK` |

Cost is tracked in **cents** (integer math) to avoid float comparison
issues. Display layer divides by 100 for human-readable dollars.

When any cap is exceeded mid-iteration, the project is marked `failed`
and a Discord escalation message is posted. David's `/project kill`
flips the state to `killed` between iterations.

### Resume on bot restart

`HERMES_RESUME_ON_STARTUP=1` (default) enables automatic resume of any
non-terminal project on bot startup. The resume flow:
1. Scan `<hermesDir>/projects/` for non-terminal projects.
2. For each, look up the Discord thread via `client.channels.fetch()`.
3. If found, re-fire the orchestrator with the persisted state.
4. If the thread is no longer in the cache (archived, deleted), log a
   warning and skip — the project stays in its last-known state.

This was a non-obvious design choice; we considered making resume
manual-only (David types `/project resume` in each thread) but that
defeats the point of "fire and forget" autonomy. The trade-off: an
archived-then-reopened thread may surprise David with reanimation.
We mitigate by always posting a "🔄 Hermes project resumed" message
when resume kicks in.

### Discord interface

New text commands (regex-matched like the existing `/kill`, `/status`):

| Command | Where | Purpose |
|---------|-------|---------|
| `/project start [--mode=auto\|manual] [--flags] "goal"` | channel | Start new project |
| `/project start in <path> [--flags] "goal"` | channel | Start in local path |
| `/project list` | anywhere | List all projects |
| `/project status` | thread | Show current state |
| `/project plan` | thread | Show the plan.md |
| `/project kill` | thread | Mark project killed |
| `/project resume` | thread | Re-run a killed/failed project |

All Hermes messages are prefixed with `🪪 Hermes:` so David can
distinguish them from Claude Code's engineering output in the same
thread.

### Why standalone, not pm-system integration

Three options were offered:
- A. Reuse `pm-system` (existing PM tool with multi-role + AI agent)
- B. Standalone (this ADR)
- C. Both

David chose **B**. Reasons honored:
- `pm-system` is a separate system with its own auth, DB, and
  deployment story. Coupling Hermes to it would require Hermes to
  handle pm-system credentials and network failures.
- Hermes's state model is simpler than pm-system's: one goal in,
  N tasks out, no multi-user, no role-based access.
- Rollback = `rm -rf src/hermes/`. No external state to clean up.

We can revisit this in Phase 2 if David wants Hermes tasks to appear
in the pm-system dashboard.

## Implementation

Twelve new files under `src/hermes/` and `src/discord/handlers/`:

| File | Lines | Purpose |
|------|-------|---------|
| `src/hermes/types.ts` | ~150 | `ProjectState`, `Task`, `JournalEntry`, `HermesRuntimeConfig` |
| `src/hermes/state.ts` | ~150 | Atomic file I/O, journal append, project listing |
| `src/hermes/planner.ts` | ~150 | LLM goal decomposition (Haiku) |
| `src/hermes/judge.ts` | ~150 | LLM self-assessment (Haiku) |
| `src/hermes/executor.ts` | ~100 | Wraps `runViaSdk()` with task semantics |
| `src/hermes/orchestrator.ts` | ~280 | Main state machine + resume |
| `src/hermes/discord.ts` | ~110 | Discord embed/format helpers |
| `src/hermes/state.test.ts` | ~200 | Atomic I/O, journal, listing tests |
| `src/hermes/orchestrator.test.ts` | ~140 | `pickNextTask` + `shouldStop` logic |
| `src/discord/handlers/hermesCommands.ts` | ~340 | All command handlers + dispatch |
| `src/discord/handlers/hermesCommands.test.ts` | ~110 | Command matcher + arg parser tests |
| `docs/operations/0003-hermes-agent.md` | this | |

Plus 4 modified files:

- `src/config.ts`: +6 new config keys (`hermes.*`, `paths.hermesDir`)
- `.env.example`: +new section
- `src/index.ts`: +5 lines for `resumeActiveProjects` after `client.login`
- `src/discord/handlers/messageCreate.ts`: +10 lines to dispatch `/project`

**Total: ~1900 lines, 12 new files, 4 modified.**

## Verification

- ✅ `bun run typecheck` passes
- ✅ `bun test` passes 182/182 (138 existing + 44 new Hermes tests)
- Manual E2E (deferred to follow-up; not run in this pass because
  /project requires a live Discord token to exercise the full loop)
  - Smoke: `/project start in /tmp/foo "create hello.txt"` → 1 task
  - Multi-task: `/project start in /tmp/foo "build CLI with 3 commands and tests"`
  - Safety: `/project start --max-iterations=2 "impossible goal"` → escalate
  - Resume: kill bot mid-execution, restart → orchestrator resumes

## Future work (out of scope for Phase 1)

These are explicitly **deferred**:

- **Multiple parallel projects**: Phase 1 runs one project at a time
  (resumed projects fire async, but no explicit concurrency control).
  Phase 2 should add a semaphore around `runProject()`.
- **pm-system integration**: see "Why standalone" above.
- **Git branch per task**: Each task could create a branch; final
  completion would open a PR. Useful for code review but adds
  significant complexity.
- **Hermes that learns from past projects**: A simple version would
  be to embed the last 3 projects' state.json into the planner
  prompt. Defer until we have ≥10 historical projects to learn from.
- **Web dashboard**: For now, Discord is the only UI. A web view
  of project state would be nice but is not needed for v1.
- **Resume across Discord server moves**: If David moves the bot to
  a new server, in-flight projects cannot resume (thread IDs change).
  This is acceptable for now.

## Follow-up changes (post-ADR)

### 3. Manual mode redesign (2026-06-22, late)

**Original intent (this ADR):** manual mode means per-task approval —
Hermes plans N tasks and waits for the Chairman's `go` / `skip` /
`abort` reply before each one.

**Revised intent (after David clarified):** manual mode means "skip
the Hermes planning loop entirely" — the goal is passed directly to
Claude Code as a single prompt, the same flow as the original
`@bot <prompt>` mention. Chairman just watches Claude Code work and
can interrupt with `/project kill`.

**Code changes:**

- **Added `runManualProject`** in `src/hermes/orchestrator.ts`:
  - Single `runViaSdk(state.goal)` call (same as the existing
    `@bot` flow via `forwardToClaude`)
  - Typing indicator for the whole run
  - State transitions: `executing` → `done | failed`
  - No planning, no per-task approval, no judge
- **Modified `runProject`**: when `state.mode === "manual"`, dispatch
  to `runManualProject`. This is the single switch — both
  `handleProjectStart` and `handleProjectResume` route through
  `runProject` and get the right behavior.
- **Modified Hermes thread consume gate** in
  `src/discord/handlers/hermesCommands.ts`:
  - **Before**: any message in a Hermes thread was consumed (did not
    fall through to `forwardToClaude`).
  - **After**: consume only if `mode === "auto" && isActive(state)`.
    Manual-mode threads (and any terminal-state thread) let messages
    fall through so David's follow-ups resume the Claude Code session
    via the existing `forwardToClaude` flow.
- **Removed** `parseApprovalReply`, `waitForManualApproval`, and the
  per-task approval gate in `runOneTask` (no longer relevant).
- **`handleProjectSetMode`** now refuses to change mode on active
  projects (must `/project kill` first).

**Why the redesign:** the original per-task approval UX added friction
without clear value. David (the Chairman) just wants to either
"trust Hermes to figure it out" (auto) or "tell Claude Code exactly
what to do" (manual). The third option ("Hermes plans, I approve each
step") was unused.

**Tests:** removed 6 `parseApprovalReply` tests (function gone); added
4 `manual mode dispatch` tests verifying the gate logic and the
`isActive` contract.

### 1. `@bot /project start` mention handling — regression fix

**Symptom:** Typing `@bot /project start "幫我完成 aged-system 項目"`
in Discord returned `❌ Invalid path: does not exist: /project start`.

**Root cause:** Discord replaces `@bot` with `<@userId>` in message
content. The first version of `isProjectCommand` matched against
`/^\/project\b/i.test(msg.content.trim())` — which only matched
when the message **started with** `/project`. With the mention
prefix, it didn't match, so control fell through to the legacy
`parseMention` flow. `parseMention` saw the leading `/` and
interpreted `/project start` as an absolute local path.

**Fix:** In `src/discord/handlers/messageCreate.ts`, strip the
leading `<@id>` mention from `msg.content` **before** checking
for the `/project` prefix. The cleaned content is then passed
to `dispatchHermesCommand`. The matchers themselves don't need
to know about mentions — the dispatcher is the single point of
truth for routing.

```typescript
const mentionStripped = msg.content.trim().replace(/<@!?\d+>\s*/g, "").trim();
if (/^\/project\b/i.test(mentionStripped)) {
  const handled = await dispatchHermesCommand(mentionStripped, {...});
  if (handled) return;
}
```

**Why at the dispatcher, not the matchers:** Adding `stripMention`
inside `hermesCommands.ts` was considered but rejected — the central
dispatcher is the cleaner place to handle Discord's mention format
because it's the single entry point for all messages. The matchers
stay focused on "is this a /project command" without knowing about
Discord specifics. ADR-0001 makes the same point about central
dispatcher clarity.

**Regression test:** `hermesCommands.test.ts` documents the
contract — the matchers expect mention-stripped input, and the
messageCreate dispatcher is responsible for stripping.

### 2. Typing indicator for the whole orchestrator run

**Symptom:** During a long-running Hermes project, the Discord
thread looked idle between status messages. Hard to tell if
Hermes was still working or stuck.

**Fix:** New `src/hermes/typing.ts` — a `TypingIndicator` class
that calls `thread.sendTyping()` immediately and then refreshes
every 8 seconds (Discord typing expires at 10s, so 8s is the
safe refresh interval). The orchestrator's `runProject` is
wrapped in `try/finally`:

```typescript
const typing = new TypingIndicator(deps.thread);
typing.start();
try {
  // ... planning, executing, judging ...
} finally {
  typing.stop();
}
```

**Coverage:** The indicator is on for the entire orchestrator
run — planner LLM call, waiting on Claude Code, judge LLM call,
and any idle time between tasks. Even if Claude Code is also
calling its own `discord_typing` tool (MCP), Hermes's loop keeps
the indicator visible during gaps. The interval is `unref()`'d
so a leaked indicator can never keep the bot process alive.

**Test:** `src/hermes/typing.test.ts` (8 tests) covers the
lifecycle: start, stop, idempotency, post-stop no-op,
silently-swallows-errors, and `isActive` state.

## Migration / rollback

Purely additive. Rollback procedure:
```bash
rm -rf src/hermes/ src/discord/handlers/hermesCommands.ts
rm src/hermes/*.test.ts
git revert <hermes-commit>
```

The existing `@bot` flow is untouched. No SQLite migration. No env
var conflicts (new `HERMES_*` keys are namespaced).
