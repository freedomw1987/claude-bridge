/**
 * Tests for the messageCreate orchestrator.
 *
 * Covers the auth gate, mention flow, and thread-reply branches
 * that don't reach the actual claude subprocess. Deeper tests
 * (forward to claude) would need to mock runClaude.
 *
 * Test env vars (DISCORD_TOKEN etc.) are set by ./test-setup.ts
 * via bunfig.toml preload — they are in scope before this module
 * is evaluated, so config.ts sees them.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../../db";
import { handleMessageCreate } from "./messageCreate";
import { EMPTY_PROMPT_TEXT, NO_SESSION_TEXT, HELP_TEXT } from "../help";
import { ProjectRegistry } from "../../projects/registry";

const CHANNEL_ID = "test-channel";
const BOT_ID = "bot-1";
const USER_ID = "test-user";

// ---- Mock helpers ----

interface MockCall {
  called: boolean;
  args: unknown[];
}

const newCallLog = (): MockCall => ({ called: false, args: [] });

interface MockMsgOverrides {
  authorId?: string;
  isBot?: boolean;
  channelId?: string;
  content?: string;
  mentionsBot?: boolean;
  isThread?: boolean;
  parentId?: string | null;
  threadId?: string;
}

const mockMsg = (overrides: MockMsgOverrides = {}) => {
  const reply = newCallLog();
  const react = newCallLog();
  const sendTyping = newCallLog();
  const startThread = newCallLog();
  const threadSend = newCallLog();
  const threadId = overrides.threadId ?? "thread-1";
  const isThread = overrides.isThread ?? false;
  const parentId = overrides.parentId ?? (isThread ? CHANNEL_ID : null);

  // Mentions map: .size + .has
  const mentionSet = new Set<string>();
  if (overrides.mentionsBot) mentionSet.add(BOT_ID);

  const channel = {
    id: isThread ? threadId : CHANNEL_ID,
    isThread: () => isThread,
    parentId,
    sendTyping: () => {
      sendTyping.called = true;
      return Promise.resolve();
    },
    send: (content: string) => {
      threadSend.called = true;
      threadSend.args.push(content);
      return Promise.resolve({ id: "msg-1", content });
    },
  };

  const msg = {
    author: {
      bot: overrides.isBot ?? false,
      id: overrides.authorId ?? USER_ID,
    },
    client: { user: { id: BOT_ID } },
    channelId: overrides.channelId ?? CHANNEL_ID,
    channel,
    mentions: {
      users: {
        get size() {
          return mentionSet.size;
        },
        has: (id: string) => mentionSet.has(id),
      },
    },
    content: overrides.content ?? "",
    reply: (content: string) => {
      reply.called = true;
      reply.args.push(content);
      return Promise.resolve();
    },
    react: (emoji: string) => {
      react.called = true;
      react.args.push(emoji);
      return Promise.resolve();
    },
    startThread: (opts: { name: string }) => {
      startThread.called = true;
      startThread.args.push(opts);
      return Promise.resolve(channel);
    },
  };

  return {
    msg,
    reply,
    react,
    sendTyping,
    startThread,
    threadSend,
  };
};

const setupDeps = (): {
  store: SessionStore;
  projects: ProjectRegistry;
  cleanup: () => void;
} => {
  const dir = mkdtempSync(join(tmpdir(), "cb-mc-"));
  const dbPath = join(dir, "sessions.db");
  const schemaPath = join(import.meta.dir, "..", "..", "db", "schema.sql");
  const store = new SessionStore(dbPath, schemaPath);
  const projects = new ProjectRegistry({ root: dir });
  return {
    store,
    projects,
    cleanup: () => store.close(),
  };
};

// ---- Tests ----

describe("handleMessageCreate — auth gate", () => {
  it("ignores messages from bots (silent)", async () => {
    const { store, projects, cleanup } = setupDeps();
    try {
      const { msg, reply } = mockMsg({ isBot: true });
      await handleMessageCreate(msg as never, { store, projects });
      expect(reply.called).toBe(false);
      expect(store.list()).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("ignores messages from unauthorized users (silent)", async () => {
    const { store, projects, cleanup } = setupDeps();
    try {
      const { msg, reply } = mockMsg({ authorId: "different-user" });
      await handleMessageCreate(msg as never, { store, projects });
      expect(reply.called).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("handleMessageCreate — mention flow", () => {
  it("replies with EMPTY_PROMPT_TEXT when @bot has no content", async () => {
    const { store, projects, cleanup } = setupDeps();
    try {
      const { msg, reply } = mockMsg({
        content: `<@${BOT_ID}>`,
        mentionsBot: true,
      });
      await handleMessageCreate(msg as never, { store, projects });
      expect(reply.called).toBe(true);
      expect(reply.args[0]).toBe(EMPTY_PROMPT_TEXT);
      // No thread should be created for an empty prompt
      expect(store.list()).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("ignores messages in wrong channel (silent)", async () => {
    const { store, projects, cleanup } = setupDeps();
    try {
      const { msg, reply } = mockMsg({
        channelId: "different-channel",
        content: `<@${BOT_ID}> hello`,
        mentionsBot: true,
      });
      await handleMessageCreate(msg as never, { store, projects });
      expect(reply.called).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("handleMessageCreate — thread reply flow", () => {
  it("replies with NO_SESSION_TEXT in a thread with no session", async () => {
    const { store, projects, cleanup } = setupDeps();
    try {
      const { msg, reply } = mockMsg({
        isThread: true,
        threadId: "unknown-thread",
        content: "hello",
      });
      await handleMessageCreate(msg as never, { store, projects });
      expect(reply.called).toBe(true);
      expect(reply.args[0]).toBe(NO_SESSION_TEXT);
    } finally {
      cleanup();
    }
  });

  it("handles /help in a thread with no session (doesn't need session)", async () => {
    const { store, projects, cleanup } = setupDeps();
    try {
      const { msg, reply } = mockMsg({
        isThread: true,
        threadId: "unknown-thread",
        content: "/help",
      });
      await handleMessageCreate(msg as never, { store, projects });
      expect(reply.called).toBe(true);
      expect(reply.args[0]).toBe(HELP_TEXT);
    } finally {
      cleanup();
    }
  });

  it("marks session as killed on /kill in an active session", async () => {
    const { store, projects, cleanup } = setupDeps();
    try {
      // Seed an active session
      store.create({
        threadId: "thread-1",
        channelId: CHANNEL_ID,
        repoUrl: null,
        localPath: "/tmp/x",
        repoPath: "/tmp/x",
      });
      const { msg, reply } = mockMsg({
        isThread: true,
        threadId: "thread-1",
        content: "/kill",
      });
      await handleMessageCreate(msg as never, { store, projects });
      expect(reply.called).toBe(true);
      expect(reply.args[0]).toContain("Session killed");
      const session = store.get("thread-1")!;
      expect(session.status).toBe("killed");
    } finally {
      cleanup();
    }
  });

  it("ignores /kill in a thread with no session (suggests starting in dev channel)", async () => {
    const { store, projects, cleanup } = setupDeps();
    try {
      const { msg, reply } = mockMsg({
        isThread: true,
        threadId: "unknown-thread",
        content: "/kill",
      });
      await handleMessageCreate(msg as never, { store, projects });
      expect(reply.called).toBe(true);
      // Should NOT have tried to setStatus on a non-existent session
      expect(reply.args[0]).toBe(NO_SESSION_TEXT);
    } finally {
      cleanup();
    }
  });
});
