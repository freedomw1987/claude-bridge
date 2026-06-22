# ADR-0004 — `/project setMode auto <duration>`: Time-Bounded Auto Mode

**Date:** 2026-06-22
**Status:** Proposed (awaiting David sign-off)
**Related:** ADR-0003 (Hermes agent), ADR-0003 §3 (manual mode redesign)

## Context

ADR-0003 introduced Hermes's two-mode design:

- **Manual mode** — goal goes directly to Claude Code, no planning loop.
- **Auto mode** — Hermes plans, executes, judges in a `planning → executing ⇄ judging` state machine.

The current `handleProjectSetMode` (in `src/discord/handlers/hermesCommands.ts`)
is **gated to terminal-state projects only**:

> Cannot change mode while project is `${state.status}`. Use `/project kill`
> first, then start a new project with the new mode.

That gate is correct for *changing* an existing project's mode mid-run
(it would desync the orchestrator's in-memory state from disk). But it
makes David's intended workflow impossible:

> "Let me `setMode auto` to let Hermes agent manage a project for a while
> (the duration is user-set)."

The user-set duration was always the missing piece. Today the only
time-bounded run is the safety cap `HERMES_MAX_WALL_HOURS=4` — a
hard ceiling, not a user-facing affordance.

## Decision

Add a third command form:

```
/project setMode auto <duration>     # "30m" | "2h" | "1d" | "1h30m"
/project setMode manual              # cancel any running auto timer
```

`<duration>` is **optional** when toggling to `auto` (defaults to the
existing `HERMES_MAX_WALL_HOURS` cap as a de-facto bound) and **required
to be absent** when toggling to `manual` (manual has no timer).

### Why duration defaults to the wall-hour cap

The `HERMES_MAX_WALL_HOURS=4` safety cap already exists in
`config.paths.hermesDir` plumbing (ADR-0003 §"Safety caps"). Treating
the user-set duration as a **floor** (always ≤ the safety cap) keeps
the cap meaningful without changing its semantics. We *clamp*:

```
effective_duration = min(user_duration, HERMES_MAX_WALL_HOURS)
```

If the user types `1d` (24h) and the cap is 4h, we run for 4h and
notify the user at start: "⏱ Capped at 4h (the safety cap)."

### Why we relax the active-state gate

The current gate exists because the orchestrator's in-memory state
would desync. The new `setMode auto <duration>` flow avoids that by
**starting the timer at the gate** and **stopping the orchestrator at
the next soft-exit boundary** — both happen at well-defined points in
the state machine:

- **Timer start**: `setTimeout(softExit, durationMs)` is set in
  `handleProjectSetMode` *after* `isActive(state) && new_mode === "auto"`
  is confirmed. Timer is stored in `state.timer` (new field, see below)
  so a bot restart can restore it.
- **Timer fire**: At the next `judging` → verdict transition, the
  orchestrator checks `state.timer?.expiresAt`. If wallclock has
  passed the deadline, the orchestrator sets status to `killed` with
  a new `killedReason: "duration_expired"` and posts a Discord
  message ("⏱ Auto-mode duration elapsed. Project stopped at
  `killing` boundary. Use `/project resume` to continue.").
- **Manual override**: `/project setMode manual` calls
  `clearTimeout(state.timer.handle)` and nulls the timer field.

### Why soft-exit at judge verdict, not at task boundary

We considered two boundaries:

1. **Task boundary** — between `executing` tasks (after `runViaSdk()`
   returns, before picking the next task).
2. **Judge boundary** — after the judge LLM emits its verdict, before
   the next `executing` round.

Judge boundary wins because:

- **It's idempotent**: a task boundary interrupt would force us to
  mark the in-flight task as "interrupted" and the next resume would
  need to either retry or skip it. The judge boundary always sees a
  consistent state because judge is *between* the executing loop and
  the verdict.
- **It's cheaper**: the timer check is one `Date.now()` comparison
  per judge pass (typically every 1-5 tasks), not per task.
- **The state machine already checks user intent at judge**: ADR-0003
  describes the judge transition as the natural place to decide
  `done | needs_more | stuck`. Adding `| duration_expired` follows the
  same shape.

The trade-off: a long Claude Code task (e.g. 10min `runViaSdk()`)
that finishes *after* the timer fires will still run to completion
before the judge boundary is reached. We surface this in the start
message: "⏱ Will stop at next judge pass after `<expiresAt>` (any
in-flight Claude Code task will finish first)."

### Timer field in `ProjectState`

Add to `src/hermes/types.ts` `ProjectState`:

```typescript
interface ProjectTimer {
  /** Wallclock ms since epoch when the timer should fire. */
  expiresAt: number;
  /** Node Timeout handle (transient, NOT serialized). */
  handle?: NodeJS.Timeout;
  /** Original user-requested duration string (e.g. "30m"). */
  requestedDuration: string;
  /** Whether the timer was clamped to HERMES_MAX_WALL_HOURS. */
  clamped: boolean;
}

interface ProjectState {
  // ... existing fields ...
  timer?: ProjectTimer;
}
```

`handle` is intentionally not serialized — it's a process-local
reference. On bot restart, we re-create it from `expiresAt` if the
project is non-terminal and `state.timer` is set (see "Resume on
restart" below).

### State machine extension

```
   planning ──► executing ──► judging ──► done | failed | killed
                                       ▲
                                       │
                              ┌────────┴────────┐
                              │ timer fired     │
                              │ at judge pass   │
                              │ → killed        │
                              │   reason:       │
                              │   "duration     │
                              │    expired"     │
                              └─────────────────┘
```

`done` and `duration_expired` are now distinct terminal states:

- `done` — judge verdict: goal achieved.
- `failed` — error or stuck verdict.
- `killed` — `/project kill` OR `duration_expired` OR `manual` switch.

This keeps ADR-0003's `isActive` / `isTerminal` predicates intact
(only `done | failed | killed` are terminal; `duration_expired` is a
subtype of `killed`).

### `setMode` UX details

| User types | Result |
|---|---|
| `setMode auto 30m` | Start auto mode with 30-min timer (clamped to cap if needed) |
| `setMode auto 1d` | Reject with `⏱ Max duration is 4h (HERMES_MAX_WALL_HOURS)` |
| `setMode auto` | Default to `HERMES_MAX_WALL_HOURS` value (e.g. 4h) |
| `setMode auto invalid` | Reject with `⏱ Cannot parse duration: "invalid"` |
| `setMode manual` (project is auto) | Cancel timer, switch to manual, orchestrator aborts current judge pass |
| `setMode manual` (project is manual) | No-op, reply "Project is already in \`manual\` mode." |
| `setMode auto 30m` (project is already auto with timer) | Replace existing timer; reply "⏱ New timer: 30m from now." |

### Resume on bot restart

In `src/index.ts`'s `resumeActiveProjects` (post-`client.login`),
extend the resume logic to:

1. For each non-terminal project, check `state.timer?.expiresAt`.
2. If set and `expiresAt > Date.now()`, recreate the
   `setTimeout(softExit, expiresAt - Date.now())`.
3. If `expiresAt <= Date.now()`, immediately call `softExit(projectId)`
   and mark the project `killed` with reason `duration_expired`.
4. Post a "🔄 Hermes project resumed (timer: Xm remaining)" message.

### Duration parser

A small `parseDuration(s: string): number | null` helper in
`src/hermes/duration.ts`:

| Input | Output (ms) |
|---|---|
| `"30m"` | 1,800,000 |
| `"2h"` | 7,200,000 |
| `"1d"` | 86,400,000 |
| `"1h30m"` | 5,400,000 |
| `"90s"` | 90,000 |
| `""` | null (caller decides default) |
| `"foo"` | null |

Strict format: digits + unit (`s`/`m`/`h`/`d`), no spaces, units in
descending order. Test cases in `duration.test.ts`.

### Status embed integration

`formatStatusEmbed` (in `src/hermes/discord.ts`) gets a new field:

```
🪪 Hermes:
  Status: executing (task 3/5)
  Mode: auto (timer: 23:14 remaining)  ← new
  Iterations: 7/20
  Cost: $1.23 / $5.00
  Wall-clock: 47m / 4h
```

The "timer" line is omitted when `state.timer` is unset.

## Implementation

| File | Change | Lines (est) |
|------|--------|-------------|
| `src/hermes/duration.ts` | New: `parseDuration` | ~40 |
| `src/hermes/duration.test.ts` | New: parser test cases | ~60 |
| `src/hermes/types.ts` | Add `ProjectTimer` to `ProjectState` | +15 |
| `src/hermes/state.ts` | Persist `timer` (without `handle`) in `state.json`; re-hydrate on `loadState` | +20 |
| `src/hermes/orchestrator.ts` | At `judging → verdict` transition, check `state.timer.expiresAt`; if past, `killed` w/ reason | +25 |
| `src/hermes/orchestrator.ts` | New `softExit(projectId)` exported helper | +30 |
| `src/index.ts` | `resumeActiveProjects` recreate `setTimeout` from persisted `expiresAt` | +20 |
| `src/discord/handlers/hermesCommands.ts` | `matchSetMode` accepts optional duration arg | +5 |
| `src/discord/handlers/hermesCommands.ts` | `handleProjectSetMode`: parse duration, clamp to cap, set/clear timer, branch on mode | +60 |
| `src/discord/handlers/hermesCommands.ts` | Update `setMode auto` gate: allow active projects when going to `auto`, but only with timer | +15 |
| `src/hermes/discord.ts` | `formatStatusEmbed` add timer line | +10 |
| `docs/operations/0004-setmode-auto-duration.md` | This ADR | — |
| `docs/PRD.md` | Note `setMode auto <duration>` as user-facing affordance | +5 |
| `docs/ARCHITECTURE.md` | Update state-machine diagram; add `duration_expired` branch | +10 |
| `docs/MILESTONES.md` | Add Phase 1.5 entry | +10 |
| `docs/taskboard.md` | Add Phase 1.5 status section | +10 |

**Total: ~335 lines, 2 new files, 8 modified.**

## Verification

- ✅ `bun run typecheck` passes
- ✅ `bun test` passes (existing 182 + ~20 new tests)
- ✅ Manual E2E (live Discord):
  1. `/project start in /tmp/foo "create hello.txt"` (manual default)
  2. `/project setMode auto 1m` — timer starts, status shows `timer: 0:59`
  3. Wait 70s, observe `⏱ Auto-mode duration elapsed` message at next judge pass
  4. `/project status` shows `killed` with reason `duration_expired`
  5. `/project resume` — orchestrator restarts, **without** the old timer
  6. `/project setMode auto 2s`, then `/project setMode manual` — timer cancelled, status shows no timer line

## Why not just `--duration` on `/project start`?

Two reasons:

1. **`setMode auto <duration>` matches the natural mental model**: David
   already uses `setMode` to flip modes; adding a duration to the
   existing affordance is a one-line regex change, whereas adding
   `--duration` to `parseStartArgs` requires plumbing the value all
   the way through `newProjectState` and into the orchestrator's
   initial timer setup.
2. **Re-toggling is a real use case**: a user might start in manual,
   watch a few Claude Code replies, then realize they want autonomous
   mode for the next hour. The current `parseStartArgs` doesn't
   support that — they'd have to `/project kill` and re-`start`.
   `setMode auto <duration>` covers that flow with one command.

We can still add `--duration` to `parseStartArgs` later as a
shorthand for "start in auto with this timer", but the primary
surface is `setMode auto <duration>`.

## Out of scope (deferred)

- **Per-task timer** (e.g. "give me 5m on this task before judging")
  — only project-level timer in v1.
- **Timer notifications** ("⏱ 5m remaining" warning at 75% and 90% of
  duration) — could be added via a Discord webhook in the
  `softExit` boundary check.
- **Auto-extension** ("if judge verdict is `needs_more` and timer
  is at 80% of budget, auto-extend by 50%") — explicitly rejected in
  this ADR; user can `/project setMode auto <new-duration>` instead.
- **Multi-project concurrent timers** — handled by the existing
  per-project orchestrator; no shared state.

## Follow-up migration / rollback

Purely additive. Rollback:

```bash
rm -f src/hermes/duration.ts src/hermes/duration.test.ts
git revert <0004-commit>
```

No SQLite migration. The `state.json` schema adds a new optional
field `timer`; older state files load fine (TypeScript treats
`timer` as `ProjectTimer | undefined`).

## Acceptance checklist (for sign-off)

- [ ] `<duration>` format: `30m` / `2h` / `1d` / `1h30m` (verified in `duration.test.ts`)
- [ ] Soft-exit at judge boundary (not task boundary)
- [ ] `done | failed | killed | duration_expired` all terminal
- [ ] `setMode manual` cancels the timer
- [ ] Bot restart recreates timer from `expiresAt` (with offset for elapsed time)
- [ ] Status embed shows `timer: M:SS remaining` when active
- [ ] Start message tells user the clamped cap if `1d` requested with 4h cap
- [ ] `/project resume` after `duration_expired` does NOT restore the old timer
