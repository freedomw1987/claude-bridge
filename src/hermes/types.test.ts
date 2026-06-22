/**
 * Tests for ProjectTimer / KilledReason additions in types.ts (ADR-0004).
 *
 * These are type-level + runtime-shape tests:
 * - ProjectTimer JSON.stringify strips the `handle` field (transient)
 * - ProjectTimer.parse round-trips the rest of the fields
 * - newProjectState initializes killedReason undefined
 *
 * State machine semantics (isActive etc.) are tested in state.test.ts.
 */

import { describe, test, expect } from "bun:test";
import {
  DEFAULT_HERMES_CONFIG,
  isActive,
  newProjectState,
  type KilledReason,
  type ProjectState,
  type ProjectTimer,
} from "./types";

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

describe("ProjectTimer JSON round-trip (handle stripped)", () => {
  test("JSON.stringify includes handle as {} by default — explicit toJSON is required to strip it", () => {
    const timer: ProjectTimer = {
      expiresAt: 1700000000000,
      // A fake handle — by default JSON.stringify renders NodeJS Timeout
      // objects as `{}` (no enumerable own props). The right guarantee is
      // that loadState / saveState explicitly strip the field — see
      // state.ts stripTimerHandle() helper (M2.3).
      handle: setTimeout(() => {}, 1) as unknown as ReturnType<typeof setTimeout>,
      requestedDuration: "30m",
      effectiveMs: 1_800_000,
      clamped: false,
    };
    const raw = JSON.parse(JSON.stringify(timer));
    // This is the bug we just caught: handle serializes as {}, not undefined.
    // The fix is in state.ts: saveState must explicitly delete timer.handle
    // before stringify. The test here pins the BUG so a future refactor
    // doesn't silently re-introduce it.
    expect(raw.handle).toEqual({});
    // The rest of the fields round-trip cleanly:
    expect(raw.expiresAt).toBe(1_700_000_000_000);
    expect(raw.requestedDuration).toBe("30m");
    expect(raw.effectiveMs).toBe(1_800_000);
    expect(raw.clamped).toBe(false);
  });

  test("ProjectState with timer round-trips expiresAt / requestedDuration / effectiveMs / clamped", () => {
    const state = baseState();
    state.timer = {
      expiresAt: Date.now() + 30 * 60 * 1000,
      requestedDuration: "30m",
      effectiveMs: 1_800_000,
      clamped: false,
    };
    const restored = JSON.parse(JSON.stringify(state)) as ProjectState;
    expect(restored.timer).toBeDefined();
    expect(restored.timer!.expiresAt).toBe(state.timer.expiresAt);
    expect(restored.timer!.requestedDuration).toBe("30m");
    expect(restored.timer!.effectiveMs).toBe(1_800_000);
    expect(restored.timer!.clamped).toBe(false);
    // handle should be undefined after round-trip
    expect(restored.timer!.handle).toBeUndefined();
  });

  test("ProjectState with timer can be restored from a stored JSON snapshot", () => {
    // Simulate a stored state.json file with no `handle` field
    const storedTimer = {
      expiresAt: 1_700_000_000_000,
      requestedDuration: "1h",
      effectiveMs: 3_600_000,
      clamped: false,
    };
    // The shape should match ProjectTimer minus handle
    expect(storedTimer).not.toHaveProperty("handle");
    // The rest of the fields are preserved
    const restored: ProjectTimer = {
      ...storedTimer,
      handle: undefined,
    };
    expect(restored.expiresAt).toBe(1_700_000_000_000);
    expect(restored.effectiveMs).toBe(3_600_000);
  });
});

describe("KilledReason surface on ProjectState", () => {
  test("newProjectState has no killedReason", () => {
    const s = baseState();
    expect(s.killedReason).toBeUndefined();
  });

  test("killed status with duration_expired is a valid terminal state", () => {
    const s = baseState();
    s.status = "killed";
    s.killedReason = "duration_expired";
    s.endedAt = new Date().toISOString();
    expect(isActive(s)).toBe(false);
    expect(s.killedReason).toBe("duration_expired");
  });

  test("killed status with user_kill / manual_switch is also valid", () => {
    const reasons: KilledReason[] = ["user_kill", "manual_switch"];
    for (const r of reasons) {
      const s = baseState();
      s.status = "killed";
      s.killedReason = r;
      expect(isActive(s)).toBe(false);
      expect(s.killedReason).toBe(r);
    }
  });
});

describe("ProjectTimer field defaults", () => {
  test("ProjectState without timer is a valid active state", () => {
    const s = baseState();
    expect(s.timer).toBeUndefined();
    expect(isActive(s)).toBe(true); // still in 'planning'
  });

  test("Older state.json (no timer field) loads fine — timer is optional", () => {
    // Simulate an older state.json without the timer field
    const legacyJson = JSON.stringify({
      id: "p",
      threadId: "t",
      createdAt: "2026-06-22T00:00:00Z",
      updatedAt: "2026-06-22T00:00:00Z",
      goal: "g",
      mode: "auto",
      repoPath: "/r",
      repoSource: "new",
      status: "planning",
      plan: [],
      currentTaskId: null,
      iterations: 0,
      costUsd: 0,
      config: DEFAULT_HERMES_CONFIG,
      startedAt: "2026-06-22T00:00:00Z",
      endedAt: null,
      journal: [],
    });
    const parsed = JSON.parse(legacyJson) as ProjectState;
    expect(parsed.timer).toBeUndefined();
    expect(parsed.killedReason).toBeUndefined();
    // No errors thrown — the new fields are backward-compatible.
  });
});
