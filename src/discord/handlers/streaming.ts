/**
 * Claude streaming + run orchestration.
 *
 * `forwardToClaude` is the central function for executing a Claude Code run
 * against a thread. It dispatches to one of two runners based on
 * `config.claude.useSdk`:
 *
 *   - `runViaClaudeCli` — the legacy path: `Bun.spawn("claude -p --output-format
 *     stream-json --verbose ...")` plus a SendQueue-throttled post loop.
 *     Phase 0. Carries the full stream-parsing + chunking + status-banner UX.
 *
 *   - `runViaSdk` — Phase 1: `query()` against the Claude Agent SDK. Claude
 *     decides when to send via the `discord_send` tool; the bot just relays
 *     tool calls. No stream parsing, no pendingText buffer, no chunker.
 *
 * Helpers in this file:
 *   - startTypingIndicator — refresh Discord's typing flag every 8s
 *   - safeReact — best-effort reaction
 *   - highlightReply — reply to a message, with channel.send fallback
 */

import type { Message, ThreadChannel } from "discord.js";
import { config } from "../../config";
import { log } from "../../logger";
import { runClaude, type ClaudeRunResult } from "../../agent/runner";
import { activeProcessCount } from "../../cleanup";
import { runViaSdk } from "../../agent/sdkRunner";
import type { SessionStore } from "../../db";
import { splitForDiscord, DISCORD_MAX } from "../split";
import { SendQueue } from "../sendQueue";
import { truncate, stripThinkTags, containsQuestion, formatToolUse, TOOL_ICON } from "./format";

/**
 * Prefix applied to every Claude Code reply posted to a thread (UX-3).
 * Lets David visually distinguish Hermes orchestrator metadata
 * ("🪪 Hermes:") from CC's actual engineering output.
 */
export const CLAUDE_PREFIX = "🤖 **Claude Code:**";

/**
 * RG-005: branded type for a Discord-send function that has been wrapped
 * with `makeClaudeSend`. The phantom `__brand` field is invisible at
 * runtime (never set or read) but forces TypeScript to reject any
 * `thread.send` / `channel.send` raw pass-through at the `runViaSdk`
 * call site. The only way to satisfy this type is to wrap with
 * `makeClaudeSend(thread, queue?)`, which prepends CLAUDE_PREFIX.
 *
 * Why branded instead of a generic alias: without the brand, a raw
 * `(content: string) => Promise<Message>` from `thread.send` is
 * structurally compatible with `makeClaudeSend`'s return type, and
 * the compiler would silently accept either — re-introducing the
 * very regression RG-005 exists to prevent.
 */
export type PrefixedSend = (content: string) => Promise<Message> & {
  readonly __brand: "PrefixedSend";
};

/**
 * Build a Discord-send function that prefixes every message with
 * `CLAUDE_PREFIX`. Used by both the CLI and SDK runner paths so that
 * `discord_send` tool calls and streamed text are visually tagged the
 * same way.
 *
 * Pass `queue` to throttle multi-chunk sends (when content exceeds
 * Discord's 2000-char limit and we split into multiple messages). The
 * runner paths already have a `SendQueue` for `discord_send` calls, so
 * they pass it in here. Without a queue, sends fire synchronously
 * (acceptable for short single-message replies).
 *
 * Returns the FIRST Message (Discord's reply object) — `discordSendTool`
 * needs the message ID for its return value. Continuation chunks are
 * posted as separate messages but their IDs are discarded.
 *
 * Assumes content is already cleaned of `<ant_thinking>` etc by
 * upstream tool wrappers (see RG-002 in REGRESSION-GUARD.md).
 */
export function makeClaudeSend(
  thread: ThreadChannel,
  queue?: SendQueue,
): PrefixedSend {
  const post = (text: string): Promise<Message> =>
    queue
      ? queue.send<Message>((c) => thread.send(c), text)
      : thread.send(text);
  const fn = async (content: string): Promise<Message> => {
    if (!content) {
      // Should not happen — callers must check empty before calling —
      // but guard anyway so we never return a fake Message.
      throw new Error("makeClaudeSend: empty content");
    }
    const budget = DISCORD_MAX - CLAUDE_PREFIX.length - 1;
    const bodyChunks = splitForDiscord(content, budget);
    const first = await post(`${CLAUDE_PREFIX} ${bodyChunks[0]}`);
    for (let i = 1; i < bodyChunks.length; i++) {
      await post(bodyChunks[i]);
    }
    return first;
  };
  return fn as PrefixedSend;
}

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

// ---- Run dispatcher ----

