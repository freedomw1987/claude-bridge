/**
 * RG-011 audit — judge output stripping & parse/timeout errors.
 *
 * Background (regression 2026-06-24):
 *   David reported two opaque failures that Hermes projects were hitting
 *   frequently:
 *     1. `⚠️ escalated: orchestrator crashed: Error: judge: invalid JSON
 *         response: [ { "validation": "regex", "code": "invalid_string", ...`
 *     2. `⚠️ escalated: orchestrator crashed: Error: Claude Code process
 *         aborted by user`
 *
 *   Both came from the SAME three bugs in src/hermes/judge.ts that the
 *   planner already had fixed in RG-008/RG-010:
 *     - stripCodeFences didn't call stripThinkTags (LLM-leaked thinking
 *       blocks poisoned JSON.parse → "invalid JSON response")
 *     - the for-await loop didn't check ac.signal.aborted (timeout fired
 *       → SDK surfaced opaque "Connection aborted by user" string)
 *     - the task-id regex `^t\d+$` was too strict (LLM often emits
 *       `T1`, `task-1`, `1.0` → Zod "validation: regex" failure)
 *
 *   Plus two additional gaps the planner didn't have:
 *     - judge timeout was hardcoded to 3min (planner is configurable
 *       via HERMES_PLANNER_TIMEOUT_MS)
 *     - judge had no auto-retry, so transient LLM hiccups killed the
 *       project at the last mile
 *
 * Fixes (in src/hermes/judge.ts):
 *   - stripCodeFences calls stripThinkTags first (mirror planner RG-010)
 *   - JudgeParseError typed class with raw + cleaned + cause preserved
 *     for the journal
 *   - JudgeTimeoutError typed class with timeoutMs; thrown when
 *     ac.signal.aborted fires (mirror planner RG-008)
 *   - JUDGE_TASK_SCHEMA id regex loosened to `^[a-zA-Z0-9_-]+$`;
 *     normalizeJudgeTasks auto-renumbers to t<existingPlanLen+1>..t<N>
 *     and remaps dependsOn
 *   - judgeTimeoutMs now configurable via HERMES_JUDGE_TIMEOUT_MS
 *     (default 5min, raised from hardcoded 3min)
 *   - judgeProject wraps judgeProjectWithRetry which retries ONCE on
 *     JudgeTimeoutError / JudgeParseError
 *
 * Invariants covered here:
 *   I-1..I-7   judge stripCodeFences (mirror planner I-1..I-7)
 *   I-8..I-10  JudgeParseError shape
 *   I-11, I-12 JudgeTimeoutError shape
 *   I-13..I-16 normalizeJudgeTasks behavior
 *   I-17, I-18 JUDGE_TASK_SCHEMA regex (loose accepts, rejects empty)
 *   I-19..I-21 judgeProject retry behavior (via mocked judgeProjectOnce)
 */

// ── Test setup ──────────────────────────────────────────────────────────
//
// Retry behavior is tested via dependency injection: the judge exposes
// `setJudgeOnceImpl(fn)` / `resetJudgeOnceImpl()` so tests can swap the
// inner `judgeProjectOnce` for a controllable mock. This avoids
// `mock.module("./judge", ...)` which would conflict with
// orchestratorRG011.test.ts (which also mocks `./judge` — module-level
// mocks leak across test files in the same bun process). See
// judge.ts: `Test hook: dependency injection for retry tests`.
import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JudgeParseError,
  JudgeTimeoutError,
  stripCodeFences,
  normalizeJudgeTasks,
  judgeProject,
  setJudgeOnceImpl,
  resetJudgeOnceImpl,
} from "./judge";
import {
  newProjectState,
  type ProjectState,
  type JudgeVerdict,
} from "./types";

