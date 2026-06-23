/**
 * Tests for the `stripThinkTags` helper in format.ts (RG-002).
 *
 * These cover the three known tag variants that Claude Code / Anthropic
 * extended thinking emit, plus edge cases (dangling tags, multi-line
 * blocks, no-think content, leading/trailing whitespace, multiple
 * blocks in one string).
 *
 * Invariant: After stripThinkTags, the result MUST NOT contain any
 * opening or closing tag matching `(?i)<think|ant_thinking` in any
 * form. If a refactor breaks this, the leak resurfaces in Discord.
 */

import { describe, test, expect } from "bun:test";
import { stripThinkTags, formatToolResult } from "./format";

const TAG_RE = /<\s*\/?\s*(?:ant_)?think(?:ing)?\s*>/i;

describe("stripThinkTags (RG-002)", () => {
  test("returns plain text unchanged", () => {
    const input = "Just a normal reply with no thinking blocks.";
    expect(stripThinkTags(input)).toBe(input);
  });

  test("strips <ant_thinking>...</ant_thinking> (Anthropic extended)", () => {
    const input =
      "<ant_thinking>\nThe user wants X.\nLet me think.\n</ant_thinking>\n\nThe answer is X.";
    const out = stripThinkTags(input);
    expect(out).not.toMatch(TAG_RE);
    expect(out).toContain("The answer is X.");
    expect(out).not.toContain("Let me think");
  });

  test("strips <thinking>...</thinking> (older CC variant)", () => {
    const input = "<thinking>reasoning</thinking>\nFinal answer.";
    const out = stripThinkTags(input);
    expect(out).not.toMatch(TAG_RE);
    expect(out).toBe("Final answer.");
  });

  test("strips <think>...</think> (lowercase, no -ing)", () => {
    const input = "<think>quick thought</think>\nAnswer.";
    const out = stripThinkTags(input);
    expect(out).not.toMatch(TAG_RE);
    expect(out).toBe("Answer.");
  });

  test("handles multi-line thinking blocks", () => {
    const lines = [
      "Line 1 of thinking.",
      "Line 2 of thinking.",
      "Line 3 with code:",
      "```",
      "function foo() { return 42; }",
      "```",
      "End of thinking.",
    ];
    const input =
      "<ant_thinking>\n" + lines.join("\n") + "\n</ant_thinking>\n\nVisible.";
    const out = stripThinkTags(input);
    expect(out).not.toMatch(TAG_RE);
    expect(out).not.toContain("Line 1 of thinking");
    expect(out).not.toContain("function foo");
    expect(out).toBe("Visible.");
  });

  test("strips multiple thinking blocks in one string", () => {
    const input =
      "<ant_thinking>thought 1</ant_thinking>\n\nFirst answer.\n\n" +
      "<thinking>thought 2</thinking>\n\nSecond answer.";
    const out = stripThinkTags(input);
    expect(out).not.toMatch(TAG_RE);
    expect(out).toContain("First answer.");
    expect(out).toContain("Second answer.");
  });

  test("handles dangling closing tag (no opening match)", () => {
    // Defensive: if CC writes </ant_thinking> without a matching opener
    // (e.g. truncation), we still strip the stray tag.
    const input = "Some text\n</ant_thinking>\nMore text";
    const out = stripThinkTags(input);
    expect(out).not.toMatch(TAG_RE);
    expect(out).toContain("Some text");
    expect(out).toContain("More text");
  });

  test("handles dangling opening tag (no closing match)", () => {
    // Defensive: if CC writes <ant_thinking> without </ant_thinking>
    // (e.g. truncation), we still strip the stray opener.
    const input = "Some text\n<ant_thinking>\nMore text";
    const out = stripThinkTags(input);
    expect(out).not.toMatch(TAG_RE);
    expect(out).toContain("Some text");
    expect(out).toContain("More text");
  });

  test("trims leading/trailing whitespace", () => {
    const input = "\n\n  <ant_thinking>thought</ant_thinking>\n\nAnswer.  \n";
    const out = stripThinkTags(input);
    expect(out).toBe("Answer.");
  });

  test("collapses 3+ newlines into 2", () => {
    const input = "<ant_thinking>thought</ant_thinking>\n\n\n\n\nAnswer.";
    const out = stripThinkTags(input);
    expect(out).toBe("Answer.");
    // No more than 2 consecutive newlines anywhere
    expect(out).not.toMatch(/\n{3,}/);
  });

  test("returns empty string for empty input", () => {
    expect(stripThinkTags("")).toBe("");
  });

  test("returns empty string for input that is only a thinking block", () => {
    const input = "<ant_thinking>just thinking</ant_thinking>";
    expect(stripThinkTags(input)).toBe("");
  });

  test("matches the actual log line from 2026-06-21T19:03:52", () => {
    // Pin the regression: this exact text appeared in a `sdk assistant
    // text` log preview on 2026-06-21. Before the fix, the bare
    // </ant_thinking> would have leaked into the user's Discord view
    // (and the user would have seen ONLY the thinking tag with no
    // final answer, because there was none in this block).
    const input =
      "<ant_thinking>\nDone reporting aged-system progress to user via Discord.\n</ant_thinking>";
    const out = stripThinkTags(input);
    expect(out).not.toMatch(TAG_RE);
    // The text was entirely inside a thinking block — strip result is
    // empty. The discordSendTool and sdkRunner both check `!visible`
    // and skip the post in this case, which is the right behavior.
    expect(out).toBe("");
  });

  test("is case-insensitive on tag names", () => {
    const input = "<ANT_THINKING>thought</ANT_THINKING>\nAnswer.";
    const out = stripThinkTags(input);
    expect(out).not.toMatch(TAG_RE);
    expect(out).toBe("Answer.");
  });

  test("tolerates extra whitespace inside tag", () => {
    // CC sometimes writes < ant_thinking > with spaces (rare but seen
    // in older models).
    const input = "< ant_thinking >thought</ ant_thinking >\nAnswer.";
    const out = stripThinkTags(input);
    expect(out).not.toMatch(TAG_RE);
    expect(out).toBe("Answer.");
  });
});

