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
import {
  dispatchHermesCommand,
  handleDeleteConfirmReply,
} from "./hermesCommands";
import { ensureRepoReady } from "./targets";
import { forwardToClaude } from "./streaming";
import { stripMention } from "../stripMention";

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

  // RG-009 phase 2: handle yes/no confirmation replies for
  // /project delete. Must run before the /project dispatch
  // (which would otherwise treat "yes" as a non-/project command
  // and fall through) and before the thread-session check (a
  // delete confirmation can be sent at top level).
  const confirmHandled = await handleDeleteConfirmReply(msg);
  if (confirmHandled) return;

  // Hermes /project commands take precedence over @bot mention handling.
  // /project start works at top level (no @bot mention needed); other
  // subcommands work in a project thread. Strip the leading @bot mention
  // so users can invoke Hermes either way (phone previews often include
  // the mention automatically). Without this, the legacy parseMention
  // flow would see "/project" as a path because it starts with "/".
  const mentionStripped = stripMention(msg.content);
  if (/^\/project\b/i.test(mentionStripped)) {
    const handled = await dispatchHermesCommand(mentionStripped, {
      msg,
      store,
      isTopLevel: !msg.channel.isThread(),
    });
    if (handled) return;
  }

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
  } else {
    // No target resolved (no newProject / repoUrl / localPath) but the
    // prompt was non-empty (otherwise the empty-prompt check above would
    // have caught it). Don't create a thread for an unresolvable task —
    // otherwise we forward to Claude with cwd = a non-existent path and
    // the spawn fails with ENOENT, surfacing as the cryptic
    // "Claude Code native binary ... exists but failed to launch" error.
    await msg.reply(NO_TARGET_TEXT);
    return;
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

  // P2.5: archive the user's message for the conversation feed. We
  // archive the original `msg.content` (with mentions stripped by the
  // parser upstream) and any attachments so the APP can re-render the
  // full chat history. Hermes-mode messages are already journaled via
  // the orchestrator, so skip them here.
  if (session.mode !== "autopilot" && session.mode !== "manual") {
    const { appendMessage } = await import("../../messages");
    appendMessage(thread.id, {
      ts: msg.createdTimestamp
        ? new Date(msg.createdTimestamp).toISOString()
        : new Date().toISOString(),
      role: "user",
      content: parsed.prompt,
      meta: msg.attachments.size > 0
        ? {
            attachments: [...msg.attachments.values()].map((a) => ({
              name: a.name,
              size: a.size,
              type: a.contentType ?? "unknown",
            })),
          }
        : undefined,
    });
  }

  // P2.5 stability: preflight for Anthropic's per-message token cap.
  // The SDK's session is persistent (claudeSession field in DB), so
  // context accumulates across turns. A single very long message
  // can blow past the per-message limit and surface as
  // "API Error: 400 invalid params, context window exceeds limit
  // (2013)" — seen in bot.err.log on 2026-06-27. We approximate
  // tokens as chars/4 (a common rule-of-thumb; the SDK would
  // tokenize for real but we want a fast guard). 90k chars ≈ 22.5k
  // tokens, comfortably under all current model per-message limits.
  const MAX_PROMPT_CHARS = 90_000;
  let promptForCC = parsed.prompt;
  if (parsed.prompt.length > MAX_PROMPT_CHARS) {
    const truncated = parsed.prompt.slice(0, MAX_PROMPT_CHARS);
    promptForCC =
      truncated +
      "\n\n[… message truncated at " +
      MAX_PROMPT_CHARS +
      " characters; the rest of your input was dropped to stay under the model's per-message cap. …]";
    log.warn("messageCreate: truncated oversized message", {
      threadId: thread.id,
      originalLen: parsed.prompt.length,
      truncatedLen: promptForCC.length,
    });
  }

  await forwardToClaude(msg, thread, promptForCC, session, store);
}
