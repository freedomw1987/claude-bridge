/**
 * Tests for hermes/state.ts — atomic file I/O, journal append, project listing.
 * No mocks needed; uses temp directories.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendJournal,
  clearTimer,
  ensureProjectDir,
  listProjects,
  loadState,
  projectDir,
  resolveHermesDir,
  saveState,
  stripTimerHandle,
} from "./state";
import {
  DEFAULT_HERMES_CONFIG,
  isActive,
  newProjectState,
  type ProjectState,
} from "./types";

let tmpRoot: string;
let hermesDir: string;
let projectId: string;

function baseState(): ProjectState {
  return newProjectState({
    id: "p",
    threadId: "t",
    goal: "g",
    mode: "auto",
    repoPath: "/r",
    repoSource: "new",
    config: DEFAULT_HERMES_CONFIG,
  });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hermes-state-"));
  hermesDir = join(tmpRoot, "hermes");
  projectId = "test-project-1";
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("resolveHermesDir", () => {
  test("uses override when provided", () => {
    expect(resolveHermesDir("/data", "/custom")).toBe("/custom");
  });

  test("uses <dataDir>/hermes when override is empty", () => {
    expect(resolveHermesDir("/data", "")).toBe("/data/hermes");
  });

  test("uses <dataDir>/hermes when override is whitespace", () => {
    expect(resolveHermesDir("/data", "   ")).toBe("/data/hermes");
  });

  test("expands ~ in override", () => {
    const result = resolveHermesDir("/data", "~/custom");
    expect(result.startsWith("/")).toBe(true);
    expect(result.endsWith("/custom")).toBe(true);
  });
});

describe("ensureProjectDir + projectDir", () => {
  test("creates project + artifacts subdirectories", () => {
    const dir = ensureProjectDir(hermesDir, projectId);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "artifacts"))).toBe(true);
    expect(projectDir(hermesDir, projectId)).toBe(dir);
  });
});

describe("saveState + loadState", () => {
  test("round-trip preserves all fields", () => {
    ensureProjectDir(hermesDir, projectId);
    const state = newProjectState({
      id: projectId,
      threadId: "thread-123",
      goal: "build a CLI",
      mode: "auto",
      repoPath: "/tmp/repo",
      repoSource: "new",
      config: DEFAULT_HERMES_CONFIG,
    });

    saveState(hermesDir, projectId, state);
    const loaded = loadState(hermesDir, projectId);

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(state.id);
    expect(loaded!.threadId).toBe(state.threadId);
    expect(loaded!.goal).toBe(state.goal);
    expect(loaded!.mode).toBe("auto");
    expect(loaded!.status).toBe("planning");
    expect(loaded!.config.maxIterations).toBe(DEFAULT_HERMES_CONFIG.maxIterations);
  });

  test("saveState updates updatedAt to a recent timestamp", () => {
    ensureProjectDir(hermesDir, projectId);
    const state = newProjectState({
      id: projectId,
      threadId: "t",
      goal: "g",
      mode: "auto",
      repoPath: "/r",
      repoSource: "new",
      config: DEFAULT_HERMES_CONFIG,
    });
    // Force a clearly-different timestamp by setting state.createdAt to
    // 1 hour ago. After saveState, updatedAt will be set to "now" which
    // is at least 1 hour after the original.
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
    state.createdAt = oneHourAgo;
    state.updatedAt = oneHourAgo;
    saveState(hermesDir, projectId, state);
    const loaded = loadState(hermesDir, projectId);
    expect(loaded).not.toBeNull();
    // updatedAt should be set to "now" (much more recent than the
    // original 1-hour-ago timestamp).
    expect(new Date(loaded!.updatedAt).getTime()).toBeGreaterThan(
      new Date(oneHourAgo).getTime() + 60_000, // > 59 min after original
    );
    // createdAt should NOT be touched by saveState.
    expect(loaded!.createdAt).toBe(oneHourAgo);
  });

  test("atomic write: no state.json.tmp after success", () => {
    ensureProjectDir(hermesDir, projectId);
    const state = newProjectState({
      id: projectId,
      threadId: "t",
      goal: "g",
      mode: "auto",
      repoPath: "/r",
      repoSource: "new",
      config: DEFAULT_HERMES_CONFIG,
    });
    saveState(hermesDir, projectId, state);
    expect(existsSync(projectDir(hermesDir, projectId) + "/state.json.tmp")).toBe(false);
    expect(existsSync(projectDir(hermesDir, projectId) + "/state.json")).toBe(true);
  });

  test("loadState returns null when state.json missing", () => {
    ensureProjectDir(hermesDir, projectId);
    expect(loadState(hermesDir, projectId)).toBeNull();
  });

  test("loadState returns null when state.json is corrupted", () => {
    ensureProjectDir(hermesDir, projectId);
    const { writeFileSync } = require("node:fs");
    writeFileSync(
      projectDir(hermesDir, projectId) + "/state.json",
      "{invalid json",
    );
    expect(loadState(hermesDir, projectId)).toBeNull();
  });
});

describe("appendJournal", () => {
  test("writes entry to journal.log", () => {
    ensureProjectDir(hermesDir, projectId);
    appendJournal(hermesDir, projectId, {
      type: "task_start",
      message: "t1: do thing",
    });
    const logContent = readFileSync(
      projectDir(hermesDir, projectId) + "/journal.log",
      "utf8",
    );
    expect(logContent).toContain("[task_start] t1: do thing");
    expect(logContent).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("multiple entries accumulate in order", () => {
    ensureProjectDir(hermesDir, projectId);
    appendJournal(hermesDir, projectId, { type: "task_start", message: "first" });
    appendJournal(hermesDir, projectId, { type: "task_done", message: "second" });
    appendJournal(hermesDir, projectId, { type: "judge", message: "third" });
    const content = readFileSync(
      projectDir(hermesDir, projectId) + "/journal.log",
      "utf8",
    );
    const idxFirst = content.indexOf("first");
    const idxSecond = content.indexOf("second");
    const idxThird = content.indexOf("third");
    expect(idxFirst).toBeGreaterThan(-1);
    expect(idxSecond).toBeGreaterThan(idxFirst);
    expect(idxThird).toBeGreaterThan(idxSecond);
  });

  test("custom ts is honored", () => {
    ensureProjectDir(hermesDir, projectId);
    appendJournal(hermesDir, projectId, {
      type: "status",
      message: "manual",
      ts: "2026-06-22T00:00:00.000Z",
    });
    const content = readFileSync(
      projectDir(hermesDir, projectId) + "/journal.log",
      "utf8",
    );
    expect(content.startsWith("2026-06-22T00:00:00.000Z [status]")).toBe(true);
  });
});

describe("listProjects", () => {
  function createProject(id: string, status: ProjectState["status"]): void {
    ensureProjectDir(hermesDir, id);
    const state = newProjectState({
      id,
      threadId: `t-${id}`,
      goal: `goal for ${id}`,
      mode: "auto",
      repoPath: "/r",
      repoSource: "new",
      config: DEFAULT_HERMES_CONFIG,
    });
    state.status = status;
    saveState(hermesDir, id, state);
  }

  test("returns all projects when no filter", () => {
    createProject("p1", "executing");
    createProject("p2", "done");
    createProject("p3", "failed");
    expect(listProjects(hermesDir).length).toBe(3);
  });

  test("filters to active only when activeOnly=true", () => {
    createProject("p1", "executing");
    createProject("p2", "done");
    createProject("p3", "planning");
    createProject("p4", "killed");
    createProject("p5", "judging");
    const active = listProjects(hermesDir, { activeOnly: true });
    expect(active.length).toBe(3);
    const activeIds = active.map((s) => s.id).sort();
    expect(activeIds).toEqual(["p1", "p3", "p5"]);
  });

  test("returns empty array when no projects dir", () => {
    expect(listProjects(hermesDir)).toEqual([]);
  });
});

describe("isActive", () => {
  test("planning/executing/judging are active", () => {
    expect(isActive({ status: "planning" } as ProjectState)).toBe(true);
    expect(isActive({ status: "executing" } as ProjectState)).toBe(true);
    expect(isActive({ status: "judging" } as ProjectState)).toBe(true);
  });

  test("done/failed/killed are not active", () => {
    expect(isActive({ status: "done" } as ProjectState)).toBe(false);
    expect(isActive({ status: "failed" } as ProjectState)).toBe(false);
    expect(isActive({ status: "killed" } as ProjectState)).toBe(false);
  });
});

// ── Timer handle hygiene (M2.3 / ADR-0004) ─────────────────────────

describe("stripTimerHandle", () => {
  test("returns input unchanged when no timer is set", () => {
    const s = baseState();
    expect(stripTimerHandle(s)).toBe(s); // identity, no copy
  });

  test("removes handle from a timer-equipped state, keeps the rest", () => {
    const s = baseState();
    s.timer = {
      expiresAt: 1_700_000_000_000,
      handle: setTimeout(() => {}, 1) as unknown as ReturnType<typeof setTimeout>,
      requestedDuration: "30m",
      effectiveMs: 1_800_000,
      clamped: false,
    };
    const stripped = stripTimerHandle(s);
    expect(stripped.timer).toBeDefined();
    expect(stripped.timer!.handle).toBeUndefined();
    expect(stripped.timer!.expiresAt).toBe(1_700_000_000_000);
    expect(stripped.timer!.requestedDuration).toBe("30m");
    expect(stripped.timer!.effectiveMs).toBe(1_800_000);
    expect(stripped.timer!.clamped).toBe(false);
  });

  test("does not mutate the input state's timer.handle", () => {
    const s = baseState();
    const handle = setTimeout(() => {}, 1) as unknown as ReturnType<
      typeof setTimeout
    >;
    s.timer = {
      expiresAt: 1_700_000_000_000,
      handle,
      requestedDuration: "1h",
      effectiveMs: 3_600_000,
      clamped: false,
    };
    const stripped = stripTimerHandle(s);
    // Original still has its live handle (orchestrator keeps using it).
    expect(s.timer!.handle).toBe(handle);
    expect(stripped.timer!.handle).toBeUndefined();
    // Identity is broken (we returned a new object).
    expect(stripped).not.toBe(s);
  });
});

describe("clearTimer", () => {
  test("returns input unchanged when no timer is set", () => {
    const s = baseState();
    expect(clearTimer(s)).toBe(s);
  });

  test("drops the entire timer field (no handle-less zombie)", () => {
    const s = baseState();
    s.timer = {
      expiresAt: 1_700_000_000_000,
      handle: undefined,
      requestedDuration: "30m",
      effectiveMs: 1_800_000,
      clamped: false,
    };
    const cleared = clearTimer(s);
    expect(cleared.timer).toBeUndefined();
    expect(s.timer).toBeDefined(); // input not mutated
  });

  test("drops timer even when handle is live (no leak)", () => {
    const s = baseState();
    s.timer = {
      expiresAt: 1_700_000_000_000,
      handle: setTimeout(() => {}, 1) as unknown as ReturnType<typeof setTimeout>,
      requestedDuration: "1h",
      effectiveMs: 3_600_000,
      clamped: false,
    };
    const cleared = clearTimer(s);
    expect(cleared.timer).toBeUndefined();
  });
});

describe("saveState / loadState — timer round-trip (M2.3)", () => {
  test("saveState strips timer.handle from disk copy, keeps in-memory live", () => {
    const s = baseState();
    const handle = setTimeout(() => {}, 60_000) as unknown as ReturnType<
      typeof setTimeout
    >;
    s.timer = {
      expiresAt: Date.now() + 30 * 60 * 1000,
      handle,
      requestedDuration: "30m",
      effectiveMs: 1_800_000,
      clamped: false,
    };
    ensureProjectDir(hermesDir, projectId);
    saveState(hermesDir, projectId, s);

    // In-memory state still has its live handle (orchestrator keeps it).
    expect(s.timer!.handle).toBe(handle);

    // Disk copy does NOT have the handle.
    const onDisk = JSON.parse(
      readFileSync(join(projectDir(hermesDir, projectId), "state.json"), "utf8"),
    ) as ProjectState;
    expect(onDisk.timer).toBeDefined();
    expect(onDisk.timer!.handle).toBeUndefined();
    expect(onDisk.timer!.expiresAt).toBe(s.timer.expiresAt);
    expect(onDisk.timer!.requestedDuration).toBe("30m");
    expect(onDisk.timer!.effectiveMs).toBe(1_800_000);
    expect(onDisk.timer!.clamped).toBe(false);
  });

  test("loadState returns a state with no handle even if disk had one (defensive)", () => {
    // Simulate a legacy / buggy snapshot where handle is `{}` (the bug
    // we pinned in types.test.ts). The loader should drop it.
    const dir = projectDir(hermesDir, projectId);
    ensureProjectDir(hermesDir, projectId);
    const legacy = {
      ...baseState(),
      timer: {
        expiresAt: 1_700_000_000_000,
        handle: {}, // the bug snapshot
        requestedDuration: "30m",
        effectiveMs: 1_800_000,
        clamped: false,
      },
    };
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify(legacy, null, 2),
    );
    const loaded = loadState(hermesDir, projectId);
    expect(loaded).not.toBeNull();
    expect(loaded!.timer).toBeDefined();
    expect(loaded!.timer!.handle).toBeUndefined();
    expect(loaded!.timer!.expiresAt).toBe(1_700_000_000_000);
  });

  test("loadState of state with no timer returns state with no timer", () => {
    const s = baseState();
    ensureProjectDir(hermesDir, projectId);
    saveState(hermesDir, projectId, s);
    const loaded = loadState(hermesDir, projectId);
    expect(loaded!.timer).toBeUndefined();
  });

  test("saveState with cleared timer writes no timer field at all", () => {
    const s = baseState();
    s.timer = {
      expiresAt: 1_700_000_000_000,
      handle: undefined,
      requestedDuration: "30m",
      effectiveMs: 1_800_000,
      clamped: false,
    };
    ensureProjectDir(hermesDir, projectId);
    saveState(hermesDir, projectId, clearTimer(s));
    const onDisk = JSON.parse(
      readFileSync(join(projectDir(hermesDir, projectId), "state.json"), "utf8"),
    ) as ProjectState;
    expect(onDisk.timer).toBeUndefined();
  });

  test("saveState preserves killedReason across round-trip", () => {
    const s = baseState();
    s.status = "killed";
    s.killedReason = "duration_expired";
    s.endedAt = new Date().toISOString();
    ensureProjectDir(hermesDir, projectId);
    saveState(hermesDir, projectId, s);
    const loaded = loadState(hermesDir, projectId);
    expect(loaded!.killedReason).toBe("duration_expired");
    expect(loaded!.status).toBe("killed");
  });
});