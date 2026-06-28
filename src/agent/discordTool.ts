/**
 * Custom Discord tools exposed to Claude Code via the SDK's MCP transport.
 *
 * The Claude Agent SDK has no top-level "custom tools" option. Custom tools
 * are exposed by creating an in-process MCP server with `createSdkMcpServer()`
 * and registering each tool via the `tool()` factory. The factory takes:
 *   - name: string
 *   - description: string
 *   - inputSchema: Zod raw shape (e.g. { content: z.string() })
 *   - handler: (args, extra) => Promise<CallToolResult>
 *
 * CallToolResult is the MCP standard: { content: ContentBlock[], isError?: bool }
 * where ContentBlock is typically { type: "text", text: string }.
 *
 * ## RG-012 — per-run factory pattern (NOT module-level mutable)
 *
 * Each tool's `handler` closure captures the per-run `deps` (thread + send
 * wrapper) at factory-call time. This is why we expose four
 * `createXxxTool(deps)` factories plus an aggregate `createDiscordTools(deps)`
 * factory instead of pre-built singletons.
 *
 * Why not pre-build the tools once at module load? Because then the handlers
 * would need a *mutable* `deps` binding (e.g. `setDiscordToolDeps()`) — and
 * that races across concurrent SDK runs: thread A starts a run, sets `deps`
 * to threadA; thread B starts a run, sets `deps` to threadB and *overwrites*
 * A's binding; thread A's Claude fires `discord_send` and the handler now
 * posts to thread B. This was a real user-visible bug (2026-06-27, RG-012).
 *
 * With the factory pattern, each `runViaSdk` call creates its own MCP server
 * with its own tool set, each handler closure bound to its own thread. No
 * shared mutable state — isolation is enforced by JavaScript's lexical
 * scoping, not by external synchronization.
 */

import { z } from "zod";
import type { Message, ThreadChannel } from "discord.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  tool,
  type SdkMcpToolDefinition,
  type AnyZodRawShape,
} from "@anthropic-ai/claude-agent-sdk";
import { log } from "../logger";
import { truncate, stripThinkTags } from "../discord/handlers/format";

const DISCORD_MAX = 1900;

/** Helper: build a successful text result. */
function textResult(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
  };
}

/** Helper: build an error result. */
function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

export interface DiscordToolDeps {
  thread: ThreadChannel;
  /** Rate-limited `thread.send` wrapper. */
  send: (content: string) => Promise<Message>;
}

// ──────────────────────────────────────────────────────────────────────────
// Per-tool factory functions. Each takes the per-run `deps` and returns
// a fresh SdkMcpToolDefinition whose handler closure captures those deps.
// ──────────────────────────────────────────────────────────────────────────

/**
 * discord_send — post a message to the current thread.
 *
 * Content must be <= 1900 chars; longer content is rejected with a clear error
 * so Claude learns to split into multiple calls. If `reply_to_message_id` is
 * given and the target exists, we use `target.reply()` to highlight it;
 * otherwise we fall back to a plain `thread.send`.
 */
export function createDiscordSendTool(
  deps: DiscordToolDeps,
): SdkMcpToolDefinition<{
  content: z.ZodString;
  reply_to_message_id: z.ZodOptional<z.ZodString>;
}> {
  const schema = {
    content: z
      .string()
      .min(1)
      .max(DISCORD_MAX * 5) // Allow up to 5x to give Claude room before chunking kicks in
      .describe("Message text"),
    reply_to_message_id: z
      .string()
      .optional()
      .describe("Optional: message ID to reply to (highlights it for the user)"),
  };
  return tool(
    "discord_send",
    "Send a message to the current Discord thread. Returns the new message ID. " +
      "Content must be <= 1900 characters; if your reply is longer, split it into " +
      "multiple calls (one per logical paragraph or section). Use \\n\\n for " +
      "paragraph breaks. Prefer a single well-structured call over many tiny ones.",
    schema,
    async (input, _extra) => {
      // RG-002: strip thinking-block tags BEFORE the length check and
      // before posting. CC's content frequently wraps reasoning in
      // <ant_thinking>...</ant_thinking> (or <thinking>...</thinking>
      // for older models); if we don't strip, the user sees raw XML
      // instead of CC's final answer. Stripping can also reduce the
      // effective length, so a 2102-char raw CC reply with 1500 chars
      // of thinking might legitimately fit in 1900 once stripped.
      const rawContent = input.content;
      const content = stripThinkTags(rawContent);
      if (content !== rawContent) {
        log.info("discord_send stripped thinking blocks", {
          rawLength: rawContent.length,
          strippedLength: content.length,
        });
      }
      log.info("discord_send called", {
        contentLength: content.length,
        hasReplyTarget: !!input.reply_to_message_id,
      });
      if (content.length > DISCORD_MAX) {
        return errorResult(
          `content is ${content.length} chars (max ${DISCORD_MAX}); split into multiple calls`,
        );
      }
      let msg: Message;
      if (input.reply_to_message_id) {
        try {
          const target = await deps.thread.messages.fetch(input.reply_to_message_id);
          msg = await target.reply(content);
        } catch {
          msg = await deps.send(content);
        }
      } else {
        msg = await deps.send(content);
      }
      // P2.5: archive the CC message so the conversation feed in the
      // APP can re-render the full chat history after bot restart.
      const { appendMessage } = await import("../messages");
      appendMessage(deps.thread.id, {
        ts: new Date().toISOString(),
        role: "assistant",
        content,
        meta: { toolName: "discord_send" },
      });
      log.info("discord_send posted", { message_id: msg.id });
      return textResult(
        JSON.stringify({ message_id: msg.id, content_length: msg.content.length }),
      );
    },
  );
}

