/**
 * Discord formatting helpers.
 *
 * Pure functions for tool-use display, text truncation, think-tag stripping,
 * and question detection. No external deps beyond Message type for the
 * caller. Safe to unit-test in isolation.
 */

/**
 * Truncate a string with "..." suffix.
 * Used everywhere Discord length limits matter.
 */
export const truncate = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, max - 3) + "...";

/**
 * Heuristic: does this response end with a question that asks for user input?
 * Looks at the last ~250 chars for trailing `?` and question phrases.
 */
export function containsQuestion(text: string): boolean {
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

/**
 * Format a tool_use event for Discord display.
 * Shows the most relevant argument(s) per tool type.
 */
export function formatToolUse(name: string, input: unknown): string {
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

/**
 * Tool icon for the recent-activity line in the streaming placeholder.
 */
export const TOOL_ICON: Record<string, string> = {
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
