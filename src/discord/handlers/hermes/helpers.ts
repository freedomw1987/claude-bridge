/**
 * Shared helpers for Hermes command handlers.
 *
 * Pure functions + small filesystem lookups used by multiple handlers
 * (findProjectByThread, parseStartArgs, etc.). Split out from the
 * monolithic hermesCommands.ts so each handler file stays focused
 * on its own command.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadState } from "../../../hermes/state";
import type { ProjectState, ProjectMode } from "../../../hermes/types";

/**
 * Scan all Hermes projects on disk and return the one whose `threadId`
 * matches. Used by:
 *   - `/project adopt` (preflight: refuse if a project already exists)
 *   - `/project status` / `setMode` (find current project for this thread)
 *   - `dispatchHermesCommand` (consume-gate for AUTO mode)
 *
 * O(n) scan of the projects directory; n is typically <20 so this is
 * cheap. Don't introduce an index without measuring.
 */
export function findProjectByThread(
  hermesDir: string,
  threadId: string,
): ProjectState | null {
  const projectsRoot = join(hermesDir, "projects");
  if (!existsSync(projectsRoot)) return null;
  for (const entry of readdirSync(projectsRoot)) {
    const s = loadState(hermesDir, entry);
    if (s && s.threadId === threadId) return s;
  }
  return null;
}

/**
 * Truncate a string with "…" suffix. Local copy because the format.ts
 * helper uses "..." which reads as noise in a Discord reply context.
 */
export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Parse an integer from a CLI flag value. Returns 0 on parse failure
 * so callers can distinguish "unset" from "explicit 0" via the
 * `parsed.flags.maxX ?? default` chain in handleProjectStart.
 */
export function parseIntOr(v: string): number {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Validate + resolve a local path passed to `/project start in <path>`.
 *
 * Allows ~, absolute /, or relative paths with alphanum, /, -, _, ., =, space.
 * Returns either { ok: true, path } with the tilde expanded, or
 * { ok: false, error } with a human-readable rejection message.
 */
export function resolveLocalPath(
  p: string,
): { ok: true; path: string } | { ok: false; error: string } {
  if (!p || p.trim() === "") return { ok: false, error: "empty path" };
  // Reject obvious bad chars but allow ~, alphanum, /, -, _, ., =
  if (!/^[~][\w./= -]*$|^[/][\w./= -]*$|^[\w][\w./= -]*$/.test(p)) {
    return { ok: false, error: `invalid characters in path: ${p}` };
  }
  const expanded = p.startsWith("~")
    ? join(process.env.HOME ?? "/", p.slice(1))
    : p;
  return { ok: true, path: expanded };
}

export interface StartArgs {
  ok: boolean;
  error?: string;
  goal: string;
  localPath?: string;
  flags: {
    mode?: ProjectMode;
    maxIterations?: number;
    maxCostUsd?: number;
    maxWallHours?: number;
    maxAttemptsPerTask?: number;
  };
}

/**
 * Parse `/project start [--flags] [in <path>] "goal"`.
 *
 * Returns either `{ ok: true, goal, localPath, flags }` or
 * `{ ok: false, error, goal: "", flags: {} }`. Validation of the
 * goal's semantic content (e.g. min length, max length) is NOT
 * done here — we want the helper to be a clean parse, with the
 * caller deciding what content is acceptable.
 */
export function parseStartArgs(raw: string): StartArgs {
  const flags: StartArgs["flags"] = {};
  let s = raw.trim();

  // Pull out --key=value flags.
  const flagRe = /--([a-z-]+)(?:=("[^"]*"|\S+))?/gi;
  let m: RegExpExecArray | null;
  while ((m = flagRe.exec(s)) !== null) {
    const key = m[1].toLowerCase();
    let val = m[2] ?? "true";
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    switch (key) {
      case "mode":
        if (val !== "auto" && val !== "manual") {
          return { ok: false, error: `invalid --mode: ${val}`, goal: "", flags };
        }
        flags.mode = val;
        break;
      case "max-iterations":
      case "maxiterations":
        flags.maxIterations = parseIntOr(val);
        break;
      case "max-cost":
      case "maxcostusd":
        flags.maxCostUsd = parseIntOr(val);
        break;
      case "max-wall-hours":
      case "maxwallhours":
        flags.maxWallHours = parseIntOr(val);
        break;
      case "max-attempts":
      case "maxattemptisper-task":
        flags.maxAttemptsPerTask = parseIntOr(val);
        break;
      default:
        return { ok: false, error: `unknown flag: --${key}`, goal: "", flags };
    }
  }
  s = s.replace(flagRe, "").trim();

  // Optional `in <path>` clause.
  let localPath: string | undefined;
  const inMatch = s.match(/^in\s+("[^"]+"|\S+)\s*([\s\S]*)$/i);
  if (inMatch) {
    localPath = inMatch[1];
    if (localPath.startsWith('"') && localPath.endsWith('"')) localPath = localPath.slice(1, -1);
    s = inMatch[2].trim();
  }

  // Remaining text is the goal (must be quoted).
  const goalMatch = s.match(/^"([^"]+)"\s*$/);
  if (!goalMatch) {
    return { ok: false, error: `goal must be wrapped in double quotes`, goal: "", flags };
  }
  const goal = goalMatch[1].trim();
  if (goal.length < 3) {
    return { ok: false, error: `goal too short (min 3 chars)`, goal: "", flags };
  }

  return { ok: true, goal, localPath, flags };
}