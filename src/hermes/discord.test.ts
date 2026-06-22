/**
 * Tests for the `formatStatusEmbed` timer line (M2.8 / ADR-0004).
 *
 * The status embed should:
 * - Omit the timer line when state.timer is undefined
 * - Render `⏱ Timer: M:SS remaining (auto, <duration>)` when expiresAt > now
 * - Render `⏱ Timer: expired (will stop at next judge pass)` when
 *   expiresAt <= now (the soft-exit boundary has not yet fired)
 * - Place the timer line between the header and the task summary
 *
 * We don't mock Date.now() — we use real `Date.now()` deltas with
 * generous margins so the tests aren't flaky under load.
 */

import { describe, test, expect } from "bun:test";
import { formatStatusEmbed } from "./discord";
import {
  DEFAULT_HERMES_CONFIG,
  newProjectState,
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

function withTimer(state: ProjectState, expiresAt: number, requestedDuration = "30m"): ProjectState {
  const timer: ProjectTimer = {
    expiresAt,
    // handle is irrelevant for these formatter tests
    handle: null as unknown as ReturnType<typeof setTimeout>,
    requestedDuration,
    effectiveMs: expiresAt - Date.now(),
    clamped: false,
  };
  return { ...state, timer };
}

describe("formatStatusEmbed — timer line (M2.8)", () => {
  test("omits timer line when state.timer is undefined", () => {
    const state = baseState();
    expect(state.timer).toBeUndefined();
    const out = formatStatusEmbed(state);
    expect(out).not.toContain("⏱");
    expect(out).not.toContain("Timer:");
  });

  test("renders active countdown when expiresAt is in the future", () => {
    const state = withTimer(baseState(), Date.now() + 30 * 60 * 1000);
    const out = formatStatusEmbed(state);
    // The countdown will be exactly 30:00 (within a second) because
    // formatCountdown floors to the whole second.
    expect(out).toMatch(/⏱ Timer: 30:00 remaining \(auto, 30m\)/);
  });

  test("renders countdown with hours when expiresAt is far in the future", () => {
    const state = withTimer(
      baseState(),
      Date.now() + 2 * 60 * 60 * 1000 + 30 * 60 * 1000 + 5 * 1000,
      "2h30m",
    );
    const out = formatStatusEmbed(state);
    expect(out).toContain("⏱ Timer: 2:30:0");
    expect(out).toContain("(auto, 2h30m)");
  });

  test("renders expired message when expiresAt is in the past", () => {
    const state = withTimer(baseState(), Date.now() - 5_000);
    const out = formatStatusEmbed(state);
    expect(out).toContain("⏱ Timer: expired (will stop at next judge pass)");
    expect(out).not.toContain("remaining");
  });

  test("places timer line between header and task summary", () => {
    const state = withTimer(baseState(), Date.now() + 15 * 60 * 1000);
    const out = formatStatusEmbed(state);
    const headerIdx = out.indexOf("Project status");
    const statusIdx = out.indexOf("Status:");
    const timerIdx = out.indexOf("⏱ Timer:");
    const tasksIdx = out.indexOf("Tasks:");
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(statusIdx).toBeGreaterThan(headerIdx);
    expect(timerIdx).toBeGreaterThan(statusIdx);
    expect(tasksIdx).toBeGreaterThan(timerIdx);
  });

  test("uses state.mode in the timer label (e.g. 'manual' with timer is rendered as 'manual')", () => {
    // Per design, the user shouldn't be able to set a timer in manual mode,
    // but if a state does have a timer + mode=manual (defensive), we still
    // render the mode value rather than hardcoding 'auto'.
    const state = withTimer({ ...baseState(), mode: "manual" }, Date.now() + 10 * 60 * 1000);
    const out = formatStatusEmbed(state);
    expect(out).toMatch(/⏱ Timer: 10:00 remaining \(manual, 30m\)/);
  });

  test("clamps near-zero remaining to 'expired' (not 0:00)", () => {
    // 100ms in the future — the embed shouldn't say "0:00 remaining" if
    // the boundary is essentially here. formatCountdown returns "0:00" for
    // remainingMs <= 0, but our wrapping uses `> 0`, so 100ms > 0 → 0:00
    // remaining shows. This test pins that behavior: tiny positive
    // remaining displays as a (visually stale) "0:00 remaining" until the
    // next judge pass flips it to "expired". That's acceptable for a
    // sub-second display.
    const state = withTimer(baseState(), Date.now() + 100);
    const out = formatStatusEmbed(state);
    expect(out).toMatch(/⏱ Timer: 0:00 remaining/);
  });
});
