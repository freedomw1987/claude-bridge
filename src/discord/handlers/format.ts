/**
 * Discord formatting helpers.
 *
 * Pure functions for text truncation and think-tag stripping. Used by
 * the Discord layer (truncate for chunk lengths) and by the SDK runner
 * (stripThinkTags to scrub Claude Code's extended-thinking blocks
 * before posting to Discord, RG-002).
 *
 * Phase 3 (2026-06-27): removed CLI-streaming helpers that became
 * dead code after the CLI runner retired —
 *   - formatToolUse    (CLI tool_use detail formatting)
 *   - formatToolResult (CLI tool_result one-liner)
 *   - TOOL_ICON        (CLI status-banner icon map)
 *   - containsQuestion (CLI final-text heuristic)
 * The SDK path doesn't render a streaming status banner, so these
 * had no callers.
 */

/**
 * Truncate a string with "..." suffix.
 * Used everywhere Discord length limits matter.
 */
export const truncate = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, max - 3) + "...";

/**
 * Strip thinking-block tags that Claude Code emits, in all known
 * variants, and collapse 3+ newlines into 2.
 *
 * Why this is comprehensive: Claude Code / Anthropic extended thinking
 * uses several tag forms depending on the model + SDK version:
 *  - `<thinking>...</thinking>`         (older CC, generic)
 *  - `<ant_thinking>...</ant_thinking>` (Anthropic extended thinking,
 *    the most common form in 2025-2026)
 *  - `<think>...</think>`               (some 3rd-party mirrors)
 *
 * A leak of any of these into Discord is a user-visible bug — the user
 * sees raw XML instead of CC's final answer (RG-002). The regex below
 * matches `<\s*` + any of the three tag names + `\s*>` to cover the
 * `ant_thinking` variant specifically, with `[\s\S]*?` (non-greedy,
 * any newlines) to handle multi-line blocks.
 */
const THINKING_TAG_RE =
  /<\s*(?:ant_)?think(?:ing)?\s*>[\s\S]*?<\s*\/?\s*(?:ant_)?think(?:ing)?\s*>/gi;

export function stripThinkTags(text: string): string {
  return text
    // Strip opening + closing tags + their contents (matches <thinking>,
    // <ant_thinking>, <think>; closing tags </thinking>, </ant_thinking>,
    // </think> are matched standalone in case the opening tag was split).
    .replace(THINKING_TAG_RE, "")
    // Defensive: in case the opening tag was malformed (e.g. CC wrote
    // `<thinking\n` instead of `<thinking>`), strip the dangling closing
    // tag on its own. Without this, a `<thinking>` without a matching
    // `</thinking>` leaves a stray opening tag visible.
    .replace(/<\s*\/?\s*(?:ant_)?think(?:ing)?\s*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}