// Tag constants — built via concatenation so the parser doesn't see
// an opening tag and try to interpret it. The real haiku-4-5 LLM
// emits these tags verbatim in the judge response (mirror of
// plannerRG010.test.ts which faces the same leak).
const TAG_OPEN = "<" + "thinking" + ">";
const TAG_CLOSE = "</" + "thinking" + ">";
const TAG_OPEN_ALT = "<" + "ant_thinking" + ">";
const TAG_CLOSE_ALT = "</" + "ant_thinking" + ">";
const TAG_OPEN_VARIANT = "<" + "think" + ">";

const JUDGE_JSON = `{
  "verdict": "done",
  "reasoning": "All tasks completed successfully."
}`;

const THINK_BLOCK =
  TAG_OPEN +
  "\nThe user wants me to judge whether the project is complete.\n" +
  "Let me think about this carefully.\n\n" +
  "I should consider:\n1. What was the goal?\n2. Were all tasks done?\n\n" +
  "OK I think the project is complete.\n" +
  TAG_CLOSE;

describe("RG-011 I-1..I-7: judge stripCodeFences", () => {
  test("I-1: strips thinking blocks (regression 2026-06-24)", () => {
    const input = THINK_BLOCK + "\n" + JUDGE_JSON;
    const out = stripCodeFences(input);
    expect(out).not.toContain(TAG_OPEN);
    expect(out).not.toContain(TAG_CLOSE);
    expect(out).toContain('"verdict"');
    expect(out).toContain('"reasoning"');
  });

  test("I-2: strips ant_thinking blocks", () => {
    const input = THINK_BLOCK + "\n" + JUDGE_JSON;
    const out = stripCodeFences(input);
    expect(out).not.toContain(TAG_OPEN_ALT);
    expect(out).not.toContain(TAG_CLOSE_ALT);
  });

  test("I-3: strips the short think variant (with closing tag)", () => {
    const shortThinkBlock =
      TAG_OPEN_VARIANT +
      "\nThe user wants me to judge the project. " +
      "Let me think about this carefully. OK I think it's done.\n" +
      TAG_OPEN_VARIANT.replace("<", "</");
    const input = shortThinkBlock + "\n" + JUDGE_JSON;
    const out = stripCodeFences(input);
    expect(out).not.toContain(TAG_OPEN_VARIANT);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  test("I-4: the actual regression input (thinking + fence) is fully cleaned", () => {
    const input =
      THINK_BLOCK + "\n" + "```json\n" + JUDGE_JSON + "\n```";
    const out = stripCodeFences(input);
    expect(() => JSON.parse(out)).not.toThrow();
    const parsed = JSON.parse(out);
    expect(parsed.verdict).toBe("done");
    expect(parsed.reasoning).toContain("tasks completed");
  });

  test("I-5: is idempotent — stripping twice gives same result", () => {
    const input =
      THINK_BLOCK + "\n" + "```json\n" + JUDGE_JSON + "\n```";
    const once = stripCodeFences(input);
    const twice = stripCodeFences(once);
    expect(twice).toBe(once);
  });

  test("I-6: plain JSON (no thinking, no fence) is returned unchanged", () => {
    const out = stripCodeFences(JUDGE_JSON);
    expect(out).toBe(JUDGE_JSON);
  });

  test("I-7: missing opening fence is OK (model wrote plain JSON)", () => {
    const input = THINK_BLOCK + "\n" + JUDGE_JSON;
    const out = stripCodeFences(input);
    expect(() => JSON.parse(out)).not.toThrow();
  });
});

describe("RG-011 I-8..I-10: JudgeParseError", () => {
  test("I-8: carries raw output, cleaned output, and cause", () => {
    const cause = new SyntaxError("Unrecognized token");
    const rawInput = THINK_BLOCK + "```json\n" + JUDGE_JSON + "\n```";
    const err = new JudgeParseError({
      raw: rawInput,
      cleaned: "{not valid json}",
      cause,
    });
    expect(err.raw).toBe(rawInput);
    expect(err.cleaned).toBe("{not valid json}");
    expect(err.cause).toBe(cause);
  });

  test("I-9: is an instanceof Error", () => {
    const err = new JudgeParseError({
      raw: "x",
      cleaned: "y",
      cause: new Error("cause"),
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(JudgeParseError);
    expect(err.name).toBe("JudgeParseError");
  });

  test("I-10: message starts with 'judge: invalid JSON' (for log grep)", () => {
    const err = new JudgeParseError({
      raw: "x",
      cleaned: "y",
      cause: new SyntaxError("Unexpected token"),
    });
    expect(err.message).toStartWith("judge: invalid JSON");
    expect(err.message).toContain("Unexpected token");
  });

  test("I-10b: JudgeParseError is distinguishable from JudgeTimeoutError", () => {
    const parseErr = new JudgeParseError({ raw: "x", cleaned: "y", cause: new Error() });
    const timeoutErr = new JudgeTimeoutError(300_000);
    expect(parseErr instanceof JudgeTimeoutError).toBe(false);
    expect(timeoutErr instanceof JudgeParseError).toBe(false);
  });
});

describe("RG-011 I-11, I-12: JudgeTimeoutError", () => {
  test("I-11: carries timeoutMs and formats seconds in the message", () => {
    const err = new JudgeTimeoutError(300_000);
    expect(err.timeoutMs).toBe(300_000);
    expect(err.message).toContain("300s");
    expect(err.message).toStartWith("judge timed out after");
  });

  test("I-12: is an instanceof Error", () => {
    const err = new JudgeTimeoutError(60_000);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(JudgeTimeoutError);
    expect(err.name).toBe("JudgeTimeoutError");
  });
});

describe("RG-011 I-13..I-16: normalizeJudgeTasks", () => {
  test("I-13: renumbers IDs starting from existingPlanLen + 1", () => {
    const out = normalizeJudgeTasks(
      [
        { id: "T1", title: "A", description: "do A", dependsOn: [] },
        { id: "task-2", title: "B", description: "do B", dependsOn: [] },
      ],
      2,
    );
    expect(out.map((t) => t.id)).toEqual(["t3", "t4"]);
    expect(out[0].title).toBe("A");
    expect(out[1].title).toBe("B");
    expect(out[0].status).toBe("pending");
    expect(out[0].attempts).toBe(0);
  });

  test("I-14: remaps dependsOn to the renumbered IDs (A depends on B, both proposed)", () => {
    const out = normalizeJudgeTasks(
      [
        { id: "A", title: "Task A", description: "do A", dependsOn: ["B"] },
        { id: "B", title: "Task B", description: "do B", dependsOn: [] },
      ],
      0,
    );
    expect(out[0].id).toBe("t1");
    expect(out[0].dependsOn).toEqual(["t2"]);
    expect(out[1].id).toBe("t2");
    expect(out[1].dependsOn).toEqual([]);
  });

  test("I-15: dedupes dependsOn entries", () => {
    const out = normalizeJudgeTasks(
      [
        {
          id: "A",
          title: "Task A",
          description: "do A",
          dependsOn: ["B", "B", "B"],
        },
        {
          id: "B",
          title: "Task B",
          description: "do B",
          dependsOn: [],
        },
      ],
      0,
    );
    expect(out[0].id).toBe("t1");
    expect(out[0].dependsOn).toEqual(["t2"]);
    expect(out[1].id).toBe("t2");
    expect(out[1].dependsOn).toEqual([]);
  });

  test("I-16: passes through unknown deps (e.g. existing plan task IDs)", () => {
    const out = normalizeJudgeTasks(
      [
        { id: "A", title: "Task A", description: "do A", dependsOn: ["t1", "T2"] },
      ],
      2,
    );
    expect(out[0].id).toBe("t3");
    expect(out[0].dependsOn).toEqual(["t1", "T2"]);
  });
});

describe("RG-011 I-17, I-18: JUDGE_TASK_SCHEMA regex (loose)", () => {
  test("I-17: accepts free-form LLM IDs", () => {
    const ids = ["T1", "task-1", "1", "TASK_42", "step-one", "t1"];
    for (const id of ids) {
      expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });

  test("I-18: rejects empty string and whitespace-only IDs", () => {
    for (const id of ["", " ", "has space", "has/slash", "1.0", "has.dot"]) {
      expect(id).not.toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });
});

// ── I-19..I-21: judgeProject retry behavior ──────────────────────────
//
// `judgeProject` (public entry point) wraps `judgeProjectWithRetry`,
// which calls the module-scoped `judgeOnceImpl` (defaulting to
// `judgeProjectOnce`). Tests use `setJudgeOnceImpl()` / `resetJudgeOnceImpl()`
// (see judge.ts) to swap the inner function with a controllable mock.
// The retry wrapper itself is the real implementation.
describe("RG-011 I-19..I-21: judgeProject retry behavior (via DI hook)", () => {
  let tmpDir: string;
  let repoPath: string;
  let callCount = 0;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rg011-"));
    repoPath = join(tmpDir, "repo");
    callCount = 0;
    // Default impl: succeed with a "done" verdict (no retry needed).
    // Each test overrides via setJudgeOnceImpl below.
    setJudgeOnceImpl(async () => ({
      verdict: "done" as const,
      reasoning: "default",
    }));
  });

  afterEach(() => {
    // Restore the real judgeProjectOnce so subsequent tests in OTHER
    // files (which may import this module) see the real implementation.
    // Without this reset, a test that left a throwing impl in place
    // would leak across the test suite.
    resetJudgeOnceImpl();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeProject(planLen = 1): ProjectState {
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
    for (let i = 0; i < planLen; i++) {
      s.plan.push({
        id: `t${i + 1}`,
        title: `task ${i + 1}`,
        description: `desc ${i + 1}`,
        status: "done",
        attempts: 1,
        dependsOn: [],
      });
    }
    return s;
  }

  test("I-19: retries once on JudgeTimeoutError, then propagates if second attempt also times out", async () => {
    const project = makeProject(1);
    setJudgeOnceImpl(async () => {
      callCount++;
      throw new JudgeTimeoutError(300_000);
    });

    let caught: unknown = null;
    try {
      await judgeProject(project);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JudgeTimeoutError);
    // Exactly 2 attempts (initial + one retry).
    expect(callCount).toBe(2);
  });

  test("I-20: retries once on JudgeParseError, then propagates if second attempt also parses bad", async () => {
    const project = makeProject(0);
    setJudgeOnceImpl(async () => {
      callCount++;
      throw new JudgeParseError({
        raw: "x",
        cleaned: "y",
        cause: new SyntaxError("Unrecognized token"),
      });
    });

    let caught: unknown = null;
    try {
      await judgeProject(project);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JudgeParseError);
    expect(callCount).toBe(2);
  });

  test("I-20b: first attempt fails, second attempt succeeds — returns verdict from second", async () => {
    const project = makeProject(0);
    const goodVerdict: JudgeVerdict = { verdict: "done", reasoning: "ok" };
    setJudgeOnceImpl(async () => {
      callCount++;
      if (callCount === 1) {
        throw new JudgeParseError({
          raw: "x",
          cleaned: "y",
          cause: new SyntaxError("Unrecognized token"),
        });
      }
      return goodVerdict;
    });

    const verdict = await judgeProject(project);
    expect(verdict.verdict).toBe("done");
    expect(verdict.reasoning).toBe("ok");
    expect(callCount).toBe(2);
  });

  test("I-21: does NOT retry on generic Error (propagates immediately)", async () => {
    const project = makeProject(0);
    setJudgeOnceImpl(async () => {
      callCount++;
      throw new Error("network failure: ECONNRESET");
    });

    let caught: unknown = null;
    try {
      await judgeProject(project);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(JudgeTimeoutError);
    expect(caught).not.toBeInstanceOf(JudgeParseError);
    // Exactly 1 attempt — no retry on generic Error.
    expect(callCount).toBe(1);
  });
});