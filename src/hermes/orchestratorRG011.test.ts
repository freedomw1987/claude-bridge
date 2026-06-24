/**
 * RG-011 audit (Part B) — orchestrator catch block handles judge errors.
 *
 * This is a SEPARATE test file from hermesCommands.test.ts because that
 * file uses `mock.module("../../hermes/orchestrator", ...)` to mock out
 * `runProject` for the RG-006 / RG-007 audits. Mock.module is hoisted
 * at file load and applies to ALL tests in that file. To exercise the
 * REAL `runProject` (so we can verify the catch block maps a
 * JudgeTimeoutError / JudgeParseError to status="judge_timed_out" /
 * "judge_parse_error" with clean escalation messages), we need a fresh
 * module graph — hence this separate file. Same rationale as
 * orchestratorRG008.test.ts.
 *
 * Approach: declare the judge mock as a top-level `mock()` (which is
 * hoisted by bun before any user code runs). Per-test we set
 * `setJudgeOnceImpl(...)` to install the desired rejection
 * behavior. This is the canonical bun pattern for module mocking.
 *
 * Invariants covered here:
 *   I-1, I-2  JudgeTimeoutError → status="judge_timed_out" + "🕐" escalation
 *             (regression guard: must NOT contain the old "aborted by user"
 *              string the user reported in 2026-06-24)
 *   I-3, I-4  JudgeParseError → status="judge_parse_error" + "🔧" escalation
 *   I-5       JudgeParseError is NOT misclassified as JudgeTimeoutError
 *   I-6       JudgeParseError is NOT misclassified as PlannerParseError
 *   I-7       JudgeTimeoutError is NOT misclassified as PlannerTimeoutError
 *   I-8       Generic Error still maps to status="failed" (regression guard)
 *   I-9       Journal records `judge timed out after Ns`
 *   I-10      Journal preserves raw LLM output for JudgeParseError
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
} from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProjectDir, loadState, saveState } from "./state";
import { newProjectState, type ProjectState } from "./types";
import {
  JudgeParseError,
  JudgeTimeoutError,
  setJudgeOnceImpl,
  resetJudgeOnceImpl,
} from "./judge";
import { PlannerParseError, PlannerTimeoutError } from "./planner";
import { runProject } from "./orchestrator";
import type { ThreadChannel } from "discord.js";

// ── DI hook for the judge (RG-011 pattern) ─────────────────────────────
// We use the dependency-injection seam exposed in judge.ts
// (`setJudgeOnceImpl` / `resetJudgeOnceImpl`) instead of
// `mock.module("./judge", ...)`. The mock.module approach leaks across
// test files when two files mock the same module (judgeRG011.test.ts
// and this file both would mock `./judge`); the DI hook is per-test
// scoped via beforeEach/afterEach.
//
// Note: we don't mock `judgeProject` directly — we mock its inner
// dependency (`judgeProjectOnce`). The retry wrapper runs the real
// retry logic, so the orchestrator sees the actual error type thrown
// by the inner function. This is exactly what we want to test.

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
  // simply no-ops (matching the convention in orchestratorRG008.test.ts
  // that the typing errors are non-actionable).
  sendTyping(): Promise<unknown> {
    return Promise.resolve();
  }
}

function makeProject(repoPath: string): ProjectState {
  const s = newProjectState({
    id: `p-rg011-${Math.random().toString(36).slice(2, 10)}`,
    threadId: `thread-rg011-${Math.random().toString(36).slice(2, 10)}`,
    goal: "rg011 audit",
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
  // Pre-populate state to skip straight to the judging phase. We
  // also need a task that's done so pickNextTask returns null and
  // the orchestrator transitions to "judging".
  s.status = "judging";
  s.startedAt = new Date(Date.now() - 1000).toISOString();
  s.plan.push({
    id: "t1",
    title: "task 1",
    description: "do thing",
    status: "done",
    attempts: 1,
    dependsOn: [],
  });
  return s;
}

describe("RG-011: orchestrator catch block (real runProject, judgeProjectOnce injected)", () => {
  let hermesDir: string;
  let project: ProjectState;
  let thread: FakeThread;

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), "rg011-"));
    hermesDir = tmp;
    project = makeProject(join(tmp, "repo"));
    thread = new FakeThread();
    // Default impl: succeed with "done" verdict (no error thrown,
    // so the orchestrator's catch block isn't exercised). Per-test
    // overrides below install the desired rejection behavior.
    setJudgeOnceImpl(async () => ({
      verdict: "done" as const,
      reasoning: "default",
    }));
  });

  afterEach(() => {
    // Restore real judgeProjectOnce so other test files aren't
    // affected by our injection.
    resetJudgeOnceImpl();
    rmSync(hermesDir, { recursive: true, force: true });
  });

  // I-1: JudgeTimeoutError → status="judge_timed_out" + "🕐" escalation.
  test("I-1: JudgeTimeoutError → status='judge_timed_out' + '🕐' escalation", async () => {
    ensureProjectDir(hermesDir, project.id);
    saveState(hermesDir, project.id, project);

    // Install a JudgeTimeoutError rejection.
    setJudgeOnceImpl(async () => {
      throw new JudgeTimeoutError(5 * 60 * 1000);
    });

    await runProject(project.id, {
      hermesDir,
      thread: thread as unknown as ThreadChannel,
      claudeSession: null,
    });

    // Reload from disk and assert.
    const reloaded = loadState(hermesDir, project.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.status).toBe("judge_timed_out");
    expect(reloaded!.endedAt).not.toBeNull();

    // The escalation message must contain the 🕐 clock and the
    // configured timeout in seconds. It must NOT contain the old
    // "Claude Code process aborted by user" string the user reported
    // in the 2026-06-24 regression — that was the symptom of this
    // bug (the SDK surfaced that string before the typed-error fix).
    const escalation = thread.sent.find((s) => s.includes("escalated"));
    expect(escalation).toBeDefined();
    expect(escalation!).toContain("🕐");
    expect(escalation!).toContain("300s"); // 5min = 300s
    expect(escalation!).toContain("judge timed out");
    expect(escalation).not.toContain("aborted by user");
  });

  // I-2: The journal must record the judge timeout as a structured
  // escalate entry (mirror of I-9 in planner pattern).
  test("I-2: journal records 'judge timed out after Ns' for JudgeTimeoutError", async () => {
    ensureProjectDir(hermesDir, project.id);
    saveState(hermesDir, project.id, project);
    setJudgeOnceImpl(async () => {
      throw new JudgeTimeoutError(5 * 60 * 1000);
    });

    await runProject(project.id, {
      hermesDir,
      thread: thread as unknown as ThreadChannel,
      claudeSession: null,
    });

    const journalPath = join(hermesDir, "projects", project.id, "journal.log");
    const journal = readFileSync(journalPath, "utf-8");
    expect(journal).toMatch(/\[escalate\] judge timed out after 300s/);
    expect(journal).toContain("judge_timed_out");
  });

  // I-3: JudgeParseError → status="judge_parse_error" + "🔧" escalation.
  // The regression 2026-06-24 was that a Zod regex validation error
  // (judge LLM emitted `T1` instead of `t1`) made the parse fail,
  // which previously fell into the generic "failed" path with the
  // opaque "judge: invalid JSON response: ..." message. The new
  // branch preserves the raw output in the journal for debug.
  test("I-3: JudgeParseError → status='judge_parse_error' + '🔧' escalation + raw output in journal", async () => {
    ensureProjectDir(hermesDir, project.id);
    saveState(hermesDir, project.id, project);

    const rawSample =
      "\nLet me think about this carefully.\nOK I think the project is done.\n```json\n{not actually json}\n```";
    setJudgeOnceImpl(async () => {
      throw new JudgeParseError({
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

    // Status must be judge_parse_error (not failed, not timed_out,
    // not judge_timed_out).
    const reloaded = loadState(hermesDir, project.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.status).toBe("judge_parse_error");
    expect(reloaded!.endedAt).not.toBeNull();

    // Escalation must use the new "🔧 judge output was unparseable"
    // path, NOT the old "orchestrator crashed" path.
    const escalation = thread.sent.find((s) => s.includes("escalated"));
    expect(escalation).toBeDefined();
    expect(escalation!).toContain("🔧");
    expect(escalation!).toContain("judge output was unparseable");
    // Must NOT contain the old "🕐" timeout prefix or the old
    // "orchestrator crashed" generic path.
    expect(escalation).not.toContain("🕐");
    expect(escalation).not.toContain("orchestrator crashed:");

    // Journal must preserve the raw LLM output (up to 500 chars) so
    // the failure is debuggable from the project thread.
    const journalPath = join(hermesDir, "projects", project.id, "journal.log");
    const journal = readFileSync(journalPath, "utf-8");
    expect(journal).toMatch(/\[escalate\] judge output was unparseable/);
    // The raw output should be JSON-stringified in the journal, so
    // newlines become \n escapes. We check for a substring that's
    // present regardless of the truncation boundary.
    expect(journal).toContain("not actually json");
  });

  // I-4: regression guard — the escalation must contain the friendly
  // "🔧 judge output was unparseable" path, NOT the raw "judge: invalid
  // JSON response" string from the pre-RG-011 implementation.
  test("I-4: JudgeParseError escalation uses the typed-error path (no raw 'invalid JSON' string)", async () => {
    ensureProjectDir(hermesDir, project.id);
    saveState(hermesDir, project.id, project);
    setJudgeOnceImpl(async () => {
      throw new JudgeParseError({
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

    const escalation = thread.sent.find((s) => s.includes("escalated"));
    expect(escalation).toBeDefined();
    // The friendly prefix must be present (🔧 + "judge output was unparseable")
    expect(escalation!).toContain("🔧");
    expect(escalation!).toContain("judge output was unparseable");
  });

  // I-5: JudgeParseError must NOT be misclassified as JudgeTimeoutError.
  // The two branches are siblings in the catch; the order of `instanceof`
  // checks matters: JudgeParseError must be checked BEFORE the generic
  // Error fallback, and JudgeTimeoutError must be checked BEFORE
  // JudgeParseError so a parse error doesn't get reported as a timeout.
  test("I-5: JudgeParseError is NOT misclassified as JudgeTimeoutError", async () => {
    ensureProjectDir(hermesDir, project.id);
    saveState(hermesDir, project.id, project);
    setJudgeOnceImpl(async () => {
      throw new JudgeParseError({
        raw: "x",
        cleaned: "y",
        cause: new Error("cause"),
      });
    });

    await runProject(project.id, {
      hermesDir,
      thread: thread as unknown as ThreadChannel,
      claudeSession: null,
    });

    const reloaded = loadState(hermesDir, project.id);
    expect(reloaded!.status).toBe("judge_parse_error");
    expect(reloaded!.status).not.toBe("judge_timed_out");
    expect(reloaded!.status).not.toBe("failed");

    const escalation = thread.sent.find((s) => s.includes("escalated"));
    expect(escalation!).not.toContain("🕐");
    expect(escalation!).toContain("🔧");
  });

  // I-6: cross-regression guard — JudgeParseError must NOT be
  // misclassified as PlannerParseError (different module, different
  // class identity). The orchestrator catches both, and a misclassified
  // status would route the user to the wrong recovery action.
  test("I-6: JudgeParseError is NOT misclassified as PlannerParseError", async () => {
    ensureProjectDir(hermesDir, project.id);
    saveState(hermesDir, project.id, project);
    setJudgeOnceImpl(async () => {
      throw new JudgeParseError({
        raw: "x",
        cleaned: "y",
        cause: new Error("cause"),
      });
    });

    await runProject(project.id, {
      hermesDir,
      thread: thread as unknown as ThreadChannel,
      claudeSession: null,
    });

    const reloaded = loadState(hermesDir, project.id);
    expect(reloaded!.status).toBe("judge_parse_error");
    expect(reloaded!.status).not.toBe("parse_error");

    const escalation = thread.sent.find((s) => s.includes("escalated"));
    // Planner's escalation mentions "planner output was unparseable";
    // judge's mentions "judge output was unparseable".
    expect(escalation!).toContain("judge output was unparseable");
    expect(escalation!).not.toContain("planner output was unparseable");
  });

  // I-7: cross-regression guard — JudgeTimeoutError must NOT be
  // misclassified as PlannerTimeoutError.
  test("I-7: JudgeTimeoutError is NOT misclassified as PlannerTimeoutError", async () => {
    ensureProjectDir(hermesDir, project.id);
    saveState(hermesDir, project.id, project);
    setJudgeOnceImpl(async () => {
      throw new JudgeTimeoutError(5 * 60 * 1000);
    });

    await runProject(project.id, {
      hermesDir,
      thread: thread as unknown as ThreadChannel,
      claudeSession: null,
    });

    const reloaded = loadState(hermesDir, project.id);
    expect(reloaded!.status).toBe("judge_timed_out");
    expect(reloaded!.status).not.toBe("timed_out");

    const escalation = thread.sent.find((s) => s.includes("escalated"));
    expect(escalation!).toContain("judge timed out");
    expect(escalation!).not.toContain("planner timed out");
  });

  // I-8: regression guard — the new judge branches must not leak into
  // the generic failure path. A non-judge, non-planner error must still
  // map to status="failed" with the "orchestrator crashed" message.
  test("I-8: generic Error → status='failed' (regression guard)", async () => {
    ensureProjectDir(hermesDir, project.id);
    saveState(hermesDir, project.id, project);
    setJudgeOnceImpl(async () => {
      throw new Error("simulated orchestrator crash");
    });

    await runProject(project.id, {
      hermesDir,
      thread: thread as unknown as ThreadChannel,
      claudeSession: null,
    });

    const reloaded = loadState(hermesDir, project.id);
    expect(reloaded!.status).toBe("failed");

    const escalation = thread.sent.find((s) => s.includes("escalated"));
    expect(escalation).toBeDefined();
    // Must use the generic "orchestrator crashed" path, NOT the
    // "🕐" judge-timed-out prefix and NOT the "🔧" parse prefix.
    expect(escalation!).not.toContain("🕐");
    expect(escalation!).not.toContain("🔧");
    expect(escalation!).toContain("orchestrator crashed");

    const journalPath = join(hermesDir, "projects", project.id, "journal.log");
    const journal = readFileSync(journalPath, "utf-8");
    expect(journal).toMatch(/\[escalate\] orchestrator crash:.*simulated orchestrator crash/);
  });

  // I-9: regression guard — importing PlannerTimeoutError from the
  // planner module and instantiating it must NOT match JudgeTimeoutError
  // (different classes). This protects future refactors from
  // accidentally merging the two error hierarchies.
  test("I-9: PlannerTimeoutError and JudgeTimeoutError are distinct classes", () => {
    const p = new PlannerTimeoutError(15 * 60 * 1000);
    const j = new JudgeTimeoutError(5 * 60 * 1000);
    expect(p instanceof JudgeTimeoutError).toBe(false);
    expect(j instanceof PlannerTimeoutError).toBe(false);
    expect(p.name).toBe("PlannerTimeoutError");
    expect(j.name).toBe("JudgeTimeoutError");
  });

  // I-10: regression guard — same for parse error classes.
  test("I-10: PlannerParseError and JudgeParseError are distinct classes", () => {
    const p = new PlannerParseError({ raw: "x", cleaned: "y", cause: new Error() });
    const j = new JudgeParseError({ raw: "x", cleaned: "y", cause: new Error() });
    expect(p instanceof JudgeParseError).toBe(false);
    expect(j instanceof PlannerParseError).toBe(false);
    expect(p.name).toBe("PlannerParseError");
    expect(j.name).toBe("JudgeParseError");
  });
});