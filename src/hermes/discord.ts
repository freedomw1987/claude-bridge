/**
 * Hermes Discord helpers — formatting + thread-bound send wrapper.
 *
 * All messages are prefixed with "🪪 Hermes:" so David can distinguish
 * orchestrator output from Claude Code's engineering output in the same
 * thread. The orchestrator never edits messages in place — every status
 * change is a new Discord message, mirroring ADR-0002's streaming
 * architecture (no in-process buffer of text).
 */

import type { ThreadChannel } from "discord.js";
import type { ProjectState, Task } from "./types";

export const HERMES_PREFIX = "🪪 **Hermes:**";

/** Discord limits messages to 2000 chars; split long status into chunks. */
const DISCORD_MAX = 1900;

export function chunkForDiscord(text: string): string[] {
  if (text.length <= DISCORD_MAX) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + DISCORD_MAX));
    i += DISCORD_MAX;
  }
  return chunks;
}

/**
 * Thread-bound send function. Posts each chunk as a separate message,
 * matching the streaming architecture from ADR-0002. Returns the last
 * message posted (the SDK only cares about the Promise resolving).
 */
export function makeHermesSend(thread: ThreadChannel) {
  return async (content: string): Promise<void> => {
    const prefixed = `${HERMES_PREFIX} ${content}`;
    for (const chunk of chunkForDiscord(prefixed)) {
      await thread.send(chunk);
    }
  };
}

export function formatPlanMessage(state: ProjectState): string {
  const lines: string[] = [];
  lines.push(`📋 **Plan ready** — ${state.plan.length} tasks for: *${state.goal}*`);
  lines.push("");
  for (const t of state.plan) {
    const deps = t.dependsOn.length > 0 ? ` _(after ${t.dependsOn.join(", ")})_` : "";
    lines.push(`- **${t.id}** ${t.title}${deps}`);
  }
  lines.push("");
  lines.push(`⏳ Starting execution (mode=${state.mode}, budget=$${(state.config.maxCostUsd / 100).toFixed(2)}, max iters=${state.config.maxIterations})...`);
  return lines.join("\n");
}

export function formatTaskStart(state: ProjectState, task: Task): string {
  const idx = state.plan.indexOf(task) + 1;
  const total = state.plan.length;
  return [
    `▶️ **Task ${idx}/${total}: ${task.id}** ${task.title}` +
      (task.attempts > 1 ? ` (attempt ${task.attempts})` : ""),
    `> ${task.description}`,
  ].join("\n");
}

export function formatTaskDone(
  state: ProjectState,
  task: Task,
  details: { durationMs: number; costUsd: number },
): string {
  const done = state.plan.filter((t) => t.status === "done").length;
  const total = state.plan.length;
  return [
    `✅ **${task.id} done** in ${formatDuration(details.durationMs)} ($${(details.costUsd / 100).toFixed(2)})`,
    `Progress: ${done}/${total} (${Math.round((done / total) * 100)}%) | Total $${(state.costUsd / 100).toFixed(2)} | ${state.iterations} iter`,
  ].join("\n");
}

export function formatTaskFail(
  task: Task,
  error: string,
  willRetry: boolean,
): string {
  return [
    `❌ **${task.id} failed** (attempt ${task.attempts})`,
    `> ${error.slice(0, 300)}`,
    willRetry ? `⏳ Will retry...` : `🚫 No more retries; escalating.`,
  ].join("\n");
}

export function formatCompletion(state: ProjectState): string {
  const elapsed = state.endedAt
    ? Math.round(
        (new Date(state.endedAt).getTime() - new Date(state.startedAt).getTime()) /
          60000,
      )
    : 0;
  const done = state.plan.filter((t) => t.status === "done").length;
  return [
    `🎉 **Project complete** in ${elapsed} min, $${(state.costUsd / 100).toFixed(2)} spent.`,
    `Tasks: ${done}/${state.plan.length} done, ${state.iterations} total iterations.`,
    ``,
    `Verdict: ${state.lastVerdict?.reasoning ?? "(no verdict recorded)"}`,
    ``,
    `📂 Workspace: \`${state.repoPath}\``,
  ].join("\n");
}

export function formatEscalation(state: ProjectState, reason: string): string {
  return [
    `⚠️ **Project escalated to David**`,
    `Reason: ${reason}`,
    ``,
    `Reply in this thread to give direction, or send \`/project kill\` to stop.`,
    `Workspace: \`${state.repoPath}\``,
  ].join("\n");
}

export function formatStatusEmbed(state: ProjectState): string {
  const done = state.plan.filter((t) => t.status === "done").length;
  const failed = state.plan.filter((t) => t.status === "failed").length;
  const inProg = state.plan.filter((t) => t.status === "in_progress").length;
  const pending = state.plan.filter((t) => t.status === "pending").length;
  const elapsed = Math.round(
    (Date.now() - new Date(state.startedAt).getTime()) / 60000,
  );
  return [
    `📊 **Project status: ${state.id.slice(0, 8)}**`,
    `Status: \`${state.status}\` | Mode: \`${state.mode}\``,
    `Tasks: ${done} done, ${inProg} in progress, ${pending} pending, ${failed} failed (${state.plan.length} total)`,
    `Cost: $${(state.costUsd / 100).toFixed(2)} / $${(state.config.maxCostUsd / 100).toFixed(2)} | Iterations: ${state.iterations} / ${state.config.maxIterations} | Elapsed: ${elapsed} min / ${state.config.maxWallHours}h`,
    `Workspace: \`${state.repoPath}\``,
  ].join("\n");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}