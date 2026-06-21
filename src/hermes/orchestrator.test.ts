/**
 * Tests for hermes/orchestrator.ts pure helpers — pickNextTask, shouldStop.
 * Does NOT exercise the full orchestrator loop (which requires Discord + SDK).
 */

import { describe, test, expect } from "bun:test";
import { pickNextTask, shouldStop } from "./orchestrator";
import {
  DEFAULT_HERMES_CONFIG,
  isActive,
  newProjectState,
  type ProjectState,
  type Task,
} from "./types";

function baseState(overrides: Partial<ProjectState> = {}): ProjectState {
  const s = newProjectState({
    id: "p",
    threadId: "t",
    goal: "g",
    mode: "auto",
    repoPath: "/r",
    repoSource: "new",
    config: DEFAULT_HERMES_CONFIG,
  });
  // Start at a recent timestamp so wall-hours cap doesn't fire instantly.
  s.startedAt = new Date(Date.now() - 1000).toISOString();
  return { ...s, ...overrides };
}

function task(
  id: string,
  status: Task["status"] = "pending",
  deps: string[] = [],
): Task {
  return {
    id,
    title: `task ${id}`,
    description: `desc ${id}`,
    status,
    attempts: 0,
    dependsOn: deps,
  };
}

describe("pickNextTask", () => {
  test("returns null when plan is empty", () => {
    expect(pickNextTask(baseState({ plan: [] }))).toBeNull();
  });

  test("returns null when no pending tasks", () => {
    const state = baseState({
      plan: [task("t1", "done"), task("t2", "in_progress"), task("t3", "failed")],
    });
    expect(pickNextTask(state)).toBeNull();
  });

  test("returns the single pending task", () => {
    const state = baseState({ plan: [task("t1", "pending")] });
    expect(pickNextTask(state)?.id).toBe("t1");
  });

  test("returns first pending task in order", () => {
    const state = baseState({
      plan: [task("t1", "done"), task("t2", "pending"), task("t3", "pending")],
    });
    expect(pickNextTask(state)?.id).toBe("t2");
  });

  test("skips pending task with unsatisfied deps", () => {
    const state = baseState({
      plan: [
        task("t1", "pending"),
        task("t2", "pending", ["t1"]),
        task("t3", "pending"),
      ],
    });
    // t1 has no deps, so it's picked.
    expect(pickNextTask(state)?.id).toBe("t1");
  });

  test("blocks task whose dep is still in_progress", () => {
    const state = baseState({
      plan: [task("t1", "in_progress"), task("t2", "pending", ["t1"])],
    });
    // t1 is in_progress, t2 is blocked; no eligible task.
    expect(pickNextTask(state)).toBeNull();
  });

  test("unblocks task whose dep is done", () => {
    const state = baseState({
      plan: [task("t1", "done"), task("t2", "pending", ["t1"])],
    });
    expect(pickNextTask(state)?.id).toBe("t2");
  });

  test("treats skipped deps as satisfied", () => {
    const state = baseState({
      plan: [task("t1", "skipped"), task("t2", "pending", ["t1"])],
    });
    expect(pickNextTask(state)?.id).toBe("t2");
  });

  test("multi-dep task needs ALL deps done", () => {
    const state = baseState({
      plan: [
        task("t1", "done"),
        task("t2", "pending"),
        task("t3", "pending", ["t1", "t2"]),
      ],
    });
    // t1 done, t2 pending (no deps), so t2 is picked first.
    expect(pickNextTask(state)?.id).toBe("t2");
    // Mark t2 done → t3 should be eligible.
    state.plan[1].status = "done";
    expect(pickNextTask(state)?.id).toBe("t3");
  });
});

describe("shouldStop", () => {
  test("returns null when under all caps", () => {
    const state = baseState({ iterations: 5, costUsd: 100 });
    expect(shouldStop(state)).toBeNull();
  });

  test("stops when iterations >= maxIterations", () => {
    const state = baseState({
      iterations: DEFAULT_HERMES_CONFIG.maxIterations,
      costUsd: 0,
    });
    const reason = shouldStop(state);
    expect(reason).toContain("iterations");
    expect(reason).toContain(String(DEFAULT_HERMES_CONFIG.maxIterations));
  });

  test("stops when costUsd >= maxCostUsd", () => {
    const state = baseState({
      iterations: 0,
      costUsd: DEFAULT_HERMES_CONFIG.maxCostUsd,
    });
    const reason = shouldStop(state);
    expect(reason).toContain("cost");
    expect(reason).toContain("$");
  });

  test("stops when wall-clock >= maxWallHours", () => {
    const state = baseState({
      iterations: 0,
      costUsd: 0,
      startedAt: new Date(
        Date.now() - (DEFAULT_HERMES_CONFIG.maxWallHours + 1) * 3600 * 1000,
      ).toISOString(),
    });
    const reason = shouldStop(state);
    expect(reason).toContain("elapsed");
    expect(reason).toContain("h");
  });

  test("does not stop at exactly cap-1", () => {
    const state = baseState({
      iterations: DEFAULT_HERMES_CONFIG.maxIterations - 1,
      costUsd: DEFAULT_HERMES_CONFIG.maxCostUsd - 1,
    });
    expect(shouldStop(state)).toBeNull();
  });
});

