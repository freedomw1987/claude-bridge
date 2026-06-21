/**
 * messageCreate handler.
 *
 * Direct CLI mode (no Docker):
 *   - Each message runs `claude -p <prompt> --resume <sid>` directly on the host
 *   - Session context is preserved across messages via claude's session file
 *   - Files are read/written directly in the work dir (no mount needed)
 *
 * Slash commands (in threads):
 *   - `/repo <url|path|name>`: change target
 *   - `/projects`: list projects
 *   - `/kill`: stop session
 *   - `/status`: show session info
 */

import type { Message, ThreadChannel } from "discord.js";
import { ChannelType } from "discord.js";
import { config } from "../../config";
import { log } from "../../logger";
import {
  parseMention,
  isValidRepoUrl,
  isValidLocalPath,
  isLocalPathString,
  isValidProjectName,
} from "../parser";
import { splitForDiscord, DISCORD_MAX } from "../split";
import { taskRepoPath } from "../../utils/path";
import type { SessionStore } from "../../db";
import { runClaude, type ClaudeRunResult } from "../../agent/runner";
import { gitClone } from "../../utils/git";
import type { ProjectRegistry } from "../../projects/registry";
import { mkdirSync, existsSync } from "node:fs";

interface HandlerDeps {
  store: SessionStore;
  projects: ProjectRegistry;
}

const isMentioningBot = (msg: Message, botUserId: string): boolean => {
  if (msg.mentions.users.size === 0) return false;
  return msg.mentions.users.has(botUserId);
};

const matchRepoCommand = (content: string): string | null => {
  const m = content.match(/^\/repo\s+(\S+)/i);
  return m ? m[1] : null;
};

const isKillCommand = (content: string): boolean => /^\/kill\b/i.test(content.trim());

const isStatusCommand = (content: string): boolean => /^\/status\b/i.test(content.trim());

const isProjectsCommand = (content: string): boolean =>
  /^\/projects\b/i.test(content.trim());

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, max - 3) + "...";

/**
 * Discord typing indicator expires after ~10s. We refresh every 8s.
 * Returns a stop() function to cancel the interval.
 */
function startTypingIndicator(channel: { sendTyping: () => Promise<unknown> }): () => void {
  let active = true;
  const tick = () => {
    if (!active) return;
    channel.sendTyping().catch(() => {});
  };
  // Fire immediately, then every 8s
  tick();
  const handle = setInterval(tick, 8000);
  return () => {
    active = false;
    clearInterval(handle);
  };
}

/**
 * React to a message, ignoring errors (e.g., missing permissions).
 */
async function safeReact(msg: Message, emoji: string): Promise<void> {
  try {
    await msg.react(emoji);
  } catch {
    // ignore — reactions are best-effort
  }
}

/**
 * Reply to a message (which highlights the original in yellow on Discord).
 * Used to notify the user when Claude finishes or has a question.
 */
async function highlightReply(
  msg: Message,
  content: string,
): Promise<void> {
  try {
    await msg.reply(content);
  } catch {
    // Fallback to a regular send if reply fails
    try {
      const ch = msg.channel as { send?: (c: string) => Promise<unknown> };
      if (typeof ch.send === "function") {
        await ch.send(content);
      }
    } catch {
      // give up silently
    }
  }
}

/**
 * Heuristic: does this response end with a question that asks for user input?
 * Looks at the last ~250 chars for trailing `?` and question phrases.
 */
function containsQuestion(text: string): boolean {
  const trimmed = text.trimEnd();
  // Trailing question mark
  if (trimmed.endsWith("?") || trimmed.endsWith("？")) return true;
  // Last 250 chars
  const tail = trimmed.slice(-250).toLowerCase();
  const patterns = [
    "should i",
    "would you like",
    "do you want",
    "let me know",
    "what do you think",
    "shall i",
    "want me to",
  ];
  return patterns.some((p) => tail.includes(p));
}

