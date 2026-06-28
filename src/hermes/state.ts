/**
 * Hermes state file I/O.
 *
 * One project = one directory under `<hermesDir>/projects/<projectId>/`:
 *
 *   state.json   — full ProjectState, atomic-rewritten on every save
 *   plan.md      — human-readable plan, written once after planning
 *   journal.log  — append-only decision log (more detailed than state.journal)
 *   artifacts/   — placeholder for completed project's deliverable manifests
 *
 * Atomic writes use the writeFileSync(tmp) → renameSync(target) pattern so
 * a bot crash mid-write can never leave a half-written state.json. The
 * `.tmp` file is best-effort cleaned on read.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  appendFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { log } from "../logger";
import {
  isActive,
  type JournalEntry,
  type JournalEntryType,
  type ProjectState,
  type ProjectTimer,
} from "./types";

// ── Timer handle hygiene (ADR-0004) ──────────────────────────────────
//
// `ProjectTimer.handle` is a NodeJS Timeout reference — process-local and
// NOT serializable. NodeJS Timeouts have no own enumerable props, so
// `JSON.stringify(handle)` produces `{}` (not `undefined`), and the field
// would round-trip as a phantom `{}` on disk. We strip it explicitly in
// saveState and re-create it from `expiresAt` in loadState (the latter
// happens in index.ts's resumeActiveProjects, not here — we don't want
// loadState to spawn side-effect timers on a plain disk read).
//
// The pattern below (immutable struct -> strip -> JSON.stringify) keeps
// the in-memory `state.timer.handle` reference intact for the running
// orchestrator while writing a clean `state.json` to disk.

/**
 * Return a deep-clone of `state` with `state.timer.handle` removed.
 * The in-memory `state` object is NOT mutated — callers can keep using
 * the live handle reference after saveState returns.
 */
export function stripTimerHandle(state: ProjectState): ProjectState {
  if (!state.timer) return state;
  const { handle: _, ...persistable } = state.timer;
  return { ...state, timer: persistable };
}

/**
 * Clear the timer field entirely (used on terminal transition, manual
 * switch, or `/project kill`). Returns a new state object; the input
 * is not mutated.
 */
export function clearTimer(state: ProjectState): ProjectState {
  if (!state.timer) return state;
  const { timer: _, ...without } = state;
  return without as ProjectState;
}

export function projectDir(hermesDir: string, projectId: string): string {
  return join(hermesDir, "projects", projectId);
}

/** Ensure the project dir exists; creates it (and parents) if not. */
export function ensureProjectDir(
  hermesDir: string,
  projectId: string,
): string {
  const dir = projectDir(hermesDir, projectId);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  return dir;
}

/**
 * Atomically persist state. Uses the write-to-tmp + rename pattern so a
 * crash mid-write can never produce a half-written state.json. After rename
 * succeeds, the previous state.json (if any) is replaced — there is no
 * historical snapshot. For debugging, journal.log is the durable record.
 */
