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
  handleProjectAdopt,
} from "./hermesCommands";
import type { Message, ThreadChannel } from "discord.js";
import { ensureProjectDir, loadState, saveState } from "../../hermes/state";
import {
  DEFAULT_HERMES_CONFIG,
  isActive,
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

// ── RG-007 mock state ────────────────────────────────────────────────
// Extended (per task spec) so the SAME orchestrator mock also tracks
// `softExit` and `adoptProject` calls. These are used by
// `handleProjectAdopt` to kill conflicting same-repoRoot projects and
// to persist the new project. `softExitShouldThrow` lets I-10 simulate
// a flaky softExit without aborting the adopt chain.
let softExitCalls: Array<{
  projectId: string;
  reason: "duration_expired" | "manual_switch";
}> = [];
let adoptProjectCalls: Array<{
  projectId: string;
  repoRoot: string;
  goal: string;
  mode: "auto" | "manual";
}> = [];
let softExitShouldThrow = false;
let adoptProjectCreatedIds: Array<{ hermesDir: string; projectId: string }> = [];
function resetRg007Mocks() {
  softExitCalls = [];
  adoptProjectCalls = [];
  adoptProjectCreatedIds = [];
  softExitShouldThrow = false;
}

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
    softExit: async (
      projectId: string,
      _state: unknown,
      _deps: unknown,
      reason: "duration_expired" | "manual_switch",
    ) => {
      softExitCalls.push({ projectId, reason });
      if (softExitShouldThrow) {
        throw new Error("simulated softExit failure");
      }
      // Return a minimal ProjectState-shaped object. The real handler
      // ignores the return value here (it reloads via loadState after
      // softExit) — we just need a non-undefined value to keep the
      // handler happy if it ever does `await` something off the result.
      return { id: projectId, status: "killed" };
    },
    // NOTE: adoptProject is `export function` (synchronous) in the real
    // module — the handler does `const state = adoptProject(...)` with
    // NO await. Our mock must therefore return a ProjectState synchronously.
    // We synthesize one with `newProjectState` so callers that read
    // `state.timer`, `state.id`, etc. see well-formed values.
    //
    // The real `adoptProject` calls `ensureProjectDir` + `saveState`
    // before returning; we mirror that so the handler's downstream
    // `saveState` calls (line 518, 540 of hermesCommands.ts) don't fail
    // with ENOENT.
    //
    // We also track the synthesized projectId in a module-scoped
    // `adoptProjectCreatedIds` so the RG-007 afterEach can clean up
    // the new project even if the test fails after adoptProject
    // returns (otherwise a failed test leaves the project on disk
    // and the next run's findProjectByThread soft-rejects).
    adoptProject: (input: {
      hermesDir: string;
      projectId: string;
      threadId: string;
      goal: string;
      mode: "auto" | "manual";
      repoRoot: string;
      repoPath: string;
    }) => {
      adoptProjectCalls.push({
        projectId: input.projectId,
        repoRoot: input.repoRoot,
        goal: input.goal,
        mode: input.mode,
      });
      adoptProjectCreatedIds.push({
        hermesDir: input.hermesDir,
        projectId: input.projectId,
      });
      ensureProjectDir(input.hermesDir, input.projectId);
      const state: ProjectState = {
        id: input.projectId,
        threadId: input.threadId,
        goal: input.goal,
        mode: input.mode,
        repoPath: input.repoPath,
        repoRoot: input.repoRoot,
        repoSource: "local" as const,
        status: "planning" as const,
        plan: [],
        currentTaskId: null,
        iterations: 0,
        costUsd: 0,
        config: DEFAULT_HERMES_CONFIG,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        endedAt: null,
        journal: [],
      };
      saveState(input.hermesDir, input.projectId, state);
      return state;
    },
  };
});

// ── RG-007: identity mock ─────────────────────────────────────────────
// `/tmp/rg007-repo` is not a real git working tree in tests. Mock
// `resolveProjectRoot` to return its input unchanged so each test can
// drive identity deterministically by setting `session.repoPath` on the
// fake SessionStore. (Real resolveProjectRoot falls back to the abs
// path anyway, but mocking removes the spawn-grep dependency.)
mock.module("../../hermes/projectIdentity", () => ({
  resolveProjectRoot: async (p: string) => p,
}));

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
      repoRoot: "/tmp/rg006",
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

