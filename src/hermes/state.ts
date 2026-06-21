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
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { log } from "../logger";
import {
  isActive,
  type JournalEntry,
  type JournalEntryType,
  type ProjectState,
} from "./types";

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
  const json = JSON.stringify(state, null, 2);
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
 * Append a journal entry both to the in-memory state.journal array and to
 * the durable journal.log file. The in-memory copy is small (last N entries
 * is fine; we keep all of them for now) and exists for /project status
 * quick view; the file is the source of truth for after-restart replay.
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
  // Best-effort mirror to state.json. Caller should saveState() afterward
  // to make the in-memory copy atomic — this is just an in-place mutation.
  const state = loadState(hermesDir, projectId);
  if (state) {
    state.journal.push(full);
  }
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