describe("formatToolResult", () => {
  test("returns empty string for empty input", () => {
    expect(formatToolResult("", false)).toBe("");
    expect(formatToolResult("", true)).toBe("");
  });

  test("returns empty string for whitespace-only input", () => {
    expect(formatToolResult("   \n\n\t  \n", false)).toBe("");
  });

  test("returns plain text unchanged when short", () => {
    expect(formatToolResult("file written", false)).toBe("file written");
  });

  test("prefixes with ❌ on isError", () => {
    expect(formatToolResult("permission denied", true)).toBe("❌ permission denied");
  });

  test("truncates long input with ellipsis (default 200)", () => {
    const long = "a".repeat(500);
    const out = formatToolResult(long, false);
    expect(out.length).toBe(200);
    expect(out.endsWith("…")).toBe(true);
  });

  test("respects custom max", () => {
    const out = formatToolResult("x".repeat(100), false, 50);
    expect(out.length).toBe(50);
    expect(out.endsWith("…")).toBe(true);
  });

  test("does not add ellipsis when input fits exactly", () => {
    const exact = "a".repeat(200);
    expect(formatToolResult(exact, false)).toBe(exact);
    expect(formatToolResult(exact, false).endsWith("…")).toBe(false);
  });

  test("collapses newlines and tabs into single spaces", () => {
    // Multi-line tool output (e.g. file dump, error stack) compresses
    // to one readable line — critical for the 1500-char status banner
    // which would otherwise overflow when many tools fire in succession.
    const multi = "line 1\nline 2\n\tline 3\n\nline 4";
    expect(formatToolResult(multi, false)).toBe("line 1 line 2 line 3 line 4");
  });

  test("collapses internal runs of spaces", () => {
    expect(formatToolResult("a   b    c", false)).toBe("a b c");
  });

  test("truncates AFTER collapsing (multi-line long output)", () => {
    // 50 short lines joined → ~250 chars → still under 200 → truncated
    const manyLines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    const out = formatToolResult(manyLines, false);
    // After collapse: "line 1 line 2 line 3 ... line 50" ≈ 200+ chars
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toContain("line 1");
    expect(out).toContain("line 2");
  });

  test("error preview also collapses and truncates", () => {
    const longErr = "TypeError: foo\n  at bar (x.js:1:1)\n  at baz (y.js:2:2)\n";
    const out = formatToolResult(longErr, true);
    expect(out.startsWith("❌ ")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(201); // 200 + leading "❌ "
    expect(out).not.toContain("\n");
  });

  test("does NOT prepend ❌ when isError is false even if input has 'error' word", () => {
    // Edge case: a successful Bash result that contains the substring
    // "error" should not be flagged.
    expect(formatToolResult("0 errors, 3 warnings", false)).toBe(
      "0 errors, 3 warnings",
    );
  });

  test("trims leading and trailing whitespace after collapse", () => {
    expect(formatToolResult("\n\n  hello world  \n", false)).toBe(
      "hello world",
    );
  });
});
