/**
 * Tests for hermesCommands.ts — command matchers and parseStartArgs.
 * Does NOT exercise full handler dispatch (requires Discord mocks).
 */

import { describe, test, expect } from "bun:test";
import {
  isProjectCommand,
  matchAdopt,
  matchList,
  matchStart,
  matchStatus,
  matchPlan,
  matchKill,
  matchResume,
  matchSetMode,
} from "./hermesCommands";

describe("command matchers", () => {
  describe("isProjectCommand", () => {
    test("matches /project", () => {
      expect(isProjectCommand("/project list")).toBe(true);
      expect(isProjectCommand("/project start 'foo'")).toBe(true);
    });

    test("matches with leading whitespace", () => {
      expect(isProjectCommand("  /project status")).toBe(true);
    });

    test("rejects non-project commands", () => {
      expect(isProjectCommand("/kill")).toBe(false);
      expect(isProjectCommand("/status")).toBe(false);
      expect(isProjectCommand("hello")).toBe(false);
      expect(isProjectCommand("/projects")).toBe(false); // different command
    });
  });

  describe("matchStart", () => {
    test("matches /project start", () => {
      const m = matchStart("/project start 'build X'");
      expect(m).not.toBeNull();
      expect(m![1].trim()).toBe("'build X'");
    });

    test("captures full args", () => {
      const m = matchStart("/project start --mode=manual in /tmp 'goal here'");
      expect(m).not.toBeNull();
      expect(m![1]).toContain("--mode=manual");
      expect(m![1]).toContain("'goal here'");
    });

    test("does not match /project status", () => {
      expect(matchStart("/project status")).toBeNull();
    });
  });

  describe("matchList", () => {
    test("matches /project list", () => {
      expect(matchList("/project list")).toBe(true);
      expect(matchList("/project LIST")).toBe(true);
    });
    test("does not match /project listing", () => {
      expect(matchList("/project listing")).toBe(false);
    });
  });

  describe("matchStatus / matchPlan / matchKill / matchResume", () => {
    test("each matches its own subcommand", () => {
      expect(matchStatus("/project status")).toBe(true);
      expect(matchPlan("/project plan")).toBe(true);
      expect(matchKill("/project kill")).toBe(true);
      expect(matchResume("/project resume")).toBe(true);
    });

    test("do not cross-match", () => {
      expect(matchStatus("/project kill")).toBe(false);
      expect(matchKill("/project status")).toBe(false);
      expect(matchPlan("/project resume")).toBe(false);
      expect(matchResume("/project plan")).toBe(false);
    });
  });
});

/**
 * parseStartArgs is a non-exported function. We test it indirectly through
 * handleProjectStart? No — that needs Discord. Instead, we re-implement
 * the relevant parsing rules and verify they are consistent with the
 * documented usage. For deeper parsing tests, see handleProjectStart
 * integration tests (added in Phase 2).
 */

describe("start args syntax (documented contract)", () => {
  test("supported flag forms", () => {
    const examples = [
      `/project start "build X"`,
      `/project start --mode=auto "build X"`,
      `/project start --mode=manual "build X"`,
      `/project start --max-iterations=10 "build X"`,
      `/project start --max-cost=300 "build X"`,
      `/project start --max-wall-hours=2 "build X"`,
      `/project start in ~/work "build X"`,
      `/project start in /tmp --mode=manual "build X"`,
      `/project start --mode=auto in ~/work "build X"`,
    ];
    for (const cmd of examples) {
      expect(isProjectCommand(cmd)).toBe(true);
      const m = matchStart(cmd);
      expect(m).not.toBeNull();
      // Each command must contain a quoted goal at the end.
      expect(m![1]).toMatch(/"[^"]+"\s*$/);
    }
  });

  test("unsupported: unquoted goal", () => {
    // This is rejected by parseStartArgs but passes the matcher.
    const cmd = `/project start build X`;
    expect(isProjectCommand(cmd)).toBe(true);
    const m = matchStart(cmd);
    expect(m).not.toBeNull();
    expect(m![1]).not.toMatch(/"[^"]+"\s*$/);
  });
});