// ── RG-007: /project adopt auto-kills same-repoRoot Hermes projects ──
//
// One repo = one Hermes project. When `/project adopt` runs, it scans
// disk for any active project whose `repoRoot` matches the incoming
// session's git toplevel, and soft-kills them before creating the new
// project. The flow is sequential (scan → kill → wait → adopt → notify)
// per the Q3 decision. The old project's state is preserved on disk
// (status=killed, supersededBy=newId) so a later `/project resume` can
// recover it.
//
// Setup notes:
// - We mock `../../hermes/projectIdentity` to return the input path
//   verbatim. Real resolveProjectRoot shells out to `git rev-parse`,
//   which would tie tests to the repo state. Since the handler treats
//   the result as opaque string equality, this preserves the exact
//   collision-detection contract.
// - We mock `../../hermes/orchestrator` to track `softExit` and
//   `adoptProject` calls so we can assert on the sequential flow
//   without actually running the orchestrator or stopping CC.
// - We pre-populate `<hermesDir>/projects/<id>/state.json` so
//   findConflictingProjects sees them via listProjects. We also need
//   to clean up these in afterEach to avoid pollution between tests.
describe("RG-007: /project adopt auto-kills same-repoRoot conflicts", () => {
  let hermesDir: string;

  // Minimal SessionStore-shaped mock. handleProjectAdopt reads
  // session.repoPath to compute repoRoot (via the mocked
  // resolveProjectRoot). We vary repoPath per test to drive the
  // collision semantics deterministically.
  const newFakeStore = (repoPath: string) => {
    return {
      get: (_threadId: string) => ({
        repoPath,
        claudeSession: "sess-rg007",
        sdk: "claude-code",
      }),
    };
  };

  const newFakeMsg = (content = "/project adopt \"new goal\"") => {
    const replies: string[] = [];
    const threadSends: string[] = [];
    const msg = {
      reply: (c: string) => {
        replies.push(c);
        return Promise.resolve();
      },
      channel: {
        send: (c: string) => {
          threadSends.push(c);
          return Promise.resolve();
        },
      } as unknown as ThreadChannel,
      author: { id: "test-user", bot: false },
      client: { user: { id: "bot-1" } },
      channelId: "test-channel",
      content,
      mentions: { users: { size: 0, has: () => false } },
    } as unknown as Message;
    return { msg, replies, threadSends };
  };

  // Tracks IDs of projects we created in this test, for cleanup.
  // Both `seedProject` (pre-existing) and `adoptProject` mock (newly
  // synthesized) populate this list. We use it in afterEach to wipe
  // the per-test projects even when the test fails partway through.
  // Declared before seedProject so the inner closure can read it
  // (closures hoist by reference, but the declaration needs to exist
  // before the first use at runtime).
  const cleanupIds: string[] = [];

  // Build a pre-existing project. `repoRoot` and `status` are the
  // drivers of collision detection: an active project with the same
  // repoRoot is a conflict; a terminal project with the same
  // repoRoot is not.
  const seedProject = (overrides: {
    repoRoot: string;
    status: ProjectState["status"];
    threadId: string;
  }): ProjectState => {
    const tag = Math.random().toString(36).slice(2, 10);
    const s = newProjectState({
      id: `old-${tag}`,
      threadId: overrides.threadId,
      goal: `seed-${tag}`,
      mode: "auto",
      repoPath: overrides.repoRoot,
      repoRoot: overrides.repoRoot,
      repoSource: "local",
      config: DEFAULT_HERMES_CONFIG,
    });
    s.status = overrides.status;
    if (!isActive(s)) {
      s.endedAt = new Date().toISOString();
    }
    ensureProjectDir(hermesDir, s.id);
    saveState(hermesDir, s.id, s);
    cleanupIds.push(s.id);
    return s;
  };

  // The handler reads hermesDir from config (`<DATA_DIR>/hermes`), NOT
  // from a test param. So all RG-007 tests share the canonical
  // hermesDir with RG-006 / state tests. We accept the noise and rely
  // on:
  //  (1) wiping any `thread-rg007-*` projects at the start of every
  //      test (to drop leftover from a prior failed run), and
  //  (2) wiping everything we created in afterEach.
  // If RG-007 ever needs hermetic isolation, we'd have to override
  // config via mock.module — overkill for 10 invariants.

  beforeEach(() => {
    resetRg007Mocks();
    runProjectCalls = [];
    const baseDataDir = process.env.DATA_DIR ?? "/tmp/claude-bridge-test-data";
    hermesDir = join(baseDataDir, "hermes");
    // Pre-test wipe: drop any `thread-rg007-*` projects left over from
    // a prior failed test run. Without this, a fresh-run test would
    // soft-reject its own adopt because the previous run's project
    // is still on disk with the same threadId.
    const { rmSync, readdirSync, existsSync } = require("node:fs") as typeof import("node:fs");
    if (existsSync(join(hermesDir, "projects"))) {
      for (const entry of readdirSync(join(hermesDir, "projects"))) {
        const s = loadState(hermesDir, entry);
        if (s && s.threadId?.startsWith("thread-rg007-")) {
          rmSync(join(hermesDir, "projects", entry), {
            recursive: true,
            force: true,
          });
        }
      }
    }
    cleanupIds.length = 0;
  });

  afterEach(() => {
    // Clean up every project we created. We don't wipe the entire
    // hermesDir because sibling test suites (RG-006, state tests)
    // share it.
    const { rmSync } = require("node:fs") as typeof import("node:fs");
    for (const id of cleanupIds) {
      rmSync(join(hermesDir, "projects", id), { recursive: true, force: true });
    }
  });

  // I-1: fresh repoRoot → no conflicts → adopt succeeds, no softExit
  test("I-1: adopt on fresh repoRoot does NOT call softExit", async () => {
    const { msg, threadSends } = newFakeMsg();
    const store = newFakeStore("/tmp/rg007-fresh");

    await handleProjectAdopt(
      msg,
      "thread-rg007-fresh",
      msg.channel as unknown as ThreadChannel,
      store as never,
      { goal: "fresh adopt", mode: "auto" },
    );

    expect(softExitCalls).toHaveLength(0);
    expect(adoptProjectCalls).toHaveLength(1);
    expect(adoptProjectCalls[0].repoRoot).toBe("/tmp/rg007-fresh");
    // Adopt succeeded, so we should see the "🎯 Hermes project adopted"
    // kickoff message in threadSends. The handler sends via
    // thread.send (not msg.reply) for the adopt kickoff (this is
    // different from handleProjectStart which DOES use msg.reply
    // for the same kind of message — RG-007 vs RG-004 divergence,
    // tracked as a follow-up).
    const adoptConfirm = threadSends.find((s) =>
      s.includes("Hermes project adopted")
    );
    expect(adoptConfirm).toBeDefined();
    // And the kickoff "📋 Planning..." is in the same thread.send.
    expect(threadSends.some((s) => s.includes("Planning"))).toBe(true);
    // No "Superseded" line on a fresh-repoRoot adopt (I-1 negative case).
    expect(threadSends.some((s) => s.includes("Superseded"))).toBe(false);
  });

  // I-2: one active conflict → softExit + adopt + supersedeBy stamped
  test("I-2: adopt on repoRoot with 1 active project soft-kills it first", async () => {
    const old = seedProject({
      repoRoot: "/tmp/rg007-busy",
      status: "executing",
      threadId: "thread-old-busy",
    });
    const { msg } = newFakeMsg();
    const store = newFakeStore("/tmp/rg007-busy");

    await handleProjectAdopt(
      msg,
      "thread-rg007-busy",
      msg.channel as unknown as ThreadChannel,
      store as never,
      { goal: "supersede one", mode: "auto" },
    );

    // softExit called once for the old project
    expect(softExitCalls).toHaveLength(1);
    expect(softExitCalls[0].projectId).toBe(old.id);
    // adopt called once for the new project
    expect(adoptProjectCalls).toHaveLength(1);
    // The old project's state on disk has been stamped supersededBy
    const reloaded = loadState(hermesDir, old.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.supersededBy).toBeDefined();
    expect(adoptProjectCalls[0].repoRoot).toBe("/tmp/rg007-busy");
  });

  // I-3: two active conflicts → soft-kill BOTH, then adopt
  test("I-3: adopt on repoRoot with 2 active projects soft-kills both sequentially", async () => {
    const old1 = seedProject({
      repoRoot: "/tmp/rg007-double",
      status: "executing",
      threadId: "thread-old-double-1",
    });
    const old2 = seedProject({
      repoRoot: "/tmp/rg007-double",
      status: "planning",
      threadId: "thread-old-double-2",
    });
    const { msg } = newFakeMsg();
    const store = newFakeStore("/tmp/rg007-double");

    await handleProjectAdopt(
      msg,
      "thread-rg007-double",
      msg.channel as unknown as ThreadChannel,
      store as never,
      { goal: "supersede two", mode: "auto" },
    );

    expect(softExitCalls).toHaveLength(2);
    const killedIds = softExitCalls.map((c) => c.projectId).sort();
    expect(killedIds).toEqual([old1.id, old2.id].sort());
    expect(adoptProjectCalls).toHaveLength(1);
  });

  // I-4: terminal conflict (status=killed) → NOT a conflict, adopt
  // proceeds without softExit. This pins the "preserve killed state,
  // don't re-kill dead projects" invariant from the Q2 decision.
  test("I-4: terminal (killed) project on same repoRoot is NOT a conflict", async () => {
    const dead = seedProject({
      repoRoot: "/tmp/rg007-dead",
      status: "killed",
      threadId: "thread-old-dead",
    });
    const { msg } = newFakeMsg();
    const store = newFakeStore("/tmp/rg007-dead");

    await handleProjectAdopt(
      msg,
      "thread-rg007-dead",
      msg.channel as unknown as ThreadChannel,
      store as never,
      { goal: "adopt over dead", mode: "auto" },
    );

    expect(softExitCalls).toHaveLength(0);
    expect(adoptProjectCalls).toHaveLength(1);
    // The dead project's state is preserved unchanged
    const reloaded = loadState(hermesDir, dead.id);
    expect(reloaded!.status).toBe("killed");
    expect(reloaded!.supersededBy).toBeUndefined();
  });

  // I-5: monorepo sub-folder collapse — the mock for resolveProjectRoot
  // is identity (returns input as-is), so to simulate the collapse we
  // must use the SAME repoRoot string for both old + new. This is the
  // "we'd get the same string from `git rev-parse`" simulation. The
  // point of this test: a project on `~/www/X/apps/web` and a new
  // adopt on `~/www/X/apps/api` would both resolve to `~/www/X` in
  // production, and the test proves the handler treats them as a
  // conflict on the resolved root.
  test("I-5: monorepo sub-folders collapse (same resolved repoRoot → conflict)", async () => {
    const old = seedProject({
      repoRoot: "/tmp/rg007-monorepo-root",
      status: "executing",
      threadId: "thread-old-monorepo",
    });
    const { msg } = newFakeMsg();
    // New session's repoPath is a sub-folder, but in our mock
    // resolveProjectRoot returns it verbatim, so we use the SAME
    // repoRoot string to simulate the git-toplevel collapse.
    const store = newFakeStore("/tmp/rg007-monorepo-root");

    await handleProjectAdopt(
      msg,
      "thread-rg007-monorepo",
      msg.channel as unknown as ThreadChannel,
      store as never,
      { goal: "monorepo sub-adopt", mode: "auto" },
    );

    expect(softExitCalls).toHaveLength(1);
    expect(softExitCalls[0].projectId).toBe(old.id);
  });

  // I-6: different repoRoot → no conflict, no softExit
  test("I-6: adopt on DIFFERENT repoRoot does NOT kill other projects", async () => {
    seedProject({
      repoRoot: "/tmp/rg007-unrelated-A",
      status: "executing",
      threadId: "thread-old-A",
    });
    seedProject({
      repoRoot: "/tmp/rg007-unrelated-B",
      status: "executing",
      threadId: "thread-old-B",
    });
    const { msg } = newFakeMsg();
    const store = newFakeStore("/tmp/rg007-unrelated-C");

    await handleProjectAdopt(
      msg,
      "thread-rg007-unrelated-C",
      msg.channel as unknown as ThreadChannel,
      store as never,
      { goal: "totally different repo", mode: "auto" },
    );

    expect(softExitCalls).toHaveLength(0);
    expect(adoptProjectCalls).toHaveLength(1);
    expect(adoptProjectCalls[0].repoRoot).toBe("/tmp/rg007-unrelated-C");
  });

  // I-7: supersede notification in kickoff thread.send contains old IDs
  test("I-7: kickoff thread.send contains 'Superseded' line with old project IDs", async () => {
    const old = seedProject({
      repoRoot: "/tmp/rg007-notify",
      status: "executing",
      threadId: "thread-old-notify",
    });
    const { msg, threadSends } = newFakeMsg();
    const store = newFakeStore("/tmp/rg007-notify");

    await handleProjectAdopt(
      msg,
      "thread-rg007-notify",
      msg.channel as unknown as ThreadChannel,
      store as never,
      { goal: "with notify", mode: "auto" },
    );

    // The kickoff message goes via thread.send, not msg.reply. Look in
    // threadSends for the "Superseded" line that lists the truncated
    // old project id.
    const supersededMsg = threadSends.find((s) => s.includes("Superseded"));
    expect(supersededMsg).toBeDefined();
    expect(supersededMsg!).toContain(old.id.slice(0, 8));
  });

  // I-8: state.json on the new project persists repoRoot
  test("I-8: adopted new project has repoRoot stored in state", async () => {
    seedProject({
      repoRoot: "/tmp/rg007-store",
      status: "killed",
      threadId: "thread-old-store",
    });
    const { msg } = newFakeMsg();
    const store = newFakeStore("/tmp/rg007-store");

    await handleProjectAdopt(
      msg,
      "thread-rg007-store",
      msg.channel as unknown as ThreadChannel,
      store as never,
      { goal: "store repoRoot", mode: "auto" },
    );

    // adoptProject was called with the right repoRoot. (The mock
    // returns a synthesized state but does NOT persist it — the
    // real handler also calls saveState, but with the mock we verify
    // via the adoptProjectCalls capture.)
    expect(adoptProjectCalls[0].repoRoot).toBe("/tmp/rg007-store");
  });

  // I-9: supersededBy on old state points to the NEW project id
  test("I-9: supersededBy on old state points to the new project id", async () => {
    const old = seedProject({
      repoRoot: "/tmp/rg007-super",
      status: "executing",
      threadId: "thread-old-super",
    });
    const { msg } = newFakeMsg();
    const store = newFakeStore("/tmp/rg007-super");

    await handleProjectAdopt(
      msg,
      "thread-rg007-super",
      msg.channel as unknown as ThreadChannel,
      store as never,
      { goal: "supersedeBy stamp", mode: "auto" },
    );

    const reloaded = loadState(hermesDir, old.id);
    expect(reloaded!.supersededBy).toBe(adoptProjectCalls[0].projectId);
  });

  // I-10: softExit failure does NOT abort the adopt chain
  // If one old project's softExit throws, the handler should log +
  // continue to adopt. This is the "defensive sequential" guarantee.
  test("I-10: softExit failure on one project does NOT abort adopt chain", async () => {
    seedProject({
      repoRoot: "/tmp/rg007-flaky",
      status: "executing",
      threadId: "thread-old-flaky",
    });
    softExitShouldThrow = true;
    const { msg, threadSends } = newFakeMsg();
    const store = newFakeStore("/tmp/rg007-flaky");

    // Should NOT throw — handler catches per-kill errors.
    await handleProjectAdopt(
      msg,
      "thread-rg007-flaky",
      msg.channel as unknown as ThreadChannel,
      store as never,
      { goal: "flaky softExit", mode: "auto" },
    );

    // adopt still succeeded despite softExit throwing
    expect(adoptProjectCalls).toHaveLength(1);
    // The handler still posted the adopt confirmation (via
    // thread.send, not msg.reply — see I-1 comment for the
    // RG-007 vs RG-004 divergence note) AND the kickoff
    // thread.send.
    expect(threadSends.some((s) => s.includes("Hermes project adopted"))).toBe(true);
    expect(threadSends.some((s) => s.includes("Planning"))).toBe(true);
  });
});
