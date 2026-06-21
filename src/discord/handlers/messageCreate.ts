/**
 * messageCreate handler — entry point + orchestrator.
 *
 * Two main branches:
 *   - Thread reply: dispatch as a slash command, or forward to Claude
 *   - Top-level mention: parse target, create thread, start Claude run
 *
 * Per-branch logic is split across:
 *   - commands.ts   — /kill, /status, /projects, /help, /repo
 *   - targets.ts    — project list, target resolution, repo clone
 *   - streaming.ts  — Claude subprocess + Discord streaming
 *   - format.ts     — text/tool formatting helpers
 *
 * This file stays small (orchestration only) so the high-level flow is
 * readable at a glance.
 */

import type { Message, ThreadChannel } from "discord.js";
import { config } from "../../config";
import { log } from "../../logger";
import { existsSync, mkdirSync } from "node:fs";
import {
  parseMention,
  isValidRepoUrl,
  isValidLocalPath,
  isValidProjectName,
} from "../parser";
import { taskRepoPath } from "../../utils/path";
import type { SessionStore } from "../../db";
import type { ProjectRegistry } from "../../projects/registry";
import { sendHelp, EMPTY_PROMPT_TEXT, NO_TARGET_TEXT, NO_SESSION_TEXT } from "../help";
import { dispatchCommand } from "./commands";
import { ensureRepoReady } from "./targets";
import { forwardToClaude } from "./streaming";

interface HandlerDeps {
  store: SessionStore;
  projects: ProjectRegistry;
}

const isMentioningBot = (msg: Message, botUserId: string): boolean => {
  if (msg.mentions.users.size === 0) return false;
  return msg.mentions.users.has(botUserId);
};

/**
 * Top-level message handler. Routes to one of two flows:
 *   A. Thread reply → command dispatch, or forward to Claude
 *   B. Top-level mention → resolve target, create thread, start Claude
 */
