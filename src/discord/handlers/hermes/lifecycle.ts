/**
 * In-thread Hermes commands (status / plan / kill / resume) and the
 * channel-level list command.
 *
 * These are smaller handlers with relatively little logic each — keeping
 * them in one file avoids the overhead of a 30-line module per command.
 * If any of these grow beyond ~150 lines, split them out.
 */

import type { Message, ThreadChannel } from "discord.js";
import { config } from "../../../config";
import { log } from "../../../logger";
import {
  appendJournal,
  listProjects,
  resolveHermesDir,
  saveState,
} from "../../../hermes/state";
import { HERMES_PREFIX } from "../../../hermes/discord";
import { formatPlanMessage, formatStatusEmbed } from "../../../hermes/discord";
import { runProject } from "../../../hermes/orchestrator";
import { abortSdkRun, isSdkRunActive } from "../../../agent/sdkRunner";
import { findProjectByThread } from "./helpers";
import type { SessionStore } from "../../../db";

// ── /project status ───────────────────────────────────────────────────

export async function handleProjectStatus(
  msg: Message,
  threadId: string,
): Promise<void> {
  const hermesDir = resolveHermesDir(config.paths.dataDir, config.paths.hermesDir);
  const state = findProjectByThread(hermesDir, threadId);
  if (!state) {
    await msg.reply(`❌ No Hermes project in this thread.`);
    return;
  }
  await msg.reply(formatStatusEmbed(state));
}

// ── /project plan ─────────────────────────────────────────────────────

export async function handleProjectPlan(
  msg: Message,
  threadId: string,
): Promise<void> {
  const hermesDir = resolveHermesDir(config.paths.dataDir, config.paths.hermesDir);
  const state = findProjectByThread(hermesDir, threadId);
  if (!state) {
    await msg.reply(`❌ No Hermes project in this thread.`);
    return;
  }
  if (state.plan.length === 0) {
    await msg.reply(`📋 Plan not generated yet (status=${state.status}).`);
    return;
  }
  await msg.reply(formatPlanMessage(state));
}

// ── /project kill ─────────────────────────────────────────────────────

export async function handleProjectKill(
  msg: Message,
  threadId: string,
): Promise<void> {
  const hermesDir = resolveHermesDir(config.paths.dataDir, config.paths.hermesDir);
  const state = findProjectByThread(hermesDir, threadId);
  if (!state) {
    await msg.reply(`❌ No Hermes project in this thread.`);
    return;
  }
  if (state.status === "done" || state.status === "failed" || state.status === "killed" || state.status === "timed_out") {
    await msg.reply(`Project is already \`${state.status}\`.`);
    return;
  }
  // RG-008 (regression 2026-06-22): the previous implementation set
  // `state.status = "killed"` and `state.endedAt` but never
  // populated `state.killedReason`. The downstream consumers
  // (`formatStatusEmbed`, `/project status`, journal reads) then
  // showed `killedReason: undefined` for user-initiated kills,
  // indistinguishable from duration_expired / manual_switch /
  // superseded_by_X. Fix: write "user_kill" so the audit trail
  // distinguishes the four kill paths. (The other three paths
  // already write their own killedReason in softExit, in
  // handleProjectAdopt, and the duration_expired branch in
  // softExit.) Also append a journal entry so the kill is
  // visible in the audit log with a structured message instead
  // of leaving a silent state transition.
  state.status = "killed";
  state.killedReason = "user_kill";
  state.endedAt = new Date().toISOString();
  state.currentTaskId = null;
  saveState(hermesDir, state.id, state);
  appendJournal(hermesDir, state.id, {
    type: "status",
    message: `user typed /project kill (threadId=${threadId})`,
  });
  // Also abort any in-flight SDK run on this thread so the current
  // Claude Code task stops sooner (instead of running to completion).
  // The orchestrator's main loop also re-reads state.json between
  // iterations, so even without this abort the next iteration would
  // see the killed status and exit; the abort just makes the UX
  // feel snappier.
  const aborted = isSdkRunActive(threadId) ? abortSdkRun(threadId) : false;
  await msg.reply(
    `🛑 Project \`${state.id.slice(0, 8)}\` marked killed.${aborted ? " Aborted current task." : ""}`,
  );
  log.info("hermes: project killed by user", {
    projectId: state.id,
    threadId,
    inFlightAbort: aborted,
  });
}

// ── /project resume ───────────────────────────────────────────────────

export async function handleProjectResume(
  msg: Message,
  threadId: string,
  thread: ThreadChannel,
  store: SessionStore,
): Promise<void> {
  const hermesDir = resolveHermesDir(config.paths.dataDir, config.paths.hermesDir);
  const state = findProjectByThread(hermesDir, threadId);
  if (!state) {
    await msg.reply(`❌ No Hermes project in this thread.`);
    return;
  }
  if (
    state.status !== "killed"
    && state.status !== "failed"
    && state.status !== "timed_out"
    // RG-010: parse_error is a planner failure, not a runtime
    // failure. /project resume should be able to retry the
    // planner (which may succeed the second time if the LLM
    // happened to leak thinking tags the first time).
    && state.status !== "parse_error"
  ) {
    await msg.reply(`Project is \`${state.status}\`; nothing to resume.`);
    return;
  }
  // Reset to executing; orchestrator will pick up where it left off.
  state.status = "executing";
  state.endedAt = null;
  saveState(hermesDir, state.id, state);

  const session = store.get(threadId);
  await msg.reply(`${HERMES_PREFIX} 🔄 Resuming project...`);
  runProject(state.id, {
    hermesDir,
    thread,
    claudeSession: session?.claudeSession ?? null,
    userMsgStub: msg,
  }).catch((err) => {
    log.error("hermes: resumed project crashed", {
      projectId: state.id,
      err: String(err),
    });
  });
}

// ── /project list ─────────────────────────────────────────────────────

export async function handleProjectList(msg: Message): Promise<void> {
  const hermesDir = resolveHermesDir(config.paths.dataDir, config.paths.hermesDir);
  const all = listProjects(hermesDir);
  if (all.length === 0) {
    await msg.reply("📭 No Hermes projects yet.");
    return;
  }
  const lines = [`📋 **Hermes projects (${all.length}):**`];
  for (const s of all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const done = s.plan.filter((t) => t.status === "done").length;
    const total = s.plan.length;
    lines.push(
      `- \`${s.id.slice(0, 8)}\` ${s.status} | ${done}/${total} tasks | $${(s.costUsd / 100).toFixed(2)} | "${s.goal.slice(0, 50)}"`,
    );
  }
  await msg.reply(lines.join("\n"));
}