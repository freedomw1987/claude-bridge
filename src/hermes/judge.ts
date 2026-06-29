/**
 * Hermes judge — self-assesses whether a project is done after all planned
 * tasks have executed (or hit their retry cap).
 *
 * Verdict shapes:
 *   done       — the goal is met; project should close
 *   needs_more — add N more tasks; project re-enters executing
 *   stuck      — cannot make progress; escalate to David
 *
 * The judge may also do lightweight objective verification via the prompt:
 * we suggest it check for expected files / test results based on the goal,
 * but it must not actually run shell commands (permissionMode: "plan").
 *
 * ── RG-011 (regression 2026-06-24) — Judge robustness ────────────────
 *
 * Pre-RG-011, this module had three opaque-failure bugs that all surfaced
 * to the user as the same "orchestrator crashed: ..." line, hiding the
 * real cause from both David and from the recovery action he should take:
 *
 *   1. Missing `stripThinkTags` in `stripCodeFences` (mirror of RG-010).
 *      The judge LLM (haiku-4-5) leaks thinking blocks even when the
 *      system prompt says "JSON only". Without stripping, JSON.parse
 *      choked on the leading `<` and the error became the opaque
 *      `judge: invalid JSON response: SyntaxError: Unrecognized token '<'`.
 *
 *   2. Missing `ac.signal.aborted` check in the for-await loop (mirror
 *      of RG-008). When the configured judge timeout fired, the SDK
 *      surfaced `Error: Connection aborted by user` to the orchestrator,
 *      which had no way to distinguish a timeout from a real crash. The
 *      project landed on `status="failed"` with the misleading "Claude
 *      Code process aborted by user" string — even though the user
 *      hadn't aborted anything.
 *
 *   3. Task ID regex `^t\d+$` was too strict. The judge LLM doesn't
 *      know what IDs are already used by the planner, so it often emits
 *      `T1`, `task-1`, or `1.0`, all of which fail Zod's regex check
 *      and produce `validation: "regex"` Zod issues.
 *
 * Fixes (this rewrite):
 *   - `stripCodeFences` now strips `<ant_thinking>` etc. FIRST (mirror
 *     planner.ts:147). If parse STILL fails, throw `JudgeParseError`
 *     (typed, with raw + cleaned + cause preserved for the journal).
 *   - for-await checks `ac.signal.aborted` FIRST and throws
 *     `JudgeTimeoutError(judgeTimeoutMs)`. No more opaque "aborted
 *     by user" — orchestrator maps it to `status="judge_timed_out"`.
 *   - Task ID regex loosened to `^[a-zA-Z0-9_-]+$`. After parse,
 *     `normalizeJudgeTasks` auto-renumbers the proposed IDs to
 *     `t<existingPlanLen+1>..t<existingPlanLen+N>` and remaps
 *     `dependsOn` to match — so any reasonable LLM output becomes
 *     well-formed tasks with no collision risk.
 *   - Judge timeout is now configurable via `HERMES_JUDGE_TIMEOUT_MS`
 *     (default 5min, raised from the previous hardcoded 3min).
 *   - `judgeProject` wraps `judgeProjectWithRetry` which retries ONCE
 *     on `JudgeTimeoutError` or `JudgeParseError`. Transient LLM
 *     hiccups (the dominant failure mode in practice) no longer kill
 *     a project at the last mile. Other errors propagate immediately
 *     so real bugs aren't masked.
 */

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config";
import { log } from "../logger";
import { z } from "zod";
import { extractJson } from "./jsonExtract";
import { stripThinkTags } from "../discord/handlers/format";
import type { JudgeVerdict, ProjectState, Task } from "./types";

/**
 * RG-011: thrown when the judge LLM's output cannot be parsed as JSON
 * matching the JUDGE_RESPONSE_SCHEMA. Mirrors `PlannerParseError`
 * (planner.ts:46). Carries the first 500 chars of the raw LLM output
 * so the failure is debuggable from the project journal without
 * re-running the judge.
 *
 * The orchestrator catches this via `instanceof JudgeParseError` and
 * transitions the project to `status="judge_parse_error"` with a
 * "🔧 judge output was unparseable" escalation — distinct from a
 * generic failure and from a timeout.
 */
export class JudgeParseError extends Error {
  readonly raw: string;
  readonly cleaned: string;
  readonly cause: unknown;
  constructor(opts: { raw: string; cleaned: string; cause: unknown }) {
    super(`judge: invalid JSON response: ${String(opts.cause)}`);
    this.name = "JudgeParseError";
    this.raw = opts.raw;
    this.cleaned = opts.cleaned;
    this.cause = opts.cause;
  }
}

