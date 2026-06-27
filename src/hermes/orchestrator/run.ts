/**
 * Main orchestrator state machine + per-phase logic.
 *
 * `runProject` is the entry point for a project's lifecycle:
 *
 *   planning ──► executing ──► judging ──► done | failed | killed
 *      │            │              │
 *      └────────────┴──────────────┘
 *          catch: typed errors → dedicated terminal status
 *
 * The loop between executing ↔ judging handles the "judge says
 * needs_more" case: new tasks are appended and the project re-enters
 * executing.
 *
 * On any cap exceeded, status → "failed" and a Discord escalation is
 * posted. David's `/project kill` flips status → "killed" between
 * iterations (the main loop re-reads state.json at the top of every
 * iteration to detect external changes — see RG-007 / RG-008).
 *
 * Phase functions (`doPlanning`, `runOneTask`) are private to this
 * file because they reach into runProject's local state shape.
 */

import { log } from "../../logger";
import { executeTask, type ExecutorDeps } from "../executor";
import {
  PlannerParseError,
  PlannerTimeoutError,
  planProject,
} from "../planner";
import { JudgeParseError, JudgeTimeoutError, judgeProject } from "../judge";
import {
  appendJournal,
  loadState,
  saveState,
} from "../state";
import type { ProjectState, Task } from "../types";
import {
  formatCompletion,
  formatEscalation,
  formatPlanMessage,
  formatTaskDone,
  formatTaskFail,
  formatTaskStart,
  HERMES_PREFIX,
  makeHermesSend,
} from "../discord";
import { TypingIndicator } from "../typing";
import { makeClaudeSend } from "../../discord/handlers/streaming";
import { runManualProject } from "./manual";
import { softExit } from "./lifecycle";
import { checkTimerExpired, pickNextTask, shouldStop } from "./safety";
import type { OrchestratorDeps } from "./types";

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
    // The outer loop covers the full lifecycle. Each iteration is one
    // pass through planning → executing → judging. The judge may add
    // more tasks (verdict="needs_more"); we restart the outer loop to
    // pick them up. Using a loop instead of recursion (B2, 2026-06-27)
    // keeps the call stack bounded — a 5-10 task project no longer grows
    // a stack 5-10 deep.
    const LOOP_GUARD_LIMIT = 100;
    let outerLoopGuard = 0;
    outer: while (true) {
      if (++outerLoopGuard > LOOP_GUARD_LIMIT) {
        log.error("hermes orchestrator: outer loop guard tripped", { projectId });
        state.status = "failed";
        state.endedAt = new Date().toISOString();
        saveState(deps.hermesDir, projectId, state);
        await send(formatEscalation(state, "internal: orchestrator outer loop guard tripped"));
        return;
      }

      // ── 1. Planning ─────────────────────────────────────────────
      if (state.status === "planning") {
        state = await doPlanning(state, deps);
      }

      // ── 2. Executing (inner loop, one task per iteration) ───────
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

      // ── 3. Judging ─────────────────────────────────────────────
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
          // Append new tasks; restart the outer loop to pick them up.
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
          continue outer;  // B2: was a recursive runProject() call
        }
        // "stuck" or "needs_more" without nextTasks
        state.status = "failed";
        state.endedAt = new Date().toISOString();
        saveState(deps.hermesDir, projectId, state);
        await send(formatEscalation(state, `judge says ${verdict.verdict}: ${verdict.reasoning}`));
        return;
      }

      // state.status is not planning / executing / judging — terminal
      // (e.g., resumed into a done/failed/killed project). Nothing to do.
      return;
    }
  } catch (err) {
    log.error("hermes orchestrator: unhandled error", {
      projectId,
      err: String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    // RG-008: distinguish planner timeout from a generic crash. The
    // planner throws PlannerTimeoutError when the LLM call exceeds
    // `config.hermes.plannerTimeoutMs` (default 15min). Map it to a
    // dedicated `timed_out` status + a clean escalation message
    // ("🕐 planner timed out…") rather than the opaque
    // "orchestrator crashed: Claude Code process aborted by user"
    // string we used to see (regression 2026-06-22, 6/6 of the
    // failed projects in /project list exhibited this).
    //
    // RG-010: similarly distinguish planner parse failure (LLM leaked
    // thinking tags, malformed JSON, etc.) into a `parse_error`
    // status.
    //
    // RG-011: mirror the above for the JUDGE. Pre-RG-011, the judge
    // surfaced both opaque errors the user reported.
    const isPlannerTimeout = err instanceof PlannerTimeoutError;
    const isPlannerParseError = err instanceof PlannerParseError;
    const isJudgeTimeout = err instanceof JudgeTimeoutError;
    const isJudgeParseError = err instanceof JudgeParseError;
    state.status = isPlannerTimeout
      ? "timed_out"
      : isPlannerParseError
      ? "parse_error"
      : isJudgeTimeout
      ? "judge_timed_out"
      : isJudgeParseError
      ? "judge_parse_error"
      : "failed";
    state.endedAt = new Date().toISOString();
    saveState(deps.hermesDir, projectId, state);
    // Preserve the raw LLM output in the journal so the failure
    // is debuggable from the project thread without re-running
    // the planner/judge. Cap at 500 chars to keep the journal readable.
    const rawSnippet = (isPlannerParseError && err instanceof PlannerParseError)
      || (isJudgeParseError && err instanceof JudgeParseError)
      ? (isPlannerParseError
          ? (err as PlannerParseError).raw.slice(0, 500)
          : (err as JudgeParseError).raw.slice(0, 500))
      : null;
    appendJournal(deps.hermesDir, projectId, {
      type: "escalate",
      message: isPlannerTimeout
        ? `planner timed out after ${Math.round((err as PlannerTimeoutError).timeoutMs / 1000)}s; project ${state.id.slice(0, 8)} ended in timed_out`
        : isPlannerParseError
        ? `planner output was unparseable as JSON; project ${state.id.slice(0, 8)} ended in parse_error. raw=${JSON.stringify(rawSnippet)}`
        : isJudgeTimeout
        ? `judge timed out after ${Math.round((err as JudgeTimeoutError).timeoutMs / 1000)}s; project ${state.id.slice(0, 8)} ended in judge_timed_out`
        : isJudgeParseError
        ? `judge output was unparseable as JSON; project ${state.id.slice(0, 8)} ended in judge_parse_error. raw=${JSON.stringify(rawSnippet)}`
        : `orchestrator crash: ${String(err).slice(0, 300)}`,
    });
    const escalationMsg = isPlannerTimeout
      ? `🕐 planner timed out after ${Math.round((err as PlannerTimeoutError).timeoutMs / 1000)}s — goal was too complex for the planner LLM. Try /project resume with HERMES_PLANNER_TIMEOUT_MS raised, or split the goal.`
      : isPlannerParseError
      ? `🔧 planner output was unparseable as JSON — the LLM leaked thinking tags or returned malformed JSON. The raw output is in the project journal for inspection. Try /project resume to retry the planner, or simplify the goal.`
      : isJudgeTimeout
      ? `🕐 judge timed out after ${Math.round((err as JudgeTimeoutError).timeoutMs / 1000)}s — the judge LLM took too long to assess the project. Try /project resume to retry the judge.`
      : isJudgeParseError
      ? `🔧 judge output was unparseable as JSON — the LLM leaked thinking tags or returned malformed JSON. The raw output is in the project journal for inspection. Try /project resume to retry the judge.`
      : `orchestrator crashed: ${String(err).slice(0, 200)}`;
    await send(formatEscalation(state, escalationMsg));
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

  // RG-005 / UX-3: wrap with makeClaudeSend so CC replies posted via
  // the SDK's auto-post path get the "🤖 Claude Code:" prefix.
  const claudeSend = makeClaudeSend(deps.thread);

  const execDeps: ExecutorDeps = {
    thread: deps.thread,
    repoPath: state.repoPath,
    claudeSession: deps.resolveClaudeSession
      ? deps.resolveClaudeSession(state.threadId)
      : deps.claudeSession,
    send: claudeSend,
    userMsgStub: deps.userMsgStub,
  };

  const { result } = await executeTask(task, state, execDeps);

  // Re-read disk state BEFORE processing the result. If the user killed
  // the project mid-task, the disk will reflect that and we must NOT
  // overwrite it. Just return the fresh state so the main loop sees
  // the kill on its next check.
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