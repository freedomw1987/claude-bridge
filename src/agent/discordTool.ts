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
 * Tool handlers have closure access to the Discord thread + SendQueue, so the
 * side effects (thread.send, thread.sendTyping, msg.react, thread.messages.fetch)
 * happen inline. The SDK dispatches each tool call to our handler and packages
 * the result back to Claude.
 */

import { z } from "zod";
import type { Message, ThreadChannel } from "discord.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../logger";
import { truncate } from "../discord/handlers/format";

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

/**
 * discord_send — post a message to the current thread.
 *
 * Content must be <= 1900 chars; longer content is rejected with a clear error
 * so Claude learns to split into multiple calls. If `reply_to_message_id` is
 * given and the target exists, we use `target.reply()` to highlight it;
 * otherwise we fall back to a plain `thread.send`.
 */
export const discordSendTool = tool(
  "discord_send",
  "Send a message to the current Discord thread. Returns the new message ID. " +
    "Content must be <= 1900 characters; if your reply is longer, split it into " +
    "multiple calls (one per logical paragraph or section). Use \\n\\n for " +
    "paragraph breaks. Prefer a single well-structured call over many tiny ones.",
  {
    content: z
      .string()
      .min(1)
      .max(DISCORD_MAX * 5) // Allow up to 5x to give Claude room before chunking kicks in
      .describe("Message text"),
    reply_to_message_id: z
      .string()
      .optional()
      .describe("Optional: message ID to reply to (highlights it for the user)"),
  },
  async (input, _extra) => {
    const content = input.content;
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
    log.info("discord_send posted", { message_id: msg.id });
    return textResult(
      JSON.stringify({ message_id: msg.id, content_length: msg.content.length }),
    );
  },
);

/**
 * discord_typing — show the typing indicator for ~10s.
 * Call before long tool operations so the user knows work is in progress.
 */
export const discordTypingTool = tool(
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

/**
 * discord_react — add an emoji reaction to a message in the thread.
 */
export const discordReactTool = tool(
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
      .describe("Emoji — Unicode (✅, ❌, ❓) or custom name:id (e.g. custom_emoji:123)"),
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

/**
 * discord_read_history — fetch recent messages from the current thread.
 * Chronological order (oldest first). Useful when the agent needs context
 * beyond the user's most recent message (e.g., earlier messages in the thread,
 * other users' comments — though this bot currently only allows one user).
 */
export const discordReadHistoryTool = tool(
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

export const allDiscordTools = [
  discordSendTool,
  discordTypingTool,
  discordReactTool,
  discordReadHistoryTool,
];

/**
 * Mutable binding so the `tool()` factories (defined at module load time)
 * can pick up per-thread deps (thread + send wrapper) at run time.
 *
 * The `tool()` factory returns a definition object immediately, but the
 * handler closure captures `deps` via this binding. We update it before
 * every Discord run, so each tool dispatch sees the correct thread.
 *
 * This is a deliberate trade-off: defining tools with explicit `deps`
 * would require creating a new MCP server (and re-`tool()`-ing all four)
 * per thread, which is wasteful. A module-level mutable binding is fine
 * because only one Discord run executes per thread at a time (the
 * concurrency cap is enforced upstream).
 */
let deps: DiscordToolDeps;

export function setDiscordToolDeps(d: DiscordToolDeps): void {
  deps = d;
}