export async function handleMessageCreate(
  msg: Message,
  deps: HandlerDeps,
): Promise<void> {
  const { store, projects } = deps;

  if (msg.author.bot) {
    log.debug("ignored: bot author", { authorId: msg.author.id });
    return;
  }
  if (msg.author.id !== config.discord.allowedUserId) {
    log.debug("ignored: unauthorized user", { authorId: msg.author.id });
    return;
  }

  // Channel gate: either a top-level message in the configured channel,
  // or any message in a thread whose parent is the configured channel.
  const inConfiguredChannel = msg.channelId === config.discord.channelId;
  const inThreadOfChannel =
    msg.channel.isThread() &&
    msg.channel.parentId === config.discord.channelId;
  if (!inConfiguredChannel && !inThreadOfChannel) {
    log.debug("ignored: wrong channel", {
      channelId: msg.channelId,
      parentId: msg.channel.isThread() ? msg.channel.parentId : null,
    });
    return;
  }

  log.debug("message received", {
    channelId: msg.channelId,
    isThread: msg.channel.isThread(),
    isMention: msg.mentions.users.size > 0,
    contentPreview: msg.content.slice(0, 80),
  });

  const botUserId = msg.client.user!.id;

  // Case A: thread reply — try command dispatch first, then forward
  if (
    msg.channel.isThread() &&
    msg.channel.parentId === config.discord.channelId
  ) {
    const session = store.get(msg.channel.id);
    if (!session) {
      // No session in this thread — it wasn't started by claude-bridge.
      // Help works without a session; everything else needs one.
      if (msg.content.trim().match(/^\/help\b/i)) {
        await sendHelp(msg);
        return;
      }
      await msg.reply(NO_SESSION_TEXT);
      return;
    }

    const handled = await dispatchCommand(msg.content, session, {
      msg,
      store,
      projects,
    });
    if (handled) return;

    await forwardToClaude(
      msg,
      msg.channel as ThreadChannel,
      msg.content,
      session,
      store,
    );
    return;
  }

  // Case B: top-level mention
  if (!isMentioningBot(msg, botUserId)) {
    log.debug("ignored: no mention in channel");
    return;
  }

  const parsed = parseMention(msg.content, botUserId, { projects });
  log.info("received mention", {
    threadName: parsed.threadName,
    repoUrl: parsed.repoUrl,
    localPath: parsed.localPath,
    newProject: parsed.newProject,
    promptLen: parsed.prompt.length,
  });

  // Empty prompt: just @bot with no content. Don't create a useless thread.
  if (
    parsed.prompt.trim() === "" &&
    !parsed.newProject &&
    !parsed.repoUrl &&
    !parsed.localPath
  ) {
    log.info("empty prompt — sending usage hint");
    await msg.reply(EMPTY_PROMPT_TEXT);
    return;
  }

  let resolvedLocalPath: string | null = null;

  if (parsed.newProject) {
    if (!isValidProjectName(parsed.newProject)) {
      await msg.reply(
        `❌ Invalid project name: \`${parsed.newProject}\` (use letters, digits, ., _, -; max 64 chars)`,
      );
      return;
    }
    const exists = existsSync(parsed.localPath!);
    if (exists) {
      await msg.reply(
        `❌ \`${parsed.localPath}\` already exists.\n` +
          `To use the existing project, write: \`@bot in ${parsed.newProject} <prompt>\``,
      );
      return;
    }
    mkdirSync(parsed.localPath!, { recursive: true });
    try {
      const proc = Bun.spawn({
        cmd: ["git", "init", parsed.localPath!],
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
    } catch (err) {
      log.warn("git init failed (non-fatal)", { err: String(err) });
    }
    resolvedLocalPath = parsed.localPath!;
  } else if (parsed.repoUrl) {
    if (!isValidRepoUrl(parsed.repoUrl)) {
      await msg.reply(`❌ Not a valid repo URL: \`${parsed.repoUrl}\``);
      return;
    }
  } else if (parsed.localPath) {
    const v = isValidLocalPath(parsed.localPath);
    if (!v.ok) {
      await msg.reply(`❌ Invalid path: ${v.error}`);
      return;
    }
    resolvedLocalPath = v.resolved!;
  }

  let thread;
  try {
    thread = await msg.startThread({
      name: parsed.threadName,
      autoArchiveDuration: 60,
      reason: "claude-bridge task thread",
    });
  } catch (err) {
    log.error("failed to create thread", { err: String(err) });
    await msg.reply("❌ Failed to create thread.");
    return;
  }

  const repoPath = resolvedLocalPath
    ? resolvedLocalPath
    : taskRepoPath(config.paths.tasksRoot, thread.id);

  const session = store.create({
    threadId: thread.id,
    channelId: config.discord.channelId,
    repoUrl: parsed.repoUrl,
    localPath: parsed.localPath,
    repoPath,
  });

  log.info("session created", {
    threadId: session.threadId,
    repoPath: session.repoPath,
    newProject: parsed.newProject,
  });

  const lines: string[] = [
    "✅ **Thread ready**",
    `Session: \`${session.threadId}\``,
  ];
  if (parsed.newProject) {
    lines.push(`🆕 New project: **${parsed.newProject}**`);
    lines.push(`Work dir: \`${repoPath}\` (created + git init'd)`);
  } else if (parsed.repoUrl) {
    lines.push(`Repo: ${parsed.repoUrl}`);
    lines.push(`Work dir: \`${repoPath}\` (will be cloned)`);
  } else if (resolvedLocalPath) {
    lines.push(`Local: \`${parsed.localPath}\``);
    lines.push(`Work dir: \`${resolvedLocalPath}\``);
  } else {
    lines.push(NO_TARGET_TEXT);
  }
  lines.push("", "⏳ Starting Claude Code...");
  await thread.send(lines.join("\n"));

  if (parsed.repoUrl) {
    const ok = await ensureRepoReady(thread, session);
    if (!ok) return;
  }

  await forwardToClaude(msg, thread, parsed.prompt, session, store);
}
