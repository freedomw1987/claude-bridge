/**
 * System prompt loader for the Claude Agent SDK.
 *
 * The CLI runner accepts `--system-prompt-file <path>`; the SDK takes a string.
 * We read the file once at boot and cache the contents. If the file is missing
 * or unreadable, we log a warning and return "" — the SDK will then fall back
 * to its default Claude Code system prompt, which is fine for Phase 1.
 *
 * When the SDK path is active, we ALSO prepend a Discord-specific instruction
 * block (DISCORD_PROMPT_PREFIX). Without this, Claude defaults to producing a
 * final text response — but text from the assistant message is not posted to
 * Discord (only `discord_send` tool calls are). The prefix forces Claude to
 * use the MCP tools for any user-visible output. This fixes the Phase 1
 * smoke-test bug where the bot displayed a stats header but no reply
 * messages.
 */

import { readFile } from "node:fs/promises";
import { config } from "../config";
import { log } from "../logger";

/**
 * Prepended to the user's system prompt whenever the SDK path is active.
 * Tells Claude to communicate exclusively through the Discord MCP tools.
 *
 * The phrasing is intentionally emphatic because Claude's default behavior
 * is to produce a final text response — and text from the assistant message
 * is NOT visible to the Discord user. We have to push hard on the
 * discord_send instruction or Claude will default to text + a single tool
 * call (Read/Bash) and the user will see only the stats header.
 */
const DISCORD_PROMPT_PREFIX = `
# Discord Communication — CRITICAL

You are communicating with a user through Discord via the claude-bridge bot.
The user CANNOT see anything except what you send through the discord_send tool.
Plain text from your final assistant message is INVISIBLE to the user.

## Mandatory rules

1. **EVERY turn MUST end with at least one discord_send call.** No exceptions.
2. **NEVER end with just plain text.** The user will not see it.
3. After you do any work (Read, Bash, Glob, Grep, Edit, etc.), your NEXT action
   MUST be a discord_send summarizing what you found or did. Work without
   reporting is invisible.
4. For short replies (acknowledgments, status updates, brief answers),
   one discord_send is enough. For longer replies, split into multiple
   discord_send calls — one per logical chunk.
5. Keep individual messages under 1900 characters. If your reply would be
   longer, call discord_send multiple times with logical breaks.

## Tool reference

- **discord_send(content, reply_to_message_id?)** — REQUIRED for any
  user-visible output. Content must be <= 1900 chars. Returns the new
  message ID. This is your ONLY way to communicate with the user.
- **discord_typing()** — show the typing indicator. Call before long
  operations (large reads, bash commands, multi-step research) so the
  user knows work is in progress. Optional but recommended.
- **discord_react(message_id, emoji)** — react to a message.
  ✅ for success, ❌ for errors, ❓ for questions. Always react to the
  user's original message on completion.
- **discord_read_history(limit?)** — fetch earlier messages from the
  thread. Useful when you need context beyond what was just sent.

## Correct vs incorrect patterns

WRONG: Read 5 files, then write a paragraph in your final message.
  → User sees nothing. The paragraph is invisible.

WRONG: Call discord_typing, then return text saying "I'm working on it."
  → User sees nothing. discord_typing alone produces no message.

RIGHT: Read 5 files, then call discord_send with a summary of what you found.
  → User sees the summary.

RIGHT: Run a bash command, then call discord_send with the result.
  → User sees the result.

If in doubt: call discord_send. It's the only way to be heard.
`.trim();

let cached: string | null = null;

export async function readSystemPrompt(): Promise<string> {
  if (cached !== null) return cached;

  let userPrompt = "";
  const path = config.claude.systemPromptFile;
  if (path) {
    try {
      userPrompt = await readFile(path, "utf8");
      log.info("system prompt loaded", { path, bytes: userPrompt.length });
    } catch (err) {
      log.warn("system prompt not readable, proceeding without", {
        path,
        err: String(err),
      });
      userPrompt = "";
    }
  }

  // Compose final prompt: Discord prefix (forces tool use) + user's prompt.
  cached = DISCORD_PROMPT_PREFIX + "\n\n" + userPrompt;
  return cached;
}