/**
 * RG-011: thrown when the judge LLM call exceeds
 * `config.hermes.judgeTimeoutMs` (env HERMES_JUDGE_TIMEOUT_MS,
 * default 5min). Mirrors `PlannerTimeoutError` (planner.ts:83).
 *
 * The orchestrator catches this via `instanceof JudgeTimeoutError`
 * and transitions the project to `status="judge_timed_out"` with a
 * "🕐 judge timed out" escalation — distinct from a generic
 * failure and from a parse error. Carries the effective timeout in
 * ms so the message can be specific ("judge timed out after 300s").
 */
export class JudgeTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`judge timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "JudgeTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

const JUDGE_TASK_SCHEMA = z.object({
  // RG-011: loosened from `^t\d+$` to accept any alphanumeric+dash+underscore
  // ID the LLM emits (T1, task-1, 1, etc.). The post-parse
  // `normalizeJudgeTasks` helper renumbers them to a clean `t<N>`
  // sequence anchored at `existingPlanLen + 1`.
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/, "task id must be alphanumeric (normalized post-parse)"),
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(2000),
  dependsOn: z.array(z.string()).default([]),
});

const JUDGE_RESPONSE_SCHEMA = z.object({
  verdict: z.enum(["done", "needs_more", "stuck"]),
  reasoning: z.string().max(2000),
  nextTasks: z.array(JUDGE_TASK_SCHEMA).optional(),
});

const SYSTEM_PROMPT = `You are Hermes, a senior project manager, judging whether a software project is complete.

You will receive:
- The Chairman's original goal
- A list of tasks that were attempted, with their outcomes
- Notes from the engineer (Claude Code) on what was actually built

Return ONLY valid JSON matching:
{
  "verdict": "done" | "needs_more" | "stuck",
  "reasoning": "1-3 sentences explaining the verdict",
  "nextTasks": [ ... ]   // ONLY when verdict === "needs_more"
}