export async function forwardToClaude(
  userMsg: Message,
  thread: ThreadChannel,
  prompt: string,
  session: ReturnType<SessionStore["get"]> & object,
  store: SessionStore,
): Promise<void> {
  // Phase 2 runner selection:
  //   - config.claude.useSdk = false → force CLI globally (kill switch)
  //   - config.claude.useSdk = true  → honor per-thread session.runnerKind
  // The env var is no longer a per-bot opt-in; it's now a global override.
  const useSdk = config.claude.useSdk && session.runnerKind === "sdk";
  if (useSdk) {
    await runViaSdkWrapper(userMsg, thread, prompt, session, store);
  } else {
    await runViaClaudeCli(userMsg, thread, prompt, session, store);
  }
}

// ---- SDK path (Phase 1) ----

async function runViaSdkWrapper(
  userMsg: Message,
  thread: ThreadChannel,
  prompt: string,
  session: ReturnType<SessionStore["get"]> & object,
  _store: SessionStore,
): Promise<void> {
  if (!session.repoPath) {
    await thread.send(
      "⚠️ No target set. Send `/repo <url|path|name>` first, then re-send your message.",
    );
    return;
  }

  // Concurrency cap: count active SDK runs as well as CLI subprocesses,
  // since both consume the same host resources. Use the cap loosely —
  // SDK sessions are persistent in memory but only consume real CPU
  // during a turn.
  const cap = config.runtime.maxConcurrentContainers;
  if (activeProcessCount() >= cap) {
    log.info("concurrency cap reached, skipping sdk run", {
      active: activeProcessCount(),
      cap,
      threadId: session.threadId,
    });
    await thread.send(
      `⏳ ${activeProcessCount()} claude run${activeProcessCount() === 1 ? "" : "s"} already in flight (cap: ${cap}). Please wait and try again.`,
    );
    return;
  }

  // SendQueue: same rate-limit primitive as the CLI path. CC may emit many
  // `discord_send` calls in a burst (typing refresh, final summary,
  // multi-message answer) and we want to stay under Discord's per-channel
  // 5 msg / 5 s limit. The queue is fresh per Discord run.
  //
  // UX-3: wrap with makeClaudeSend so every discord_send call (and every
  // continuation chunk) carries the "🤖 Claude Code:" prefix. This makes
  // Hermes metadata ("🪪 Hermes:") vs CC engineering output visually
  // distinct — critical for auto→manual mode transitions where David
  // needs to see CC's prior work to take over.
  const queue = new SendQueue();
  // Placeholder: raw queue send (no CLAUDE prefix) so the final edited
  // header doesn't accidentally carry both the placeholder prefix and
  // the "🧠 Claude" summary line.
  const placeholder = await queue.send<Message>(
    (c) => thread.send(c),
    "⏳ Working...",
  );
  const send = makeClaudeSend(thread, queue);
  const stopTyping = startTypingIndicator(thread);

  let result;
  try {
    result = await runViaSdk(userMsg, thread, prompt, session, send);
  } catch (err) {
    log.error("sdk run threw unexpectedly", { err: String(err) });
    stopTyping();
    await placeholder.edit(
      `❌ Claude error: \`${truncate(String(err), 200)}\``,
    );
    await safeReact(userMsg, "❌");
    return;
  }

  stopTyping();

  // Persist session ID for resume on next message.
  if (result.sessionId) {
    _store.setClaudeSession(session.threadId, result.sessionId);
  }

  if (result.aborted) {
    // /kill or shutdown interrupted the run. Don't react as error.
    await placeholder.edit(`🛑 Run aborted.`);
    return;
  }

  if (result.isError) {
    await placeholder.edit(
      `❌ Claude error: \`${truncate(result.errorMessage ?? "unknown", 200)}\``,
    );
    await highlightReply(
      userMsg,
      `❌ Claude failed: \`${truncate(result.errorMessage ?? "unknown", 200)}\``,
    );
    await safeReact(userMsg, "❌");
    return;
  }

  // Build summary header. With the SDK path there is no streamed text in the
  // bot — Claude sent messages directly via `discord_send` tool calls. The
  // header is therefore short: stats only.
  const header =
    `🧠 Claude (${(result.durationMs / 1000).toFixed(1)}s · ` +
    `${result.inputTokens}→${result.outputTokens} tok · ` +
    `$${result.costUsd.toFixed(4)})\n` +
    `**${result.toolCallCount} tool call${result.toolCallCount === 1 ? "" : "s"}**` +
    (result.numTurns > 1 ? ` across ${result.numTurns} turn${result.numTurns === 1 ? "" : "s"}` : "");

  // Edit placeholder to header. The "transcript" of Claude's actual reply
  // lives in the messages it sent via `discord_send` — they appear in the
  // thread above the placeholder.
  try {
    await placeholder.edit(truncate(header, DISCORD_MAX));
  } catch (err) {
    log.warn("failed to edit placeholder with summary", { err: String(err) });
  }

  const summary =
    `✅ Done in ${(result.durationMs / 1000).toFixed(1)}s · ` +
    `${result.toolCallCount} tool call${result.toolCallCount === 1 ? "" : "s"} · ` +
    `$${result.costUsd.toFixed(4)}`;
  await highlightReply(userMsg, summary);
  await safeReact(userMsg, "✅");
}