function stripThinkTags(text: string): string {
  return text
    .replace(/<\/think>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Format a tool_use event for Discord display.
 * Shows the most relevant argument(s) per tool type.
 */
function formatToolUse(name: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  const pick = (k: string): string | undefined => {
    const v = obj[k];
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return undefined;
  };

  const trunc = (s: string, n: number): string =>
    s.length <= n ? s : s.slice(0, n - 1) + "…";

  switch (name) {
    case "Bash": {
      const cmd = pick("command") ?? pick("cmd") ?? "";
      return `\`${trunc(cmd, 200)}\``;
    }
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit": {
      const p = pick("file_path") ?? pick("path") ?? "";
      return `\`${trunc(p, 150)}\``;
    }
    case "Glob": {
      const p = pick("pattern") ?? "";
      return `pattern: \`${trunc(p, 100)}\``;
    }
    case "Grep": {
      const p = pick("pattern") ?? "";
      const path = pick("path") ?? pick("-path") ?? "";
      return `pattern: \`${trunc(p, 80)}\` in \`${trunc(path, 60)}\``;
    }
    case "WebFetch": {
      const url = pick("url") ?? "";
      return `\`${trunc(url, 120)}\``;
    }
    case "WebSearch": {
      const q = pick("query") ?? "";
      return `\`${trunc(q, 120)}\``;
    }
    case "Task": {
      const desc = pick("description") ?? "";
      return `\`${trunc(desc, 120)}\``;
    }
    case "NotebookEdit": {
      const p = pick("notebook_path") ?? "";
      return `\`${trunc(p, 120)}\``;
    }
    case "TodoWrite":
      return "updating task list";
    default: {
      // Generic — show first short string field
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string" && v.length > 0 && v.length < 200) {
          return `${k}: \`${trunc(v, 120)}\``;
        }
      }
      return "";
    }
  }
}

const TOOL_ICON: Record<string, string> = {
  Bash: "🛠️",
  Read: "📖",
  Write: "📝",
  Edit: "✏️",
  MultiEdit: "✏️",
  Glob: "📂",
  Grep: "🔍",
  WebFetch: "🌐",
  WebSearch: "🔎",
  Task: "🤖",
  NotebookEdit: "📓",
  TodoWrite: "☑️",
};

export async function handleMessageCreate(
  msg: Message,
  deps: HandlerDeps,
): Promise<void> {
  const { store, projects } = deps;

  if (msg.author.bot) return;
  if (msg.author.id !== config.discord.allowedUserId) return;

  // Channel gate: either a top-level message in the configured channel,
  // or any message in a thread whose parent is the configured channel.
  const inConfiguredChannel = msg.channelId === config.discord.channelId;
  const inThreadOfChannel =
    msg.channel.isThread() &&
    msg.channel.parentId === config.discord.channelId;
  if (!inConfiguredChannel && !inThreadOfChannel) return;

  const botUserId = msg.client.user!.id;

  // Case A: thread reply
  if (
    msg.channel.isThread() &&
    msg.channel.parentId === config.discord.channelId
  ) {
    const session = store.get(msg.channel.id);
    if (!session) {
      await msg.reply("(no active session in this thread)");
      return;
    }

    if (isKillCommand(msg.content)) {
      store.setStatus(session.threadId, "killed");
      store.setContainer(session.threadId, null);
      await msg.reply("🛑 Session killed. Files remain on host.");
      return;
    }

    if (isStatusCommand(msg.content)) {
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
      return;
    }

    if (isProjectsCommand(msg.content)) {
      await sendProjectsList(msg, projects);
      return;
    }

    const newTarget = matchRepoCommand(msg.content);
    if (newTarget) {
      await applyTarget(msg, session.threadId, newTarget, store, projects);
      return;
    }

    await forwardToClaude(msg, msg.channel as ThreadChannel, msg.content, session, store);
    return;
  }

  // Case B: top-level mention
  if (!isMentioningBot(msg, botUserId)) return;

  const parsed = parseMention(msg.content, botUserId, { projects });
  log.info("received mention", {
    threadName: parsed.threadName,
    repoUrl: parsed.repoUrl,
    localPath: parsed.localPath,
    newProject: parsed.newProject,
  });

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
    lines.push("⚠️ No target — send `/repo <url|path|name>` in this thread.");
  }
  lines.push("", "⏳ Starting Claude Code...");
  await thread.send(lines.join("\n"));

  if (parsed.repoUrl) {
    const ok = await ensureRepoReady(thread, session);
    if (!ok) return;
  }

  await forwardToClaude(msg, thread, parsed.prompt, session, store);
}

