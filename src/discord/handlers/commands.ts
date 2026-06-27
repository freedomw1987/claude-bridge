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
 * Phase 3 (2026-06-27): removed /use-cli and /use-sdk — the CLI runner
 * was retired; every thread runs on the SDK runner unconditionally.
 *
 * `dispatchCommand` routes a content string to the right handler.
 * Returns true if the content was a recognized command (caller should
 * stop further processing); false if it should be forwarded to Claude.
 */

import type { Message } from "discord.js";
import { log } from "../../logger";
import { abortSdkRun } from "../../agent/sdkRunner";
import { sendHelp } from "../help";
import type { ProjectRegistry } from "../../projects/registry";
import type { Session } from "../../types";
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
  // Phase 3: SDK is the only runner. Abort the in-flight query via
  // the SDK's abortSdkRun; the next message in this thread starts a
  // fresh query (and the SDK's session persistence means CC's prior
  // context is on disk; we don't try to wipe it — /kill today is
  // informational).
  const aborted = abortSdkRun(session.threadId);
  if (aborted) {
    log.info("aborted sdk run via /kill", { threadId: session.threadId });
  }
  store.setStatus(session.threadId, "killed");
  await msg.reply("🛑 Session killed. Files remain on host.");
}

async function handleStatus(
  msg: Message,
  session: Session,
  _store: SessionStore,
): Promise<void> {
  const s = _store.get(session.threadId)!;
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
      `• runner: \`sdk\` (CLI retired in Phase 3)\n` +
      `• claude session: ${s.claudeSession ? `\`${s.claudeSession.slice(0, 8)}…\`` : "_none_"}\n` +
      `• messages: ${s.totalMessages}`,
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

  const newTarget = matchRepoCommand(content);
  if (newTarget) {
    await applyTarget(msg, session.threadId, newTarget, store, projects);
    return true;
  }

  return false;
}