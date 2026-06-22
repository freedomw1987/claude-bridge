/**
 * Hermes orchestrator — main state machine for one project.
 *
 * Lifecycle: planning → executing ⇄ judging → done | failed | killed
 *
 *   planning   — planner LLM decomposes the goal into tasks
 *   executing  — for each pending task with deps satisfied, run Claude Code
 *   judging    — judge LLM self-assesses whether the goal is met
 *
 * The loop between executing ↔ judging handles the "judge says needs_more"
 * case: new tasks are appended and the project re-enters executing.
 *
 * Safety caps:
 *   - maxIterations: total task attempts (one per iteration)
 *   - maxCostUsd: cumulative Claude Code cost in cents
 *   - maxWallHours: wall-clock from project start
 *   - maxAttemptsPerTask: per-task retry cap (independent of maxIterations)
 *
 * On any cap exceeded, status → "failed" and a Discord escalation is
 * posted. David's `/project kill` flips status → "killed" between iterations.
 *
 * This module is pure async — it does not bind to Discord globally. The
 * caller (Discord command handler or resume-on-startup) provides the deps
 * (thread-bound send, thread, userMsg stub, session lookup).
 */

import { runViaSdk, type SdkRunResult } from "../agent/sdkRunner";
import { log } from "../logger";
import { executeTask, type ExecutorDeps } from "./executor";
import { planProject } from "./planner";
import { judgeProject } from "./judge";
import {
  appendJournal,
  clearTimer,
  ensureProjectDir,
  loadState,
  saveState,
} from "./state";
import type { ProjectAdoption, ProjectMode, ProjectState, Task } from "./types";
import { isActive, newProjectState, type HermesRuntimeConfig } from "./types";
import {
  formatCompletion,
  formatEscalation,
  formatPlanMessage,
  formatTaskDone,
  formatTaskFail,
  formatTaskStart,
  formatTimerExpired,
  HERMES_PREFIX,
  makeHermesSend,
} from "./discord";
import { TypingIndicator } from "./typing";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export interface OrchestratorDeps {
  hermesDir: string;
  /** Resolved thread for Discord updates. Required. */
  thread: import("discord.js").ThreadChannel;
  /**
   * Claude session ID for session persistence across retries. Looked up
   * from SessionStore by the caller. May be null on first run.
   */
  claudeSession: string | null;
  /**
   * Optional stub Message for runViaSdk's first arg (which is currently
   * unused by the SDK). On resume-on-startup this is omitted.
   */
  userMsgStub?: import("discord.js").Message;
  /**
   * Optional: lookup a saved Claude session for a thread. If null, a
   * fresh session is started (no resume). Used by resume-on-startup.
   */
  resolveClaudeSession?: (threadId: string) => string | null;
}

