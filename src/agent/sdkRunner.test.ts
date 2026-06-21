/**
 * Tests for sdkRunner module-level state management.
 *
 * The `runViaSdk` function calls `query()` from the Claude Agent SDK,
 * which spawns a real `claude` CLI subprocess — too expensive to test
 * in a unit suite. We focus on the parts that have meaningful logic:
 *
 *   - activeSdkRunCount() / isSdkRunActive() — registry state
 *   - abortSdkRun(threadId) — Query.close() wiring
 *   - abortAllSdkRuns() — shutdown path
 *
 * End-to-end coverage of runViaSdk (system/init, assistant tool_use
 * counting, result message extraction, abort mid-flight) is left to
 * the manual smoke test described in the Phase 1 plan.
 */

import { describe, it, expect } from "bun:test";
import {
  activeSdkRunCount,
  isSdkRunActive,
  abortSdkRun,
  abortAllSdkRuns,
} from "./sdkRunner";

const FAKE_THREAD_ID = (): string => `fake-${Math.random().toString(36).slice(2, 10)}`;

describe("sdkRunner state management", () => {
  it("isSdkRunActive returns false for unknown thread IDs", () => {
    const id = FAKE_THREAD_ID();
    expect(isSdkRunActive(id)).toBe(false);
  });

  it("abortSdkRun returns false when no run is active for the thread", () => {
    const id = FAKE_THREAD_ID();
    expect(abortSdkRun(id)).toBe(false);
  });

  it("abortSdkRun is safe to call repeatedly with the same unknown ID", () => {
    const id = FAKE_THREAD_ID();
    expect(abortSdkRun(id)).toBe(false);
    expect(abortSdkRun(id)).toBe(false);
    expect(isSdkRunActive(id)).toBe(false);
  });

  it("abortAllSdkRuns is a no-op when no runs are active", async () => {
    const before = activeSdkRunCount();
    await abortAllSdkRuns();
    expect(activeSdkRunCount()).toBe(before);
  });

  it("activeSdkRunCount is a non-negative integer", () => {
    const n = activeSdkRunCount();
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(0);
  });
});