// ---- CLI path (legacy) ----

interface ToolUseRecord {
  name: string;
  detail: string;
  result?: string;
  resultErr?: boolean;
}

async function runViaClaudeCli(
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
  //
  // UX-3: wrap with makeClaudeSend so streamed text chunks and the
  // final summary carry the "🤖 Claude Code:" prefix (CLI path). The
  // placeholder stays raw — we edit it in place with the header line
  // after the run finishes.
  const queue = new SendQueue();
  // Placeholder: raw queue send (no CLAUDE prefix) — edited in place
  // to the summary header at the end.
  const placeholder = await queue.send<Message>(
    (c) => thread.send(c),
    "⏳ Running Claude Code...",
  );
  const send = makeClaudeSend(thread, queue);

  // Show typing indicator + react to user's message on completion
  const stopTyping = startTypingIndicator(thread);
  let reactOnDone: "ok" | "err" | null = null;
  let finalResultForHighlight: ClaudeRunResult | null = null;
  let finalError: string | null = null;

  // Pending text buffer: each text event from Claude appends here. When
  // we cross TEXT_FLUSH_THRESHOLD, we post the buffer as a new Discord
  // message (via the SendQueue) and reset. This keeps our memory
  // footprint O(threshold) and avoids the 10GB leak that the old
  // streamText accumulator caused on long Claude runs. See
  // docs/operations/0002-bridge-long-task-memory-leak.md.
  const TEXT_FLUSH_THRESHOLD = 1900;
  let pendingText = "";
  let postedBytes = 0;
  let postedChunks = 0;

  // Status: a small mutable string we edit into the placeholder every
  // 1.5s via setInterval. Limited to ~500 chars max — never grows.
  const toolUses: ToolUseRecord[] = [];
  let sessionId = session.claudeSession ?? "";
  let lastActivity = "💭 thinking…";

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
    const status = [
      lastActivity,
      ...recent,
      `📤 ${postedChunks} chunk${postedChunks === 1 ? "" : "s"} (${(postedBytes / 1024).toFixed(1)} KB streamed)`,
    ].join("\n");
    return truncate(status, 1500);
  };

  // Throttled placeholder edit. We use a setInterval-based loop instead
  // of callback-driven edits so the callback chain stays synchronous
  // (no fire-and-forget promises retaining the status string).
  const editInterval = setInterval(() => {
    placeholder.edit(renderStatus()).catch(() => {});
  }, 1500);
  // Edit immediately too, so the initial status shows up.
  placeholder.edit(renderStatus()).catch(() => {});

  // Helper: flush pendingText if it crosses the threshold. Posts via the
  // queue. Resets the buffer to empty.
  const flushIfFull = () => {
    if (pendingText.length < TEXT_FLUSH_THRESHOLD) return;
    const chunk = pendingText;
    pendingText = "";
    postedBytes += chunk.length;
    postedChunks += 1;
    send(chunk).catch((err) =>
      log.warn("failed to post stream chunk", { err: String(err) }),
    );
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
          // Append to pending buffer; flush via queue when full.
          // No retention: pendingText is reset on every flush.
          pendingText += text;
          flushIfFull();
        },
        onToolUse: (name, input) => {
          const detail = formatToolUse(name, input);
          toolUses.push({ name, detail });
          const icon = TOOL_ICON[name] ?? "🔧";
          lastActivity = detail ? `${icon} ${name}: ${detail}` : `${icon} ${name}`;
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
        },
        onUserText: (text) => {
          // user text from tool_result (when result is text-only)
          pendingText += text;
          flushIfFull();
        },
        onThinking: () => {
          lastActivity = "💭 thinking…";
        },
        onResult: () => {
          /* handled below */
        },
      },
    );
  } catch (err) {
    // Bot-side error: pendingText is still populated with everything
    // Claude streamed. We capture the error and fall through to the final
    // summary, which will prefix the error to the header and ship the
    // collected text. CRITICAL: do NOT overwrite the placeholder here —
    // that would discard the user's view of what Claude said so far.
    runError = String(err);
    log.error("claude run failed", { err: runError });
  }

  stopTyping();
  clearInterval(editInterval);

  // Final flush of any remaining pendingText (the last < 1900 chars)
  // before we transition to the summary phase.
  if (pendingText.length > 0) {
    postedBytes += pendingText.length;
    postedChunks += 1;
    try {
      await send(pendingText);
    } catch (err) {
      log.warn("failed to post final stream chunk", { err: String(err) });
    }
    pendingText = "";
  }

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
  // The final body comes from the terminal `result.text` (set by the
  // runner from `result.result` of the stream-json protocol), not from
  // a local accumulator — see docs/operations/0002-bridge-long-task-memory-leak.md
  const finalText = stripThinkTags(result?.text ?? "");
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