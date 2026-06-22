/**
 * Hermes executor — invokes Claude Code (via the SDK runner) to perform
 * one task. Wraps `runViaSdk` from `src/agent/sdkRunner.ts` so Hermes
 * gets task-shaped semantics (attempts, lastError, lastResult).
 *
 * The task prompt embeds the project goal + previous task summaries so
 * Claude Code has enough context to understand "what am I working on".
 * Claude Code's own session persistence (--resume) handles intra-task
 * continuity across Hermes's retries.
 */

import type { ThreadChannel, Message } from "discord.js";
import { runViaSdk, type SdkRunResult } from "../agent/sdkRunner";
import type { ProjectState, Task } from "./types";
import { log } from "../logger";
import type { PrefixedSend } from "../discord/handlers/streaming";

export interface ExecutorDeps {
  thread: ThreadChannel;
  repoPath: string;
  claudeSession: string | null;
  // RG-005: branded type — must be the result of `makeClaudeSend(thread, queue?)`.
  send: PrefixedSend;
  /**
   * Optional stub for runViaSdk's first arg. The SDK currently ignores
   * this argument entirely (see src/agent/sdkRunner.ts: `void userMsg`),
   * but the type signature requires a Message. For resume-on-startup
   * we don't have a real Message in hand, so this is optional and a
   * dummy is synthesized when absent.
   */
  userMsgStub?: Message;
}

export interface ExecuteResult {
  result: SdkRunResult;
  costDelta: number; // in cents
}

export async function executeTask(
  task: Task,
  state: ProjectState,
  deps: ExecutorDeps,
): Promise<ExecuteResult> {
  const prompt = buildTaskPrompt(task, state);
  log.info("hermes executor: starting task", {
    projectId: state.id,
    taskId: task.id,
    attempt: task.attempts,
    repoPath: deps.repoPath,
    promptLen: prompt.length,
  });

  const startedAt = Date.now();
  let result: SdkRunResult;
  try {
    // runViaSdk's first arg is typed Message but currently unused. For
    // resume-on-startup we don't have a real Message; synthesize a
    // channel-castable stub so types are happy. The stub is never read.
    const userMsg = deps.userMsgStub ?? (deps.thread as unknown as Message);
    result = await runViaSdk(
      userMsg,
      deps.thread,
      prompt,
      {
        threadId: state.threadId,
        claudeSession: deps.claudeSession,
        repoPath: deps.repoPath,
      },
      deps.send,
    );
  } catch (err) {
    log.error("hermes executor: runViaSdk threw", {
      projectId: state.id,
      taskId: task.id,
      err: String(err),
    });
    // Synthesize an error result so the orchestrator can handle uniformly.
    result = {
      sessionId: deps.claudeSession ?? "",
      durationMs: Date.now() - startedAt,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      isError: true,
      errorMessage: String(err),
      aborted: false,
      toolCallCount: 0,
      numTurns: 0,
    };
  }

  log.info("hermes executor: task finished", {
    projectId: state.id,
    taskId: task.id,
    isError: result.isError,
    durationMs: result.durationMs,
    costUsd: result.costUsd,
    numTurns: result.numTurns,
    toolCallCount: result.toolCallCount,
  });

  return {
    result,
    costDelta: result.costUsd,
  };
}

function buildTaskPrompt(task: Task, state: ProjectState): string {
  const completed = state.plan.filter((t) => t.status === "done");
  const failed = state.plan.filter((t) => t.status === "failed");

  const completedSection = completed.length > 0
    ? completed.map((t) => `- ${t.id}: ${t.title}`).join("\n")
    : "(none yet — this may be the first task)";

  const failedSection = failed.length > 0
    ? failed.map((t) => `- ${t.id}: ${t.title} — ${t.lastError?.slice(0, 200) ?? "unknown error"}`).join("\n")
    : "";

  const retrySection = task.attempts > 1
    ? `\n## Retry Context\nThis is attempt ${task.attempts}. Previous attempt failed with:\n${task.lastError?.slice(0, 500) ?? "(no error message captured)"}\nPlease address that and try again.\n`
    : "";

  return [
    `# Project Goal`,
    state.goal,
    ``,
    `# Your Task (${task.id})`,
    task.title,
    ``,
    `> ${task.description}`,
    ``,
    `# Workspace`,
    `Working directory: \`${state.repoPath}\``,
    `Project mode: ${state.mode} (auto = full autonomy; manual = David is watching)`,
    ``,
    `# Already Completed`,
    completedSection,
    failedSection ? `\n# Failed Tasks (so you know what NOT to repeat)\n${failedSection}` : "",
    retrySection,
    `# Instructions`,
    `1. Implement the task above in the working directory.`,
    `2. Use the discord_send tool to post status updates as you work — David is watching.`,
    `3. Run any relevant tests/checks to verify your work.`,
    `4. When done, give a concise summary in the thread using discord_send.`,
    `5. If blocked, say so clearly and stop.`,
  ].join("\n");
}