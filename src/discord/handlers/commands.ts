/**
 * Slash command matchers + handlers for thread replies.
 *
 * Commands:
 *   /kill   — stop the running session
 *   /status — show session info
 *   /projects — list known projects
 *   /help   — show usage
 *   /repo <url|path|name> — change target
 *
 * `dispatchCommand` routes a content string to the right handler.
 * Returns true if the content was a recognized command (caller should
 * stop further processing); false if it should be forwarded to Claude.
 */

import type { Message } from "discord.js";
import { log } from "../../logger";
import { abortSdkRun, isSdkRunActive } from "../../agent/sdkRunner";
import { sendHelp } from "../help";
import type { ProjectRegistry } from "../../projects/registry";
import type { RunnerKind, Session } from "../../types";
import type { SessionStore } from "../../db";
import { sendProjectsList, applyTarget } from "./targets";

// ---- Matchers (exported for testability) ----

export const isKillCommand = (content: string): boolean =>
  /^\/kill\b/i.test(content.trim());

export const isStatusCommand = (content: string): boolean =>
  /^\/status\b/i.test(content.trim());

export const isProjectsCommand = (content: string): boolean =>
  /^\/projects\b/i.test(content.trim());

export const isHelpCommand = (content: string): boolean =>
  /^\/help\b/i.test(content.trim());

export const isUseCliCommand = (content: string): boolean =>
  /^\/use-cli\b/i.test(content.trim());

export const isUseSdkCommand = (content: string): boolean =>
  /^\/use-sdk\b/i.test(content.trim());

export const matchRepoCommand = (content: string): string | null => {
  const m = content.match(/^\/repo\s+(\S+)/i);
  return m ? m[1] : null;
};

// ---- Individual handlers (exported for direct testing if needed) ----

async function handleKill(
  msg: Message,
  session: Session,
  store: SessionStore,
): Promise<void> {
  // For the SDK path, additionally abort the in-flight query if any.
  // The next message in this thread will start a fresh query (and the
  // SDK's session persistence means CC's prior context is on disk; we
  // don't try to wipe it — /kill today is informational).
  if (session.runnerKind === "sdk") {
    const aborted = abortSdkRun(session.threadId);
    if (aborted) {
      log.info("aborted sdk run via /kill", { threadId: session.threadId });
    }
  }
  store.setStatus(session.threadId, "killed");
  await msg.reply("🛑 Session killed. Files remain on host.");
}

async function handleStatus(
  msg: Message,
  session: Session,
  store: SessionStore,
): Promise<void> {
  const s = store.get(session.threadId)!;
  const target = s.repoUrl
    ? `URL: ${s.repoUrl}`
    : s.localPath
      ? `Local: \`${s.localPath}\``
      : "_none_";
  await msg.reply(
    "**Session status**\n" +
      `• thread: \`${s.threadId}\`\n` +
      `• status: \`${s.status}\`\n` +
      `• target: ${target}\n` +
      `• work dir: \`${s.repoPath}\`\n` +
      `• runner: \`${s.runnerKind}\`\n` +
      `• claude session: ${s.claudeSession ? `\`${s.claudeSession.slice(0, 8)}…\`` : "_none_"}\n` +
      `• messages: ${s.totalMessages}`,
  );
}

/**
 * Phase 2: switch a session to the CLI runner (legacy `claude -p`).
 * Takes effect on the next message in this thread. If a CLI subprocess is
 * currently in flight we don't try to kill it — it self-terminates.
 */
async function handleUseCli(
  msg: Message,
  session: Session,
  store: SessionStore,
): Promise<void> {
  if (session.runnerKind === "cli") {
    await msg.reply("🔧 This thread is already on the **CLI runner**.");
    return;
  }
  // If an SDK run is in-flight on this thread, abort it so the next
  // message picks up the new runner immediately.
  if (isSdkRunActive(session.threadId)) {
    abortSdkRun(session.threadId);
    log.info("aborted sdk run before switching to cli", {
      threadId: session.threadId,
    });
  }
  store.setRunnerKind(session.threadId, "cli");
  await msg.reply(
    "🔧 Switched this thread to **CLI runner** (legacy `claude -p` subprocess). " +
      "Next message will use the streaming chunks UX.",
  );
}

/**
 * Phase 2: switch a session to the SDK runner (Claude Agent SDK).
 * Takes effect on the next message in this thread.
 */
async function handleUseSdk(
  msg: Message,
  session: Session,
  store: SessionStore,
): Promise<void> {
  if (session.runnerKind === "sdk") {
    await msg.reply("🚀 This thread is already on the **SDK runner**.");
    return;
  }
  // If an SDK run is in-flight on this thread, abort it. (Unusual since
  // the previous runner was CLI, but safe to call.)
  if (isSdkRunActive(session.threadId)) {
    abortSdkRun(session.threadId);
  }
  store.setRunnerKind(session.threadId, "sdk");
  await msg.reply(
    "🚀 Switched this thread to **SDK runner** (Claude Agent SDK + Discord tools). " +
      "Next message will use the new tool-calling UX.",
  );
}

// ---- Dispatcher ----

export interface CommandContext {
  msg: Message;
  store: SessionStore;
  projects: ProjectRegistry;
}

/**
 * Try to handle the message as a slash command.
 * Returns true if handled (caller should stop further processing).
 * Returns false if the message is not a recognized command and should
 * be forwarded to Claude.
 */
export async function dispatchCommand(
  content: string,
  session: Session | null,
  ctx: CommandContext,
): Promise<boolean> {
  const { msg, store, projects } = ctx;

  // Commands that don't require a session
  if (isHelpCommand(content)) {
    await sendHelp(msg);
    return true;
  }

  // Commands below require an active session
  if (!session) return false;

  if (isKillCommand(content)) {
    await handleKill(msg, session, store);
    return true;
  }

  if (isStatusCommand(content)) {
    await handleStatus(msg, session, store);
    return true;
  }

  if (isProjectsCommand(content)) {
    await sendProjectsList(msg, projects);
    return true;
  }

  if (isUseCliCommand(content)) {
    await handleUseCli(msg, session, store);
    return true;
  }

  if (isUseSdkCommand(content)) {
    await handleUseSdk(msg, session, store);
    return true;
  }

  const newTarget = matchRepoCommand(content);
  if (newTarget) {
    await applyTarget(msg, session.threadId, newTarget, store, projects);
    return true;
  }

  return false;
}

// Helper for type narrowing if a caller wants a strongly-typed RunnerKind.
export const isRunnerKind = (v: unknown): v is RunnerKind =>
  v === "cli" || v === "sdk";