export async function runProject(
  projectId: string,
  deps: OrchestratorDeps,
): Promise<void> {
  const send = makeHermesSend(deps.thread);

  let state = loadState(deps.hermesDir, projectId);
  if (!state) {
    log.error("hermes orchestrator: project not found", { projectId });
    await send(`Project \`${projectId}\` not found.`);
    return;
  }

  log.info("hermes orchestrator: starting", {
    projectId,
    threadId: state.threadId,
    status: state.status,
    mode: state.mode,
  });

  // Manual mode dispatches to a single Claude Code run (no planning,
  // no per-task approval). See runManualProject for the rationale.
  if (state.mode === "manual") {
    return runManualProject(projectId, deps);
  }

  // Keep the Discord typing indicator on for the entire orchestrator
  // run. This covers planning LLM calls, waiting on Claude Code, and
  // judge LLM calls. try/finally ensures the interval is cleared on
  // every exit path (done, failed, killed, crash, resume-exit).
  const typing = new TypingIndicator(deps.thread);
  typing.start();

  try {
    // ── 1. Planning ───────────────────────────────────────────────
    if (state.status === "planning") {
      state = await doPlanning(state, deps);
    }

    // ── 2. Executing (with judge loop) ─────────────────────────────
    let loopGuard = 0;
    while (state.status === "executing") {
      // Reload state from disk at the top of every iteration to detect
      // external changes (e.g., /project kill, /project resume). Without
      // this, the orchestrator would keep running on its local copy of
      // state and never see the kill flag the user just wrote to disk.
      const fresh = loadState(deps.hermesDir, projectId);
      if (fresh && fresh.status !== state.status) {
        log.info("hermes orchestrator: external state change detected", {
          projectId,
          from: state.status,
          to: fresh.status,
        });
        state = fresh;
        if (state.status !== "executing") {
          // External transition (e.g., killed, failed) — exit cleanly.
          await send(
            `${HERMES_PREFIX} ⏹️ Project \`${state.id.slice(0, 8)}\` ${state.status} (external).`,
          );
          return;
        }
      }

      if (++loopGuard > 100) {
        log.error("hermes orchestrator: loop guard tripped", { projectId });
        state.status = "failed";
        state.endedAt = new Date().toISOString();
        saveState(deps.hermesDir, projectId, state);
        await send(formatEscalation(state, "internal: orchestrator loop guard tripped"));
        return;
      }

      if (shouldStop(state)) {
        state.status = "failed";
        state.endedAt = new Date().toISOString();
        saveState(deps.hermesDir, projectId, state);
        appendJournal(deps.hermesDir, projectId, {
          type: "escalate",
          message: "safety cap reached; stopping",
        });
        await send(formatEscalation(state, "safety cap reached (cost / time / iterations)"));
        return;
      }

      const task = pickNextTask(state);
      if (!task) {
        // No more pending tasks with satisfied deps → judge time.
        state.status = "judging";
        saveState(deps.hermesDir, projectId, state);
        break;
      }

      state = await runOneTask(state, task, deps);
    }

    // ── 3. Judging ─────────────────────────────────────────────────
    if (state.status === "judging") {
      // ADR-0004 M2.4: timer boundary check before invoking judge LLM.
      // Soft-exit at the judge boundary (not at task boundary) so the
      // in-flight task's result is preserved on disk and David can
      // /project resume without losing work.
      const timerExpired = checkTimerExpired(state);
      if (timerExpired) {
        log.info("hermes orchestrator: timer expired at judge boundary", {
          projectId,
          expiresAt: state.timer?.expiresAt,
          requested: state.timer?.requestedDuration,
        });
        state = await softExit(projectId, state, deps, "duration_expired");
        return;
      }

      const verdict = await judgeProject(state);
      state.lastVerdict = verdict;
      appendJournal(deps.hermesDir, projectId, {
        type: "judge",
        message: `verdict=${verdict.verdict}: ${verdict.reasoning.slice(0, 300)}`,
      });

      if (verdict.verdict === "done") {
        state.status = "done";
        state.endedAt = new Date().toISOString();
        saveState(deps.hermesDir, projectId, state);
        await send(formatCompletion(state));
        return;
      }
      if (verdict.verdict === "needs_more" && verdict.nextTasks && verdict.nextTasks.length > 0) {
        // Append new tasks; continue executing.
        const nextIds = verdict.nextTasks.map((t) => t.id);
        state.plan.push(...verdict.nextTasks);
        state.status = "executing";
        saveState(deps.hermesDir, projectId, state);
        appendJournal(deps.hermesDir, projectId, {
          type: "judge",
          message: `added ${verdict.nextTasks.length} task(s): ${nextIds.join(", ")}`,
        });
        await send(
          `${HERMES_PREFIX} 🔄 Judge added ${verdict.nextTasks.length} more task(s): ${nextIds.join(", ")}. Continuing...`,
        );
        // Recurse to continue the executing loop.
        return runProject(projectId, deps);
      }
      // "stuck" or "needs_more" without nextTasks
      state.status = "failed";
      state.endedAt = new Date().toISOString();
      saveState(deps.hermesDir, projectId, state);
      await send(formatEscalation(state, `judge says ${verdict.verdict}: ${verdict.reasoning}`));
      return;
    }
  } catch (err) {
    log.error("hermes orchestrator: unhandled error", {
      projectId,
      err: String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    state.status = "failed";
    state.endedAt = new Date().toISOString();
    saveState(deps.hermesDir, projectId, state);
    appendJournal(deps.hermesDir, projectId, {
      type: "escalate",
      message: `orchestrator crash: ${String(err).slice(0, 300)}`,
    });
    await send(formatEscalation(state, `orchestrator crashed: ${String(err).slice(0, 200)}`));
  } finally {
    typing.stop();
  }
}

async function doPlanning(
  state: ProjectState,
  _deps: OrchestratorDeps,
): Promise<ProjectState> {
  const planResult = await planProject({
    goal: state.goal,
    repoPath: state.repoPath,
    repoSource: state.repoSource,
  });
  state.plan = planResult.tasks;
  state.status = "executing";
  saveState(_deps.hermesDir, state.id, state);
  appendJournal(_deps.hermesDir, state.id, {
    type: "plan",
    message: `${planResult.tasks.length} tasks: ${planResult.tasks.map((t) => t.id).join(", ")}`,
  });
  appendJournal(_deps.hermesDir, state.id, {
    type: "plan",
    message: `reasoning: ${planResult.reasoning.slice(0, 300)}`,
  });
  await _deps.thread.send(formatPlanMessage(state));
  return state;
}

async function runOneTask(
  state: ProjectState,
  task: Task,
  deps: OrchestratorDeps,
): Promise<ProjectState> {
  state.currentTaskId = task.id;
  task.status = "in_progress";
  task.attempts++;
  state.iterations++;
  saveState(deps.hermesDir, state.id, state);
  appendJournal(deps.hermesDir, state.id, {
    type: "task_start",
    message: `${task.id}: ${task.title} (attempt ${task.attempts})`,
  });
  await deps.thread.send(formatTaskStart(state, task));

  const execDeps: ExecutorDeps = {
    thread: deps.thread,
    repoPath: state.repoPath,
    claudeSession: deps.resolveClaudeSession
      ? deps.resolveClaudeSession(state.threadId)
      : deps.claudeSession,
    send: (content) => deps.thread.send(content).then(() => ({} as import("discord.js").Message)),
    userMsgStub: deps.userMsgStub,
  };

  const { result } = await executeTask(task, state, execDeps);

  // Re-read disk state BEFORE processing the result. If the user killed
  // the project mid-task, the disk will reflect that and we must NOT
  // overwrite it (e.g., by setting status="failed" for a non-retryable
  // task or status="done" for a successful abort). Just return the
  // fresh state so the main loop sees the kill on its next check.
  const freshAfterExec = loadState(deps.hermesDir, state.id);
  if (freshAfterExec && freshAfterExec.status !== "executing") {
    log.info("hermes orchestrator: external state change during task, exiting", {
      projectId: state.id,
      taskId: task.id,
      newStatus: freshAfterExec.status,
    });
    state = freshAfterExec;
    state.currentTaskId = null;
    saveState(deps.hermesDir, state.id, state);
    return state;
  }

  state.costUsd += result.costUsd;

  if (result.isError) {
    task.lastError = result.errorMessage ?? "unknown error";
    const willRetry = task.attempts < state.config.maxAttemptsPerTask;
    task.status = willRetry ? "pending" : "failed";
    saveState(deps.hermesDir, state.id, state);
    appendJournal(deps.hermesDir, state.id, {
      type: "task_fail",
      message: `${task.id} attempt ${task.attempts}: ${task.lastError.slice(0, 300)}${willRetry ? " (will retry)" : " (exhausted)"}`,
    });
    await deps.thread.send(formatTaskFail(task, task.lastError, willRetry));
    if (!willRetry) {
      // Escalate immediately so David knows we're not proceeding.
      state.status = "failed";
      state.endedAt = new Date().toISOString();
      saveState(deps.hermesDir, state.id, state);
      await deps.thread.send(
        formatEscalation(state, `task ${task.id} failed after ${task.attempts} attempts`),
      );
    }
  } else {
    task.status = "done";
    task.lastResult = `session=${result.sessionId.slice(0, 12)}… turns=${result.numTurns}`;
    saveState(deps.hermesDir, state.id, state);
    appendJournal(deps.hermesDir, state.id, {
      type: "task_done",
      message: `${task.id} done in ${result.durationMs}ms, cost $${(result.costUsd / 100).toFixed(2)}, turns=${result.numTurns}`,
    });
    await deps.thread.send(formatTaskDone(state, task, {
      durationMs: result.durationMs,
      costUsd: result.costUsd,
    }));
  }

  state.currentTaskId = null;
  saveState(deps.hermesDir, state.id, state);
  return state;
}

/** Pick the next pending task whose dependencies are all done. */
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
 * Soft-exit a project: transition to `killed` with the given reason,
 * clear the timer field, post a Discord message, and return the
 * updated state. Idempotent — calling on a non-active project is a
 * no-op (we still write a journal row for audit).
 *
 * @param projectId  the project to soft-exit
 * @param state      the current state (mutated and saved)
 * @param deps       orchestrator deps (for thread + send)
 * @param reason     sub-reason for the killed status
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

/** Check safety caps; returns the reason if any cap is exceeded. */
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

/** Resume all active projects found on disk. Called from index.ts at boot. */
export async function resumeActiveProjects(
  hermesDir: string,
  fetchThread: (
    threadId: string,
  ) => Promise<import("discord.js").ThreadChannel | null>,
  resolveClaudeSession?: (threadId: string) => string | null,
  buildUserMsgStub?: (
    threadId: string,
  ) => import("discord.js").Message,
): Promise<void> {
  const { listProjects } = await import("./state");
  const active = listProjects(hermesDir, { activeOnly: true });
  if (active.length === 0) return;
  log.info("hermes: resuming active projects", { count: active.length });
  for (const state of active) {
    const thread = await fetchThread(state.threadId);
    if (!thread) {
      log.warn("hermes: cannot resume, thread not in cache", {
        projectId: state.id,
        threadId: state.threadId,
      });
      appendJournal(hermesDir, state.id, {
        type: "resume",
        message: "could not resume: thread not in Discord cache",
      });
      continue;
    }
    const userMsgStub = buildUserMsgStub?.(state.threadId);
    if (!userMsgStub) {
      log.warn("hermes: no userMsgStub provider, cannot resume", {
        projectId: state.id,
      });
      continue;
    }
    appendJournal(hermesDir, state.id, {
      type: "resume",
      message: "bot restart; resuming project",
    });
    // ADR-0004 M2.5: if the persisted timer is still in the future,
    // re-arm a setTimeout that calls softExit at the deadline. If the
    // timer already expired during downtime, fire softExit immediately
    // (queueMicrotask inside armProjectTimer handles the "past" case).
    //
    // IMPORTANT: the setTimeout callback re-loads state from disk
    // before calling softExit — the `state` object above is a snapshot
    // and may have moved on by the time the timer fires (e.g., the
    // runProject loop might have already softExited via the judge
    // boundary, or the user might have setMode manual in Discord).
    // Re-loading gives us the freshest view and keeps softExit idempotent.
    const projectId = state.id;
    const threadForTimer = thread;
    armProjectTimer(state, () => {
      const fresh = loadState(hermesDir, projectId);
      if (!fresh) {
        log.warn("hermes: armProjectTimer found no state on disk", {
          projectId,
        });
        return;
      }
      if (!isActive(fresh)) {
        // Project already terminal — nothing to do. Common case: the
        // orchestrator's judge boundary already fired the softExit.
        return;
      }
      softExit(projectId, fresh, {
        hermesDir,
        thread: threadForTimer,
        claudeSession: null,
      }, "duration_expired").catch((err) => {
        log.error("hermes: armProjectTimer softExit failed", {
          projectId,
          err: String(err),
        });
      });
    });

    // Fire-and-forget; do not await across all projects (one slow project
    // shouldn't block another from starting).
    runProject(state.id, {
      hermesDir,
      thread,
      claudeSession: resolveClaudeSession?.(state.threadId) ?? null,
      userMsgStub,
      resolveClaudeSession,
    }).catch((err) => {
      log.error("hermes: resumed project crashed", {
        projectId: state.id,
        err: String(err),
      });
    });
  }
}

/** Ensure the project's on-disk artifacts directory exists. */
export function ensureArtifactsDir(hermesDir: string, projectId: string): string {
  const dir = join(hermesDir, "projects", projectId, "artifacts");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Re-export for convenience. */
export { runViaSdk };

/**
 * Manual-mode project runner.
 *
 * In manual mode, Hermes does NOT plan / decompose / judge. Instead, the
 * whole goal is passed directly to Claude Code as a single prompt — the
 * same flow as the existing `@bot <prompt>` mention, but invoked via
 * `/project start --mode=manual`.
 *
 * After Claude Code finishes, the thread continues to work via the
 * existing `forwardToClaude` flow (David can send follow-up messages and
 * the SDK resumes the session). Hermes state stays in sync for
 * `/project status` and `/project kill` (kill aborts the in-flight run).
 */
export async function runManualProject(
  projectId: string,
  deps: OrchestratorDeps,
): Promise<void> {
  const send = makeHermesSend(deps.thread);

  let state = loadState(deps.hermesDir, projectId);
  if (!state) {
    log.error("hermes manual: project not found", { projectId });
    await send(`Project \`${projectId}\` not found.`);
    return;
  }
  if (state.mode !== "manual") {
    log.error("hermes manual: called for non-manual project", {
      projectId,
      mode: state.mode,
    });
    return;
  }

  log.info("hermes manual: starting", {
    projectId,
    threadId: state.threadId,
    goal: state.goal.slice(0, 200),
    repoPath: state.repoPath,
  });

  // Mark as executing (state starts as "planning" from newProjectState).
  state.status = "executing";
  state.startedAt = state.startedAt || new Date().toISOString();
  saveState(deps.hermesDir, projectId, state);
  appendJournal(deps.hermesDir, projectId, {
    type: "status",
    message: `manual mode: invoking Claude Code with goal as prompt`,
  });

  await deps.thread.send(
    `${HERMES_PREFIX} ▶️ Manual mode: invoking Claude Code with the goal as a single prompt.`,
  );

  const typing = new TypingIndicator(deps.thread);
  typing.start();

  let result: SdkRunResult;
  try {
    result = await runViaSdk(
      deps.userMsgStub ?? (deps.thread as unknown as import("discord.js").Message),
      deps.thread,
      state.goal,
      {
        threadId: state.threadId,
        claudeSession: deps.claudeSession,
        repoPath: state.repoPath,
      },
      (content) =>
        deps.thread.send(content).then(() => ({} as import("discord.js").Message)),
    );
  } catch (err) {
    log.error("hermes manual: runViaSdk threw", {
      projectId,
      err: String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    typing.stop();
    state.status = "failed";
    state.endedAt = new Date().toISOString();
    saveState(deps.hermesDir, projectId, state);
    appendJournal(deps.hermesDir, projectId, {
      type: "escalate",
      message: `manual run crashed: ${String(err).slice(0, 300)}`,
    });
    await send(formatEscalation(state, `manual run crashed: ${String(err).slice(0, 200)}`));
    return;
  }
  typing.stop();

  state.costUsd = result.costUsd;
  state.status = result.isError ? "failed" : "done";
  state.endedAt = new Date().toISOString();
  state.iterations = 1;
  saveState(deps.hermesDir, projectId, state);

  appendJournal(deps.hermesDir, projectId, {
    type: result.isError ? "task_fail" : "task_done",
    message: `manual run ${result.isError ? "failed" : "done"} in ${result.durationMs}ms, $${(result.costUsd / 100).toFixed(2)}`,
  });

  if (result.isError) {
    await send(
      formatEscalation(state, result.errorMessage ?? "manual run failed"),
    );
  } else {
    await deps.thread.send(
      [
        `${HERMES_PREFIX} ✅ Manual run complete.`,
        `Duration: ${formatDuration(result.durationMs)} | Cost: $${(result.costUsd / 100).toFixed(2)} | Turns: ${result.numTurns}`,
        ``,
        `You can continue in this thread — replies will be forwarded to Claude Code as follow-ups (session resume).`,
      ].join("\n"),
    );
  }

  log.info("hermes manual: finished", {
    projectId,
    isError: result.isError,
    durationMs: result.durationMs,
    costUsd: result.costUsd,
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * Adopt an existing plain Claude Code session thread into a Hermes-managed
 * project (RG-004).
 *
 * Workflow rationale: David's preferred flow is to first chat with
 * Claude Code via `@bot <prompt>` in a thread to discuss requirements,
 * then upgrade the thread to a Hermes-managed project once the goal
 * is clear. This function performs that upgrade:
 *
 *   1. Builds a `ProjectState` with the `adoption` field populated for
 *      audit trail.
 *   2. Persists state and journal.
 *
 * The caller (`handleProjectAdopt` in hermesCommands.ts) is responsible
 * for:
 *  - Validating no existing Hermes project on this thread (soft-reject
 *    with a "kill first" hint per 3B).
 *  - Looking up the existing Claude Code session in the SQLite
 *    `sessions` table (must exist; we don't synthesize one).
 *  - Parsing the duration string and clamping to `maxWallHours`.
 *  - Arming the wallclock timer if mode === "auto".
 *  - Kicking off the orchestrator after this returns.
 *
 * @returns the new ProjectState (also persisted to disk)
 */
export function adoptProject(input: {
  hermesDir: string;
  projectId: string;
  threadId: string;
  goal: string;
  mode: ProjectMode;
  repoPath: string;
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
    repoSource: input.repoSource,
    config: input.config,
  });
  state.adoption = input.adoption;
  saveState(input.hermesDir, input.projectId, state);
  appendJournal(input.hermesDir, input.projectId, {
    type: "adopt",
    message: `thread adopted from CC session; originalRepoPath=${input.adoption.originalRepoPath}, originalSessionId=${input.adoption.originalSessionId.slice(0, 12)}…`,
  });
  log.info("hermes: project adopted from CC session", {
    projectId: input.projectId,
    threadId: input.threadId,
    repoPath: input.repoPath,
    repoSource: input.repoSource,
    mode: input.mode,
  });
  return state;
}