Rules:
- "done" — every part of the goal is satisfied. Be honest; if a critical piece is missing or untested, it's not done.
- "needs_more" — concrete missing work remains. Specify 1-5 follow-up tasks using the same task shape as the planner. Do NOT propose vague work.
- "stuck" — the goal appears unreachable with the current setup (ambiguous goal, missing prerequisites, repeated failures). Pick this when retries are exhausted and you cannot define concrete next steps.`;

/**
 * RG-011: strip the LLM response before JSON.parse. Order matters:
 *   1. stripThinkTags — remove any `<ant_thinking>...</ant_thinking>` blocks
 *      (haiku-4-5 leaks them even when the system prompt says "JSON only").
 *   2. strip code fences — remove the ```json / ``` wrapping the LLM is
 *      supposed to use (and which Anthropic's system prompt may encourage
 *      defensively).
 *   3. trim whitespace.
 *
 * Pre-RG-011 this function only did step 2, so JSON.parse failed on `<`
 * when the model leaked thinking tags (mirror of the planner RG-010 bug).
 *
 * Exported for unit testing (judgeRG011.test.ts).
 */
export function stripCodeFences(s: string): string {
  return stripThinkTags(s)
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

/**
 * RG-011: auto-renumber the LLM's proposed task IDs to `t<nextN>..t<nextM>`
 * so they cannot collide with existing plan tasks, and remap `dependsOn`
 * to match. Pure function — no side effects.
 *
 * Why we do this:
 *   - The judge LLM doesn't know what task IDs the planner already used
 *     (t1..tK), and the previous strict `^t\d+$` regex caused Zod
 *     validation failures on innocuous outputs like `T1` or `1`.
 *   - Auto-renumbering sidesteps the regex failure entirely AND gives the
 *     orchestrator's DAG validator a clean slate.
 *
 * Edge cases:
 *   - Unknown deps (LLM mentioned an ID that isn't in the proposed set,
 *     e.g. an existing t3) are passed through verbatim. The orchestrator's
 *     existing DAG validation in `planner.ts` (lines 274-284, mirrored
 *     here) catches unresolved references.
 *   - Duplicate deps are deduped (LLM occasionally lists the same dep
 *     twice).
 */
export function normalizeJudgeTasks(
  proposed: Array<{
    id: string;
    title: string;
    description: string;
    dependsOn: string[];
  }>,
  existingPlanLen: number,
): Task[] {
  const idMap = new Map<string, string>();
  proposed.forEach((t, i) => {
    idMap.set(t.id, `t${existingPlanLen + i + 1}`);
  });
  return proposed.map((t, i) => {
    const newDeps = Array.from(
      new Set(
        t.dependsOn
          .map((d) => idMap.get(d) ?? d) // remap if known; pass through if unknown
          .filter((d) => d.length > 0),
      ),
    );
    return {
      id: idMap.get(t.id) ?? `t${existingPlanLen + i + 1}`,
      title: t.title,
      description: t.description,
      status: "pending" as const,
      attempts: 0,
      dependsOn: newDeps,
    };
  });
}

/**
 * Internal: run the judge with one auto-retry on transient failures.
 *
 * The judge runs at the END of a project — by the time we reach it, the
 * planner has succeeded, all planned tasks have executed (or failed),
 * and the project is one LLM call away from completion. A transient
 * failure (network blip, model hiccup, malformed-thinking-tag retry)
 * here would discard all the work for no good reason. So:
 *
 *   - First call throws `JudgeTimeoutError` or `JudgeParseError` →
 *     wait briefly, log a warn, retry ONCE with the same inputs.
 *   - Second call throws the same → propagate up to the orchestrator.
 *   - Any other Error (network failure, SDK bug, etc.) → propagate
 *     immediately on first occurrence. We do NOT retry generic errors
 *     because retrying a real bug would mask it and could compound the
 *     problem.
 *
 * The wait between attempts is 500ms — just enough for a tight network
 * loop to recover, short enough that a real timeout doesn't compound
 * (the user already waited for the first attempt to exhaust its
 * budget). Retry uses the same timeout, not a longer one, so cost is
 * bounded: worst case = 2 × judgeTimeoutMs per project per judge pass.
 *
 * `judgeProjectOnce` is exported (alongside `judgeProject`) so the
 * retry behavior can be unit-tested by mocking the inner function
 * without resorting to `mock.module("@anthropic-ai/claude-agent-sdk")`
 * which leaks across the test suite (other test files like
 * orchestratorRG011.test.ts indirectly use the SDK via runViaSdk).
 */
export async function judgeProjectWithRetry(
  state: ProjectState,
  opts?: { model?: string },
): Promise<JudgeVerdict> {
  try {
    return await judgeOnceImpl(state, opts);
  } catch (err) {
    if (err instanceof JudgeTimeoutError || err instanceof JudgeParseError) {
      log.warn("hermes judge: first attempt failed, retrying once", {
        projectId: state.id,
        errType: err instanceof JudgeTimeoutError ? "timeout" : "parse_error",
        errMessage: err.message.slice(0, 200),
      });
      // Brief wait — tight network loops usually self-correct in <500ms.
      await new Promise((r) => setTimeout(r, 500));
      // Second attempt: let it throw (typed error propagates to orchestrator).
      return await judgeOnceImpl(state, opts);
    }
    // Generic error: do not retry (could mask real bugs / compound
    // problems like repeated SDK connection failures).
    throw err;
  }
}

/**
 * Single judge attempt (no retry). Extracted from `judgeProject` so
 * `judgeProjectWithRetry` can call it twice with identical inputs.
 *
 * Exported (alongside `judgeProjectWithRetry`) so retry behavior can
 * be unit-tested via the `setJudgeOnceImpl()` dependency-injection
 * hook — see judgeRG011.test.ts I-19..I-21.
 */
export async function judgeProjectOnce(
  state: ProjectState,
  opts?: { model?: string },
): Promise<JudgeVerdict> {
  const model = opts?.model ?? config.hermes.model;
  const ac = new AbortController();
  // RG-011: timeout is configurable via config.hermes.judgeTimeoutMs
  // (env HERMES_JUDGE_TIMEOUT_MS, default 5min). See JudgeTimeoutError
  // doc above for why this is no longer hardcoded to 3min.
  const judgeTimeoutMs = config.hermes.judgeTimeoutMs;
  const timer = setTimeout(() => ac.abort(), judgeTimeoutMs);

  const taskSummary = state.plan
    .map((t) => {
      const lines = [
        `- ${t.id} [${t.status}] attempts=${t.attempts}: ${t.title}`,
      ];
      if (t.lastResult) lines.push(`    result: ${t.lastResult.slice(0, 400)}`);
      if (t.lastError) lines.push(`    error: ${t.lastError.slice(0, 400)}`);
      return lines.join("\n");
    })
    .join("\n");

  const userPrompt = `# Chairman's Goal
${state.goal}

# Workspace
${state.repoPath} (${state.repoSource})

# Task Outcomes
${taskSummary}

# Cost / Time So Far
- iterations: ${state.iterations}
- cost: $${(state.costUsd / 100).toFixed(2)}
- elapsed: ${Math.round((Date.now() - new Date(state.startedAt).getTime()) / 60000)} min

