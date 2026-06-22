/**
 * RG-008 audit (Part B) — orchestrator catch block.
 *
 * This is a SEPARATE test file from hermesCommands.test.ts because that
 * file uses `mock.module("../../hermes/orchestrator", ...)` to mock out
 * `runProject` for the RG-006 / RG-007 audits. Mock.module is hoisted
 * at file load and applies to ALL tests in that file. To exercise the
 * REAL `runProject` (so we can verify the catch block maps a
 * PlannerTimeoutError to status="timed_out" with a clean escalation
 * message), we need a fresh module graph — hence this separate file.
 *
 * Approach: declare the planner mock as a top-level `mock()` (which
 * is hoisted by bun before any user code runs). Per-test we set
 * `plannerMockImpl.mockImplementation(...)` to install the desired
 * rejection behavior. This is the canonical bun pattern for module
 * mocking.
 *
 * Invariants covered here:
 *   I-10 PlannerTimeoutError → status="timed_out" + "🕐" escalation
 *   I-11 generic Error → status="failed" (regression guard for the new
 *        timed_out branch — it must not leak into generic failures)
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProjectDir, loadState, saveState } from "./state";
import { newProjectState, type ProjectState } from "./types";
import type { ThreadChannel } from "discord.js";

// ── Hoisted planner mock ────────────────────────────────────────────────
// `mock()` is hoisted to the top of the file by bun. It returns a
// callable function whose implementation can be replaced per-test
// via `.mockImplementation(...)`. This avoids the "cannot replace
// module namespace binding" error you get when you try to assign
// directly to a re-imported module's named export.
const planProjectMock = mock(async () => {
  // default: succeed with an empty plan. Tests override this.
  return { tasks: [], reasoning: "default" };
});
mock.module("./planner", () => {
  // Re-export everything from the real planner except planProject,
  // which we replace with the mock.
  const realPlanner = require("./planner") as typeof import("./planner");
  return {
    ...realPlanner,
    planProject: planProjectMock,
  };
});

// Now we can import the orchestrator; it will see the mocked
// planProject. The import must be top-level (not inside a test) so
// that the orchestrator's `import { planProject }` is bound to the
// mock at module-load time.
import { runProject } from "./orchestrator";
import { PlannerParseError, PlannerTimeoutError } from "./planner";

// ── Test fakes ──────────────────────────────────────────────────────────

class FakeThread {
  sent: string[] = [];
  get isThread(): boolean {
    return true;
  }
  send(content: string): Promise<unknown> {
    this.sent.push(content);
    return Promise.resolve();
  }
  // TypingIndicator calls sendTyping in a setInterval. Our fake
  // simply no-ops (matching the convention in orchestrator.test.ts
  // that the typing errors are non-actionable).
  sendTyping(): Promise<unknown> {
    return Promise.resolve();
  }
}

function makeProject(repoPath: string): ProjectState {
  const s = newProjectState({
    id: `p-rg008b-${Math.random().toString(36).slice(2, 10)}`,
    threadId: `thread-rg008b-${Math.random().toString(36).slice(2, 10)}`,
    goal: "rg008b audit",
    mode: "auto",
    repoPath,
    repoRoot: repoPath,
    repoSource: "local",
    config: {
      maxIterations: 20,
      maxCostUsd: 500,
      maxWallHours: 4,
      hermesModel: "claude-haiku-4-5",
      maxAttemptsPerTask: 3,
    },
  });
  s.status = "planning";
  s.startedAt = new Date(Date.now() - 1000).toISOString();
  return s;
}

describe("RG-008b: orchestrator catch block (real runProject)", () => {
  let hermesDir: string;
  let project: ProjectState;
  let thread: FakeThread;

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), "rg008b-"));
    hermesDir = tmp;
    project = makeProject(join(tmp, "repo"));
    thread = new FakeThread();
    // Reset the mock to the default no-throw impl at the start of
    // each test so leftover state from a prior test doesn't leak.
    planProjectMock.mockImplementation(async () => ({
      tasks: [],
      reasoning: "default",
    }));
  });

  afterEach(() => {
    rmSync(hermesDir, { recursive: true, force: true });
  });

  // I-10: PlannerTimeoutError → status="timed_out" + clean "🕐" escalation.
  test("I-10: PlannerTimeoutError → status='timed_out' + '🕐' escalation", async () => {
    ensureProjectDir(hermesDir, project.id);
    saveState(hermesDir, project.id, project);

    // Install a PlannerTimeoutError rejection. The mock's return
    // type matches the real planProject's signature, but we throw
    // instead of returning.
    planProjectMock.mockImplementation(async () => {
      throw new PlannerTimeoutError(15 * 60 * 1000);
    });

    await runProject(project.id, {
      hermesDir,
      thread: thread as unknown as ThreadChannel,
      claudeSession: null,
    });

    // Reload from disk and assert.
    const reloaded = loadState(hermesDir, project.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.status).toBe("timed_out");
    expect(reloaded!.endedAt).not.toBeNull();

    // The escalation message must contain the 🕐 clock and the
    // configured timeout in seconds, NOT the old "aborted by user"
    // string that was the RG-008 regression signature.
    const escalation = thread.sent.find((s) => s.includes("escalated"));
    expect(escalation).toBeDefined();
    expect(escalation!).toContain("🕐");
    expect(escalation!).toContain("900s"); // 15min = 900s
    expect(escalation).not.toContain("aborted by user");

    // The journal must have a structured "escalate" entry pointing
    // to the timed_out cause.
    const journalPath = join(hermesDir, "projects", project.id, "journal.log");
    const journal = readFileSync(journalPath, "utf-8");
    expect(journal).toMatch(/\[escalate\] planner timed out after 900s/);
  });

  // I-11: a non-timeout error still maps to status="failed". The new
  // timed_out branch must not leak into generic failures — otherwise
  // every crash would be mislabeled as a timeout.
  test("I-11: generic Error → status='failed' (regression guard)", async () => {
    ensureProjectDir(hermesDir, project.id);
    saveState(hermesDir, project.id, project);
    planProjectMock.mockImplementation(async () => {
      throw new Error("simulated orchestrator crash");
    });

    await runProject(project.id, {
      hermesDir,
      thread: thread as unknown as ThreadChannel,
      claudeSession: null,
    });

    const reloaded = loadState(hermesDir, project.id);
    expect(reloaded!.status).toBe("failed");

    // The escalation must use the generic "orchestrator crashed" path,
    // NOT the "🕐" planner-timed-out prefix. Otherwise the new
    // timeout-mapping logic would silently eat real crashes.
    const escalation = thread.sent.find((s) => s.includes("escalated"));
    expect(escalation).toBeDefined();
    expect(escalation!).not.toContain("🕐");
    expect(escalation!).toContain("orchestrator crashed");

    // The journal must show the generic crash message. `String(err)`
    // returns "Error: simulated orchestrator crash" for a generic
    // Error, so the journal line is
    //   "2026-06-22T07:25:48.199Z [escalate] orchestrator crash: Error: simulated orchestrator crash"
    const journalPath = join(hermesDir, "projects", project.id, "journal.log");
    const journal = readFileSync(journalPath, "utf-8");
    expect(journal).toMatch(/\[escalate\] orchestrator crash:.*simulated orchestrator crash/);
  });

  // RG-010 I-12: PlannerParseError → status="parse_error" + "🔧" escalation.
  // The regression 2026-06-22 was that an LLM-leaked thinking block made
  // JSON.parse throw, which previously fell into the generic "failed"
  // path with the opaque "planner: invalid JSON response: SyntaxError:
  // Unrecognized token '<'" message. The new branch preserves the raw
  // output in the journal for debug.
  test("RG-010 I-12: PlannerParseError → status='parse_error' + '🔧' escalation + raw output in journal", async () => {
    ensureProjectDir(hermesDir, project.id);
    saveState(hermesDir, project.id, project);

    const rawSample =
      "\nThe user wants me to decompose a goal into tasks.\nLet me think about this carefully.\nOK I think 2 tasks are enough.\n```json\n{not actually json}\n```";
    planProjectMock.mockImplementation(async () => {
      throw new PlannerParseError({
        raw: rawSample,
        cleaned: "{not actually json}",
        cause: new SyntaxError("Unrecognized token"),
      });
    });

    await runProject(project.id, {
      hermesDir,
      thread: thread as unknown as ThreadChannel,
      claudeSession: null,
    });

    // Status must be parse_error (not failed, not timed_out).
    const reloaded = loadState(hermesDir, project.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.status).toBe("parse_error");
    expect(reloaded!.endedAt).not.toBeNull();

    // Escalation must use the new "🔧 planner output was unparseable"
    // path, NOT the old "orchestrator crashed" path.
    const escalation = thread.sent.find((s) => s.includes("escalated"));
    expect(escalation).toBeDefined();
    expect(escalation!).toContain("🔧");
    expect(escalation!).toContain("planner output was unparseable");
    // Must NOT contain the old "🕐" timeout prefix (otherwise the
    // new branch would leak into the timeout path) or the old
    // "orchestrator crashed" generic path.
    expect(escalation).not.toContain("🕐");
    expect(escalation).not.toContain("orchestrator crashed:");

    // Journal must preserve the raw LLM output (up to 500 chars) so
    // the failure is debuggable from the project thread.
    const journalPath = join(hermesDir, "projects", project.id, "journal.log");
    const journal = readFileSync(journalPath, "utf-8");
    expect(journal).toMatch(/\[escalate\] planner output was unparseable/);
    // The raw output should be JSON-stringified in the journal, so
    // newlines become \n escapes. We check for a substring that's
    // present regardless of the truncation boundary.
    expect(journal).toContain("not actually json");
  });

  // RG-010 I-13: regression guard — a PlannerParseError must NOT be
  // misclassified as a PlannerTimeoutError (status would otherwise
  // be "timed_out" instead of "parse_error"). The two branches are
  // siblings in the catch, and the order of `instanceof` checks
  // matters: PlannerParseError must be checked BEFORE the generic
  // Error fallback. We verify by checking the status and the
  // escalation token ("🔧" not "🕐").
  test("RG-010 I-13: PlannerParseError is NOT misclassified as timed_out", async () => {
    ensureProjectDir(hermesDir, project.id);
    saveState(hermesDir, project.id, project);
    planProjectMock.mockImplementation(async () => {
      throw new PlannerParseError({
        raw: "x",
        cleaned: "y",
        cause: new SyntaxError("Unrecognized token"),
      });
    });

    await runProject(project.id, {
      hermesDir,
      thread: thread as unknown as ThreadChannel,
      claudeSession: null,
    });

    const reloaded = loadState(hermesDir, project.id);
    expect(reloaded!.status).toBe("parse_error");
    expect(reloaded!.status).not.toBe("timed_out");
    expect(reloaded!.status).not.toBe("failed");

    const escalation = thread.sent.find((s) => s.includes("escalated"));
    expect(escalation!).not.toContain("🕐");
    expect(escalation!).toContain("🔧");
  });
});
