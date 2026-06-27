/**
 * Tests for slash command matchers + handlers.
 *
 * Phase 3 (2026-06-27): /use-cli and /use-sdk handlers were removed
 * (CLI runner retired). This file now focuses on the remaining
 * commands: /kill, /status, /projects, /repo, /help.
 *
 * Focus areas:
 *   - matchers identify the right inputs and reject lookalikes
 *   - dispatchCommand routes to the right handler
 *   - /kill calls store.setStatus('killed')
 *   - /help works without a session
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  mock,
  type Mock,
} from "bun:test";
import type { Message } from "discord.js";
import {
  isKillCommand,
  isStatusCommand,
  isProjectsCommand,
  isHelpCommand,
  matchRepoCommand,
  dispatchCommand,
} from "./commands";
import type { Session } from "../../types";
import type { SessionStore } from "../../db";

// ---- Helpers ----

function fakeMsg(content: string): Message {
  const reply = mock(async (_c: string) => undefined);
  return { content, reply } as unknown as Message;
}

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    threadId: "thread-1",
    channelId: "channel-1",
    repoUrl: null,
    localPath: null,
    repoPath: "/tmp/fake",
    claudeSession: null,
    status: "active",
    createdAt: 0,
    lastActivityAt: 0,
    totalMessages: 0,
    mode: "manual",
    milestoneGoal: null,
    milestoneCriteria: null,
    ...overrides,
  };
}

function fakeStore(): SessionStore {
  return {
    setStatus: mock((_id: string, _s: string) => undefined),
    get: mock((_id: string) => null),
  } as unknown as SessionStore;
}

// ---- Matcher tests ----

describe("isKillCommand", () => {
  it("matches /kill", () => {
    expect(isKillCommand("/kill")).toBe(true);
  });
  it("matches case-insensitively and trims whitespace", () => {
    expect(isKillCommand("/KILL")).toBe(true);
    expect(isKillCommand("  /kill  ")).toBe(true);
  });
  it("does not match lookalikes", () => {
    expect(isKillCommand("/killed")).toBe(false);
    expect(isKillCommand("kill")).toBe(false); // no slash
    expect(isKillCommand("/help")).toBe(false);
  });
});

describe("isStatusCommand", () => {
  it("matches /status", () => {
    expect(isStatusCommand("/status")).toBe(true);
  });
  it("does not match lookalikes", () => {
    expect(isStatusCommand("/stats")).toBe(false);
    expect(isStatusCommand("status")).toBe(false);
  });
});

describe("isProjectsCommand", () => {
  it("matches /projects", () => {
    expect(isProjectsCommand("/projects")).toBe(true);
  });
  it("does not match lookalikes", () => {
    expect(isProjectsCommand("/project")).toBe(false);
    expect(isProjectsCommand("/project-list")).toBe(false);
  });
});

describe("isHelpCommand", () => {
  it("matches /help", () => {
    expect(isHelpCommand("/help")).toBe(true);
  });
});

describe("matchRepoCommand", () => {
  it("extracts the target after /repo", () => {
    expect(matchRepoCommand("/repo https://github.com/foo/bar")).toBe(
      "https://github.com/foo/bar",
    );
    expect(matchRepoCommand("/repo myproject")).toBe("myproject");
  });
  it("returns null when no target", () => {
    expect(matchRepoCommand("/repo")).toBeNull();
    expect(matchRepoCommand("/help")).toBeNull();
  });
});

// ---- Dispatch tests ----

describe("dispatchCommand", () => {
  let store: SessionStore;
  let ctx: { msg: Message; store: SessionStore; projects: any };

  beforeEach(() => {
    store = fakeStore();
    ctx = {
      msg: fakeMsg("/status"),
      store,
      projects: {} as any,
    };
  });

  it("dispatches /status to handleStatus", async () => {
    const session = fakeSession();
    ctx.msg = fakeMsg("/status");
    // /status calls store.get internally; mock it to return our session
    (store.get as any) = mock((_id: string) => session);
    const handled = await dispatchCommand("/status", session, ctx);
    expect(handled).toBe(true);
  });

  it("dispatches /kill to handleKill, which calls store.setStatus", async () => {
    const session = fakeSession();
    ctx.msg = fakeMsg("/kill");
    const handled = await dispatchCommand("/kill", session, ctx);
    expect(handled).toBe(true);
    expect((store.setStatus as Mock<any>).mock.calls[0]).toEqual([
      "thread-1",
      "killed",
    ]);
  });

  it("dispatches /help even when session is null", async () => {
    const handled = await dispatchCommand("/help", null, ctx);
    expect(handled).toBe(true);
  });

  it("returns false (forwards to Claude) when content is not a command", async () => {
    const session = fakeSession();
    const handled = await dispatchCommand("just a regular message", session, ctx);
    expect(handled).toBe(false);
  });

  it("returns false for sessionless messages that aren't /help", async () => {
    const handled = await dispatchCommand("/kill", null, ctx);
    expect(handled).toBe(false);
  });
});