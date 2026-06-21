/**
 * Hermes planner — uses the Claude Agent SDK with a cheap model to
 * decompose a high-level goal into 3-10 concrete tasks.
 *
 * We use the SDK rather than calling the Anthropic Messages API directly
 * so we inherit its auth, streaming, abort, and error handling. The
 * downside is overhead (it spawns a Claude Code subprocess), but for a
 * one-shot planner call that's acceptable. If planner latency becomes
 * an issue, swap to `fetch("https://api.anthropic.com/v1/messages", ...)`.
 *
 * Output is parsed as JSON matching the Hermes schema (see
 * PLAN_RESPONSE_SCHEMA below). Markdown code fences in the response are
 * stripped defensively before parsing.
 */

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config";
import { log } from "../logger";
import { z } from "zod";
import type { Task } from "./types";

const PLANNER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const PLAN_TASK_SCHEMA = z.object({
  id: z.string().regex(/^t\d+$/, "task id must match t<digits>"),
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(2000),
  dependsOn: z.array(z.string()).default([]),
});

const PLAN_RESPONSE_SCHEMA = z.object({
  tasks: z.array(PLAN_TASK_SCHEMA).min(1).max(15),
  reasoning: z.string().max(1000),
});

const SYSTEM_PROMPT = `You are Hermes, a senior project manager. You receive a high-level goal from a "Chairman" (the user) and decompose it into concrete, ordered tasks for a software engineer (Claude Code) to execute.

Output ONLY valid JSON — no prose, no markdown. The JSON must match:
{
  "tasks": [
    {
      "id": "t1",
      "title": "short title",
      "description": "1-3 sentences describing what to do",
      "dependsOn": ["t0"]   // task IDs this depends on; empty array if none
    }
  ],
  "reasoning": "1-2 sentences on the overall approach"
}

Rules:
- 3 to 10 tasks. Fewer for trivial goals, more for complex ones.
- Each task is concrete enough that an engineer can implement it without further clarification.
- Tasks should be independently verifiable (can run tests, check files, etc.).
- dependsOn must form a valid DAG (no cycles, no self-reference).
- First task should set up the workspace (init project, explore existing repo, etc.) when the project is new.
- Final task should verify the whole deliverable (run tests, typecheck, smoke test).`;

/** Strip markdown code fences if the LLM wrapped JSON in them anyway. */
function stripCodeFences(s: string): string {
  return s
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

export interface PlanResult {
  tasks: Task[];
  reasoning: string;
}

export async function planProject(input: {
  goal: string;
  repoPath: string;
  repoSource: "new" | "clone" | "local";
  model?: string;
}): Promise<PlanResult> {
  const model = input.model ?? config.hermes.model;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PLANNER_TIMEOUT_MS);

  const userPrompt = `# Chairman's Goal
${input.goal}

# Workspace
- Path: ${input.repoPath}
- Source: ${input.repoSource}
${input.repoSource === "new" ? "- This is a brand-new project — task #1 must initialize it." : ""}
${input.repoSource === "clone" ? "- This is an existing repo cloned from a URL. Assume it is set up." : ""}
${input.repoSource === "local" ? "- This is an existing local directory. Explore before changing." : ""}

Decompose the goal into 3-10 concrete tasks. Return JSON only.`;

  log.info("hermes planner: starting", {
    goal: input.goal.slice(0, 200),
    repoSource: input.repoSource,
    model,
  });

  let q;
  try {
    q = query({
      prompt: userPrompt,
      options: {
        model,
        abortController: ac,
        cwd: input.repoPath,
        // Hermes never runs tools in the planner; "plan" mode means CC won't
        // make tool calls without explicit approval (and we never approve).
        permissionMode: "plan",
        allowDangerouslySkipPermissions: false,
        systemPrompt: SYSTEM_PROMPT,
      },
    });
  } catch (err) {
    clearTimeout(timer);
    log.error("hermes planner: query start failed", { err: String(err) });
    throw new Error(`planner: failed to start query: ${String(err)}`);
  }

  let collected = "";
  let turns = 0;
  try {
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === "assistant") {
        turns++;
        for (const block of msg.message.content) {
          if (block.type === "text") collected += block.text;
        }
      } else if (msg.type === "result") {
        if (msg.subtype !== "success") {
          log.warn("hermes planner: non-success result", {
            subtype: msg.subtype,
            error: "error" in msg ? msg.error : undefined,
          });
        }
        break;
      }
    }
  } finally {
    clearTimeout(timer);
  }

  log.info("hermes planner: got response", {
    turns,
    bytes: collected.length,
    preview: collected.slice(0, 200),
  });

  const cleaned = stripCodeFences(collected);
  let parsed;
  try {
    parsed = PLAN_RESPONSE_SCHEMA.parse(JSON.parse(cleaned));
  } catch (err) {
    log.error("hermes planner: parse failed", {
      raw: cleaned.slice(0, 1000),
      err: String(err),
    });
    throw new Error(`planner: invalid JSON response: ${String(err)}`);
  }

  // Validate dependsOn DAG.
  const ids = new Set(parsed.tasks.map((t) => t.id));
  for (const t of parsed.tasks) {
    for (const dep of t.dependsOn) {
      if (!ids.has(dep)) {
        throw new Error(`planner: task ${t.id} depends on unknown task ${dep}`);
      }
      if (dep === t.id) {
        throw new Error(`planner: task ${t.id} depends on itself`);
      }
    }
  }

  return {
    tasks: parsed.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      status: "pending" as const,
      attempts: 0,
      dependsOn: t.dependsOn,
    })),
    reasoning: parsed.reasoning,
  };
}