/**
 * RG-009 audit — /project delete + confirmation flow.
 *
 * Background (regression 2026-06-22):
 *   After David ran `/project list` and saw 9 of 10 Hermes projects
 *   in failed/killed status (mostly 0/0 tasks, $0.00 cost, dead
 *   from the now-fixed 5-minute planner timeout), he asked for a
 *   way to delete them. Pre-RG-009, there was no way to clean up
 *   dead projects short of manually `rm -rf` the project directory.
 *
 *   This audit covers:
 *     1. `matchDelete` parsing of `/project delete <id|prefix>` and
 *        `/project delete --all-failed`.
 *     2. `handleProjectDelete` Phase 1 (parse + confirm) — does NOT
 *        delete on its own; only sets up a PendingDelete.
 *     3. `handleDeleteConfirmReply` Phase 2 (yes/no) — executes the
 *        actual deletion, with userId + channelId scoping so a
 *        random "yes" reply from another user cannot trigger.
 *     4. The state.ts helpers: `deleteProject` (path-safe rm -rf)
 *        and `resolveProjectPrefix` (8-char prefix → full UUID).
 *
 * Invariants covered here:
 *   I-1  matchDelete parses the four documented shapes
 *   I-2  matchDelete rejects malformed inputs (no target, multi-token)
 *   I-3  resolveProjectPrefix resolves a unique 8-char prefix
 *   I-4  resolveProjectPrefix returns null on zero matches
 *   I-5  resolveProjectPrefix returns the ambiguous list on multiple matches
 *   I-6  deleteProject refuses path-traversal style inputs
 *   I-7  deleteProject is idempotent (false on already-gone dir)
 *   I-8  handleProjectDelete --all-failed REFUSES active projects
 *        even if the user asked for them
 *   I-9  handleProjectDelete single-id refuses to delete an active
 *        project (must /project kill first)
 *   I-10 handleProjectDelete on a single-id terminal project sets up
 *        a PendingDelete (the actual file is still on disk until
 *        "yes" arrives)
 *   I-11 handleDeleteConfirmReply with "yes" executes the deletion
 *        and the project dir is gone afterwards
 *   I-12 handleDeleteConfirmReply with "no" cancels, project survives
 *   I-13 handleDeleteConfirmReply returns false on unrelated reply
 *        (e.g. "y" / "yeah" / "nope") — fall-through to other handlers
 *   I-14 handleDeleteConfirmReply is scoped: a "yes" from a different
 *        userId does NOT trigger the delete
 *   I-15 handleDeleteConfirmReply is scoped: a "yes" from a different
 *        channelId does NOT trigger the delete
 *
 * Note: This file is intentionally separate from hermesCommands.test.ts
 * because the latter uses `mock.module("../../hermes/orchestrator")` to
 * stub out runProject for the RG-006/RG-007 audits. The mock is
 * hoisted at file load and would interfere with our handler tests if
 * we tried to use the same file. (See orchestratorRG008.test.ts for
 * the same pattern.)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  matchDelete,
  handleProjectDelete,
  handleDeleteConfirmReply,
} from "./hermesCommands";
import {
  deleteProject,
  ensureProjectDir,
  listProjects,
  resolveProjectPrefix,
  saveState,
} from "../../hermes/state";
import {
  DEFAULT_HERMES_CONFIG,
  newProjectState,
  type ProjectState,
} from "../../hermes/types";
import type { Message } from "discord.js";

// ── Test fakes ──────────────────────────────────────────────────────────

interface FakeMsg {
  content: string;
  author: { id: string; bot: boolean };
  channelId: string;
  channel: { isThread: () => boolean; send: (c: string) => Promise<unknown> };
  client: { user: { id: string } };
  mentions: { users: { size: number; has: () => boolean } };
  reply: (c: string) => Promise<unknown>;
}

interface FakeMsgAndReplies {
  msg: FakeMsg;
  replies: string[];
}

function newFakeMsg(opts: {
  content: string;
  authorId?: string;
  channelId?: string;
  isThread?: boolean;
}): FakeMsgAndReplies {
  const replies: string[] = [];
  const msg: FakeMsg = {
    content: opts.content,
    author: { id: opts.authorId ?? "user-rg009", bot: false },
    channelId: opts.channelId ?? "channel-rg009",
    channel: {
      isThread: () => opts.isThread ?? false,
      send: () => Promise.resolve(),
    },
    client: { user: { id: "bot-1" } },
    mentions: { users: { size: 0, has: () => false } },
    reply: (c: string) => {
      replies.push(c);
      return Promise.resolve();
    },
  };
  return { msg, replies };
}

function seedTerminalProject(
  hermesDir: string,
  id: string,
  status: ProjectState["status"],
  threadId: string,
  goal = "rg009 test",
): ProjectState {
  const s = newProjectState({
    id,
    threadId,
    goal,
    mode: "auto",
    repoPath: `/tmp/rg009/${id}`,
    repoRoot: `/tmp/rg009/${id}`,
    repoSource: "local",
    config: DEFAULT_HERMES_CONFIG,
  });
  s.status = status;
  s.endedAt = new Date().toISOString();
  if (status === "killed") s.killedReason = "user_kill";
  ensureProjectDir(hermesDir, s.id);
  saveState(hermesDir, s.id, s);
  return s;
}

function seedActiveProject(hermesDir: string, id: string): ProjectState {
  const s = newProjectState({
    id,
    threadId: `thread-active-${id}`,
    goal: "rg009 active test",
    mode: "auto",
    repoPath: `/tmp/rg009/${id}`,
    repoRoot: `/tmp/rg009/${id}`,
    repoSource: "local",
    config: DEFAULT_HERMES_CONFIG,
  });
  // status stays "planning" (active).
  ensureProjectDir(hermesDir, s.id);
  saveState(hermesDir, s.id, s);
  return s;
}

// Generates a per-test project id where the 8-char prefix is unique
// across the test file. The `tag` argument MUST be exactly 2
// characters; the 8-char prefix is `rg009-{tag}` (6+2=8 chars),
// which is the same convention production uses (8-char prefix).
// The 9th char onward is a random tail, so two calls with the
// SAME tag still produce different ids (the `id` match is the
// full 38-char string). Tests MUST use distinct 2-char tags
// across their projects to keep prefixes unambiguous — see the
// `rg009Id("I8F")` calls below, each using a different last
// letter.
function rg009Id(tag: string): string {
  if (tag.length !== 2) {
    throw new Error(`rg009Id tag must be exactly 2 chars (got ${JSON.stringify(tag)})`);
  }
  const tail = randomUUID().replace(/-/g, "").slice(0, 32);
  return `rg009-${tag}${tail}`;
}

// ── I-1, I-2: matchDelete parser ───────────────────────────────────────

describe("RG-009 I-1,I-2: matchDelete parsing", () => {
  test("I-1: matches /project delete <id>", () => {
    const r = matchDelete("/project delete 72be82cb");
    expect(r).toEqual({ kind: "id", target: "72be82cb" });
  });
  test("I-1: matches /project delete <full-uuid>", () => {
    const r = matchDelete("/project delete 72be82cb-b067-4f20-b514-5592bc1a455d");
    expect(r).toEqual({ kind: "id", target: "72be82cb-b067-4f20-b514-5592bc1a455d" });
  });
  test("I-1: matches /project delete --all-failed", () => {
    const r = matchDelete("/project delete --all-failed");
    expect(r).toEqual({ kind: "all-failed" });
  });
  test("I-1: case-insensitive on the keyword (target case preserved)", () => {
    // The `/i` flag makes the keyword case-insensitive but the
    // target itself is captured verbatim. UUIDs are conventionally
    // lowercase so we'd never see upper case in production, but
    // we don't want to silently mangle a user-supplied prefix.
    expect(matchDelete("/PROJECT DELETE 72be82cb")).toEqual({
      kind: "id",
      target: "72be82cb",
    });
    expect(matchDelete("/Project Delete --All-Failed")).toEqual({
      kind: "all-failed",
    });
  });
  test("I-2: rejects /project delete with no target", () => {
    expect(matchDelete("/project delete")).toBeNull();
    expect(matchDelete("/project delete ")).toBeNull();
  });
  test("I-2: rejects /project delete with multi-token target", () => {
    expect(matchDelete("/project delete 72be82cb extra")).toBeNull();
  });
  test("I-2: rejects /project (no delete subcommand)", () => {
    expect(matchDelete("/project list")).toBeNull();
    expect(matchDelete("/project status")).toBeNull();
  });
  test("I-2: rejects non-/project commands", () => {
    expect(matchDelete("/delete 72be82cb")).toBeNull();
  });
});

// ── I-3, I-4, I-5: resolveProjectPrefix ─────────────────────────────────

describe("RG-009 I-3,I-4,I-5: resolveProjectPrefix", () => {
  let hermesDir: string;
  beforeEach(() => {
    hermesDir = mkdtempSync(join(tmpdir(), "rg009-prefix-"));
  });
  afterEach(() => {
    rmSync(hermesDir, { recursive: true, force: true });
  });

  test("I-3: unique 8-char prefix resolves to full id", () => {
    const id = "abcdef01-1111-2222-3333-444444444444";
    seedTerminalProject(hermesDir, id, "failed", "thread-1");
    const r = resolveProjectPrefix(hermesDir, "abcdef01");
    expect(r.projectId).toBe(id);
    expect(r.ambiguous).toEqual([]);
  });

  test("I-3: full uuid also resolves", () => {
    const id = "abcdef02-1111-2222-3333-444444444444";
    seedTerminalProject(hermesDir, id, "failed", "thread-2");
    const r = resolveProjectPrefix(hermesDir, id);
    expect(r.projectId).toBe(id);
  });

  test("I-4: zero matches returns null", () => {
    seedTerminalProject(
      hermesDir,
      "abcdef03-1111-2222-3333-444444444444",
      "failed",
      "thread-3",
    );
    const r = resolveProjectPrefix(hermesDir, "ffffffff");
    expect(r.projectId).toBeNull();
    expect(r.ambiguous).toEqual([]);
  });

  test("I-4: empty hermes dir returns null", () => {
    const r = resolveProjectPrefix(hermesDir, "anything");
    expect(r.projectId).toBeNull();
  });

  test("I-5: multiple matches returns ambiguous list", () => {
    seedTerminalProject(
      hermesDir,
      "aabbcc00-1111-2222-3333-444444444444",
      "failed",
      "thread-a",
    );
    seedTerminalProject(
      hermesDir,
      "aabbcc01-1111-2222-3333-444444444444",
      "failed",
      "thread-b",
    );
    const r = resolveProjectPrefix(hermesDir, "aabbcc0");
    expect(r.projectId).toBeNull();
    expect(r.ambiguous.length).toBe(2);
    expect(r.ambiguous).toContain("aabbcc00-1111-2222-3333-444444444444");
    expect(r.ambiguous).toContain("aabbcc01-1111-2222-3333-444444444444");
  });

  test("I-4: prefix shorter than 4 chars returns null (defensive)", () => {
    const r = resolveProjectPrefix(hermesDir, "ab");
    expect(r.projectId).toBeNull();
  });
});

// ── I-6, I-7: deleteProject path safety + idempotency ──────────────────

describe("RG-009 I-6,I-7: deleteProject safety", () => {
  let hermesDir: string;
  beforeEach(() => {
    hermesDir = mkdtempSync(join(tmpdir(), "rg009-del-"));
  });
  afterEach(() => {
    rmSync(hermesDir, { recursive: true, force: true });
  });

  test("I-6: refuses path-traversal style inputs", () => {
    const bad = [
      "../../etc/passwd",
      "../escape",
      "abc/../../escape",
      "abc def",
      "abc;rm -rf /",
      "abc*",
      "abc&evil",
      "abc|pipe",
    ];
    for (const b of bad) {
      expect(deleteProject(hermesDir, b)).toBe(false);
    }
  });

  test("I-7: idempotent — false on already-gone project", () => {
    expect(deleteProject(hermesDir, "nonexistent-uuid")).toBe(false);
  });

  test("I-7: happy path removes the project dir", () => {
    const id = "deadbeef-1111-2222-3333-444444444444";
    seedTerminalProject(hermesDir, id, "failed", "thread-1");
    const dir = join(hermesDir, "projects", id);
    expect(existsSync(dir)).toBe(true);
    expect(deleteProject(hermesDir, id)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  test("I-7: listProjects no longer surfaces a deleted project", () => {
    const id = "deadbe02-1111-2222-3333-444444444444";
    seedTerminalProject(hermesDir, id, "failed", "thread-1");
    expect(listProjects(hermesDir).length).toBe(1);
    deleteProject(hermesDir, id);
    expect(listProjects(hermesDir).length).toBe(0);
  });
});

// ── I-8..I-15: handleProjectDelete + handleDeleteConfirmReply flow ──────

describe("RG-009 I-8..I-15: handler flow", () => {
  let hermesDir: string;
  let originalDataDir: string | undefined;

  // The handler reads hermesDir via
  //   resolveHermesDir(config.paths.dataDir, config.paths.hermesDir)
  // config.paths.dataDir is loaded from env at module-init time
  // (config.ts uses `process.env.DATA_DIR` via the `optional()` helper,
  // which is called once when the config module is first imported).
  //
  // To get a hermetic hermesDir per test we would normally re-import
  // config, but that would invalidate all sibling test files. Instead
  // we exercise the handler in two modes:
  //   (a) "dataDir inherited" — use the live process DATA_DIR
  //       (typically /tmp/claude-bridge-test-data, set by
  //       test-setup.ts) and create projects in <DATA_DIR>/hermes.
  //       This is the path that matches the production code 1:1.
  //   (b) For tests that don't depend on hermesDir resolution, we
  //       use the matcher / state-helper tests in the earlier blocks
  //       (I-1..I-7) which run hermetically.
  //
  // The "live DATA_DIR" approach is safe because the per-test
  // projectIds are random UUIDs and we clean up in afterEach.

  beforeEach(() => {
    originalDataDir = process.env.DATA_DIR;
    // Ensure DATA_DIR is set to the canonical test location.
    if (!process.env.DATA_DIR) {
      process.env.DATA_DIR = "/tmp/claude-bridge-test-data";
    }
    hermesDir = join(process.env.DATA_DIR, "hermes");
    // Pre-test cleanup: wipe any leftover rg009- projects from
    // previous runs (or from earlier tests in this file that left
    // data behind). This is essential because resolveProjectPrefix
    // does a case-insensitive startsWith match — a leftover project
    // with a shared 8-char prefix will cause an "ambiguous" error
    // in the next test that creates a project with the same prefix.
    if (existsSync(hermesDir)) {
      for (const id of listProjects(hermesDir)) {
        if (id.id.toLowerCase().startsWith("rg009-")) {
          deleteProject(hermesDir, id.id);
        }
      }
    }
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    // Best-effort: wipe per-test rg009 projects.
    if (existsSync(hermesDir)) {
      for (const id of listProjects(hermesDir)) {
        if (id.id.toLowerCase().startsWith("rg009-")) {
          deleteProject(hermesDir, id.id);
        }
      }
    }
  });

  // Helper: aggressively clean up all rg009- projects from previous
  // tests. We use this in tests where leftover state from earlier
  // tests in the same run can cause "ambiguous" prefix errors. The
  // outer beforeEach/afterEach should keep things tidy, but in
  // practice we observed leftover state leaking across test
  // invocations (because the beforeEach runs *after* the previous
  // test's afterEach, but the previous test's project creations
  // are not visible to the next test's beforeEach via a different
  // module's module-scoped `pendingDeletes` map — we don't have
  // that issue here, but rg009- projects on disk DO leak).
  function preClean(): void {
    if (!existsSync(hermesDir)) return;
    for (const id of listProjects(hermesDir)) {
      if (id.id.toLowerCase().startsWith("rg009-")) {
        deleteProject(hermesDir, id.id);
      }
    }
  }

  // I-8: --all-failed skips active projects.
  test("I-8: --all-failed skips active projects, lists only terminal in prompt", async () => {
    // Aggressive cleanup: previous tests' afterEach can leave
    // residual rg009- projects (e.g. when an assertion fails and
    // the cleanup logic is short-circuited by the failure).
    preClean();
    // Per-test salt + unique authorId so the PendingDelete map
    // (keyed by userId) doesn't bleed across tests. Each project
    // gets its own 4-char tag (I8XX) so the 8-char prefix is unique.
    const authorId = `user-rg009-I8`;
    const failedId = rg009Id("8F"); // I-8 Failed
    const killedId = rg009Id("8K"); // I-8 Killed
    const activeId = rg009Id("8A"); // I-8 Active
    seedTerminalProject(hermesDir, failedId, "failed", "thread-rg009-I8-1");
    seedTerminalProject(hermesDir, killedId, "killed", "thread-rg009-I8-2");
    seedActiveProject(hermesDir, activeId);

    const { msg, replies } = newFakeMsg({
      content: "/project delete --all-failed",
      authorId,
    });
    await handleProjectDelete(msg as unknown as Message, { kind: "all-failed" });

    expect(replies.length).toBe(1);
    const prompt = replies[0];
    // The prompt should list BOTH terminal projects.
    expect(prompt).toContain(failedId.slice(0, 8));
    expect(prompt).toContain(killedId.slice(0, 8));
    // But NOT the active one. Use the full 8-char prefix to
    // avoid false positives (the 7-char prefix `rg009-I8` is
    // shared with the failed/killed ids which use 4-char tags
    // all starting with "I8").
    expect(prompt).not.toContain(activeId.slice(0, 8));
    // And the prompt explicitly says "all failed/killed/timed_out".
    expect(prompt.toLowerCase()).toContain("failed");

    // Phase 1 must NOT have deleted anything yet.
    expect(existsSync(join(hermesDir, "projects", failedId))).toBe(true);
    expect(existsSync(join(hermesDir, "projects", killedId))).toBe(true);
    expect(existsSync(join(hermesDir, "projects", activeId))).toBe(true);
  });

  // I-9: single-id delete on active project is rejected.
  test("I-9: single-id delete on active project is rejected (no PendingDelete set)", async () => {
    preClean();
    const authorId = `user-rg009-I9`;
    const activeId = rg009Id("9A");
    seedActiveProject(hermesDir, activeId);

    const { msg, replies } = newFakeMsg({
      content: `/project delete ${activeId.slice(0, 8)}`,
      authorId,
    });
    await handleProjectDelete(msg as unknown as Message, {
      kind: "id",
      target: activeId.slice(0, 8),
    });

    // The reply should mention "active" so the user knows why.
    expect(replies.length).toBe(1);
    expect(replies[0].toLowerCase()).toContain("active");

    // Project still on disk.
    expect(existsSync(join(hermesDir, "projects", activeId))).toBe(true);

    // And no PendingDelete is set, so a "yes" reply should NOT
    // trigger the delete.
    const { msg: yesMsg, replies: yesReplies } = newFakeMsg({
      content: "yes",
      authorId, // same userId as the original /project delete
    });
    const handled = await handleDeleteConfirmReply(yesMsg as unknown as Message);
    expect(handled).toBe(false);
    expect(yesReplies).toEqual([]);
    // Project still on disk.
    expect(existsSync(join(hermesDir, "projects", activeId))).toBe(true);
  });

  // I-10: single-id delete on terminal project sets up a PendingDelete
  // but does NOT delete yet.
  test("I-10: single-id delete on terminal project sets up PendingDelete (Phase 1 only)", async () => {
    preClean();
    const authorId = `user-rg009-I10`;
    const channelId = `channel-rg009-I10`;
    const id = rg009Id("10");
    seedTerminalProject(hermesDir, id, "failed", "thread-rg009-I10-5");

    const { msg, replies } = newFakeMsg({
      content: `/project delete ${id.slice(0, 8)}`,
      authorId,
      channelId,
    });
    await handleProjectDelete(msg as unknown as Message, {
      kind: "id",
      target: id.slice(0, 8),
    });

    expect(replies.length).toBe(1);
    expect(replies[0]).toContain(id.slice(0, 8));
    expect(replies[0].toLowerCase()).toContain("confirm");

    // Project is still on disk.
    expect(existsSync(join(hermesDir, "projects", id))).toBe(true);
  });

  // I-11: yes → deletion happens.
  test("I-11: 'yes' reply executes the deletion", async () => {
    preClean();
    const authorId = `user-rg009-I11`;
    const channelId = `channel-rg009-I11`;
    const id = rg009Id("11");
    seedTerminalProject(hermesDir, id, "failed", "thread-rg009-I11-6");

    const { msg: phase1Msg, replies: phase1Replies } = newFakeMsg({
      content: `/project delete ${id.slice(0, 8)}`,
      authorId,
      channelId,
    });
    await handleProjectDelete(phase1Msg as unknown as Message, {
      kind: "id",
      target: id.slice(0, 8),
    });
    expect(phase1Replies.length).toBe(1);

    // Now Phase 2: send "yes" with the SAME userId+channelId.
    const { msg: yesMsg, replies: yesReplies } = newFakeMsg({
      content: "yes",
      authorId: phase1Msg.author.id,
      channelId: phase1Msg.channelId,
    });
    const handled = await handleDeleteConfirmReply(yesMsg as unknown as Message);
    expect(handled).toBe(true);
    expect(yesReplies.length).toBe(1);
    // The reply text for a single deletion is just "🗑️ Deleted 1
    // project." (no id listed). We verify the deletion by
    // checking the project dir is gone, plus the response status.
    expect(yesReplies[0].toLowerCase()).toContain("deleted");

    // Project dir is gone.
    expect(existsSync(join(hermesDir, "projects", id))).toBe(false);
  });

  // I-12: no → cancellation, project survives.
  test("I-12: 'no' reply cancels, project survives", async () => {
    preClean();
    const authorId = `user-rg009-I12`;
    const channelId = `channel-rg009-I12`;
    const id = rg009Id("12");
    seedTerminalProject(hermesDir, id, "failed", "thread-rg009-I12-7");

    const { msg: phase1Msg } = newFakeMsg({
      content: `/project delete ${id.slice(0, 8)}`,
      authorId,
      channelId,
    });
    await handleProjectDelete(phase1Msg as unknown as Message, {
      kind: "id",
      target: id.slice(0, 8),
    });

    const { msg: noMsg, replies: noReplies } = newFakeMsg({
      content: "no",
      authorId: phase1Msg.author.id,
      channelId: phase1Msg.channelId,
    });
    const handled = await handleDeleteConfirmReply(noMsg as unknown as Message);
    expect(handled).toBe(true);
    expect(noReplies.length).toBe(1);
    expect(noReplies[0].toLowerCase()).toContain("cancel");

    // Project still on disk.
    expect(existsSync(join(hermesDir, "projects", id))).toBe(true);
  });

  // I-13: unrelated reply → returns false, fall-through.
  test("I-13: unrelated reply (e.g. 'y', 'nope', 'yes please') returns false", async () => {
    for (const text of ["y", "nope", "yes please", "ok", ""]) {
      const { msg, replies } = newFakeMsg({ content: text });
      const handled = await handleDeleteConfirmReply(msg as unknown as Message);
      expect(handled).toBe(false);
      expect(replies).toEqual([]);
    }
  });

  // I-14: yes from a different userId does NOT trigger the delete.
  test("I-14: 'yes' from a different userId does NOT trigger the delete", async () => {
    const s = randomUUID();
    const id = `rg009-${s}f0000008-1111-2222-3333-444444444444`;
    seedTerminalProject(hermesDir, id, "failed", `thread-rg009-${s}-8`);

    const { msg: phase1Msg } = newFakeMsg({
      content: `/project delete ${id.slice(0, 8)}`,
      authorId: "user-rg009-A",
    });
    await handleProjectDelete(phase1Msg as unknown as Message, {
      kind: "id",
      target: id.slice(0, 8),
    });

    // Different user replies "yes" in the same channel.
    const { msg: yesMsg, replies: yesReplies } = newFakeMsg({
      content: "yes",
      authorId: "user-rg009-B",
      channelId: phase1Msg.channelId,
    });
    const handled = await handleDeleteConfirmReply(yesMsg as unknown as Message);
    expect(handled).toBe(false);
    expect(yesReplies).toEqual([]);

    // Project survives.
    expect(existsSync(join(hermesDir, "projects", id))).toBe(true);
  });

  // I-15: yes from a different channelId does NOT trigger the delete.
  test("I-15: 'yes' from a different channelId does NOT trigger the delete", async () => {
    const s = randomUUID();
    const id = `rg009-${s}f0000009-1111-2222-3333-444444444444`;
    seedTerminalProject(hermesDir, id, "failed", `thread-rg009-${s}-9`);

    const { msg: phase1Msg } = newFakeMsg({
      content: `/project delete ${id.slice(0, 8)}`,
      authorId: "user-rg009-A",
      channelId: "channel-A",
    });
    await handleProjectDelete(phase1Msg as unknown as Message, {
      kind: "id",
      target: id.slice(0, 8),
    });

    // Same user replies "yes" but in a different channel.
    const { msg: yesMsg, replies: yesReplies } = newFakeMsg({
      content: "yes",
      authorId: "user-rg009-A",
      channelId: "channel-B",
    });
    const handled = await handleDeleteConfirmReply(yesMsg as unknown as Message);
    expect(handled).toBe(false);
    expect(yesReplies).toEqual([]);

    // Project survives.
    expect(existsSync(join(hermesDir, "projects", id))).toBe(true);
  });
});
