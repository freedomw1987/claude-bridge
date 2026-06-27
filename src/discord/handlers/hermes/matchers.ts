/**
 * Hermes slash-command matchers.
 *
 * Each matcher is a pure regex check (no Discord API calls) that returns
 * either a boolean or the parsed args. Split out from the monolithic
 * hermesCommands.ts file for testability — every matcher here can be
 * unit-tested without booting a Discord client.
 *
 * Slash-prefix matching follows the existing pattern in `commands.ts`
 * (regex on content.trim()), so we don't need to register real slash
 * commands via the Discord API.
 */

import type { Message } from "discord.js";
import type { ProjectMode } from "../../../hermes/types";
import { stripMention } from "../../stripMention";

// Re-export so the existing `import { stripMention } from ".../hermes/matchers"`
// call sites in hermesCommands.ts continue to work.
export { stripMention };

export const isProjectCommand = (content: string): boolean =>
  /^\/project\b/i.test(stripMention(content));

export const matchStart = (content: string): RegExpMatchArray | null =>
  stripMention(content).match(/^\/project\s+start\b\s*([\s\S]*)$/i);

export const matchStatus = (content: string): boolean =>
  /^\/project\s+status\b/i.test(stripMention(content));

export const matchPlan = (content: string): boolean =>
  /^\/project\s+plan\b/i.test(stripMention(content));

export const matchKill = (content: string): boolean =>
  /^\/project\s+kill\b/i.test(stripMention(content));

export const matchResume = (content: string): boolean =>
  /^\/project\s+resume\b/i.test(stripMention(content));

export const matchList = (content: string): boolean =>
  /^\/project\s+list\b/i.test(stripMention(content));

/**
 * RG-009: Match `/project delete <id|prefix>` or
 * `/project delete --all-failed`.
 *
 * Returns the parsed args, or null if the command shape is invalid.
 * Validation of "project exists" / "prefix is unique" is done in
 * handleProjectDelete.
 */
export const matchDelete = (
  content: string,
): { kind: "id"; target: string } | { kind: "all-failed" } | null => {
  const m = stripMention(content).match(
    /^\/project\s+delete(?:\s+([\s\S]+))?$/i,
  );
  if (!m) return null;
  const arg = (m[1] ?? "").trim();
  if (arg === "") return null;
  if (arg.toLowerCase() === "--all-failed") return { kind: "all-failed" };
  // Single-token id/prefix. Reject multi-token to avoid silent
  // truncation (e.g. "/project delete 72be82cb extra").
  if (/\s/.test(arg)) return null;
  return { kind: "id", target: arg };
};

/**
 * Match `/project setMode auto|manual [duration]` or
 * `/project setMode=auto|manual` (legacy form, no duration).
 *
 * Examples:
 *   "/project setMode auto"        → { mode: "auto", duration: undefined }
 *   "/project setMode auto 30m"    → { mode: "auto", duration: "30m" }
 *   "/project setMode auto 1h30m"  → { mode: "auto", duration: "1h30m" }
 *   "/project setMode manual"      → { mode: "manual", duration: undefined }
 *   "/project setMode=auto 30m"    → { mode: "auto", duration: "30m" }
 *   "/project setMode foo"         → null
 *
 * Duration is captured as a raw string; the caller (handleProjectSetMode)
 * passes it to parseDuration(). We don't validate here so the parser
 * error messages stay in one place.
 */
export const matchSetMode = (
  content: string,
): { mode: ProjectMode; duration?: string } | null => {
  // Capture the mode + optional duration. Duration is one or more
  // "<digits><unit>" chunks separated by nothing (parser handles
  // ordering). We capture the rest of the line so trailing tokens
  // like "setMode auto 30m extra" are still parseable — handleProjectSetMode
  // complains if there's any leftover after duration.
  const m = stripMention(content).match(
    /^\/project\s+setMode(?:\s+|=)(\w+)(?:\s+([\dhms]+))?(?:\s+(.*))?$/i,
  );
  if (!m) return null;
  const modeRaw = m[1].toLowerCase();
  if (modeRaw !== "auto" && modeRaw !== "manual") return null;
  const duration = m[2];
  const leftover = m[3]?.trim();
  // Reject trailing garbage so typos like "setMode auto 30m!" surface
  // a clear error rather than silently being parsed.
  if (leftover && leftover.length > 0) return null;
  if (duration) return { mode: modeRaw, duration };
  return { mode: modeRaw };
};

/**
 * Match `/project adopt "<goal>" [auto <duration>] [manual]`.
 *
 * The goal MUST be wrapped in double quotes (same convention as
 * `/project start`). After the closing quote, optional mode and
 * duration tokens can appear in either order:
 *
 *   "/project adopt \"fix the auth bug\""           → auto 4h (default)
 *   "/project adopt \"fix the auth bug\" auto 1h"   → auto 1h
 *   "/project adopt \"fix the auth bug\" manual"    → manual
 *   "/project adopt \"x\" auto 30m manual"          → null (conflicting modes)
 *
 * Returns the parsed args, or null if the command shape is invalid.
 * Validation of session existence, no-existing-Hermes-project, duration
 * parsing, etc. is done in handleProjectAdopt.
 */
export const matchAdopt = (
  content: string,
):
  | { goal: string; mode: ProjectMode; duration?: string }
  | null => {
  // Group 1: quoted goal, Group 2: trailing tokens (optional).
  const m = stripMention(content).match(
    /^\/project\s+adopt\s+"([^"]+)"(?:\s+([\s\S]+))?$/i,
  );
  if (!m) return null;
  const goal = m[1].trim();
  if (goal.length < 3) return null;
  const trailing = (m[2] ?? "").trim();
  if (trailing === "") {
    return { goal, mode: "auto" };
  }
  // Trailing must be either:
  //   "manual"
  //   "auto [duration]"
  // Anything else → null. We don't accept "manual [duration]" because
  // manual mode never has a wallclock timer.
  if (/^manual$/i.test(trailing)) {
    return { goal, mode: "manual" };
  }
  const autoMatch = trailing.match(/^auto(?:\s+([\dhms]+))?$/i);
  if (autoMatch) {
    return { goal, mode: "auto", duration: autoMatch[1] };
  }
  return null;
};

/**
 * Shared context for all Hermes command handlers. Passed in by
 * messageCreate.ts (which already has the deps from createClient).
 */
export interface HermesCommandContext {
  msg: Message;
  store: import("../../../db").SessionStore;
  /** True when invoked in the configured channel (not in any thread). */
  isTopLevel: boolean;
}