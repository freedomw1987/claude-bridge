/**
 * Tests for slash command matchers + /use-cli / /use-sdk handlers.
 *
 * Focus areas:
 *   - isUseCliCommand / isUseSdkCommand match the right inputs (and reject lookalikes)
 *   - dispatchCommand routes the new commands to the right handlers
 *   - handleUseCli / handleUseSdk update runnerKind via store.setRunnerKind
 *   - Both handlers short-circuit when the runner is already the requested one
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
  isUseCliCommand,
  isUseSdkCommand,
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
    runnerKind: "sdk",
    ...overrides,
  };
}

function fakeStore(): SessionStore {
  return {
    setRunnerKind: mock((_id: string, _kind: "cli" | "sdk") => undefined),
    setStatus: mock((_id: string, _s: string) => undefined),
    get: mock((_id: string) => null),
  } as unknown as SessionStore;
}

// ---- Matcher tests ----

describe("isUseCliCommand", () => {
  it("matches /use-cli", () => {
    expect(isUseCliCommand("/use-cli")).toBe(true);
  });
  it("matches case-insensitively and trims whitespace", () => {
    expect(isUseCliCommand("/USE-CLI")).toBe(true);
    expect(isUseCliCommand("  /use-cli  ")).toBe(true);
  });
  it("matches /use-cli with trailing text", () => {
    expect(isUseCliCommand("/use-cli please")).toBe(true);
  });
  it("does not match lookalikes", () => {
    expect(isUseCliCommand("/use-sdk")).toBe(false);
    expect(isUseCliCommand("/useclic")).toBe(false);
    expect(isUseCliCommand("use-cli")).toBe(false); // no slash
    expect(isUseCliCommand("/use")).toBe(false);
  });
});

describe("isUseSdkCommand", () => {
  it("matches /use-sdk", () => {
    expect(isUseSdkCommand("/use-sdk")).toBe(true);
  });
  it("matches case-insensitively and trims whitespace", () => {
    expect(isUseSdkCommand("/USE-SDK")).toBe(true);
    expect(isUseSdkCommand("  /use-sdk  ")).toBe(true);
  });
  it("does not match lookalikes", () => {
    expect(isUseSdkCommand("/use-cli")).toBe(false);
    expect(isUseSdkCommand("/usesdk")).toBe(false);
    expect(isUseSdkCommand("/use")).toBe(false);
  });
});

// ---- Dispatch tests ----

describe("dispatchCommand — runner kind switching", () => {
  let store: SessionStore;
  let ctx: { msg: Message; store: SessionStore; projects: any };

  beforeEach(() => {
    store = fakeStore();
    ctx = {
      msg: fakeMsg("/use-cli"),
      store,
      projects: {} as any,
    };
  });

  it("dispatches /use-cli to handleUseCli, which calls store.setRunnerKind('cli')", async () => {
    const session = fakeSession({ runnerKind: "sdk" });
    const handled = await dispatchCommand("/use-cli", session, ctx);
    expect(handled).toBe(true);
    expect((store.setRunnerKind as Mock<any>).mock.calls[0]).toEqual([
      "thread-1",
      "cli",
    ]);
  });

  it("dispatches /use-sdk to handleUseSdk, which calls store.setRunnerKind('sdk')", async () => {
    const session = fakeSession({ runnerKind: "cli" });
    ctx.msg = fakeMsg("/use-sdk");
    const handled = await dispatchCommand("/use-sdk", session, ctx);
    expect(handled).toBe(true);
    expect((store.setRunnerKind as Mock<any>).mock.calls[0]).toEqual([
      "thread-1",
      "sdk",
    ]);
  });

  it("short-circuits /use-cli when already on CLI", async () => {
    const session = fakeSession({ runnerKind: "cli" });
    const handled = await dispatchCommand("/use-cli", session, ctx);
    expect(handled).toBe(true);
    // store.setRunnerKind should NOT be called — already on CLI.
    expect((store.setRunnerKind as Mock<any>).mock.calls.length).toBe(0);
  });

  it("short-circuits /use-sdk when already on SDK", async () => {
    const session = fakeSession({ runnerKind: "sdk" });
    ctx.msg = fakeMsg("/use-sdk");
    const handled = await dispatchCommand("/use-sdk", session, ctx);
    expect(handled).toBe(true);
    expect((store.setRunnerKind as Mock<any>).mock.calls.length).toBe(0);
  });

  it("returns false (forwards to Claude) when session is null", async () => {
    const handled = await dispatchCommand("/use-cli", null, ctx);
    expect(handled).toBe(false);
  });
});
