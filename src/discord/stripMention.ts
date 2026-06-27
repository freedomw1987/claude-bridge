/**
 * Strip Discord user mentions from a message content string.
 *
 * Used by both `hermes/matchers.ts` (to identify `/project` commands
 * even when prefixed by `@bot` or other user mentions) and
 * `messageCreate.ts` (to recognize the mention-prefixed `/project`
 * invocation form). The parser has its own botUserId-specific variant
 * that only strips the bot's mention — that one's not deduped because
 * the semantics differ.
 *
 * Pattern: `<@123>` or `<@!123>` (nickname variant), followed by
 * optional whitespace, replaced with empty. Toggles match discord.js's
 * message mention syntax (the `!` distinguishes nicknames from
 * usernames; both forms must be handled).
 *
 * Returns the content with leading/trailing whitespace removed (matches
 * the historical behavior callers depend on).
 */
export function stripMention(content: string): string {
  return content.trim().replace(/<@!?\d+>\s*/g, "").trim();
}