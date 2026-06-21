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
 */

export type ProjectMode = "auto" | "manual";

export type ProjectStatus =
  | "planning"
  | "executing"
  | "judging"
  | "done"
  | "failed"
  | "killed";

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
  | "resume";

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
}

export type JudgeVerdictType = "done" | "needs_more" | "stuck";

export interface JudgeVerdict {
  verdict: JudgeVerdictType;
  reasoning: string;
  /** Tasks to add if verdict === "needs_more". */
  nextTasks?: Task[];
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