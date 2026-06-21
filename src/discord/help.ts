/**
 * Help text + reply helper.
 *
 * Used by:
 *   - /help slash command
 *   - fallback reply when bot is mentioned with empty/ambiguous target
 *   - reply when a user messages in a thread with no active session
 *
 * Keeping the help text + reply logic in one module so the messageCreate
 * handler (already 795 lines) doesn't keep growing.
 */

import type { Message } from "discord.js";

export const HELP_TEXT = `🤖 **claude-bridge — usage**

**Quick start** (in your dev channel)
• \`@bot in <project> <prompt>\` — work in an existing project
• \`@bot new <name> <prompt>\` — create a new project
• \`@bot <git-url> <prompt>\` — clone a repo and work on it
• \`@bot <local-path> <prompt>\` — work in an existing local dir

**Inside a thread**
Just type messages — each one is forwarded to Claude Code.
Context is preserved across messages (the session is resumed).
By default, threads use the **SDK runner** (Claude Agent SDK + Discord
tools: \`discord_send\`, \`discord_typing\`, \`discord_react\`, \`discord_read_history\`).
Use \`/use-cli\` to switch back to the legacy streaming UX.

**Slash commands** (inside a thread)
• \`/repo <url|path|name>\` — change the working target
• \`/projects\` — list all known projects
• \`/status\` — show current session info (incl. runner kind)
• \`/kill\` — stop the running session (files remain on host)
• \`/use-cli\` — switch this thread to the CLI runner (legacy streaming)
• \`/use-sdk\` — switch this thread to the SDK runner (tool-calling)
• \`/help\` — show this message`;

/**
 * Reply to a message with the help text.
 * Falls back to channel.send if the reply fails (e.g. deleted message).
 */
export async function sendHelp(msg: Message): Promise<void> {
  try {
    await msg.reply(HELP_TEXT);
  } catch {
    try {
      const ch = msg.channel as { send?: (c: string) => Promise<unknown> };
      if (typeof ch.send === "function") {
        await ch.send(HELP_TEXT);
      }
    } catch {
      // give up silently
    }
  }
}

export const EMPTY_PROMPT_TEXT = `👋 What do you want me to do?

Try one of these in your dev channel:
• \`@bot in <project> <prompt>\` — work in an existing project
• \`@bot new <name> <prompt>\` — create a new project
• \`@bot <git-url> <prompt>\` — clone a repo
• \`@bot <local-path> <prompt>\` — work in a local dir

Type \`/help\` in a thread for the full reference.`;

export const NO_TARGET_TEXT = `🤔 I couldn't figure out what to work on.

Your message should mention a project, path, or git URL. Try:
• \`@bot in claude-bridge fix the parser\`
• \`@bot new my-app a CLI for resizing images\`
• \`@bot <github-url> <prompt>\`
• Or send \`/repo <url|path|name>\` here to set a target.

Type \`/help\` for the full reference.`;

export const NO_SESSION_TEXT = `🤔 No active session in this thread.

This thread wasn't started by claude-bridge. To start a task:
1. Go to your dev channel
2. Type \`@bot <prompt>\` — a new thread will be created for you

Type \`/help\` in your new thread for usage examples.`;
