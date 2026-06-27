/**
 * Manual-mode project runner.
 *
 * In manual mode, Hermes does NOT plan / decompose / judge. Instead,
 * the whole goal is passed directly to Claude Code as a single prompt
 * — the same flow as the existing `@bot <prompt>` mention, but
 * invoked via `/project start --mode=manual`.
 *
 * After Claude Code finishes, the thread continues to work via the
 * existing `forwardToClaude` flow (David can send follow-up messages
 * and the SDK resumes the session). Hermes state stays in sync for
 * `/project status` and `/project kill` (kill aborts the in-flight run).
 */

import { log } from "../../logger";
import { loadState } from "../state";
import { makeClaudeSend } from "../../discord/handlers/streaming";
import { executeTask, type ExecutorDeps } from "../executor";
import { makeHermesSend } from "../discord";
import {
  formatCompletion,
  formatEscalation,
  formatTaskStart,
  HERMES_PREFIX,
} from "../discord";
import type { OrchestratorDeps } from "./types";

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

  // Manual mode treats the whole goal as one task. We synthesize a
  // single-task plan so status / kill semantics are uniform with auto mode.
  if (state.plan.length === 0) {
    state.plan = [
      {
        id: "m1",
        title: state.goal.slice(0, 120),
        description: state.goal,
        status: "in_progress",
        attempts: 1,
        dependsOn: [],
      },
    ];
  }
  const task = state.plan[0];
  task.status = "in_progress";
  task.attempts = 1;
  state.iterations = 1;
  state.status = "executing";
  state.currentTaskId = task.id;

  // Save initial state before running so a crash mid-run leaves a
  // recoverable record.
  // (use state.ts saveState)

  await deps.thread.send(formatTaskStart(state, task));

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

  let result;
  try {
    const execResult = await executeTask(task, state, execDeps);
    result = execResult.result;
  } catch (err) {
    log.error("hermes manual: executeTask crashed", {
      projectId,
      err: String(err),
    });
    state.status = "failed";
    state.endedAt = new Date().toISOString();
    state.currentTaskId = null;
    await deps.thread.send(formatEscalation(state, `manual run crashed: ${String(err).slice(0, 200)}`));
    return;
  }

  state.costUsd += result.costUsd;
  task.status = result.isError ? "failed" : "done";
  state.currentTaskId = null;
  if (result.isError) {
    state.status = "failed";
    state.endedAt = new Date().toISOString();
    await deps.thread.send(formatEscalation(state, `manual run failed: ${result.errorMessage ?? "unknown"}`));
    return;
  }
  state.status = "done";
  state.endedAt = new Date().toISOString();
  await deps.thread.send(formatCompletion(state));
  await send(`${HERMES_PREFIX} ✅ Manual run complete.`);
}