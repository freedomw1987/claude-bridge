/**
 * Hermes Agent — core types.
 *
 * One project per Discord thread. The orchestrator (`orchestrator.ts`) drives
 * a project through `planning → executing → judging → done|failed|killed`,
 * persisting state to `data/hermes/projects/<projectId>/state.json` after
 * every transition. All files in this directory are the source of truth —
 * the SQLite `sessions` table only stores a pointer (`threadId`) and the
 * Discord-side lifecycle.
 *
 * State machine (see orchestrator.ts):
 *   planning ──► executing ──► judging ──► done | failed | killed
 *      │            │              │
 *      │            ▼              ▼
 *      └─── failed / killed  failed / killed
 *
 * "executing" can loop back into itself: judge verdict "needs_more" appends
 * new tasks and re-enters the loop. "judging" can also go back to "executing"
 * if a task is added by the judge.
 *
 * Auto-mode timer (ADR-0004):
 *   When `/project setMode auto <duration>` is invoked, a `ProjectTimer` is
 *   attached to the state. The orchestrator's judging boundary checks
 *   `state.timer.expiresAt` on every pass; if past, the project transitions
 *   to `killed` with `killedReason: "duration_expired"`. The `handle` field
 *   is a transient NodeJS Timeout and is NOT serialized.
 */

export type ProjectMode = "auto" | "manual";

export type ProjectStatus =
  | "planning"
  | "executing"
  | "judging"
  | "done"
  | "failed"
  | "killed"
  | "timed_out"; // RG-008: planner LLM call exceeded plannerTimeoutMs (default 15min)

/**
 * Sub-reason for `killed` status. The base state machine has 3 terminal
 * states; "killed" can be reached by 3 different paths and we want to
 * surface *which* path in `/project status` and the journal.
 */
export type KilledReason =
  | "user_kill" // /project kill command
  | "duration_expired" // auto-mode timer fired
  | "manual_switch"; // /project setMode manual cancelled auto-mode

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "failed"
  | "skipped";

export type JournalEntryType =
  | "plan"
  | "task_start"
  | "task_done"
  | "task_fail"
  | "judge"
  | "status"
  | "escalate"
  | "resume"
  | "timer"
  | "adopt";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  attempts: number;
  dependsOn: string[];
  /** Last successful result summary (first ~500 chars of Claude Code output). */
  lastResult?: string;
  /** Last error message if the task failed. */
  lastError?: string;
}

export interface JournalEntry {
  ts: string;
  type: JournalEntryType;
  message: string;
}

export interface HermesRuntimeConfig {
  /** Hard cap on orchestrator iterations (one per task attempt). */
  maxIterations: number;
  /** Hard cap on total cost in USD across all Claude Code runs. */
  maxCostUsd: number;
  /** Hard cap on wall-clock time from project start to completion. */
  maxWallHours: number;
  /** Model used for Hermes's own planner + judge calls. Cheap, hot-loop. */
  hermesModel: string;
  /** Max retries per individual task before marking failed. */
  maxAttemptsPerTask: number;
}

export interface ProjectState {
  id: string;
  threadId: string;
  createdAt: string;
  updatedAt: string;
  /** Original David-supplied goal text. */
  goal: string;
  /** Auto = full autonomous loop; Manual = David approves each task. */
  mode: ProjectMode;
  /** Resolved working directory (cloned repo, local path, or new project). */
  repoPath: string;
  /** Whether this is a new project, a cloned repo, or an existing local dir. */
  repoSource: "new" | "clone" | "local";
  status: ProjectStatus;
  plan: Task[];
  currentTaskId: string | null;
  /** Total orchestrator iterations (one per task attempt). */
  iterations: number;
  /** Running total of USD spent across all Claude Code runs in this project. */
  costUsd: number;
  config: HermesRuntimeConfig;
  startedAt: string;
  endedAt: string | null;
  /** Last judge verdict (for resume / audit). */
  lastVerdict?: JudgeVerdict;
  /** In-memory journal mirror; journal.log is the durable copy. */
  journal: JournalEntry[];
  /**
   * Auto-mode timer (ADR-0004). Set when `/project setMode auto <duration>`
   * is invoked. The `handle` field is process-local and stripped before
   * serialization; `expiresAt` is wallclock ms and is the source of truth.
   */
  timer?: ProjectTimer;
  /**
   * Sub-reason for `killed` status. Null/undefined for non-killed states.
   * Surfaced in `/project status` and the journal entry on transition.
   */
  killedReason?: KilledReason;
  /**
   * Audit trail for `/project adopt` upgrades. Set when an existing
   * plain Claude Code session thread is promoted into a Hermes-managed
   * project. Absent for projects created via `/project start`.
   *
   * We keep this as an optional field rather than a top-level flag so
   * `/project status` and the journal can show "adopted from CC
   * session" history. The orchestrator does not branch on this field
   * — its presence is purely informational.
   */
  adoption?: ProjectAdoption;
  /**
   * Git toplevel of `repoPath` at project-creation time. Populated by
   * `newProjectState` / `adoptProject` (RG-007) and used as the
   * identity key for `/project adopt` collision detection. Two
   * projects with the same `repoRoot` are considered the same project
   * for the purpose of auto-killing superseded projects on adopt.
   *
   * If `repoPath` is not inside a git working tree, this falls back
   * to the absolute path of `repoPath` (see `projectIdentity.ts`).
   */
  repoRoot: string;
  /**
   * Set when a project is auto-killed by a subsequent `/project adopt`
   * on the same `repoRoot` (RG-007). Records the projectId of the
   * superseding project so the kill reason is traceable from the
   * killed state alone. The old state is preserved on disk so a later
   * `/project resume` (or even `/project adopt` from a different
   * thread) can recover it. Set only on the killed (old) side.
   */
  supersededBy?: string;
}