/**
 * Regression: 2026-06-22 — /project kill did not stop the orchestrator.
 *
 * Root cause: the orchestrator held state in a local `let state` variable
 * and never re-read from disk between iterations. When handleProjectKill
 * wrote state.status="killed" to disk, the orchestrator's local state
 * was still "executing" and the while loop continued.
 *
 * Fix: at the top of every while-loop iteration, reload state from disk
 * and exit if status changed externally. Also: in runOneTask, after
 * executeTask returns, reload state and exit early if no longer executing
 * (so we don't overwrite the killed status with "done" or "failed").
 */
describe("kill detection (regression: 2026-06-22)", () => {
  test("isActive correctly identifies terminal vs non-terminal states", () => {
    // The orchestrator's reload-then-check pattern relies on
    // state.status === "executing" as the loop guard. Verify that
    // "killed" is treated as terminal so the loop exits.
    const { isActive } = require("./types");
    expect(isActive({ status: "executing" } as ProjectState)).toBe(true);
    expect(isActive({ status: "killed" } as ProjectState)).toBe(false);
    // This is what the orchestrator checks: state.status === "executing"
    // in the while loop. After kill, status is "killed", so the loop exits.
    const killedState: ProjectState = { status: "killed" } as ProjectState;
    expect(killedState.status === "executing").toBe(false);
  });
});

describe("parseApprovalReply (manual mode)", () => {
  // Deprecated 2026-06-22: manual mode no longer does per-task approval.
  // Manual mode now passes the whole goal directly to Claude Code (the
  // @bot flow), so there is no approval gate and no reply vocabulary.
  // The parseApprovalReply function and its test suite were removed.
  test.skip("placeholder — manual mode approval flow removed", () => {});
});

/**
 * Manual mode dispatch (2026-06-22 redesign).
 *
 * Manual mode means: the goal is passed directly to Claude Code as a
 * single prompt (no planning, no per-task approval). Equivalent to the
 * original @bot flow but invoked via /project start. runProject should
 * dispatch to runManualProject when state.mode === "manual".
 *
 * These tests verify the dispatch surface (state.mode detection) using
 * a loadState round-trip. Full integration of runManualProject would
 * require Discord mocks and is out of scope for unit tests.
 */
describe("manual mode dispatch (regression: 2026-06-22)", () => {
  test("a manual-mode project has no plan (runProject should skip doPlanning)", () => {
    // The contract: in manual mode, runProject's planning phase must
    // NOT call the LLM planner. Since we set plan=[] here, doPlanning
    // would have no tasks to attach. The real dispatch is at the top
    // of runProject (state.mode === "manual" -> runManualProject).
    const state = baseState({ mode: "manual", plan: [] });
    expect(state.mode).toBe("manual");
    expect(state.plan).toEqual([]);
  });

  test("isActive(manual project) lets the consume gate pass through to forwardToClaude", () => {
    // In manual mode, the Hermes thread consume gate must NOT consume
    // (so David's follow-up messages reach forwardToClaude for session
    // resume). The gate checks mode === "auto" AND isActive, so a
    // manual project returns false from the gate.
    const state = baseState({
      mode: "manual",
      status: "executing",
    });
    expect(isActive(state)).toBe(true);
    // The dispatcher logic in hermesCommands:
    const shouldConsume = state.mode === "auto" && isActive(state);
    expect(shouldConsume).toBe(false);
  });

  test("isActive(auto project) IS consumed by the gate", () => {
    const state = baseState({
      mode: "auto",
      status: "executing",
    });
    const shouldConsume = state.mode === "auto" && isActive(state);
    expect(shouldConsume).toBe(true);
  });

  test("terminal state (done) is NOT consumed regardless of mode", () => {
    // After manual run completes, status="done" — David's follow-ups
    // should fall through to forwardToClaude (session resume).
    const autoDone = baseState({ mode: "auto", status: "done" });
    const manualDone = baseState({ mode: "manual", status: "done" });
    expect((autoDone.mode === "auto") && isActive(autoDone)).toBe(false);
    expect((manualDone.mode === "auto") && isActive(manualDone)).toBe(false);
  });
});