/**
 * Lifecycle helpers — soft-exit, timer arming, and project adoption.
 *
 * These functions bridge the orchestrator's state machine and the
 * on-disk state files. Split from the main `run.ts` so the run logic
 * stays focused on the planning → executing → judging state machine.
 */

import {
  appendJournal,
  clearTimer,
  ensureProjectDir,
  saveState,
} from "../state";
import {
  newProjectState,
  type HermesRuntimeConfig,
  type ProjectAdoption,
  type ProjectMode,
  type ProjectState,
} from "../types";
import { log } from "../../logger";
import { formatTimerExpired } from "../discord";
import { HERMES_PREFIX } from "../discord";
import type { OrchestratorDeps } from "./types";

/**
 * Soft-exit a project: transition to `killed` with the given reason,
 * clear the timer field, post a Discord message, and return the
 * updated state. Idempotent — calling on a non-active project is a
 * no-op (we still write a journal row for audit).
 */
export async function softExit(
  projectId: string,
  state: ProjectState,
  deps: OrchestratorDeps,
  reason: "duration_expired" | "manual_switch",
): Promise<ProjectState> {
  const requestedDuration = state.timer?.requestedDuration ?? "n/a";
  // Clear any live timer handle so it doesn't keep the process alive.
  if (state.timer?.handle) {
    clearTimeout(state.timer.handle);
  }
  state.status = "killed";
  state.killedReason = reason;
  state.endedAt = new Date().toISOString();
  state.currentTaskId = null;
  // Drop the timer field entirely (handle-strip is handled by saveState).
  state = clearTimer(state);
  // Ensure the on-disk directory exists — softExit can be called before
  // the orchestrator has saved state (e.g., from /project setMode manual
  // on a never-resumed project). Idempotent.
  ensureProjectDir(deps.hermesDir, projectId);
  saveState(deps.hermesDir, projectId, state);
  appendJournal(deps.hermesDir, projectId, {
    type: "timer",
    message:
      reason === "duration_expired"
        ? `auto-mode duration expired; project killed (timer was ${requestedDuration})`
        : `manual switch cancelled auto-mode timer`,
  });
  await deps.thread.send(
    reason === "duration_expired"
      ? formatTimerExpired(state)
      : `${HERMES_PREFIX} ⏹️ Project \`${state.id.slice(0, 8)}\` killed (manual switch).`,
  );
  return state;
}

/**
 * Arm a wallclock timer for an active auto-mode project (ADR-0004).
 *
 * If `state.timer` is unset → no-op (manual mode, or no timer requested).
 * If `state.timer.expiresAt` is already past → call onExpire immediately
 * (no setTimeout, since delay would be negative).
 * Otherwise, schedule a `setTimeout` that calls onExpire at the
 * deadline. The handle is stored back on `state.timer.handle` so
 * `softExit` (and the `state.ts:clearTimer` strip) can clear it.
 *
 * Returns the (possibly live) handle, or null if no timer was set.
 * The handle is intentionally unref()'d so a leaked timer can never
 * keep the bot process alive (matches the TypingIndicator pattern).
 */
export function armProjectTimer(
  state: ProjectState,
  onExpire: () => void | Promise<void>,
): ReturnType<typeof setTimeout> | null {
  if (!state.timer) return null;
  const delay = state.timer.expiresAt - Date.now();
  if (delay <= 0) {
    // Already past — fire immediately. Use queueMicrotask so the caller
    // can finish the current statement before the callback runs.
    queueMicrotask(() => {
      void onExpire();
    });
    return null;
  }
  const handle = setTimeout(() => {
    void onExpire();
  }, delay);
  // Don't keep the process alive on a leaked timer.
  if (typeof (handle as { unref?: () => void }).unref === "function") {
    (handle as { unref: () => void }).unref();
  }
  state.timer.handle = handle;
  return handle;
}

/**
 * Adopt an existing plain Claude Code session thread into a Hermes-managed
 * project. Persists a new ProjectState with the `adoption` provenance
 * block populated (RG-004). Used by `/project adopt` (see
 * `src/discord/handlers/hermes/adopt.ts`).
 */
export function adoptProject(input: {
  hermesDir: string;
  projectId: string;
  threadId: string;
  goal: string;
  mode: ProjectMode;
  repoPath: string;
  repoRoot: string;
  repoSource: "new" | "clone" | "local";
  config: HermesRuntimeConfig;
  adoption: ProjectAdoption;
}): ProjectState {
  ensureProjectDir(input.hermesDir, input.projectId);
  const state = newProjectState({
    id: input.projectId,
    threadId: input.threadId,
    goal: input.goal,
    mode: input.mode,
    repoPath: input.repoPath,
    repoRoot: input.repoRoot,
    repoSource: input.repoSource,
    config: input.config,
  });
  state.adoption = input.adoption;
  saveState(input.hermesDir, input.projectId, state);
  appendJournal(input.hermesDir, input.projectId, {
    type: "adopt",
    message: `thread adopted from CC session; repoRoot=${input.repoRoot}, originalSessionId=${input.adoption.originalSessionId.slice(0, 12)}…`,
  });
  log.info("hermes: project adopted from CC session", {
    projectId: input.projectId,
    threadId: input.threadId,
    repoPath: input.repoPath,
    repoRoot: input.repoRoot,
    repoSource: input.repoSource,
    mode: input.mode,
  });
  return state;
}