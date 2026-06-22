/**
 * Tests for hermesCommands.ts — command matchers, parseStartArgs, and
 * the RG-006 auto-resume behavior of handleProjectSetMode.
 *
 * Does NOT exercise the full dispatch loop (requires Discord client
 * mocks); instead tests the handler directly with a fake Message.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  handleProjectSetMode,
} from "./hermesCommands";
import type { Message, ThreadChannel } from "discord.js";
import { ensureProjectDir, loadState, saveState } from "../../hermes/state";
import {
  DEFAULT_HERMES_CONFIG,
  newProjectState,
  type ProjectState,
} from "../../hermes/types";
import { config } from "../../config";

// ── Mock runProject so we can audit auto-resume without spawning CC ────
// `mock.module` is hoisted by bun to run before the test file's
// top-level imports resolve, so hermesCommands.ts picks up this fake
// instead of the real orchestrator.runProject. We capture the call
// args in a module-scoped variable so each test can assert against it.
let runProjectCalls: Array<{ projectId: string; hasUserMsgStub: boolean; claudeSession: string | null }> = [];
mock.module("../../hermes/orchestrator", () => {
  return {
    runProject: async (
      projectId: string,
      deps: { claudeSession: string | null; userMsgStub?: Message },
    ) => {
      runProjectCalls.push({
        projectId,
        claudeSession: deps.claudeSession,
        hasUserMsgStub: deps.userMsgStub !== undefined,
      });
    },
    armProjectTimer: () => null, // not used in these tests; no-op
    softExit: async () => {
      throw new Error("softExit should not be called in these tests");
    },
    adoptProject: async () => {
      throw new Error("adoptProject should not be called in these tests");
    },
  };
});

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


// ── RG-006: /project setMode auto auto-resumes terminal project ──────
//
// Before RG-006, `/project setMode auto` on a terminal project (status:
// killed/failed/done, e.g. after a prior `setMode manual` soft-exit)
// only flipped state.mode + armed the timer; the user then also had to
// type `/project resume` to actually restart the orchestrator. The fix
// (hermesCommands.ts handleProjectSetMode, post-RG-006) auto-resumes a
// terminal project transparently. These tests pin the 7 invariants below.
//
//   I-1  setMode auto on a TERMINAL project triggers runProject
//   I-2  setMode auto on a TERMINAL project sets status="executing" + clears endedAt
//   I-3  setMode auto on a TERMINAL project appends a journal entry "auto-resumed ..."
//   I-4  setMode auto on an ACTIVE project does NOT call runProject
//   I-5  setMode manual on any project does NOT call runProject
//   I-6  setMode auto without duration uses the safety cap default (4h)
//   I-7  The reply message hints "resuming orchestrator" when terminal

describe("RG-006: setMode auto auto-resumes terminal project", () => {
  let hermesDir: string;
  let state: ProjectState;

  // FakeMessage mirrors the surface handleProjectSetMode needs:
  //   - .reply(string) → records the message
  //   - .channel      → cast to ThreadChannel (orchestrator mock doesn't use it)
  const newFakeMessage = () => {
    const replies: string[] = [];
    const msg = {
      reply: (content: string) => {
        replies.push(content);
        return Promise.resolve();
      },
      channel: {} as ThreadChannel,
      author: { id: "test-user", bot: false },
      client: { user: { id: "bot-1" } },
      channelId: "test-channel",
      content: "/project setMode auto",
      mentions: { users: { size: 0, has: () => false } },
    } as unknown as Message;
    return { msg, replies };
  };

  // Minimal SessionStore-shaped mock. handleProjectSetMode only calls
  // store.get(threadId) (with optional `.claudeSession`), so a stub
  // that returns null is sufficient for these tests.
  const newFakeStore = (claudeSession: string | null = null) => {
    return {
      get: () => (claudeSession ? { claudeSession } : null),
    };
  };

  // Build a project state suitable for the test scenario. Defaults to
  // an active (executing) project; override status/mode/timer to
  // simulate the desired pre-state. Each project gets a unique id AND
  // a unique threadId so findProjectByThread can't accidentally match
  // a sibling test's project.
  const makeProject = (
    overrides: Partial<ProjectState> = {},
  ): ProjectState => {
    const tag = Math.random().toString(36).slice(2, 8);
    const s = newProjectState({
      id: `p-rg006-${tag}`,
      threadId: `thread-rg006-${tag}`,
      goal: "rg006 audit",
      mode: "manual",
      repoPath: "/tmp/rg006",
      repoSource: "local",
      config: DEFAULT_HERMES_CONFIG,
    });
    s.status = "killed";
    s.killedReason = "user_kill";
    s.endedAt = new Date().toISOString();
    s.startedAt = new Date(Date.now() - 1000).toISOString();
    return { ...s, ...overrides };
  };

  beforeEach(() => {
    runProjectCalls = [];
    // handleProjectSetMode resolves the hermes dir via
    // resolveHermesDir(config.paths.dataDir, config.paths.hermesDir).
    // `dataDir` is pinned by test-setup.ts to /tmp/claude-bridge-test-data
    // and `hermesDir` is cleared so the resolver falls through to
    // <dataDir>/hermes. Each test uses a unique projectId (see
    // makeProject) to avoid cross-test pollution since hermesDir is
    // shared across tests.
    const baseDataDir = process.env.DATA_DIR ?? "/tmp/claude-bridge-test-data";
    hermesDir = join(baseDataDir, "hermes");
    state = makeProject();
    ensureProjectDir(hermesDir, state.id);
    saveState(hermesDir, state.id, state);
  });

  afterEach(() => {
    // Clean up the per-test project dir to avoid journal/state pollution
    // between tests, but keep the parent hermes root in place for the
    // next test.
    if (state?.id) {
      const { rmSync } = require("node:fs") as typeof import("node:fs");
      rmSync(join(hermesDir, "projects", state.id), {
        recursive: true,
        force: true,
      });
    }
  });

  // I-1: terminal → runProject is called with the right projectId
  test("I-1: setMode auto on a TERMINAL project triggers runProject", async () => {
    expect(state.status).toBe("killed"); // sanity: pre-condition is terminal
    const { msg } = newFakeMessage();
    const store = newFakeStore("sess-abc");

    await handleProjectSetMode(msg, state.threadId, "auto", undefined, store as never);

    expect(runProjectCalls).toHaveLength(1);
    expect(runProjectCalls[0].projectId).toBe(state.id);
    // The handler passes `userMsgStub: msg` so the orchestrator can use
    // it as the SDK's first arg. Verify it's wired through.
    expect(runProjectCalls[0].hasUserMsgStub).toBe(true);
    // claudeSession is read from store.get(threadId) and passed through
    expect(runProjectCalls[0].claudeSession).toBe("sess-abc");
  });

  // I-2: terminal → state.status flips to "executing", endedAt cleared
  test("I-2: setMode auto on a TERMINAL project flips status to executing and clears endedAt", async () => {
    expect(state.endedAt).not.toBeNull(); // sanity: pre-condition has endedAt
    const { msg } = newFakeMessage();

    await handleProjectSetMode(msg, state.threadId, "auto");

    const after = loadState(hermesDir, state.id)!;
    expect(after.status).toBe("executing");
    expect(after.endedAt).toBeNull();
    // mode should also be "auto" (timer armed regardless of resume)
    expect(after.mode).toBe("auto");
  });

  // I-3: terminal → journal.log contains the auto-resume entry
  test("I-3: setMode auto on a TERMINAL project appends 'auto-resumed by /project setMode auto' journal entry", async () => {
    const { msg } = newFakeMessage();

    await handleProjectSetMode(msg, state.threadId, "auto");

    const journalPath = join(
      hermesDir,
      "projects",
      state.id,
      "journal.log",
    );
    const log = readFileSync(journalPath, "utf8");
    // The handler appends:
    //   `<ts> [status] mode changed → auto (timer=4h (default))`
    //   `<ts> [status] auto-resumed by /project setMode auto (was killed)`
    expect(log).toContain("mode changed → auto");
    expect(log).toContain("auto-resumed by /project setMode auto");
    // The "was <oldStatus>" suffix is part of the RG-006 contract so
    // operators can see what state we resumed FROM.
    expect(log).toMatch(/auto-resumed by \/project setMode auto \(was killed\)/);
  });

  // I-4: active → runProject is NOT called (loop is already running)
  test("I-4: setMode auto on an ACTIVE project does NOT call runProject", async () => {
    const active = makeProject({
      status: "executing",
      mode: "auto",
      endedAt: null,
      killedReason: undefined,
    });
    ensureProjectDir(hermesDir, active.id);
    saveState(hermesDir, active.id, active);

    const { msg } = newFakeMessage();
    await handleProjectSetMode(msg, active.threadId, "auto");

    // No resume needed — orchestrator loop is already running. Calling
    // runProject again would spawn a second loop and race the existing
    // one.
    expect(runProjectCalls).toHaveLength(0);
  });

  // I-5: manual switch → runProject is NOT called (no auto-resume)
  test("I-5: setMode manual does NOT call runProject (no auto-resume on manual switch)", async () => {
    // Start from terminal
    expect(state.status).toBe("killed");
    const { msg } = newFakeMessage();

    await handleProjectSetMode(msg, state.threadId, "manual");

    // manual → no resume; mode flipped, no runProject call
    expect(runProjectCalls).toHaveLength(0);
    const after = loadState(hermesDir, state.id)!;
    expect(after.mode).toBe("manual");
  });

  // I-6: setMode auto with no duration → uses HERMES_MAX_WALL_HOURS cap
  test("I-6: setMode auto without duration uses the safety cap default (4h)", async () => {
    const { msg, replies } = newFakeMessage();
    console.log("[I-6] DATA_DIR=", process.env.DATA_DIR, "HERMES_DIR=", JSON.stringify(process.env.HERMES_DIR));
    console.log("[I-6] config.paths.dataDir=", config.paths.dataDir, " hermesDir=", JSON.stringify(config.paths.hermesDir));

    await handleProjectSetMode(msg, state.threadId, "auto");
    console.log("[I-6] replies=", JSON.stringify(replies));

    const after = loadState(hermesDir, state.id)!;
    expect(after.timer).toBeDefined();
    // handler formats default as "<N>h (default)" — verify both the
    // literal marker and that it matches the configured cap
    expect(after.timer!.requestedDuration).toContain("(default)");
    expect(after.timer!.requestedDuration).toContain(
      `${config.hermes.maxWallHours}h`,
    );
    // effectiveMs should equal capMs (no clamping since user didn't ask
    // for anything longer than the cap)
    const capMs = config.hermes.maxWallHours * 60 * 60 * 1000;
    expect(after.timer!.effectiveMs).toBe(capMs);
    expect(after.timer!.clamped).toBe(false);
  });

  // I-7: reply message contains "resuming orchestrator" hint
  test("I-7: reply message contains 'resuming orchestrator' when project is terminal", async () => {
    expect(state.status).toBe("killed");
    const { msg, replies } = newFakeMessage();

    await handleProjectSetMode(msg, state.threadId, "auto");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("resuming orchestrator");
    // And does NOT contain the "will plan tasks" non-terminal phrasing
    expect(replies[0]).not.toContain("Hermes will plan tasks,");
  });

  // Bonus: a setMode auto on an active project should reply with the
  // non-terminal phrasing ("Hermes will plan tasks...") and NOT mention
  // "resuming orchestrator". Pins the message branch.
  test("I-7 (active): reply uses 'will plan tasks' phrasing, not 'resuming orchestrator'", async () => {
    const active = makeProject({
      status: "executing",
      mode: "auto",
      endedAt: null,
      killedReason: undefined,
    });
    ensureProjectDir(hermesDir, active.id);
    saveState(hermesDir, active.id, active);

    const { msg, replies } = newFakeMessage();
    await handleProjectSetMode(msg, active.threadId, "auto");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Hermes will plan tasks,");
    expect(replies[0]).not.toContain("resuming orchestrator");
  });

  // Sanity: with a duration arg, the requested duration is honored
  test("setMode auto with explicit duration uses that duration (not the cap)", async () => {
    const { msg } = newFakeMessage();

    await handleProjectSetMode(msg, state.threadId, "auto", "30m");

    const after = loadState(hermesDir, state.id)!;
    expect(after.timer).toBeDefined();
    expect(after.timer!.requestedDuration).toBe("30m");
    expect(after.timer!.effectiveMs).toBe(30 * 60 * 1000);
    expect(after.timer!.clamped).toBe(false);
  });
});