/**
 * discord_typing — show the typing indicator for ~10s.
 * Call before long tool operations so the user knows work is in progress.
 */
export function createDiscordTypingTool(
  deps: DiscordToolDeps,
): SdkMcpToolDefinition<AnyZodRawShape> {
  return tool(
    "discord_typing",
    "Show the 'typing...' indicator on the thread for ~10 seconds. Call this " +
      "before long operations (e.g., before a Bash command that takes a while, " +
      "or before reading a large file) so the user knows the agent is still working. " +
      "Safe to call multiple times — Discord refreshes the indicator.",
    {},
    async (_input, _extra) => {
      try {
        await deps.thread.sendTyping();
      } catch {
        // Best-effort; typing is ephemeral.
      }
      return textResult(JSON.stringify({ ok: true }));
    },
  );
}

/**
 * discord_react — add an emoji reaction to a message in the thread.
 */
export function createDiscordReactTool(
  deps: DiscordToolDeps,
): SdkMcpToolDefinition<{
  message_id: z.ZodString;
  emoji: z.ZodString;
}> {
  return tool(
    "discord_react",
    "Add an emoji reaction to a message in the thread. " +
      "Recommended usage: react to the user's original message with ✅ when " +
      "you've successfully completed a task, ❌ on errors, ❓ when asking a " +
      "question. Reactions are best-effort; missing permissions or unknown " +
      "emojis are silently ignored.",
    {
      message_id: z.string().describe("ID of the message to react to"),
      emoji: z
        .string()
        .describe(
          "Emoji — Unicode (✅, ❌, ❓) or custom name:id (e.g. custom_emoji:123)",
        ),
    },
    async (input, _extra) => {
      try {
        const target = await deps.thread.messages.fetch(input.message_id);
        await target.react(input.emoji);
        return textResult(JSON.stringify({ ok: true, message_id: input.message_id }));
      } catch (err) {
        return errorResult(`failed to react: ${truncate(String(err), 200)}`);
      }
    },
  );
}

/**
 * discord_read_history — fetch recent messages from the current thread.
 * Chronological order (oldest first). Useful when the agent needs context
 * beyond the user's most recent message (e.g., earlier messages in the thread,
 * other users' comments — though this bot currently only allows one user).
 */
export function createDiscordReadHistoryTool(
  deps: DiscordToolDeps,
): SdkMcpToolDefinition<{
  limit: z.ZodOptional<z.ZodNumber>;
}> {
  return tool(
    "discord_read_history",
    "Fetch recent messages from the current Discord thread (chronological order, " +
      "oldest first). Useful when you need context beyond what the user just sent " +
      "— for example, your own earlier messages, or other users' comments in the " +
      "thread. Note: in this bot's setup, threads only contain messages from the " +
      "same user, so this mostly gives you your own history.",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("How many messages to return (default 50, max 100)"),
    },
    async (input, _extra) => {
      const limit = input.limit ?? 50;
      try {
        const fetched = await deps.thread.messages.fetch({ limit });
        const messages = [...fetched.values()]
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
          .map((m) => ({
            id: m.id,
            author: m.author.username,
            author_id: m.author.id,
            is_bot: m.author.bot,
            content: m.content,
            timestamp: m.createdAt.toISOString(),
          }));
        return textResult(JSON.stringify({ count: messages.length, messages }));
      } catch (err) {
        return errorResult(`failed to read history: ${truncate(String(err), 200)}`);
      }
    },
  );
}

/**
 * Build all four Discord tools bound to the given per-run deps.
 *
 * Call this once per `runViaSdk` invocation and pass the resulting array
 * to `createSdkMcpServer({ tools })`. Each call creates a fresh tool set
 * whose handlers close over the specific `deps`, so concurrent runs on
 * different threads cannot cross-contaminate (RG-012).
 *
 * Tool index order (stable, relied on by tests):
 *   0: discord_send
 *   1: discord_typing
 *   2: discord_react
 *   3: discord_read_history
 */
export function createDiscordTools(
  deps: DiscordToolDeps,
): SdkMcpToolDefinition<any>[] {
  return [
    createDiscordSendTool(deps),
    createDiscordTypingTool(deps),
    createDiscordReactTool(deps),
    createDiscordReadHistoryTool(deps),
  ];
}
