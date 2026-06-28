/**
 * Conditional classnames — tiny replacement for `clsx`/`classnames`.
 * Filters out falsy values and joins the rest with spaces.
 */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}