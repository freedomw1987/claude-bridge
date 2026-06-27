/**
 * Safety helpers — pure functions for cap checks and DAG task selection.
 *
 * `shouldStop` / `checkTimerExpired` are pure (no side effects, no
 * I/O) so they're trivially unit-testable. `pickNextTask` is the
 * dependency-aware task selector used by the main loop.
 */

import type { ProjectState, Task } from "../types";

/**
 * Pick the next pending task whose dependencies are all done.
 *
 * Returns the first task (in `state.plan` order) whose status is
 * "pending" AND whose `dependsOn` array references only tasks that
 * are "done" or "skipped". This implements topological execution
 * without an explicit DAG library — the plan is small (3-10 tasks).
 */
export function pickNextTask(state: ProjectState): Task | null {
  for (const t of state.plan) {
    if (t.status !== "pending") continue;
    const depsOk = t.dependsOn.every((depId) => {
      const dep = state.plan.find((x) => x.id === depId);
      return dep?.status === "done" || dep?.status === "skipped";
    });
    if (depsOk) return t;
  }
  return null;
}

/**
 * Check if the project's auto-mode timer has expired (ADR-0004).
 * Returns true iff `state.timer` is set and `expiresAt` is in the past.
 * Pure function — does not mutate state, no side effects.
 */
export function checkTimerExpired(state: ProjectState): boolean {
  if (!state.timer) return false;
  return state.timer.expiresAt <= Date.now();
}

/**
 * Check safety caps; returns the reason if any cap is exceeded,
 * null otherwise. Used by the main loop at the top of every iteration
 * to bail out before spending more tokens.
 */
export function shouldStop(state: ProjectState): string | null {
  if (state.iterations >= state.config.maxIterations) {
    return `iterations >= ${state.config.maxIterations}`;
  }
  if (state.costUsd >= state.config.maxCostUsd) {
    return `cost >= $${(state.config.maxCostUsd / 100).toFixed(2)}`;
  }
  const elapsedHours =
    (Date.now() - new Date(state.startedAt).getTime()) / (1000 * 60 * 60);
  if (elapsedHours >= state.config.maxWallHours) {
    return `elapsed >= ${state.config.maxWallHours}h`;
  }
  return null;
}