Is the goal met? Return JSON only.`;

  log.info("hermes judge: starting", {
    projectId: state.id,
    taskCount: state.plan.length,
    doneCount: state.plan.filter((t) => t.status === "done").length,
    model,
    judgeTimeoutMs,
  });

  let q;
  try {
    q = query({
      prompt: userPrompt,
      options: {
        model,
        abortController: ac,
        cwd: state.repoPath,
        permissionMode: "plan",
        allowDangerouslySkipPermissions: false,
        systemPrompt: SYSTEM_PROMPT,
      },
    });
  } catch (err) {
    clearTimeout(timer);
    log.error("hermes judge: query start failed", { err: String(err) });
    throw new Error(`judge: failed to start query: ${String(err)}`);
  }

  let collected = "";
  try {
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      // RG-011: detect a timeout (the AbortController was triggered
      // by our setTimeout above) and translate it into a
      // JudgeTimeoutError. Without this, the SDK would surface the
      // generic "Connection aborted by user" string and the
      // orchestrator would have no way to distinguish a judge timeout
      // from a real crash. The for-await may still yield a final
      // message after abort, so we check before processing each one.
      if (ac.signal.aborted) {
        throw new JudgeTimeoutError(judgeTimeoutMs);
      }
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text") collected += block.text;
        }
      } else if (msg.type === "result") {
        break;
      }
    }
  } finally {
    clearTimeout(timer);
  }

  log.info("hermes judge: got response", {
    projectId: state.id,
    bytes: collected.length,
    preview: collected.slice(0, 200),
  });

  const cleaned = stripCodeFences(collected);
  let parsed;
  try {
    // P2.5 stability: use the robust extractor (handles LLM prose
    // before/after the JSON, balanced-brace parsing). See
    // jsonExtract.ts for the full strategy.
    parsed = extractJson(cleaned, collected, JUDGE_RESPONSE_SCHEMA);
  } catch (err) {
    // RG-011: throw a typed JudgeParseError so the orchestrator can
    // transition the project to status="judge_parse_error" with a
    // clear escalation message. We preserve the first 500 chars of
    // the raw LLM output so the failure is debuggable from the
    // project journal later.
    log.error("hermes judge: parse failed", {
      raw: collected.slice(0, 1000),
      cleaned: cleaned.slice(0, 1000),
      err: String(err),
    });
    throw new JudgeParseError({
      raw: collected.slice(0, 500),
      cleaned: cleaned.slice(0, 500),
      cause: err,
    });
  }

  // RG-011: auto-renumber proposed next-task IDs to t<existingPlanLen+1>..
  // t<existingPlanLen+N> and remap dependsOn to match. Without this, the
  // LLM's free-form IDs (`T1`, `task-1`, etc.) would either fail the
  // strict `^t\d+$` regex (pre-RG-011) or collide with existing plan
  // tasks (a more subtle bug). normalizeJudgeTasks is the testable seam
  // — see judgeRG011.test.ts I-13..I-16.
  const verdict: JudgeVerdict = {
    verdict: parsed.verdict,
    reasoning: parsed.reasoning,
    nextTasks: parsed.nextTasks
      ? normalizeJudgeTasks(parsed.nextTasks, state.plan.length)
      : undefined,
  };

  log.info("hermes judge: verdict", {
    projectId: state.id,
    verdict: verdict.verdict,
    reasoning: verdict.reasoning.slice(0, 200),
    nextTaskCount: verdict.nextTasks?.length ?? 0,
  });

  return verdict;
}

/**
 * Public judge entry point. Wraps `judgeProjectWithRetry` so callers
 * (currently the orchestrator at src/hermes/orchestrator.ts:194) get
 * transparent single-retry on transient failures without changing their
 * import shape.
 */
export async function judgeProject(
  state: ProjectState,
  opts?: { model?: string },
): Promise<JudgeVerdict> {
  return judgeProjectWithRetry(state, opts);
}

// ── Test hook: dependency injection for retry tests ─────────────────────
//
// `judgeProjectWithRetry` calls `judgeProjectOnce` internally. To make
// retry behavior unit-testable without resorting to `mock.module` (which
// leaks across test files when two test files mock the same module), we
// expose a thin DI seam: tests can call `setJudgeOnceImpl(fn)` to swap
// the inner function for a controllable mock, then
// `resetJudgeOnceImpl()` to restore the real implementation.
//
// Production code never calls these; they're documented as a test
// helper. The mutable binding is module-scoped, so per-test setup/teardown
// is the test's responsibility (use beforeEach/afterEach).
export type JudgeProjectOnceFn = typeof judgeProjectOnce;
let judgeOnceImpl: JudgeProjectOnceFn = judgeProjectOnce;

/** @internal — test helper to inject a mock `judgeProjectOnce`. */
export function setJudgeOnceImpl(fn: JudgeProjectOnceFn): void {
  judgeOnceImpl = fn;
}

/** @internal — test helper to restore the real `judgeProjectOnce`. */
export function resetJudgeOnceImpl(): void {
  judgeOnceImpl = judgeProjectOnce;
}