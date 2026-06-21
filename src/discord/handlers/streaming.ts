/**
 * Claude streaming + run orchestration.
 *
 * `forwardToClaude` is the central function for executing a `claude -p`
 * subprocess against a thread, streaming the JSON output back to Discord
 * with throttled message edits, then posting a final summary.
 *
 * Helpers in this file:
 *   - startTypingIndicator — refresh Discord's typing flag every 8s
 *   - safeReact — best-effort reaction
 *   - highlightReply — reply to a message, with channel.send fallback
 *   - forwardToClaude — the main run orchestrator
 */

import type { Message, ThreadChannel } from "discord.js";
import { config } from "../../config";
import { log } from "../../logger";
import { runClaude, type ClaudeRunResult } from "../../agent/runner";
import { activeProcessCount } from "../../cleanup";
import type { SessionStore } from "../../db";
import { splitForDiscord, DISCORD_MAX } from "../split";
import { SendQueue } from "../sendQueue";
import { truncate, stripThinkTags, containsQuestion, formatToolUse, TOOL_ICON } from "./format";

// ---- Discord helpers ----

/**
 * Discord typing indicator expires after ~10s. We refresh every 8s.
 * Returns a stop() function to cancel the interval.
 */
export function startTypingIndicator(
  channel: { sendTyping: () => Promise<unknown> },
): () => void {
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
export async function safeReact(msg: Message, emoji: string): Promise<void> {
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
export async function highlightReply(
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

// ---- Run orchestrator ----

interface ToolUseRecord {
  name: string;
  detail: string;
  result?: string;
  resultErr?: boolean;
}

export async function forwardToClaude(
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

  // Enforce concurrency cap. Prevents FD exhaustion when many threads
  // are active at once. Reply with a clear message and skip the run.
  const cap = config.runtime.maxConcurrentContainers;
  if (activeProcessCount() >= cap) {
    log.info("concurrency cap reached, skipping run", {
      active: activeProcessCount(),
      cap,
      threadId: session.threadId,
    });
    await thread.send(
      `⏳ ${activeProcessCount()} claude run${activeProcessCount() === 1 ? "" : "s"} already in flight (cap: ${cap}). Please wait and try again.`,
    );
    return;
  }

  // Rate-limit all subsequent thread.send calls through this queue.
  // Discord's per-channel limit is ~5 msg / 5s; bursty flushStream +
  // final-summary posts can blow past that. The queue spaces sends out
  // (~1.1s apart) while keeping the first send immediate.
  const queue = new SendQueue();
  const send = (content: string): Promise<Message> =>
    queue.send<Message>((c) => thread.send(c), content);

  const placeholder = await send("⏳ Running Claude Code...");

  // Show typing indicator + react to user's message on completion
  const stopTyping = startTypingIndicator(thread);
  let reactOnDone: "ok" | "err" | null = null;
  let finalResultForHighlight: ClaudeRunResult | null = null;
  let finalError: string | null = null;

  const collectedText: string[] = [];
  const toolUses: ToolUseRecord[] = [];
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
      // postNewStream is called inside flushStream after the queue is set up.
      // We bypass the queue here because the next step is an immediate
      // .edit() — the queued send would delay the edit unnecessarily.
      const m: Message = (await thread.send("…")) as Message;
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
    if (now - lastEditAt < 800) return; // 800ms throttle
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
        } catch {
          /* ignore */
        }
        // Subsequent chunks: post as new messages (don't lose data)
        // Routed through the SendQueue so they don't trip Discord's rate limit.
        for (let i = 1; i < chunks.length; i++) {
          try {
            await send(chunks[i]);
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
              await send(chunks[i]);
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
      } catch {
        /* ignore */
      }
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
    } catch {
      /* ignore */
    }
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
  const statsPart =
    result && !result.isError
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
  const header =
    errorPrefix + (headerParts.length > 0 ? headerParts.join("\n") + "\n\n" : "");

  // Split long body into Discord-friendly chunks. ALWAYS do this — even on
  // error, the user needs to see what Claude said before the failure.
  const finalText = stripThinkTags(collectedText.join(""));
  const availableForBody = Math.max(0, DISCORD_MAX - header.length);
  const bodyChunks = splitForDiscord(finalText, availableForBody);

  // First chunk: replace placeholder (or edit if no overflow)
  if (
    bodyChunks.length === 0 ||
    (bodyChunks.length === 1 && bodyChunks[0].length === 0)
  ) {
    // No text — show header only
    await placeholder.edit(truncate(header, DISCORD_MAX));
  } else {
    await placeholder.edit(truncate(header + bodyChunks[0], DISCORD_MAX));
  }

  // Subsequent chunks: post as separate messages, routed through the queue
  // to stay under Discord's per-channel rate limit.
  for (let i = 1; i < bodyChunks.length; i++) {
    try {
      const m = await send(bodyChunks[i]);
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
      (hasQuestion
        ? "\n❓ **Claude has a question for you** — see thread"
        : "");
    await highlightReply(userMsg, summary);
    if (hasQuestion) {
      // Bump the placeholder too so the user sees it in the thread
      try {
        await placeholder.edit(
          (placeholder.content ?? "") + "\n\n❓ **Question — see reply above**",
        );
      } catch {
        /* ignore */
      }
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