/**
 * Records the provenance of a Hermes project that was upgraded from an
 * existing plain Claude Code session thread via `/project adopt`.
 *
 * Invariants (see docs/REGRESSION-GUARD.md RG-004):
 *  - `fromSession` is always true on a populated record (distinguishes
 *    adopt from `/project start`).
 *  - `adoptedAt` is the ISO-8601 timestamp of the `/project adopt`
 *    invocation that created this project.
 *  - `originalRepoPath` is the working directory the Claude Code
 *    session was using, taken from the SQLite `sessions.repoPath` at
 *    adopt time. We do not promise it's still valid — the user can
 *    move dirs between sessions.
 *  - `originalSessionId` is the Claude Code session UUID that was
 *    active in the thread at adopt time. The orchestrator's executor
 *    resumes this session on the first task so the new Hermes
   *    sub-tasks inherit the conversation context.
 */
export interface ProjectAdoption {
  fromSession: true;
  adoptedAt: string;
  originalRepoPath: string;
  originalSessionId: string;
}

export type JudgeVerdictType = "done" | "needs_more" | "stuck";

export interface JudgeVerdict {
  verdict: JudgeVerdictType;
  reasoning: string;
  /** Tasks to add if verdict === "needs_more". */
  nextTasks?: Task[];
}

/**
 * Auto-mode timer (ADR-0004). Attached to a `ProjectState` when the user
 * runs `/project setMode auto <duration>`. The `handle` is a transient
 * NodeJS Timeout reference — it is intentionally optional and is the only
 * field that should be stripped before `JSON.stringify` and re-hydrated
 * after `JSON.parse` (via `state.ts`'s `loadState` / `saveState` helpers).
 */
export interface ProjectTimer {
  /** Wallclock ms since epoch when the timer should fire. */
  expiresAt: number;
  /** NodeJS Timeout handle. NOT serialized. */
  handle?: ReturnType<typeof setTimeout>;
  /** Original user-requested duration string (e.g. "30m", "1h30m"). */
  requestedDuration: string;
  /** Effective duration in ms (clamped to HERMES_MAX_WALL_HOURS). */
  effectiveMs: number;
  /** True if user_duration > HERMES_MAX_WALL_HOURS and was clamped. */
  clamped: boolean;
}

/** Initial runtime config defaults; overridable via env vars. */
export const DEFAULT_HERMES_CONFIG: HermesRuntimeConfig = {
  maxIterations: 20,
  // 500 cents = $5.00 USD per project. Env var HERMES_MAX_COST_USD.
  maxCostUsd: 500,
  maxWallHours: 4,
  hermesModel: "claude-haiku-4-5",
  maxAttemptsPerTask: 3,
};

/** Build a brand-new project state, ready to be persisted. */
export function newProjectState(input: {
  id: string;
  threadId: string;
  goal: string;
  mode: ProjectMode;
  repoPath: string;
  repoRoot: string;
  repoSource: "new" | "clone" | "local";
  config: HermesRuntimeConfig;
}): ProjectState {
  const now = new Date().toISOString();
  return {
    id: input.id,
    threadId: input.threadId,
    createdAt: now,
    updatedAt: now,
    goal: input.goal,
    mode: input.mode,
    repoPath: input.repoPath,
    repoSource: input.repoSource,
    repoRoot: input.repoRoot,
    status: "planning",
    plan: [],
    currentTaskId: null,
    iterations: 0,
    costUsd: 0,
    config: input.config,
    startedAt: now,
    endedAt: null,
    journal: [
      {
        ts: now,
        type: "status",
        message: `Project created. Mode=${input.mode}, repoPath=${input.repoPath}`,
      },
    ],
  };
}

/** True if the project is in a non-terminal state and should be resumed. */
export function isActive(state: ProjectState): boolean {
  return state.status === "planning"
    || state.status === "executing"
    || state.status === "judging";
}