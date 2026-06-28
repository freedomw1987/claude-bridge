/**
 * Hermes Tracker APP — Hermes-orchestrated project mocks.
 *
 * The "Hermes projects" half of the Session model. A session becomes a
 * Hermes project when the user runs `/project start` (creates one fresh)
 * or `/project adopt` (upgrades an existing conversation). See
 * `src/discord/handlers/hermes/dispatch.ts` in the bot for the actual
 * command flow.
 *
 * Shapes match `HermesProjectDetail` / `SessionSummary` from types.ts.
 */

import type { HermesProjectDetail, SessionSummary } from "@/types";

const NOW = Date.UTC(2026, 5, 27, 14, 30, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

// ── Raw details (full state per project) ────────────────────────────

export const MOCK_HERMES_PROJECTS: HermesProjectDetail[] = [
  {
    mode: "hermes",
    id: "abc12345-build-cli-todo-app",
    shortId: "abc12345",
    threadId: "thread-cli-todo-001",
    goal: "Build a CLI todo app with persistent JSON storage",
    status: "executing",
    startedAt: new Date(NOW - 18 * MIN).toISOString(),
    endedAt: null,
    lastActivityAt: new Date(NOW - 8 * MIN).toISOString(),
    costUsd: 42,
    totalMessages: 11,
    claudeSession: "hermes-session-uuid-001",
    repoPath: "~/www/cli-todo",
    repoRoot: "~/www/cli-todo",
    iterations: 4,
    plan: [
      { id: "t1", title: "Initialize Node.js project + deps", description: "npm init, install commander, chalk, etc.", status: "done", attempts: 1, dependsOn: [], lastResult: "session=a1b2c3d4… turns=3" },
      { id: "t2", title: "Define Todo interface (TS)", description: "TypeScript types for todo items", status: "done", attempts: 1, dependsOn: ["t1"] },
      { id: "t3", title: "Implement file-based persistence", description: "JSON file in ~/.claude-bridge/todos.json", status: "done", attempts: 1, dependsOn: ["t2"] },
      { id: "t4", title: "Add commands: add / list / done / rm", description: "commander.js subcommands", status: "in_progress", attempts: 1, dependsOn: ["t3"] },
      { id: "t5", title: "Add JSON output flag", description: "--json for all subcommands", status: "pending", attempts: 0, dependsOn: ["t4"] },
      { id: "t6", title: "Write unit tests", description: "vitest for each command", status: "pending", attempts: 0, dependsOn: ["t4"] },
      { id: "t7", title: "Write README + smoke test", description: "installation, usage, examples", status: "pending", attempts: 0, dependsOn: ["t6"] },
    ],
    config: { maxIterations: 20, maxCostUsd: 500, maxWallHours: 4, maxAttemptsPerTask: 3 },
    timer: {
      expiresAt: NOW + 1 * HOUR + 42 * MIN,
      requestedDuration: "2h",
      effectiveMs: 2 * HOUR,
      clamped: false,
    },
    journal: [
      { ts: new Date(NOW - 18 * MIN).toISOString(), type: "status", message: "Project created. Mode=auto, repoPath=~/www/cli-todo" },
      { ts: new Date(NOW - 17 * MIN).toISOString(), type: "plan", message: "7 tasks: t1, t2, t3, t4, t5, t6, t7" },
      { ts: new Date(NOW - 16 * MIN).toISOString(), type: "task_start", message: "t1: Initialize Node.js project + deps (attempt 1)" },
      { ts: new Date(NOW - 15 * MIN).toISOString(), type: "task_done", message: "t1 done in 45000ms, cost $0.05, turns=3" },
      { ts: new Date(NOW - 14 * MIN).toISOString(), type: "task_start", message: "t2: Define Todo interface (TS) (attempt 1)" },
      { ts: new Date(NOW - 13 * MIN).toISOString(), type: "task_done", message: "t2 done in 60000ms, cost $0.06, turns=2" },
      { ts: new Date(NOW - 12 * MIN).toISOString(), type: "task_start", message: "t3: Implement file-based persistence (attempt 1)" },
      { ts: new Date(NOW - 10 * MIN).toISOString(), type: "task_done", message: "t3 done in 120000ms, cost $0.13, turns=4" },
      { ts: new Date(NOW - 8 * MIN).toISOString(), type: "task_start", message: "t4: Add commands: add / list / done / rm (attempt 1)" },
    ],
  },

  {
    mode: "hermes",
    id: "def67890-refactor-auth",
    shortId: "def67890",
    threadId: "thread-auth-002",
    goal: "Refactor auth module to use JWT instead of session cookies",
    status: "awaiting_approval",
    startedAt: new Date(NOW - 8 * MIN).toISOString(),
    endedAt: null,
    lastActivityAt: new Date(NOW - 6 * MIN).toISOString(),
    costUsd: 18,
    totalMessages: 4,
    claudeSession: "hermes-session-uuid-002",
    repoPath: "~/www/api-server/auth",
    repoRoot: "~/www/api-server",
    iterations: 0,
    plan: [
      { id: "t1", title: "Audit current session-cookie implementation", description: "map all session touch points", status: "pending", attempts: 0, dependsOn: [] },
      { id: "t2", title: "Design JWT schema + signing key strategy", description: "RS256 vs HS256, key rotation", status: "pending", attempts: 0, dependsOn: ["t1"] },
      { id: "t3", title: "Implement token issue + verify middleware", description: "replace cookie middleware", status: "pending", attempts: 0, dependsOn: ["t2"] },
      { id: "t4", title: "Add refresh-token rotation", description: "OAuth-style flow", status: "pending", attempts: 0, dependsOn: ["t3"] },
      { id: "t5", title: "Migration: invalidate all existing sessions", description: "force re-login on deploy", status: "pending", attempts: 0, dependsOn: ["t4"] },
    ],
    config: { maxIterations: 15, maxCostUsd: 400, maxWallHours: 3, maxAttemptsPerTask: 3 },
    approval: {
      docPath: "plan.md",
      docMtime: NOW - 6 * MIN,
      requestedAt: new Date(NOW - 6 * MIN).toISOString(),
    },
    journal: [
      { ts: new Date(NOW - 8 * MIN).toISOString(), type: "status", message: "Project created. Mode=manual, repoPath=~/www/api-server/auth" },
      { ts: new Date(NOW - 7 * MIN).toISOString(), type: "plan", message: "5 tasks: t1, t2, t3, t4, t5" },
      { ts: new Date(NOW - 7 * MIN).toISOString(), type: "plan", message: "reasoning: JWT over RS256 with key rotation; manual mode so David reviews each task before execution" },
      { ts: new Date(NOW - 6 * MIN).toISOString(), type: "status", message: "Awaiting plan approval in APP before execution" },
    ],
  },

  {
    mode: "hermes",
    id: "ghi11111-add-dark-mode",
    shortId: "ghi11111",
    threadId: "thread-dark-003",
    goal: "Add dark mode toggle to the dashboard UI",
    status: "done",
    startedAt: new Date(NOW - 4 * HOUR).toISOString(),
    endedAt: new Date(NOW - 3 * HOUR - 12 * MIN).toISOString(),
    lastActivityAt: new Date(NOW - 3 * HOUR - 12 * MIN).toISOString(),
    costUsd: 18,
    totalMessages: 9,
    claudeSession: "hermes-session-uuid-003",
    repoPath: "~/www/dashboard",
    repoRoot: "~/www/dashboard",
    iterations: 4,
    plan: [
      { id: "t1", title: "Add theme tokens + CSS variables", description: "light/dark color scheme", status: "done", attempts: 1, dependsOn: [], lastResult: "session=e5f6g7h8… turns=2" },
      { id: "t2", title: "Theme toggle in nav", description: "sun/moon icon", status: "done", attempts: 1, dependsOn: ["t1"] },
      { id: "t3", title: "Persist preference in localStorage", description: "key: hermes-theme", status: "done", attempts: 1, dependsOn: ["t2"] },
      { id: "t4", title: "Follow OS preference by default", description: "prefers-color-scheme media query", status: "done", attempts: 1, dependsOn: ["t3"] },
    ],
    config: { maxIterations: 10, maxCostUsd: 200, maxWallHours: 2, maxAttemptsPerTask: 3 },
    journal: [
      { ts: new Date(NOW - 4 * HOUR).toISOString(), type: "status", message: "Project created. Mode=auto" },
      { ts: new Date(NOW - 4 * HOUR).toISOString(), type: "plan", message: "4 tasks: t1, t2, t3, t4" },
      { ts: new Date(NOW - 4 * HOUR).toISOString(), type: "task_done", message: "t1 done in 30000ms, cost $0.04" },
      { ts: new Date(NOW - 4 * HOUR + 30 * MIN).toISOString(), type: "task_done", message: "t2 done in 45000ms, cost $0.05" },
      { ts: new Date(NOW - 4 * HOUR + 35 * MIN).toISOString(), type: "task_done", message: "t3 done in 8000ms, cost $0.01" },
      { ts: new Date(NOW - 4 * HOUR + 40 * MIN).toISOString(), type: "task_done", message: "t4 done in 12000ms, cost $0.02" },
      { ts: new Date(NOW - 3 * HOUR - 12 * MIN).toISOString(), type: "status", message: "judge verdict: done. Project complete." },
    ],
  },

  {
    mode: "hermes",
    id: "jkl22222-fix-planner-timeout",
    shortId: "jkl22222",
    threadId: "thread-planner-004",
    goal: "Fix planner timeout bug in Hermes orchestrator (RG-008)",
    status: "failed",
    startedAt: new Date(NOW - 28 * HOUR).toISOString(),
    endedAt: new Date(NOW - 22 * HOUR).toISOString(),
    lastActivityAt: new Date(NOW - 22 * HOUR).toISOString(),
    costUsd: 95,
    totalMessages: 18,
    claudeSession: "hermes-session-uuid-004",
    repoPath: "~/www/claude-bridge",
    repoRoot: "~/www/claude-bridge",
    iterations: 8,
    plan: [
      { id: "t1", title: "Reproduce planner timeout with long goal", description: "synthetic test case", status: "done", attempts: 1, dependsOn: [] },
      { id: "t2", title: "Add PlannerTimeoutError class", description: "typed error for orchestrator", status: "done", attempts: 1, dependsOn: ["t1"] },
      { id: "t3", title: "Map PlannerTimeoutError → status=timed_out", description: "in orchestrator catch block", status: "done", attempts: 1, dependsOn: ["t2"] },
      { id: "t4", title: "Add HERMES_PLANNER_TIMEOUT_MS env", description: "configurable, default 15min", status: "failed", attempts: 3, dependsOn: ["t3"], lastError: "Repeated timeout after 3 attempts; likely LLM issue with the test goal, not a code bug." },
      { id: "t5", title: "Write regression test", description: "mock planner to throw PlannerTimeoutError", status: "pending", attempts: 0, dependsOn: ["t4"] },
      { id: "t6", title: "Document in CHANGELOG + ADR-0008", description: "incidental to fix", status: "pending", attempts: 0, dependsOn: ["t5"] },
    ],
    config: { maxIterations: 20, maxCostUsd: 500, maxWallHours: 4, maxAttemptsPerTask: 3 },
    journal: [
      { ts: new Date(NOW - 28 * HOUR).toISOString(), type: "status", message: "Project created. Mode=auto" },
      { ts: new Date(NOW - 28 * HOUR).toISOString(), type: "plan", message: "6 tasks: t1, t2, t3, t4, t5, t6" },
      { ts: new Date(NOW - 27 * HOUR).toISOString(), type: "task_done", message: "t1 done in 90000ms, cost $0.12" },
      { ts: new Date(NOW - 26 * HOUR).toISOString(), type: "task_done", message: "t2 done in 30000ms, cost $0.04" },
      { ts: new Date(NOW - 25 * HOUR).toISOString(), type: "task_done", message: "t3 done in 60000ms, cost $0.08" },
      { ts: new Date(NOW - 24 * HOUR).toISOString(), type: "task_fail", message: "t4 attempt 1: planner timed out after 900s" },
      { ts: new Date(NOW - 23 * HOUR).toISOString(), type: "task_fail", message: "t4 attempt 2: planner timed out after 900s" },
      { ts: new Date(NOW - 22 * HOUR).toISOString(), type: "task_fail", message: "t4 attempt 3: planner timed out after 900s (exhausted)" },
      { ts: new Date(NOW - 22 * HOUR).toISOString(), type: "escalate", message: "task t4 failed after 3 attempts" },
      { ts: new Date(NOW - 22 * HOUR).toISOString(), type: "judge", message: "verdict=stuck: planner cannot decompose this goal; recommend manual approach" },
      { ts: new Date(NOW - 22 * HOUR).toISOString(), type: "status", message: "Project ended in failed." },
    ],
  },

  {
    mode: "hermes",
    id: "mno33333-write-e2e-tests",
    shortId: "mno33333",
    threadId: "thread-e2e-005",
    goal: "Write end-to-end Playwright tests for the dashboard",
    status: "killed",
    startedAt: new Date(NOW - 5 * HOUR).toISOString(),
    endedAt: new Date(NOW - 1 * HOUR).toISOString(),
    lastActivityAt: new Date(NOW - 1 * HOUR).toISOString(),
    costUsd: 210,
    totalMessages: 22,
    claudeSession: "hermes-session-uuid-005",
    repoPath: "~/www/dashboard",
    repoRoot: "~/www/dashboard",
    iterations: 7,
    plan: [
      { id: "t1", title: "Install Playwright + configure test runner", description: "npm i -D @playwright/test, playwright.config.ts", status: "done", attempts: 1, dependsOn: [] },
      { id: "t2", title: "Set up CI test workflow", description: "GitHub Actions config", status: "done", attempts: 1, dependsOn: ["t1"] },
      { id: "t3", title: "E2E: dashboard renders project list", description: "test the homepage", status: "done", attempts: 1, dependsOn: ["t2"] },
      { id: "t4", title: "E2E: click project → detail view loads", description: "test navigation", status: "done", attempts: 1, dependsOn: ["t3"] },
      { id: "t5", title: "E2E: theme toggle persists preference", description: "light/dark + reload", status: "in_progress", attempts: 2, dependsOn: ["t4"] },
      { id: "t6", title: "E2E: add todo via APP form", description: "interactive todo flow", status: "pending", attempts: 0, dependsOn: ["t5"] },
      { id: "t7", title: "E2E: approval workflow (approve/reject)", description: "plan review UI", status: "pending", attempts: 0, dependsOn: ["t6"] },
      { id: "t8", title: "E2E: SSE journal stream updates in real time", description: "run a project + verify SSE pushes", status: "pending", attempts: 0, dependsOn: ["t7"] },
    ],
    config: { maxIterations: 25, maxCostUsd: 600, maxWallHours: 4, maxAttemptsPerTask: 3 },
    killedReason: "duration_expired",
    timer: {
      expiresAt: NOW - 1 * HOUR,
      requestedDuration: "4h",
      effectiveMs: 4 * HOUR,
      clamped: false,
    },
    journal: [
      { ts: new Date(NOW - 5 * HOUR).toISOString(), type: "status", message: "Project created. Mode=auto, timer=4h" },
      { ts: new Date(NOW - 5 * HOUR).toISOString(), type: "plan", message: "8 tasks: t1, t2, t3, t4, t5, t6, t7, t8" },
      { ts: new Date(NOW - 4 * HOUR - 50 * MIN).toISOString(), type: "task_done", message: "t1 done in 60000ms, cost $0.08" },
      { ts: new Date(NOW - 4 * HOUR - 40 * MIN).toISOString(), type: "task_done", message: "t2 done in 45000ms, cost $0.06" },
      { ts: new Date(NOW - 4 * HOUR - 30 * MIN).toISOString(), type: "task_done", message: "t3 done in 30000ms, cost $0.04" },
      { ts: new Date(NOW - 4 * HOUR - 20 * MIN).toISOString(), type: "task_done", message: "t4 done in 80000ms, cost $0.10" },
      { ts: new Date(NOW - 4 * HOUR).toISOString(), type: "task_start", message: "t5: E2E: theme toggle (attempt 1)" },
      { ts: new Date(NOW - 3 * HOUR - 50 * MIN).toISOString(), type: "task_fail", message: "t5 attempt 1: localStorage mock didn't persist across page reload" },
      { ts: new Date(NOW - 3 * HOUR - 30 * MIN).toISOString(), type: "task_start", message: "t5: E2E: theme toggle (attempt 2)" },
      { ts: new Date(NOW - 1 * HOUR).toISOString(), type: "timer", message: "auto-mode duration expired; project killed (timer was 4h)" },
    ],
  },

  {
    mode: "hermes",
    id: "pqr44444-investigate-memory-leak",
    shortId: "pqr44444",
    threadId: "thread-mem-006",
    goal: "Investigate SDK subprocess memory leak in long-running tasks",
    status: "failed",
    startedAt: new Date(NOW - 6 * HOUR).toISOString(),
    endedAt: new Date(NOW - 5 * HOUR - 30 * MIN).toISOString(),
    lastActivityAt: new Date(NOW - 5 * HOUR - 30 * MIN).toISOString(),
    costUsd: 67,
    totalMessages: 14,
    claudeSession: "hermes-session-uuid-006",
    repoPath: "~/www/claude-bridge",
    repoRoot: "~/www/claude-bridge",
    iterations: 5,
    plan: [
      { id: "t1", title: "Set up RAM tracing infrastructure", description: "BOT_RAM_TRACE=1, data/ram-trace.log", status: "done", attempts: 1, dependsOn: [] },
      { id: "t2", title: "Write scripts/ram-trace-analyze.ts", description: "ASCII chart + Hermes correlation", status: "done", attempts: 1, dependsOn: ["t1"] },
      { id: "t3", title: "Reproduce leak in long-task scenario", description: "30-min Claude Code session", status: "failed", attempts: 2, dependsOn: ["t2"], lastError: "Reproduction unreliable — needs specific prompt pattern" },
      { id: "t4", title: "Root-cause via heap snapshots", description: "use v8.writeHeapSnapshot()", status: "pending", attempts: 0, dependsOn: ["t3"] },
      { id: "t5", title: "Document findings in ADR", description: "if confirmed; otherwise close", status: "pending", attempts: 0, dependsOn: ["t4"] },
    ],
    config: { maxIterations: 15, maxCostUsd: 400, maxWallHours: 4, maxAttemptsPerTask: 3 },
    journal: [
      { ts: new Date(NOW - 6 * HOUR).toISOString(), type: "status", message: "Project created. Mode=manual" },
      { ts: new Date(NOW - 6 * HOUR).toISOString(), type: "plan", message: "5 tasks: t1, t2, t3, t4, t5" },
      { ts: new Date(NOW - 5 * HOUR - 50 * MIN).toISOString(), type: "task_done", message: "t1 done in 20000ms, cost $0.03" },
      { ts: new Date(NOW - 5 * HOUR - 40 * MIN).toISOString(), type: "task_done", message: "t2 done in 90000ms, cost $0.12" },
      { ts: new Date(NOW - 5 * HOUR).toISOString(), type: "task_start", message: "t3: reproduce leak (attempt 1)" },
      { ts: new Date(NOW - 5 * HOUR - 30 * MIN).toISOString(), type: "task_fail", message: "t3 attempt 1: did not reproduce within budget" },
      { ts: new Date(NOW - 5 * HOUR - 20 * MIN).toISOString(), type: "task_start", message: "t3: reproduce leak (attempt 2)" },
      { ts: new Date(NOW - 5 * HOUR - 30 * MIN).toISOString(), type: "task_fail", message: "t3 attempt 2: still no leak observable" },
      { ts: new Date(NOW - 5 * HOUR - 30 * MIN).toISOString(), type: "escalate", message: "task t3 failed after 2 attempts; recommend manual investigation" },
      { ts: new Date(NOW - 5 * HOUR - 30 * MIN).toISOString(), type: "status", message: "Project ended in failed." },
    ],
  },
];

// ── Helpers ──────────────────────────────────────────────────────────

/** Reduce a HermesProjectDetail to a SessionSummary for the dashboard list. */
function toSummary(p: HermesProjectDetail): SessionSummary {
  let taskTotal = 0;
  let taskDone = 0;
  let taskInProgress = 0;
  let taskFailed = 0;
  let taskPending = 0;
  for (const t of p.plan) {
    taskTotal++;
    if (t.status === "done" || t.status === "skipped") taskDone++;
    else if (t.status === "in_progress") taskInProgress++;
    else if (t.status === "failed") taskFailed++;
    else if (t.status === "pending") taskPending++;
  }
  return {
    id: p.id,
    threadId: p.threadId,
    shortId: p.shortId,
    mode: "hermes",
    goal: p.goal,
    status: p.status,
    costUsd: p.costUsd,
    startedAt: p.startedAt,
    endedAt: p.endedAt,
    lastActivityAt: p.lastActivityAt,
    totalMessages: p.totalMessages,
    taskTotal,
    taskDone,
    taskInProgress,
    taskFailed,
    taskPending,
    timer: p.timer,
    projectMode: parseProjectMode(p.journal),
  };
}

/**
 * Pull the `Mode=auto|manual` out of the first status journal entry.
 * Returns "auto" as the fallback (matching the bot's default).
 */
function parseProjectMode(
  journal: HermesProjectDetail["journal"],
): "auto" | "manual" {
  for (const j of journal) {
    const m = /Mode=(\w+)/.exec(j.message);
    if (m && (m[1] === "auto" || m[1] === "manual")) return m[1];
  }
  return "auto";
}

export function listHermesSummaries(): SessionSummary[] {
  return MOCK_HERMES_PROJECTS.map(toSummary);
}

export function getHermesDetail(id: string): HermesProjectDetail | null {
  return MOCK_HERMES_PROJECTS.find((p) => p.id === id) ?? null;
}