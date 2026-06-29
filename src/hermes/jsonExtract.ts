/**
 * Hermes — robust JSON extraction from LLM responses.
 *
 * Problem (visible in data/bot.err.log, 2026-06-22..28):
 *   The planner and judge both call Zod's `.parse()` directly on the raw
 *   LLM response. Even with `stripThinkTags` + `stripCodeFences`, the
 *   LLM sometimes wraps the JSON in prose ("Now I have enough context.
 *   Let me write the plan file. ```json {...}```") or emits malformed
 *   JSON (Chinese characters in keys, missing quotes, etc.). Zod's
 *   `SyntaxError` then bubbles up as `PlannerParseError` / `JudgeParseError`,
 *   terminating the project with status="parse_error".
 *
 * Fix: this module provides a tolerant extraction strategy:
 *   1. Try parsing the entire cleaned string as-is.
 *   2. If that fails, walk the string and find every balanced
 *      top-level `{...}` object, parse each, and return the FIRST one
 *      that satisfies the Zod schema.
 *   3. If none parses, throw a typed error with the cleaned string +
 *      first 500 chars of the raw response for post-mortem.
 *
 * Why not use a regex like `/\{[\s\S]*\}/`?
 *   Greedy regex matches from the first `{` to the LAST `}` in the
 *   string, which captures prose between objects as well. Balanced
 *   bracket parsing is O(n) and unambiguous.
 *
 * Why first valid object (vs. largest)?
 *   "Largest" rewards the LLM for emitting extra noise; "first" is
 *   what the user reads first and what the system prompt directs the
 *   model to output.
 */

import { z } from "zod";
import type { ZodTypeAny, z as zNs } from "zod";

/**
 * Walk the string, collecting every top-level `{...}` object's range.
 * Handles nested braces and quoted strings (so braces inside strings
 * don't fool the parser).
 *
 * Returns array of [start, end) pairs into the input string. The end
 * is the position just past the closing `}`.
 */
function findBalancedObjects(input: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === "{") {
      // Find the matching close brace, respecting nested braces and
      // quoted strings (which can contain braces).
      const start = i;
      let depth = 1;
      let j = i + 1;
      let inString = false;
      let escape = false;
      while (j < input.length && depth > 0) {
        const cj = input[j]!;
        if (escape) {
          escape = false;
          j++;
          continue;
        }
        if (inString) {
          if (cj === "\\") {
            escape = true;
          } else if (cj === '"') {
            inString = false;
          }
          j++;
          continue;
        }
        if (cj === '"') {
          inString = true;
        } else if (cj === "{") {
          depth++;
        } else if (cj === "}") {
          depth--;
        }
        j++;
      }
      if (depth === 0) {
        ranges.push([start, j]);
        i = j;
      } else {
        // Unbalanced — skip this `{` and move on.
        i++;
      }
    } else {
      i++;
    }
  }
  return ranges;
}

/**
 * Try to extract a value matching `schema` from `input`. Returns the
 * parsed value on success, throws a typed error with both the raw
 * response and the cleaned string on failure.
 *
 * Strategy (in order):
 *   1. Parse the entire cleaned string as JSON, validate with schema.
 *   2. For each balanced top-level object, try parsing + validating.
 *      Return the first that passes.
 *   3. Throw JsonExtractError with the cleaned text + first 500 chars
 *      of the raw text.
 */
export function extractJson<T extends ZodTypeAny>(
  input: string,
  raw: string,
  schema: T,
): zNs.infer<T> {
  // Strategy 1: parse the whole string.
  try {
    const parsed = JSON.parse(input);
    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
  } catch {
    // Not valid JSON — fall through to balanced-object search.
  }

  // Strategy 2: try each balanced object in source order.
  for (const [start, end] of findBalancedObjects(input)) {
    const candidate = input.slice(start, end);
    try {
      const parsed = JSON.parse(candidate);
      const result = schema.safeParse(parsed);
      if (result.success) return result.data;
    } catch {
      // JSON syntax error in this candidate — try next.
    }
  }

  throw new JsonExtractError({
    raw: raw.slice(0, 500),
    cleaned: input.slice(0, 500),
  });
}

/**
 * Thrown by extractJson when neither whole-string nor balanced-object
 * extraction yields a schema-valid value. Caller should retry with a
 * stricter prompt (e.g. "respond with JSON only, no prose") and
 * surface this error to the journal if retry also fails.
 */
export class JsonExtractError extends Error {
  readonly raw: string;
  readonly cleaned: string;
  constructor(opts: { raw: string; cleaned: string }) {
    super(
      `failed to extract JSON from LLM response (raw: ${opts.raw.slice(0, 200)}…)`,
    );
    this.name = "JsonExtractError";
    this.raw = opts.raw;
    this.cleaned = opts.cleaned;
  }
}

// Re-export z so callers don't need a second import.
export { z };