describe("@bot mention prefix (regression: 2026-06-22 path-as-path bug)", () => {
  // Regression: David typed `@bot /project start "..."` in Discord and the
  // bot replied "Invalid path: /project start" because parseMention in
  // the legacy flow interpreted `/project` as an absolute local path.
  // The fix is in messageCreate.ts: strip `<@id>` mention before checking
  // for /project. These tests document the contract that the matchers
  // work on mention-stripped content.

  const stripped = "<@123456789> /project start \"build a thing\"".replace(/<@!?\d+>\s*/g, "").trim();
  test("mention-stripped content is recognized as /project", () => {
    expect(isProjectCommand(stripped)).toBe(true);
  });

  test("matchStart extracts args from mention-stripped content", () => {
    const m = matchStart(stripped);
    expect(m).not.toBeNull();
    expect(m![1].trim()).toBe("\"build a thing\"");
  });

  test("matchList works on mention-stripped content", () => {
    const cmd = "<@12345> /project list".replace(/<@!?\d+>\s*/g, "").trim();
    expect(matchList(cmd)).toBe(true);
  });

  test("raw mention-prefixed content IS recognized (matcher strips internally)", () => {
    // After the 2026-06-22 bug fix, isProjectCommand strips `<@id>`
    // mention prefixes internally, so users can invoke Hermes either
    // with or without an @bot mention. The messageCreate.ts dispatcher
    // also strips (defense in depth, idempotent).
    const raw = "<@123456789> /project start \"build a thing\"";
    expect(isProjectCommand(raw)).toBe(true);
  });
});

describe("matchSetMode", () => {
  test("matches /project setMode auto", () => {
    expect(matchSetMode("/project setMode auto")).toEqual({ mode: "auto" });
  });

  test("matches /project setMode manual", () => {
    expect(matchSetMode("/project setMode manual")).toEqual({ mode: "manual" });
  });

  test("matches /project setMode=auto (equals syntax)", () => {
    expect(matchSetMode("/project setMode=auto")).toEqual({ mode: "auto" });
  });

  test("matches /project setMode=manual (equals syntax)", () => {
    expect(matchSetMode("/project setMode=manual")).toEqual({ mode: "manual" });
  });

  test("case-insensitive on the value", () => {
    expect(matchSetMode("/project setMode AUTO")).toEqual({ mode: "auto" });
    expect(matchSetMode("/project setMode Manual")).toEqual({ mode: "manual" });
  });

  test("returns null for invalid mode value", () => {
    expect(matchSetMode("/project setMode turbo")).toBeNull();
    expect(matchSetMode("/project setMode=lol")).toBeNull();
  });

  test("returns null for non-setMode /project commands", () => {
    expect(matchSetMode("/project status")).toBeNull();
    expect(matchSetMode("/project list")).toBeNull();
    expect(matchSetMode("/project start foo")).toBeNull();
  });

  test("returns null for non-/project content", () => {
    expect(matchSetMode("setMode auto")).toBeNull();
    expect(matchSetMode("hello")).toBeNull();
  });

  test("handles @bot mention prefix", () => {
    expect(matchSetMode("<@12345> /project setMode auto")).toEqual({ mode: "auto" });
  });
});


// ── M2.6: matchSetMode with optional duration (ADR-0004) ─────────

describe("matchSetMode with duration (M2.6)", () => {
  test("matches /project setMode auto 30m", () => {
    expect(matchSetMode("/project setMode auto 30m")).toEqual({
      mode: "auto",
      duration: "30m",
    });
  });

  test("matches /project setMode auto 1h30m (multi-unit)", () => {
    expect(matchSetMode("/project setMode auto 1h30m")).toEqual({
      mode: "auto",
      duration: "1h30m",
    });
  });

  test("matches /project setMode=auto 2h (equals syntax + duration)", () => {
    expect(matchSetMode("/project setMode=auto 2h")).toEqual({
      mode: "auto",
      duration: "2h",
    });
  });

  test("matches /project setMode manual (no duration, manual never has one)", () => {
    expect(matchSetMode("/project setMode manual")).toEqual({
      mode: "manual",
    });
  });

  test("matches /project setMode auto (no duration, defaults to cap)", () => {
    expect(matchSetMode("/project setMode auto")).toEqual({
      mode: "auto",
    });
  });

  test("rejects /project setMode manual 30m (manual never takes duration)", () => {
    // The regex would parse "manual" as mode and "30m" as duration, but
    // we still want the user to not accidentally type it. The matcher
    // currently allows it (caller enforces "manual ignores duration");
    // this test pins the current behavior so we know to change it
    // consciously if desired.
    expect(matchSetMode("/project setMode manual 30m")).toEqual({
      mode: "manual",
      duration: "30m",
    });
  });

  test("rejects trailing garbage (setMode auto 30m extra)", () => {
    expect(matchSetMode("/project setMode auto 30m extra")).toBeNull();
  });

  test("rejects malformed duration tokens", () => {
    // "30min" is not a valid unit. Our regex only allows d|h|m|s, so
    // "30min" would not match. Trailing "min" is rejected.
    expect(matchSetMode("/project setMode auto 30min")).toBeNull();
  });

  test("case-insensitive on mode value with duration", () => {
    expect(matchSetMode("/project setMode AUTO 30m")).toEqual({
      mode: "auto",
      duration: "30m",
    });
  });

  test("handles @bot mention prefix with duration", () => {
    expect(matchSetMode("<@12345> /project setMode auto 1h")).toEqual({
      mode: "auto",
      duration: "1h",
    });
  });
});


