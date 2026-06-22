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
import { formatCountdown } from "./duration";

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

/**
 * Hermes metadata is condensed into single-line summaries so Claude Code's
 * engineering output stays the visual focus in the thread (UX-3). Each
 * helper returns ONE line that fits well under the Hermes prefix. Verdict
 * reasoning is intentionally truncated — full text is on disk in state.json
 * for `/project status` and audit.
 */

export function formatPlanMessage(state: ProjectState): string {
  const budget = `$${(state.config.maxCostUsd / 100).toFixed(2)}`;
  return `📋 Plan: ${state.plan.length} tasks (mode=${state.mode}, budget=${budget}, max iters=${state.config.maxIterations}) → starting execution`;
}

export function formatTaskStart(state: ProjectState, task: Task): string {
  const idx = state.plan.indexOf(task) + 1;
  const total = state.plan.length;
  const attempt = task.attempts > 1 ? ` attempt ${task.attempts}` : "";
  return `▶️ ${idx}/${total} ${task.id}${attempt}`;
}

export function formatTaskDone(
  state: ProjectState,
  task: Task,
  details: { durationMs: number; costUsd: number },
): string {
  const done = state.plan.filter((t) => t.status === "done").length;
  const total = state.plan.length;
  const cost = `$${(details.costUsd / 100).toFixed(2)}`;
  const totalCost = `$${(state.costUsd / 100).toFixed(2)}`;
  return `✅ ${task.id} ${formatDuration(details.durationMs)} ${cost} (${done}/${total} • ${totalCost} • ${state.iterations} iter)`;
}

export function formatTaskFail(
  task: Task,
  error: string,
  willRetry: boolean,
): string {
  const tail = willRetry ? "retrying" : "escalating";
  const errShort = truncateInline(error, 80);
  return `❌ ${task.id} attempt ${task.attempts}: ${errShort} → ${tail}`;
}

// Note: formatTaskFail intentionally omits state — the per-task error
// is self-contained and the single-line format doesn't need aggregate
// progress. Keep state out of the signature so the caller can't
// accidentally inflate the format back to multi-line.

export function formatCompletion(state: ProjectState): string {
  const elapsed = state.endedAt
    ? Math.round(
        (new Date(state.endedAt).getTime() - new Date(state.startedAt).getTime()) /
          60000,
      )
    : 0;
  const done = state.plan.filter((t) => t.status === "done").length;
  const totalCost = `$${(state.costUsd / 100).toFixed(2)}`;
  const verdict = truncateInline(state.lastVerdict?.reasoning ?? "", 100);
  return `🎉 done ${done}/${state.plan.length} ${elapsed}m ${totalCost} • ${state.iterations} iter • ${verdict}`;
}

export function formatEscalation(state: ProjectState, reason: string): string {
  // state kept in signature for symmetry with formatCompletion; future
  // expansion (e.g. showing iteration count in escalation) may use it.
  void state;
  return `⚠️ escalated: ${truncateInline(reason, 120)} — reply or \`/project kill\``;
}

/**
 * Inline truncation: collapse multi-line error strings into a single line
 * with whitespace collapsed, capped at max chars. Keeps the single-line
 * format promise for collapsed Hermes metadata.
 */
function truncateInline(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1) + "…";
}

/**
 * When `state.timer` is set, render a one-line countdown summary for the
 * status embed. Three states:
 *  - Active (expiresAt > now): `⏱ Timer: 29:30 remaining (auto, 30m)`
 *  - Expired but not yet collected (expiresAt <= now, still present in
 *    state): `⏱ Timer: expired (will stop at next judge pass)`
 *  - No timer / cleared: undefined → caller omits the line.
 */
function formatTimerLine(state: ProjectState): string | undefined {
  if (!state.timer) return undefined;
  const remainingMs = state.timer.expiresAt - Date.now();
  if (remainingMs > 0) {
    return `⏱ Timer: ${formatCountdown(remainingMs)} remaining (${state.mode}, ${state.timer.requestedDuration})`;
  }
  return `⏱ Timer: expired (will stop at next judge pass)`;
}

export function formatStatusEmbed(state: ProjectState): string {
  const done = state.plan.filter((t) => t.status === "done").length;
  const failed = state.plan.filter((t) => t.status === "failed").length;
  const inProg = state.plan.filter((t) => t.status === "in_progress").length;
  const pending = state.plan.filter((t) => t.status === "pending").length;
  const elapsed = Math.round(
    (Date.now() - new Date(state.startedAt).getTime()) / 60000,
  );
  const timerLine = formatTimerLine(state);
  const cost = `$${(state.costUsd / 100).toFixed(2)}`;
  const budget = `$${(state.config.maxCostUsd / 100).toFixed(2)}`;
  const parts = [
    `📊 status=${state.status} mode=${state.mode}`,
    `tasks: ${done}✓ ${inProg}▶ ${pending}… ${failed}✗ / ${state.plan.length}`,
    `cost: ${cost}/${budget} • iter: ${state.iterations}/${state.config.maxIterations} • ${elapsed}m/${state.config.maxWallHours}h`,
  ];
  if (timerLine) parts.push(timerLine);
  return parts.join("\n");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * Format the message posted when an auto-mode timer expires (ADR-0004).
 * The state passed in is post-softExit — status is `killed` and
 * `killedReason === "duration_expired"`. We don't have `state.timer`
 * anymore (cleared by softExit), so we show the project's elapsed time
 * and encourage /project resume without the old timer.
 */
export function formatTimerExpired(state: ProjectState): string {
  const elapsed = state.endedAt
    ? Math.round(
        (new Date(state.endedAt).getTime() - new Date(state.startedAt).getTime()) /
          60000,
      )
    : 0;
  const done = state.plan.filter((t) => t.status === "done").length;
  return `⏱ duration elapsed — stopped at judge pass (${done}/${state.plan.length} done, ${elapsed}m). Use \`/project resume\` or \`/project setMode auto <dur>\` to continue`;
}
