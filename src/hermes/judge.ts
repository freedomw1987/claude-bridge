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
 */

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config";
import { log } from "../logger";
import { z } from "zod";
import type { JudgeVerdict, ProjectState } from "./types";

const JUDGE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

const JUDGE_TASK_SCHEMA = z.object({
  id: z.string().regex(/^t\d+$/),
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

function stripCodeFences(s: string): string {
  return s
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

export async function judgeProject(
  state: ProjectState,
  opts?: { model?: string },
): Promise<JudgeVerdict> {
  const model = opts?.model ?? config.hermes.model;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), JUDGE_TIMEOUT_MS);

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

  const cleaned = stripCodeFences(collected);
  let parsed;
  try {
    parsed = JUDGE_RESPONSE_SCHEMA.parse(JSON.parse(cleaned));
  } catch (err) {
    log.error("hermes judge: parse failed", {
      raw: cleaned.slice(0, 1000),
      err: String(err),
    });
    throw new Error(`judge: invalid JSON response: ${String(err)}`);
  }

  const verdict: JudgeVerdict = {
    verdict: parsed.verdict,
    reasoning: parsed.reasoning,
    nextTasks: parsed.nextTasks?.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      status: "pending" as const,
      attempts: 0,
      dependsOn: t.dependsOn,
    })),
  };

  log.info("hermes judge: verdict", {
    projectId: state.id,
    verdict: verdict.verdict,
    reasoning: verdict.reasoning.slice(0, 200),
  });

  return verdict;
}