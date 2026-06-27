/**
 * Claude Code run orchestration.
 *
 * Phase 3 (2026-06-27): the legacy CLI subprocess runner was retired.
 * `forwardToClaude` now dispatches exclusively to the Claude Agent SDK
 * (`runViaSdk`). Each Discord thread = one `query()` call against
 * `@anthropic-ai/claude-agent-sdk`, with four custom MCP tools
 * (`discord_send`, `discord_typing`, `discord_react`, `discord_read_history`)
 * exposed to Claude for visible output.
 *
 * Why SDK over CLI: the CLI path required the bot to parse
 * stream-json events and buffer text in-process (a 10GB leak class that
 * ADR-0002 fixed but never fully eliminated). The SDK lets Claude
 * stream internally and just call our `discord_send` tool when it has
 * user-visible output — the bot stays a thin relay.
 *
 * Helpers in this file:
 *   - startTypingIndicator — refresh Discord's typing flag every 8s
 *   - safeReact — best-effort reaction
 *   - highlightReply — reply to a message, with channel.send fallback
 */

import type { Message, ThreadChannel } from "discord.js";
import { config } from "../../config";
import { log } from "../../logger";
import { activeProcessCount } from "../../cleanup";
import { runViaSdk } from "../../agent/sdkRunner";
import type { SessionStore } from "../../db";
import { SendQueue } from "../sendQueue";
import { DISCORD_MAX, splitForDiscord } from "../split";
import { truncate } from "./format";

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
 * `CLAUDE_PREFIX`. Pass `queue` to throttle multi-chunk sends (when
 * content exceeds Discord's 2000-char limit and we split into multiple
 * messages). The runner paths already have a `SendQueue` for
 * `discord_send` calls, so they pass it in here.
 *
 * Returns the FIRST Message (Discord's reply object) — `discordSendTool`
 * needs the message ID for its return value. Continuation chunks are
 * posted as separate messages but their IDs are discarded.
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

// ---- SDK path (only runner since Phase 3) ----

/**
 * Dispatch a Discord thread reply to Claude Code via the Agent SDK.
 * Phase 3: the CLI path was retired; this function is the single
 * entry point for all Claude runs.
 */
export async function forwardToClaude(
  userMsg: Message,
  thread: ThreadChannel,
  prompt: string,
  session: ReturnType<SessionStore["get"]> & object,
  store: SessionStore,
): Promise<void> {
  await runViaSdkWrapper(userMsg, thread, prompt, session, store);
}

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

  // SendQueue: same rate-limit primitive as the legacy CLI path. CC may
  // emit many `discord_send` calls in a burst (typing refresh, final
  // summary, multi-message answer) and we want to stay under Discord's
  // per-channel 5 msg / 5 s limit. The queue is fresh per Discord run.
  //
  // UX-3: wrap with makeClaudeSend so every discord_send call (and
  // every continuation chunk) carries the "🤖 Claude Code:" prefix.
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

  // Build summary header. With the SDK path there is no streamed text
  // in the bot — Claude sent messages directly via `discord_send` tool
  // calls. The header is therefore short: stats only.
  const header =
    `🧠 Claude (${(result.durationMs / 1000).toFixed(1)}s · ` +
    `${result.inputTokens}→${result.outputTokens} tok · ` +
    `$${result.costUsd.toFixed(4)})\n` +
    `**${result.toolCallCount} tool call${result.toolCallCount === 1 ? "" : "s"}**` +
    (result.numTurns > 1 ? ` across ${result.numTurns} turn${result.numTurns === 1 ? "" : "s"}` : "");

  // Edit placeholder to header. The "transcript" of Claude's actual
  // reply lives in the messages it sent via `discord_send` — they
  // appear in the thread above the placeholder.
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