async function sendProjectsList(msg: Message, projects: ProjectRegistry): Promise<void> {
  const all = projects.list();
  if (all.length === 0) {
    await msg.reply(
      `📁 No projects found in \`${projects.rootPath()}\`\n` +
        `Set \`PROJECTS_ROOT\` env var to scan a different directory.`,
    );
    return;
  }
  const max = 30;
  const lines = all.slice(0, max).map((p, i) => `${i + 1}. **${p.name}** — \`${p.path}\``);
  let body =
    `📁 **Projects** (from \`${projects.rootPath()}\`, ${all.length} total)\n` +
    lines.join("\n");
  if (all.length > max) body += `\n… and ${all.length - max} more`;
  body += `\n\nUse: \`@bot <msg> in <name>\``;
  await msg.reply(body);
}

async function applyTarget(
  msg: Message,
  threadId: string,
  target: string,
  store: SessionStore,
  projects: ProjectRegistry,
): Promise<void> {
  const project = projects.resolve(target);
  if (project) {
    store.setLocalPath(threadId, project.name, project.path);
    await msg.reply(
      `✅ Project: **${project.name}**\nMounted: \`${project.path}\``,
    );
    return;
  }

  if (isLocalPathString(target)) {
    const v = isValidLocalPath(target);
    if (!v.ok) {
      await msg.reply(`❌ Invalid local path: ${v.error}`);
      return;
    }
    store.setLocalPath(threadId, target, v.resolved!);
    await msg.reply(`✅ Local path: \`${target}\` → \`${v.resolved}\``);
    return;
  }

  if (!isValidRepoUrl(target)) {
    await msg.reply(`❌ Not a valid repo URL, project name, or local path: \`${target}\``);
    return;
  }
  store.setRepoUrl(threadId, target);
  const newRepoPath = taskRepoPath(config.paths.tasksRoot, threadId);
  if (newRepoPath !== store.get(threadId)!.repoPath) {
    store.setLocalPath(threadId, "", newRepoPath);
  }
  const fresh = store.get(threadId)!;
  await ensureRepoReady(msg.channel as ThreadChannel, fresh);
}

async function ensureRepoReady(
  thread: ThreadChannel,
  session: ReturnType<SessionStore["get"]> & object,
): Promise<boolean> {
  if (session.localPath || (!session.repoUrl && session.repoPath)) {
    return true;
  }
  if (!session.repoUrl) return false;
  try {
    await gitClone(session.repoUrl, session.repoPath);
    log.info("repo ready", { path: session.repoPath });
    return true;
  } catch (err) {
    log.error("git clone failed", { err: String(err), url: session.repoUrl });
    await thread.send(`❌ git clone failed: \`${truncate(String(err), 200)}\``);
    return false;
  }
}

