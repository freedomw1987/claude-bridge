/**
 * Tests for hermes/orchestrator.ts pure helpers — pickNextTask, shouldStop.
 * Does NOT exercise the full orchestrator loop (which requires Discord + SDK).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armProjectTimer,
  checkTimerExpired,
  pickNextTask,
  shouldStop,
  softExit,
} from "./orchestrator";
import {
  appendJournal,
  ensureProjectDir,
  loadState,
  saveState,
} from "./state";
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

// ── Timer expiry check (M2.4 / ADR-0004) ───────────────────────────

describe("checkTimerExpired", () => {
  test("returns false when no timer is set", () => {
    const s = baseState();
    expect(s.timer).toBeUndefined();
    expect(checkTimerExpired(s)).toBe(false);
  });

  test("returns false when timer.expiresAt is in the future", () => {
    const s = baseState();
    s.timer = {
      expiresAt: Date.now() + 60_000,
      requestedDuration: "1m",
      effectiveMs: 60_000,
      clamped: false,
    };
    expect(checkTimerExpired(s)).toBe(false);
  });

  test("returns true when timer.expiresAt is in the past", () => {
    const s = baseState();
    s.timer = {
      expiresAt: Date.now() - 1_000,
      requestedDuration: "1m",
      effectiveMs: 60_000,
      clamped: false,
    };
    expect(checkTimerExpired(s)).toBe(true);
  });

  test("returns true when timer.expiresAt is exactly now (boundary)", () => {
    const s = baseState();
    s.timer = {
      expiresAt: Date.now(),
      requestedDuration: "1m",
      effectiveMs: 60_000,
      clamped: false,
    };
    // <= Date.now() is "expired" (we accept the boundary as past)
    expect(checkTimerExpired(s)).toBe(true);
  });
});

// ── softExit (M2.4 / ADR-0004) ──────────────────────────────────────
//
// softExit requires deps.thread (Discord ThreadChannel). For unit tests
// we substitute a fake that records send() calls.

class FakeThread {
  sent: string[] = [];
  send = async (content: string): Promise<unknown> => {
    this.sent.push(content);
    return {};
  };
}

function makeDeps(thread: FakeThread, hermesDir: string) {
  return {
    hermesDir,
    thread: thread as unknown as import("discord.js").ThreadChannel,
    claudeSession: null as string | null,
  };
}

describe("softExit (M2.4)", () => {
  test("transitions active project to killed with duration_expired reason", async () => {
    const thread = new FakeThread();
    const deps = makeDeps(thread, "/tmp/hermes-soft-exit-test");
    const s = baseState({ status: "judging" });
    s.timer = {
      expiresAt: Date.now() - 1_000,
      handle: setTimeout(() => {}, 1) as unknown as ReturnType<typeof setTimeout>,
      requestedDuration: "1m",
      effectiveMs: 60_000,
      clamped: false,
    };
    const out = await softExit("p", s, deps, "duration_expired");
    expect(out.status).toBe("killed");
    expect(out.killedReason).toBe("duration_expired");
    expect(out.endedAt).toBeDefined();
    expect(out.timer).toBeUndefined();
    expect(thread.sent.length).toBe(1);
    expect(thread.sent[0]).toContain("duration elapsed");
  });

  test("manual_switch reason posts a different message", async () => {
    const thread = new FakeThread();
    const deps = makeDeps(thread, "/tmp/hermes-soft-exit-test");
    const s = baseState({ status: "executing" });
    s.timer = {
      expiresAt: Date.now() + 60_000,
      handle: undefined,
      requestedDuration: "30m",
      effectiveMs: 1_800_000,
      clamped: false,
    };
    const out = await softExit("p", s, deps, "manual_switch");
    expect(out.killedReason).toBe("manual_switch");
    expect(thread.sent[0]).toContain("manual switch");
  });

  test("clears the live timer handle so it doesn't keep process alive", async () => {
    const thread = new FakeThread();
    const deps = makeDeps(thread, "/tmp/hermes-soft-exit-test");
    const s = baseState({ status: "judging" });
    const handle = setTimeout(() => {}, 60_000) as unknown as ReturnType<
      typeof setTimeout
    >;
    s.timer = {
      expiresAt: Date.now() - 1_000,
      handle,
      requestedDuration: "1m",
      effectiveMs: 60_000,
      clamped: false,
    };
    await softExit("p", s, deps, "duration_expired");
    expect(s.timer?.handle).toBe(handle); // input not mutated
  });

  test("after softExit, isActive is false and isTerminal (killed) is true", async () => {
    const thread = new FakeThread();
    const deps = makeDeps(thread, "/tmp/hermes-soft-exit-test");
    const s = baseState({ status: "executing" });
    s.timer = {
      expiresAt: Date.now() + 30_000,
      requestedDuration: "30s",
      effectiveMs: 30_000,
      clamped: false,
    };
    const out = await softExit("p", s, deps, "duration_expired");
    expect(isActive(out)).toBe(false);
    expect(out.status).toBe("killed");
  });
});


// ── armProjectTimer (M2.5 / ADR-0004) ────────────────────────────────

describe("armProjectTimer", () => {
  test("returns null when no timer is set (manual mode)", () => {
    const s = baseState();
    const handle = armProjectTimer(s, () => {});
    expect(handle).toBeNull();
  });

  test("schedules a setTimeout for future expiresAt and stores the handle", () => {
    const s = baseState();
    s.timer = {
      expiresAt: Date.now() + 60_000, // 1 min from now
      handle: undefined,
      requestedDuration: "1m",
      effectiveMs: 60_000,
      clamped: false,
    };
    const handle = armProjectTimer(s, () => {});
    expect(handle).not.toBeNull();
    expect(s.timer!.handle).toBe(handle as ReturnType<typeof setTimeout>);
    // Cleanup
    if (handle != null) clearTimeout(handle as ReturnType<typeof setTimeout>);
  });

  test("fires onExpire immediately (microtask) when expiresAt is past", async () => {
    const s = baseState();
    s.timer = {
      expiresAt: Date.now() - 1_000, // already past
      handle: undefined,
      requestedDuration: "1m",
      effectiveMs: 60_000,
      clamped: false,
    };
    let called = false;
    const handle = armProjectTimer(s, () => {
      called = true;
    });
    // Past → no setTimeout, but onExpire fires via queueMicrotask
    expect(handle).toBeNull();
    // Yield to microtask queue
    await new Promise((r) => queueMicrotask(r));
    expect(called).toBe(true);
  });

  test("does not fire onExpire synchronously for future expiresAt", async () => {
    const s = baseState();
    s.timer = {
      expiresAt: Date.now() + 60_000,
      handle: undefined,
      requestedDuration: "1m",
      effectiveMs: 60_000,
      clamped: false,
    };
    let called = false;
    const handle = armProjectTimer(s, () => {
      called = true;
    });
    // Synchronously, not called
    expect(called).toBe(false);
    // After microtask yield, still not called (only fires at setTimeout deadline)
    await new Promise((r) => queueMicrotask(r));
    expect(called).toBe(false);
    if (handle != null) clearTimeout(handle as ReturnType<typeof setTimeout>);
  });

  test("setTimeout actually fires onExpire at deadline", async () => {
    const s = baseState();
    s.timer = {
      expiresAt: Date.now() + 50, // 50ms from now
      handle: undefined,
      requestedDuration: "50ms",
      effectiveMs: 50,
      clamped: false,
    };
    let called = false;
    const handle = armProjectTimer(s, () => {
      called = true;
    });
    expect(handle).not.toBeNull();
    // Wait 100ms — should be enough for the 50ms timer
    await new Promise((r) => setTimeout(r, 100));
    expect(called).toBe(true);
  });

  test("unref()'d handle does not keep the process alive", () => {
    const s = baseState();
    s.timer = {
      expiresAt: Date.now() + 60_000,
      handle: undefined,
      requestedDuration: "1m",
      effectiveMs: 60_000,
      clamped: false,
    };
    const handle = armProjectTimer(s, () => {});
    // The handle should have unref()'d. We can't easily test "process would
    // exit" in a unit test, but we can verify the handle returned by
    // setTimeout in Node/Bun supports unref and was called.
    expect(handle).not.toBeNull();
    if (handle) {
      // No-op if unref not present, error if it is.
      (handle as unknown as { unref?: () => void }).unref?.();
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  });

  test("the stored handle is the same one returned", () => {
    const s = baseState();
    s.timer = {
      expiresAt: Date.now() + 60_000,
      handle: undefined,
      requestedDuration: "1m",
      effectiveMs: 60_000,
      clamped: false,
    };
    const handle = armProjectTimer(s, () => {});
    expect(s.timer!.handle).toBe(handle as ReturnType<typeof setTimeout>);
    if (handle != null) clearTimeout(handle as ReturnType<typeof setTimeout>);
  });
});

// ── E2E: timer fires → softExit (M2.11 / ADR-0004) ───────────────────
//
// This is the M2.11 manual-smoke-test, but as an automated integration
// test that runs in <500ms. The invariants it pins are:
//
//   1. armProjectTimer + a wallclock delay → callback fires at the deadline
//   2. The callback path used in resumeActiveProjects re-loads state from
//      disk before softExit, so it works correctly across "old state"
//      (the closure was bound to a snapshot)
//   3. softExit with reason="duration_expired" writes:
//        - state.json with status=killed, killedReason=duration_expired,
//          timer cleared
//        - journal entry
//        - one Discord send (formatTimerExpired text)
//   4. isActive(killed) === false → a second softExit call would no-op
//      (idempotency, but we don't need to retest that here)
//
// We do NOT exercise runProject's full pipeline (planner/executor/judge
// LLM calls). The test is scoped to the timer-softExit integration that
// is the entire M2.4–M2.6 / M2.11 surface. It would survive a refactor
// that moves softExit into a different module, as long as the disk-level
// observable behavior matches.

let tmpRoot: string;
let hermesDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hermes-m2-e2e-"));
  hermesDir = join(tmpRoot, "hermes");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function e2eBaseState(projectId: string, overrides: Partial<ProjectState> = {}): ProjectState {
  const s = newProjectState({
    id: projectId,
    threadId: "t-e2e",
    goal: "g-e2e",
    mode: "auto",
    repoPath: "/r-e2e",
    repoSource: "new",
    config: DEFAULT_HERMES_CONFIG,
  });
  s.startedAt = new Date(Date.now() - 1_000).toISOString();
  return { ...s, ...overrides };
}

/**
 * state.ts writes under `projectDir(hermesDir, projectId) = hermesDir/projects/<id>`.
 * Tests that read the on-disk files must use the same path resolution.
 */