export function saveState(
  hermesDir: string,
  projectId: string,
  state: ProjectState,
): void {
  state.updatedAt = new Date().toISOString();
  const dir = projectDir(hermesDir, projectId);
  const target = join(dir, "state.json");
  const tmp = join(dir, "state.json.tmp");
  // ADR-0004: strip ProjectTimer.handle (process-local Timeout) before
  // serialization. The in-memory `state` keeps its live handle for the
  // orchestrator; only the disk copy is filtered.
  const persistable = stripTimerHandle(state);
  const json = JSON.stringify(persistable, null, 2);
  try {
    writeFileSync(tmp, json);
    renameSync(tmp, target);
  } catch (err) {
    log.error("hermes: saveState failed", {
      projectId,
      err: String(err),
    });
    // Best-effort cleanup of the tmp file.
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

/** Load project state from disk. Returns null if state.json doesn't exist. */
export function loadState(
  hermesDir: string,
  projectId: string,
): ProjectState | null {
  const path = join(projectDir(hermesDir, projectId), "state.json");
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as ProjectState;
    // Defensive: clean up any orphan tmp from a crashed save.
    const tmp = join(projectDir(hermesDir, projectId), "state.json.tmp");
    if (existsSync(tmp)) {
      try {
        unlinkSync(tmp);
      } catch {
        // ignore
      }
    }
    // ADR-0004: a disk-read state should never carry a handle. If we somehow
    // loaded one (older buggy snapshot?), drop it. Re-arming the timer is
    // the caller's job (see index.ts:resumeActiveProjects).
    if (parsed.timer?.handle !== undefined) {
      const { handle: _, ...timerNoHandle } = parsed.timer;
      parsed.timer = timerNoHandle as ProjectTimer;
    }
    return parsed;
  } catch (err) {
    log.error("hermes: loadState failed", {
      projectId,
      err: String(err),
    });
    return null;
  }
}

/**
 * Append a journal entry to the durable journal.log file. The file is
 * the source of truth — there is no in-memory mirror in state.journal
 * (callers that need an in-memory journal array should keep their own
 * local list and append to it after this call returns).
 *
 * Why no in-memory mirror: the previous implementation did a sync
 * `loadState` + `state.journal.push(full)` after every append, but no
 * caller followed up with `saveState()`, so the mutation was silently
 * discarded on the next `loadState`. The disk read + JSON.parse were
 * pure waste (Hermes auto-mode did ~20 of these per project). Removed
 * 2026-06-27.
 */
export function appendJournal(
  hermesDir: string,
  projectId: string,
  entry: Omit<JournalEntry, "ts"> & { ts?: string },
): void {
  const full: JournalEntry = {
    ts: entry.ts ?? new Date().toISOString(),
    type: entry.type as JournalEntryType,
    message: entry.message,
  };
  const dir = projectDir(hermesDir, projectId);
  appendFileSync(
    join(dir, "journal.log"),
    `${full.ts} [${full.type}] ${full.message}\n`,
  );
  // P2.5: emit on the in-process event bus so the HTTP server can
  // push SSE updates to connected frontends. Imported lazily to avoid
  // a circular dependency (state.ts is imported by the bot's index,
  // which in turn starts the HTTP server which would also want events).
  // The dynamic import is fine — events.ts has no side effects at
  // module load time.
  void import("../events").then(({ appEvents }) => {
    appEvents.emit("app", { kind: "journal", projectId, entry: full });
  });
}

/** Write the human-readable plan.md (called once after planning completes). */
export function savePlan(
  hermesDir: string,
  projectId: string,
  markdown: string,
): void {
  const dir = projectDir(hermesDir, projectId);
  writeFileSync(join(dir, "plan.md"), markdown);
}

/**
 * List all projects on disk. Optionally filter to only active ones (so the
 * bot can resume them on startup).
 */
export function listProjects(
  hermesDir: string,
  opts?: { activeOnly?: boolean },
): ProjectState[] {
  const projectsRoot = join(hermesDir, "projects");
  if (!existsSync(projectsRoot)) return [];
  const out: ProjectState[] = [];
  for (const entry of readdirSync(projectsRoot)) {
    const state = loadState(hermesDir, entry);
    if (!state) continue;
    if (opts?.activeOnly && !isActive(state)) continue;
    out.push(state);
  }
  return out;
}

/**
 * RG-009: Permanently delete a project directory from disk.
 *
 * Used by `/project delete <id>` and `/project delete --all-failed`.
 * Removes the entire `<hermesDir>/projects/<projectId>/` subtree
 * (state.json, journal.log, plan.md, artifacts/) so a follow-up
 * `/project list` no longer surfaces the project.
 *
 * Safety:
 *   - `projectId` MUST be a bare UUID with no `/` or `..` segments.
 *     Anything else is rejected with `false` (no deletion occurs).
 *     The `existsSync` precheck is defensive against race conditions
 *     (project already deleted by another path) — returning `false`
 *     in that case is benign and idempotent.
 *   - This is intentionally NOT recoverable. Callers must obtain
 *     confirmation before invoking. The audit trail is the bot log
 *     (`logger.log.info("hermes: project deleted", ...)`) since the
 *     project's own journal.log is removed along with the rest of
 *     the directory.
 *
 * Returns `true` if the project dir existed and was removed, `false`
 * if it did not exist (or if the projectId was rejected by the
 * safety check).
 */
export function deleteProject(
  hermesDir: string,
  projectId: string,
): boolean {
  // Safety: reject anything that isn't a bare identifier (no
  // slashes, no whitespace, no shell metacharacters). Hermes
  // project IDs are normally RFC 4122 UUIDs (lowercase hex +
  // dashes) but test fixtures use prefixed UUIDs like
  // `rg009-I8A5cf...` so we accept any string of safe characters
  // (alphanumeric + dash + underscore) to be permissive.
  if (!/^[0-9a-zA-Z_-]+$/.test(projectId)) return false;
  const dir = projectDir(hermesDir, projectId);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * RG-009: Resolve a (possibly 8-char) project id prefix to a full
 * projectId. If exactly one project's id starts with `prefix`,
 * returns that projectId. If zero match, returns null. If multiple
 * match (ambiguous), returns a special sentinel — caller's
 * responsibility to handle.
 *
 * The sentinel is an empty string (returned as `{ ambiguous: true,
 * matches: string[] }`), so the caller can disambiguate without
 * touching extra state.
 */
export function resolveProjectPrefix(
  hermesDir: string,
  prefix: string,
): { projectId: string | null; ambiguous: string[] } {
  if (prefix.length < 4) return { projectId: null, ambiguous: [] };
  const projectsRoot = join(hermesDir, "projects");
  if (!existsSync(projectsRoot)) return { projectId: null, ambiguous: [] };
  const matches: string[] = [];
  for (const entry of readdirSync(projectsRoot)) {
    if (entry.startsWith(prefix)) matches.push(entry);
  }
  if (matches.length === 0) return { projectId: null, ambiguous: [] };
  if (matches.length === 1) return { projectId: matches[0], ambiguous: [] };
  return { projectId: null, ambiguous: matches };
}

/**
 * Resolve the hermes root dir. Mirrors the env var `HERMES_DIR` or defaults
 * to `<dataDir>/hermes`. Importing callers don't need to know the default.
 */
export function resolveHermesDir(dataDir: string, override?: string): string {
  return override && override.trim() !== ""
    ? expandTilde(override)
    : join(dataDir, "hermes");
}

function expandTilde(p: string): string {
  if (!p.startsWith("~")) return p;
  const home = process.env.HOME ?? "";
  return home + p.slice(1);
}