async function forwardToClaude(
  userMsg: Message,
  thread: ThreadChannel,
  prompt: string,
  session: ReturnType<SessionStore["get"]> & object,
  store: SessionStore,
): Promise<void> {
  store.touch(session.threadId);

  if (!session.repoUrl && !session.repoPath) {
    await thread.send(
      "⚠️ No target set. Send `/repo <url|path|name>` first, then re-send your message.",
    );
    return;
  }

  const placeholder = await thread.send("⏳ Running Claude Code...");

  // Show typing indicator + react to user's message on completion
  const stopTyping = startTypingIndicator(thread);
  let reactOnDone: "ok" | "err" | null = null;
  let finalResultForHighlight: ClaudeRunResult | null = null;
  let finalError: string | null = null;

  const collectedText: string[] = [];
  const toolUses: Array<{ name: string; detail: string; result?: string; resultErr?: boolean }> = [];
  let sessionId = session.claudeSession ?? "";
  let lastEditAt = 0;
  let lastActivity = "💭 thinking…";
  // For multi-message streaming: if text overflows Discord's 2000-char limit,
  // we post a new "stream" message and continue editing that. The placeholder
  // stays as the status/summary anchor.
  let streamMsg: Message | null = null;
  let streamText = "";

  const postNewStream = async (): Promise<Message | null> => {
    try {
      const m: Message = await thread.send("…");
      return m;
    } catch {
      return null;
    }
  };

  const renderStreamPreview = (): string => {
    return truncate(streamText, 1900);
  };

  const renderStatus = (): string => {
    const recent = toolUses.slice(-4).map((t) => {
      const ic = TOOL_ICON[t.name] ?? "🔧";
      const resultBadge = t.resultErr
        ? " ❌"
        : t.result != null
          ? " ✓"
          : "";
      return t.detail
        ? `${ic} ${t.name}: ${t.detail}${resultBadge}`
        : `${ic} ${t.name}${resultBadge}`;
    });
    const status = [lastActivity, ...recent].join("\n");
    return truncate(status, 1500);
  };

  const editPlaceholder = async () => {
    const now = Date.now();
    if (now - lastEditAt < 800) return;  // 800ms throttle
    lastEditAt = now;
    try {
      const text = `${renderStatus()}\n\n${streamText ? `**Streaming:**\n${renderStreamPreview()}` : "(no text yet)"}`;
      await placeholder.edit(truncate(text, 1900));
    } catch {
      // ignore rate-limit
    }
  };

  const flushStream = async () => {
    // If stream text exceeds 1900 chars, post a new message for the overflow.
    // CRITICAL: use splitForDiscord (not truncate) so we preserve ALL content.
    // Truncation here would silently drop the tail of long responses.
    if (streamText.length > 1800) {
      const chunks = splitForDiscord(streamText, DISCORD_MAX);
      if (streamMsg) {
        // First chunk: edit the existing stream message
        try {
          await streamMsg.edit(chunks[0]);
        } catch { /* ignore */ }
        // Subsequent chunks: post as new messages (don't lose data)
        for (let i = 1; i < chunks.length; i++) {
          try {
            await thread.send(chunks[i]);
            await new Promise((r) => setTimeout(r, 150));
          } catch (err) {
            log.warn("failed to post stream overflow chunk", {
              chunk: i,
              err: String(err),
            });
          }
        }
      } else {
        // No existing stream message — post all chunks as new messages
        for (let i = 0; i < chunks.length; i++) {
          try {
            if (i === 0) {
              streamMsg = await postNewStream();
              if (streamMsg) await streamMsg.edit(chunks[0]);
            } else {
              await thread.send(chunks[i]);
              await new Promise((r) => setTimeout(r, 150));
            }
          } catch (err) {
            log.warn("failed to post stream chunk", {
              chunk: i,
              err: String(err),
            });
          }
        }
      }
      // Reset for next chunk
      streamText = "";
      streamMsg = null;
    } else if (streamMsg) {
      // Small update — still within limits, edit in place
      try {
        await streamMsg.edit(truncate(streamText, 1900));
      } catch { /* ignore */ }
    }
  };

  let runError: string | null = null;
  let result: ClaudeRunResult | null = null;

  try {
    result = await runClaude(
      {
        prompt,
        cwd: session.repoPath,
        sessionId: session.claudeSession ?? undefined,
        permissionMode: config.claude.defaultPermissionMode,
        systemPromptFile: config.claude.systemPromptFile,
      },
      {
        onSessionId: (sid) => {
          sessionId = sid;
        },
        onTextDelta: (text) => {
          collectedText.push(text);
          streamText += text;
          flushStream().catch(() => {});
          editPlaceholder();
        },
        onToolUse: (name, input) => {
          const detail = formatToolUse(name, input);
          toolUses.push({ name, detail });
          const icon = TOOL_ICON[name] ?? "🔧";
          lastActivity = detail ? `${icon} ${name}: ${detail}` : `${icon} ${name}`;
          editPlaceholder();
        },
        onToolResult: (text, isError) => {
          // Attach result to the most recent tool_use
          const last = toolUses[toolUses.length - 1];
          if (last) {
            last.result = text.slice(0, 500);
            last.resultErr = isError;
          }
          // Show a brief result preview
          const preview = text.split("\n").slice(0, 3).join(" ").slice(0, 200);
          lastActivity = isError
            ? `❌ tool error: ${preview}${text.length > 200 ? "…" : ""}`
            : `✓ result: ${preview}${text.length > 200 ? "…" : ""}`;
          editPlaceholder();
        },
        onUserText: (text) => {
          // user text from tool_result (when result is text-only)
          streamText += text;
          flushStream().catch(() => {});
          editPlaceholder();
        },
        onThinking: () => {
          lastActivity = "💭 thinking…";
          editPlaceholder();
        },
        onResult: () => {
          /* handled below */
        },
      },
    );
  } catch (err) {
    // Bot-side error: collectedText is still populated with everything
    // Claude streamed. We capture the error and fall through to the final
    // summary, which will prefix the error to the header and ship the
    // collected text. CRITICAL: do NOT overwrite the placeholder here —
    // that would discard the user's view of what Claude said so far.
    runError = String(err);
    log.error("claude run failed", { err: runError });
  }

  stopTyping();

  if (sessionId) {
    store.setClaudeSession(session.threadId, sessionId);
  }

  // Determine error state
  if (runError) {
    finalError = runError;
    reactOnDone = "err";
  } else if (result?.isError) {
    finalError = result.errorMessage ?? "unknown error";
    reactOnDone = "err";
  } else {
    reactOnDone = "ok";
    if (result) finalResultForHighlight = result;
  }

  // Finalize any pending stream message before we post the summary
  if (streamMsg && streamText) {
    try {
      const sm = streamMsg as Message;
      await sm.edit(truncate(streamText, 1900));
    } catch { /* ignore */ }
  }

  // Build header
  const errorPrefix = runError
    ? `❌ claude run failed: \`${truncate(runError, 200)}\`\n\n`
    : result?.isError
      ? `❌ Claude error: \`${truncate(result.errorMessage ?? "unknown", 200)}\`\n\n`
      : "";

  const toolLines = toolUses.map((t) => {
    const icon = TOOL_ICON[t.name] ?? "🔧";
    const resultBadge = t.resultErr
      ? " ❌"
      : t.result != null
        ? " ✓"
        : "";
    return `  ${icon} ${t.name}${t.detail ? `: ${t.detail}` : ""}${resultBadge}`;
  });
  const statsPart = result && !result.isError
    ? `🧠 Claude (${(result.durationMs / 1000).toFixed(1)}s · ` +
      `${result.inputTokens}→${result.outputTokens} tok · ` +
      `$${result.costUsd.toFixed(4)})`
    : null;
  const headerParts = [
    statsPart,
    toolLines.length > 0
      ? `**Activity (${toolUses.length} tool call${toolUses.length === 1 ? "" : "s"}):**\n${toolLines.join("\n")}`
      : null,
  ].filter(Boolean) as string[];
  const header = errorPrefix + (headerParts.length > 0 ? headerParts.join("\n") + "\n\n" : "");

  // Split long body into Discord-friendly chunks. ALWAYS do this — even on
  // error, the user needs to see what Claude said before the failure.
  const finalText = stripThinkTags(collectedText.join(""));
  const availableForBody = Math.max(0, DISCORD_MAX - header.length);
  const bodyChunks = splitForDiscord(finalText, availableForBody);

  // First chunk: replace placeholder (or edit if no overflow)
  if (bodyChunks.length === 0 || (bodyChunks.length === 1 && bodyChunks[0].length === 0)) {
    // No text — show header only
    await placeholder.edit(truncate(header, DISCORD_MAX));
  } else {
    await placeholder.edit(truncate(header + bodyChunks[0], DISCORD_MAX));
  }

  // Subsequent chunks: post as separate messages
  for (let i = 1; i < bodyChunks.length; i++) {
    try {
      const m = await thread.send(bodyChunks[i]);
      // Small delay to avoid burst rate-limit
      await new Promise((r) => setTimeout(r, 150));
      // Reference for potential future use
      void m;
    } catch (err) {
      log.warn("failed to post continuation message", {
        chunk: i,
        err: String(err),
      });
    }
  }

  // Highlight: reply to the user's original message. Discord shows a yellow
  // highlight + notification on the user's side for replies to their own message.
  if (reactOnDone === "ok" && finalResultForHighlight) {
    const r = finalResultForHighlight;
    const hasQuestion = containsQuestion(r.text);
    const summary =
      `✅ Done in ${(r.durationMs / 1000).toFixed(1)}s · ` +
      `${r.toolUses.length} tool call${r.toolUses.length === 1 ? "" : "s"} · ` +
      `$${r.costUsd.toFixed(4)}` +
      (hasQuestion ? "\n❓ **Claude has a question for you** — see thread" : "");
    await highlightReply(userMsg, summary);
    if (hasQuestion) {
      // Bump the placeholder too so the user sees it in the thread
      try {
        await placeholder.edit(
          (placeholder.content ?? "") + "\n\n❓ **Question — see reply above**",
        );
      } catch { /* ignore */ }
    }
    await safeReact(userMsg, "✅");
  } else if (reactOnDone === "err") {
    await highlightReply(
      userMsg,
      `❌ Claude failed: \`${truncate(finalError ?? "unknown", 200)}\``,
    );
    await safeReact(userMsg, "❌");
  }
}

void ChannelType;