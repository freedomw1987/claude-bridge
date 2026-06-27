/**
 * Tests for the help module + isHelpCommand regex.
 */

import { test, expect } from "bun:test";
import { HELP_TEXT, EMPTY_PROMPT_TEXT, NO_TARGET_TEXT, NO_SESSION_TEXT } from "./help";

test("HELP_TEXT mentions all four target types", () => {
  expect(HELP_TEXT).toContain("@bot in <project>");
  expect(HELP_TEXT).toContain("@bot new <name>");
  expect(HELP_TEXT).toContain("@bot <git-url>");
  expect(HELP_TEXT).toContain("@bot <local-path>");
});

test("HELP_TEXT documents all slash commands", () => {
  expect(HELP_TEXT).toContain("/repo");
  expect(HELP_TEXT).toContain("/projects");
  expect(HELP_TEXT).toContain("/status");
  expect(HELP_TEXT).toContain("/kill");
  expect(HELP_TEXT).toContain("/help");
});

test("HELP_TEXT explains the SDK runner default", () => {
  expect(HELP_TEXT).toMatch(/Claude Agent SDK/i);
  expect(HELP_TEXT).toMatch(/discord_send/i);
});

test("HELP_TEXT fits in a single Discord message", () => {
  // Discord's hard limit is 2000; help uses default formatting
  expect(HELP_TEXT.length).toBeLessThan(2000);
  expect(HELP_TEXT.length).toBeGreaterThan(100);
});

test("EMPTY_PROMPT_TEXT suggests a real action", () => {
  expect(EMPTY_PROMPT_TEXT).toContain("What do you want me to do");
  expect(EMPTY_PROMPT_TEXT).toContain("@bot in <project>");
  expect(EMPTY_PROMPT_TEXT).toContain("/help");
  expect(EMPTY_PROMPT_TEXT.length).toBeLessThan(2000);
});

test("NO_TARGET_TEXT points to /repo and gives an example", () => {
  expect(NO_TARGET_TEXT).toContain("/repo");
  expect(NO_TARGET_TEXT).toContain("claude-bridge"); // example
  expect(NO_TARGET_TEXT).toContain("/help");
  expect(NO_TARGET_TEXT.length).toBeLessThan(2000);
});

test("NO_SESSION_TEXT points user back to the dev channel", () => {
  expect(NO_SESSION_TEXT).toContain("dev channel");
  expect(NO_SESSION_TEXT).toContain("@bot");
  expect(NO_SESSION_TEXT).toContain("/help");
  expect(NO_SESSION_TEXT.length).toBeLessThan(2000);
});

test("isHelpCommand matches /help but not /health or /helps", () => {
  const isHelpCommand = (content: string): boolean => /^\/help\b/i.test(content.trim());
  expect(isHelpCommand("/help")).toBe(true);
  expect(isHelpCommand("/HELP")).toBe(true);
  expect(isHelpCommand("  /help  ")).toBe(true);
  expect(isHelpCommand("/help me fix the parser")).toBe(true);

  // Negative cases — must not match
  expect(isHelpCommand("/health")).toBe(false);
  expect(isHelpCommand("/helpful")).toBe(false);
  expect(isHelpCommand("help")).toBe(false); // no slash
  expect(isHelpCommand("/helpme")).toBe(false); // no word boundary — actually \b matches here
});

// Note: \b in JS regex matches between word and non-word chars. So `/help\b` matches
// at the end of "help" (before space) and between "p" and "m" in "helpme" (since both
// are word chars... wait, no, \b doesn't match between two word chars). Let me verify:
test("isHelpCommand word boundary behavior", () => {
  const isHelpCommand = (content: string): boolean => /^\/help\b/i.test(content.trim());
  // /help followed by non-word char → match
  expect(isHelpCommand("/help me")).toBe(true);
  expect(isHelpCommand("/help.")).toBe(true);
  // /help followed by word char → no match
  expect(isHelpCommand("/helping")).toBe(false);
  expect(isHelpCommand("/helpful")).toBe(false);
});