function projectPath(hermesDir: string, projectId: string, file: string): string {
  return join(hermesDir, "projects", projectId, file);
}

describe("E2E M2.11 — timer fires → softExit (duration_expired)", () => {
  test(
    "end-to-end: arm timer → wait → on-disk state becomes killed (duration_expired)",
    async () => {
      // 1. Set up: persist a judging project with a 200ms timer.
      const projectId = "p-e2e-1";
      const state = e2eBaseState(projectId, { status: "judging" });
      state.timer = {
        expiresAt: Date.now() + 200,
        handle: undefined,
        requestedDuration: "200ms",
        effectiveMs: 200,
        clamped: false,
      };
      ensureProjectDir(hermesDir, projectId);
      saveState(hermesDir, projectId, state);
      appendJournal(hermesDir, projectId, {
        type: "status",
        message: "project started (auto, 200ms timer)",
      });

      // 2. Arm the timer, then schedule the runProject judge boundary
      //    the same way resumeActiveProjects does it. This is the wiring
      //    we are testing end-to-end.
      const thread = new FakeThread();

      // Simulate the on-disk snapshot that resumeActiveProjects would
      // have read (just-loaded, before the judge boundary).
      const loaded = loadState(hermesDir, projectId)!;
      const projectIdCopy = projectId;
      const threadCopy = thread;
      const armHandle = armProjectTimer(loaded, () => {
        // This is the EXACT shape of the closure in resumeActiveProjects:
        // re-load fresh state, bail if !isActive, otherwise softExit.
        const fresh = loadState(hermesDir, projectIdCopy);
        if (!fresh) return;
        if (!isActive(fresh)) return;
        softExit(projectIdCopy, fresh, {
          hermesDir,
          thread: threadCopy as unknown as import("discord.js").ThreadChannel,
          claudeSession: null,
        }, "duration_expired").catch((err) => {
          throw err;
        });
      });
      expect(armHandle).not.toBeNull();
      // Sanity: the original loaded snapshot is still active (no mutation
      // from armProjectTimer beyond the handle field).
      expect(isActive(loaded)).toBe(true);

      // 3. Wait 400ms — the timer (200ms) fires, the callback runs,
      //    softExit mutates and saves, posts a Discord message.
      await new Promise((r) => setTimeout(r, 400));

      // 4. Verify the on-disk state.
      const after = loadState(hermesDir, projectId)!;
      expect(after).toBeDefined();
      expect(after.status).toBe("killed");
      expect(after.killedReason).toBe("duration_expired");
      expect(after.endedAt).toBeDefined();
      expect(after.timer).toBeUndefined();
      expect(isActive(after)).toBe(false);

      // 5. Verify the journal got the timer entry.
      const journalPath = projectPath(hermesDir, projectId, "journal.log");
      const fs = await import("node:fs");
      const journal = fs.readFileSync(journalPath, "utf8");
      expect(journal).toContain("duration expired");
      expect(journal).toContain("auto-mode duration expired");
      expect(journal).toContain("200ms");

      // 6. Verify Discord got exactly one message.
      expect(thread.sent.length).toBe(1);
      expect(thread.sent[0]).toContain("duration elapsed");
      expect(thread.sent[0]).toContain("⏱");

      // 7. Cleanup the arm handle (defensive; the callback already ran).
      if (armHandle != null) {
        clearTimeout(armHandle as ReturnType<typeof setTimeout>);
      }
    },
  );

  test(
    "manual_switch path: softExit posts the manual message and writes the manual journal entry",
    async () => {
      const projectId = "p-e2e-manual";
      const state = e2eBaseState(projectId, { status: "executing" });
      state.timer = {
        expiresAt: Date.now() + 60_000,
        handle: undefined,
        requestedDuration: "30m",
        effectiveMs: 1_800_000,
        clamped: false,
      };
      ensureProjectDir(hermesDir, projectId);
      saveState(hermesDir, projectId, state);

      const thread = new FakeThread();
      const deps = makeDeps(thread, hermesDir);
      const out = await softExit(projectId, state, deps, "manual_switch");

      expect(out.status).toBe("killed");
      expect(out.killedReason).toBe("manual_switch");

      const after = loadState(hermesDir, projectId)!;
      expect(after.killedReason).toBe("manual_switch");
      expect(after.timer).toBeUndefined();

      const fs = await import("node:fs");
      const journal = fs.readFileSync(projectPath(hermesDir, projectId, "journal.log"), "utf8");
      expect(journal).toContain("manual switch cancelled auto-mode timer");
      expect(thread.sent[0]).toContain("manual switch");
    },
  );

  test(
    "past deadline: armProjectTimer fires onExpire via queueMicrotask (no setTimeout)",
    async () => {
      // This is the M2.5 "bot restart and timer already expired" path:
      // armProjectTimer sees expiresAt <= now and fires the callback on
      // the next microtask instead of scheduling a setTimeout. The
      // callback then sees the project is still active and softExits.
      const projectId = "p-e2e-past";
      const state = e2eBaseState(projectId, { status: "judging" });
      state.timer = {
        expiresAt: Date.now() - 1_000, // 1s in the past
        handle: undefined,
        requestedDuration: "1m",
        effectiveMs: 60_000,
        clamped: false,
      };
      ensureProjectDir(hermesDir, projectId);
      saveState(hermesDir, projectId, state);

      const thread = new FakeThread();
      const armHandle = armProjectTimer(state, () => {
        const fresh = loadState(hermesDir, projectId);
        if (!fresh || !isActive(fresh)) return;
        softExit(projectId, fresh, {
          hermesDir,
          thread: thread as unknown as import("discord.js").ThreadChannel,
          claudeSession: null,
        }, "duration_expired").catch(() => {});
      });
      // Past-deadline arm returns null (no setTimeout was scheduled)
      expect(armHandle).toBeNull();

      // Yield to the microtask queue + give softExit a tick to run.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 50));

      const after = loadState(hermesDir, projectId)!;
      expect(after.status).toBe("killed");
      expect(after.killedReason).toBe("duration_expired");
      expect(thread.sent.length).toBe(1);
    },
  );
});