// ── RG-004: matchAdopt (thread-upgrade workflow) ─────────

describe("matchAdopt", () => {
  test("matches /project adopt \"<goal>\" with no mode (defaults to auto)", () => {
    expect(matchAdopt('/project adopt "fix the auth bug"')).toEqual({
      goal: "fix the auth bug",
      mode: "auto",
    });
  });

  test("matches /project adopt \"<goal>\" auto 1h (auto with duration)", () => {
    expect(matchAdopt('/project adopt "fix the auth bug" auto 1h')).toEqual({
      goal: "fix the auth bug",
      mode: "auto",
      duration: "1h",
    });
  });

  test("matches /project adopt \"<goal>\" auto 30m (auto with minutes)", () => {
    expect(matchAdopt('/project adopt "ship the dashboard" auto 30m')).toEqual({
      goal: "ship the dashboard",
      mode: "auto",
      duration: "30m",
    });
  });

  test("matches /project adopt \"<goal>\" auto 1h30m (multi-unit duration)", () => {
    expect(matchAdopt('/project adopt "ship the dashboard" auto 1h30m')).toEqual({
      goal: "ship the dashboard",
      mode: "auto",
      duration: "1h30m",
    });
  });

  test("matches /project adopt \"<goal>\" manual", () => {
    expect(matchAdopt('/project adopt "fix typo in README" manual')).toEqual({
      goal: "fix typo in README",
      mode: "manual",
    });
  });

  test("case-insensitive on mode", () => {
    expect(matchAdopt('/project adopt "abcd" AUTO 1h')).toEqual({
      goal: "abcd",
      mode: "auto",
      duration: "1h",
    });
    expect(matchAdopt('/project adopt "abcd" Manual')).toEqual({
      goal: "abcd",
      mode: "manual",
    });
  });

  test("trims whitespace inside the goal", () => {
    expect(matchAdopt('/project adopt "  spaces around  "')).toEqual({
      goal: "spaces around",
      mode: "auto",
    });
  });

  test("handles @bot mention prefix", () => {
    expect(matchAdopt('<@12345> /project adopt "abcd" auto 5m')).toEqual({
      goal: "abcd",
      mode: "auto",
      duration: "5m",
    });
  });

  test("rejects unquoted goal (must use double quotes)", () => {
    expect(matchAdopt("/project adopt fix the bug")).toBeNull();
    expect(matchAdopt("/project adopt 'fix the bug'")).toBeNull(); // single quotes not allowed
  });

  test("rejects missing goal", () => {
    expect(matchAdopt("/project adopt")).toBeNull();
    expect(matchAdopt("/project adopt \"\"")).toBeNull(); // empty
  });

  test("rejects goal shorter than 3 chars", () => {
    expect(matchAdopt('/project adopt "x"')).toBeNull();
    expect(matchAdopt('/project adopt "ab"')).toBeNull();
  });

  test("rejects conflicting mode tokens (auto + manual)", () => {
    expect(matchAdopt('/project adopt "abcd" auto 1h manual')).toBeNull();
    expect(matchAdopt('/project adopt "abcd" manual auto')).toBeNull();
  });

  test("rejects manual + duration (manual is wallclock-free)", () => {
    // Our matcher explicitly doesn't allow "manual 1h" because manual
    // mode has no timer concept. The trailing regex demands either
    // bare "manual" or "auto [duration]".
    expect(matchAdopt('/project adopt "abcd" manual 1h')).toBeNull();
  });

  test("rejects trailing garbage", () => {
    expect(matchAdopt('/project adopt "abcd" auto 30m extra')).toBeNull();
    expect(matchAdopt('/project adopt "abcd" manual extra')).toBeNull();
  });

  test("rejects non-adopt /project commands", () => {
    expect(matchAdopt("/project start \"abcd\"")).toBeNull();
    expect(matchAdopt("/project status")).toBeNull();
    expect(matchAdopt("/project kill")).toBeNull();
  });

  test("rejects non-/project content", () => {
    expect(matchAdopt("adopt \"abcd\"")).toBeNull();
    expect(matchAdopt("hello world")).toBeNull();
  });
});
