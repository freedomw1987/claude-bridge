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
import { sendHelp } from "../help";
import type { ProjectRegistry } from "../../projects/registry";
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
  session: { threadId: string },
  store: SessionStore,
): Promise<void> {
  store.setStatus(session.threadId, "killed");
  await msg.reply("🛑 Session killed. Files remain on host.");
}

async function handleStatus(
  msg: Message,
  session: {
    threadId: string;
    repoUrl: string | null;
    localPath: string | null;
    repoPath: string;
    claudeSession: string | null;
    status: string;
    totalMessages: number;
  },
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
  session: { threadId: string } | null,
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
    await handleStatus(msg, session as Parameters<typeof handleStatus>[1], store);
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
