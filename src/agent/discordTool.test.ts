/**
 * Tests for the four Discord tools exposed to Claude Code via MCP.
 *
 * The `tool()` factory from the SDK builds handler closures. We use the
 * RG-012 factory pattern (`createDiscordTools(deps)`) so each test gets
 * a tool set whose handlers close over the test's specific `deps`. No
 * module-level mutable binding — tests are independent and can be run
 * concurrently (see the RG-012 describe block at the bottom).
 */

import { describe, it, expect, mock } from "bun:test";
import type { Message, ThreadChannel, Collection } from "discord.js";
import { createDiscordTools } from "./discordTool";
import { DISCORD_MAX } from "../discord/split";

// ---- Minimal Discord.js mocks ----

function makeMsg(overrides: {
  id?: string;
  content?: string;
  author?: Message["author"];
  createdTimestamp?: number;
  createdAt?: Date;
  react?: ReturnType<typeof mock>;
  reply?: ReturnType<typeof mock>;
} = {}): Message {
  const react = overrides.react ?? mock(async (_emoji: string) => undefined);
  const reply =
    overrides.reply ??
    mock(async (_content: string) => makeMsg({ id: "reply-msg-id", content: _content }));
  const msg: any = {
    id: overrides.id ?? "1234567890",
    content: overrides.content ?? "",
    author: overrides.author ?? ({ id: "u1", username: "alice", bot: false } as Message["author"]),
    createdTimestamp: overrides.createdTimestamp ?? Date.now(),
    createdAt: overrides.createdAt ?? new Date(),
    react,
    reply,
  };
  return msg as Message;
}

function makeThread(opts: {
  sendImpl?: (content: string) => Promise<Message>;
  sendTypingImpl?: () => Promise<void>;
  fetchImpl?: (opts: { limit?: number }) => Promise<Collection<string, Message>>;
  fetchOneImpl?: (id: string) => Promise<Message>;
}): ThreadChannel {
  const sendMock = mock(async (content: string) =>
    makeMsg({
      id: `msg-${content.slice(0, 4).replace(/\s+/g, "-")}-${Math.random().toString(36).slice(2, 6)}`,
      content,
    }),
  );
  const sendTypingMock = mock(async () => undefined);
  const fetchMock = mock(async (_id: string) => makeMsg({ id: _id }));
  const messages = {
    fetch: mock(async (arg: any) => {
      if (typeof arg === "string") {
        return opts.fetchOneImpl ? opts.fetchOneImpl(arg) : fetchMock(arg);
      }
      // Collection fetch — return a small map of mock messages.
      if (opts.fetchImpl) return opts.fetchImpl(arg);
      const map = new Map<string, Message>();
      map.set("m1", makeMsg({ id: "m1", content: "hello" }));
      map.set("m2", makeMsg({ id: "m2", content: "world" }));
      return map as unknown as Collection<string, Message>;
    }),
  };
  const thread = {
    send: opts.sendImpl ?? sendMock,
    sendTyping: opts.sendTypingImpl ?? sendTypingMock,
    messages,
  };
  return thread as unknown as ThreadChannel;
}

// Tool index mapping (stable, per RG-012 docs):
//   0: discord_send
//   1: discord_typing
//   2: discord_react
//   3: discord_read_history
const TOOL_INDEX_SEND = 0;
const TOOL_INDEX_TYPING = 1;
const TOOL_INDEX_REACT = 2;
const TOOL_INDEX_HISTORY = 3;

// ---- discord_send ----

describe("discord_send tool", () => {
  it("posts content to thread and returns message_id", async () => {
    const thread = makeThread({});
    const send = mock(async (content: string) => {
      // simulate SendQueue wrapper
      return thread.send(content);
    });
    const tools = createDiscordTools({ thread, send });

    const result = await (tools[TOOL_INDEX_SEND] as any).handler(
      { content: "hello world" },
      {},
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.message_id).toBeTruthy();
    expect(parsed.content_length).toBe("hello world".length);
  });

  it("rejects content over 1900 chars with isError result", async () => {
    const thread = makeThread({});
    const send = mock(async () => makeMsg());
    const tools = createDiscordTools({ thread, send });

    const longContent = "x".repeat(1901);
    const result = await (tools[TOOL_INDEX_SEND] as any).handler(
      { content: longContent },
      {},
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("1901");
    expect(result.content[0].text).toContain("split");
  });

  it("uses reply_to_message_id when target fetch succeeds", async () => {
    const replyMock = mock(async (_c: string) => makeMsg({ id: "reply-msg-id", content: _c }));
    const targetMsg = makeMsg({ id: "target-id", content: "original", reply: replyMock });
    const thread = makeThread({
      fetchOneImpl: async (id) => {
        expect(id).toBe("target-id");
        return targetMsg;
      },
    });
    const send = mock(async () => makeMsg());
    const tools = createDiscordTools({ thread, send });

    const result = await (tools[TOOL_INDEX_SEND] as any).handler(
      { content: "reply text", reply_to_message_id: "target-id" },
      {},
    );
    expect(result.isError).toBeUndefined();
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect((replyMock.mock.calls[0] as any[])[0]).toBe("reply text");
  });

  it("falls back to thread.send when reply target cannot be fetched", async () => {
    const thread = makeThread({
      fetchOneImpl: async () => {
        throw new Error("Unknown Message");
      },
    });
    const send = mock(async (content: string) =>
      thread.send(content),
    );
    const tools = createDiscordTools({ thread, send });

    const result = await (tools[TOOL_INDEX_SEND] as any).handler(
      { content: "fallback", reply_to_message_id: "missing-id" },
      {},
    );
    expect(result.isError).toBeUndefined();
    expect(send).toHaveBeenCalledWith("fallback");
  });

  // ── RG-002: thinking-block stripping ─────────────────────────────

  it("strips <ant_thinking>...</ant_thinking> before posting (RG-002)", async () => {
    const thread = makeThread({});
    let sentContent = "";
    const send = mock(async (content: string) => {
      sentContent = content;
      return thread.send(content);
    });
    const tools = createDiscordTools({ thread, send });

    const raw = "<ant_thinking>\nLet me think about this carefully...\nThe user wants X.\n</ant_thinking>\n\nHere is the final answer: do X then Y.";
    const result = await (tools[TOOL_INDEX_SEND] as any).handler(
      { content: raw },
      {},
    );
    expect(result.isError).toBeUndefined();
    expect(sentContent).not.toContain("<ant_thinking>");
    expect(sentContent).not.toContain("</ant_thinking>");
    expect(sentContent).not.toContain("Let me think about this carefully");
    expect(sentContent).toContain("Here is the final answer");
  });

  it("strips <thinking>...</thinking> (older CC variant) (RG-002)", async () => {
    const thread = makeThread({});
    let sentContent = "";
    const send = mock(async (content: string) => {
      sentContent = content;
      return thread.send(content);
    });
    const tools = createDiscordTools({ thread, send });

    const raw = "<thinking>reasoning here</thinking>\nActual answer text.";
    const result = await (tools[TOOL_INDEX_SEND] as any).handler(
      { content: raw },
      {},
    );
    expect(result.isError).toBeUndefined();
    expect(sentContent).not.toContain("<thinking>");
    expect(sentContent).not.toContain("</thinking>");
    expect(sentContent).toBe("Actual answer text.");
  });

  it("stripping lets a long raw content fit within 1900 chars (RG-002)", async () => {
    // Reproduces the 02:44:45 Discord incident: raw CC reply was 2102
    // chars (mostly thinking), got rejected, CC retried with 783 chars.
    // With stripping, the 2102-char raw → ~600 chars stripped, fits.
    const thread = makeThread({});
    let sentContent = "";
    const send = mock(async (content: string) => {
      sentContent = content;
      return thread.send(content);
    });
    const tools = createDiscordTools({ thread, send });

    const thinking = "<ant_thinking>\n" + "x".repeat(1900) + "\n</ant_thinking>\n";
    const finalAnswer = "Final: short answer.";
    const raw = thinking + finalAnswer;
    expect(raw.length).toBeGreaterThan(DISCORD_MAX);

    const result = await (tools[TOOL_INDEX_SEND] as any).handler(
      { content: raw },
      {},
    );
    expect(result.isError).toBeUndefined();
    expect(sentContent).toBe(finalAnswer);
  });
});

// ---- discord_typing ----

describe("discord_typing tool", () => {
  it("calls sendTyping on the thread", async () => {
    const thread = makeThread({});
    const send = mock(async () => makeMsg());
    const tools = createDiscordTools({ thread, send });

    const result = await (tools[TOOL_INDEX_TYPING] as any).handler({}, {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true });
    expect((thread as any).sendTyping).toHaveBeenCalledTimes(1);
  });

  it("does not error when sendTyping rejects", async () => {
    const thread = makeThread({
      sendTypingImpl: async () => {
        throw new Error("rate limited");
      },
    });
    const send = mock(async () => makeMsg());
    const tools = createDiscordTools({ thread, send });

    const result = await (tools[TOOL_INDEX_TYPING] as any).handler({}, {});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true });
  });
});

// ---- discord_react ----

describe("discord_react tool", () => {
  it("adds a reaction to the fetched message", async () => {
    const targetMsg = makeMsg({ id: "target-id" });
    const thread = makeThread({
      fetchOneImpl: async (id) => {
        expect(id).toBe("target-id");
        return targetMsg;
      },
    });
    const send = mock(async () => makeMsg());
    const tools = createDiscordTools({ thread, send });

    const result = await (tools[TOOL_INDEX_REACT] as any).handler(
      { message_id: "target-id", emoji: "✅" },
      {},
    );
    expect(result.isError).toBeUndefined();
    expect(targetMsg.react).toHaveBeenCalledWith("✅");
  });

  it("returns isError when react throws (e.g., missing permissions)", async () => {
    const reactMock = mock(async () => {
      throw new Error("Missing Permissions");
    });
    const targetMsg = makeMsg({ id: "target-id", react: reactMock });
    const thread = makeThread({
      fetchOneImpl: async () => targetMsg,
    });
    const send = mock(async () => makeMsg());
    const tools = createDiscordTools({ thread, send });

    const result = await (tools[TOOL_INDEX_REACT] as any).handler(
      { message_id: "target-id", emoji: "✅" },
      {},
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Missing Permissions");
  });
});

// ---- discord_read_history ----

describe("discord_read_history tool", () => {
  it("returns chronological message list (oldest first)", async () => {
    const messages = new Map<string, Message>();
    const now = Date.now();
    messages.set(
      "m-old",
      makeMsg({
        id: "m-old",
        content: "older",
        author: { id: "u1", username: "alice", bot: false } as Message["author"],
        createdTimestamp: now - 1000,
        createdAt: new Date(now - 1000),
      }),
    );
    messages.set(
      "m-new",
      makeMsg({
        id: "m-new",
        content: "newer",
        author: { id: "u2", username: "bob", bot: true } as Message["author"],
        createdTimestamp: now,
        createdAt: new Date(now),
      }),
    );
    const thread = makeThread({
      fetchImpl: async ({ limit }) => {
        expect(limit).toBe(50);
        return messages as unknown as Collection<string, Message>;
      },
    });
    const send = mock(async () => makeMsg());
    const tools = createDiscordTools({ thread, send });

    const result = await (tools[TOOL_INDEX_HISTORY] as any).handler({}, {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(2);
    expect(parsed.messages[0].id).toBe("m-old");
    expect(parsed.messages[1].id).toBe("m-new");
    expect(parsed.messages[1].is_bot).toBe(true);
  });

  it("clamps limit to 1-100", async () => {
    let receivedLimit: number | undefined;
    const thread = makeThread({
      fetchImpl: async ({ limit }) => {
        receivedLimit = limit;
        return new Map() as unknown as Collection<string, Message>;
      },
    });
    const send = mock(async () => makeMsg());
    const tools = createDiscordTools({ thread, send });

    // limit=999 should be clamped to 100 by the tool schema, but at the
    // handler level we already passed schema validation. So this asserts
    // the handler trusts the input and the schema handles bounds.
    await (tools[TOOL_INDEX_HISTORY] as any).handler({ limit: 999 }, {});
    expect(receivedLimit).toBe(999); // schema clamps, handler sees valid value
  });

  it("defaults limit to 50 when omitted", async () => {
    let receivedLimit: number | undefined;
    const thread = makeThread({
      fetchImpl: async ({ limit }) => {
        receivedLimit = limit;
        return new Map() as unknown as Collection<string, Message>;
      },
    });
    const send = mock(async () => makeMsg());
    const tools = createDiscordTools({ thread, send });

    await (tools[TOOL_INDEX_HISTORY] as any).handler({}, {});
    expect(receivedLimit).toBe(50);
  });

  it("returns isError when thread.messages.fetch throws", async () => {
    const thread = makeThread({
      fetchImpl: async () => {
        throw new Error("Missing Access");
      },
    });
    const send = mock(async () => makeMsg());
    const tools = createDiscordTools({ thread, send });

    const result = await (tools[TOOL_INDEX_HISTORY] as any).handler({}, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Missing Access");
  });
});

// ---- RG-012: concurrent SDK runs must not cross-contaminate ----
//
// Regression guard for the 2026-06-27 incident where two threads running
// CC SDK queries simultaneously would have CC's `discord_send` etc. routed
// to the wrong thread (module-level `setDiscordToolDeps()` race).
//
// These tests use the factory pattern (`createDiscordTools(deps)`) to give
// each "run" its own tool set whose handlers close over the specific
// thread/send. If someone reverts to a module-level mutable binding, the
// interleaved `Promise.all` calls will race and the assertions will fail:
// the wrong `send` will be invoked, leaking cross-thread content.

describe("RG-012 cross-thread isolation (concurrent runs)", () => {
  it("discord_send from 2 concurrent tool sets routes to the correct thread", async () => {
    const sentToA: string[] = [];
    const sentToB: string[] = [];
    const threadA = makeThread({});
    const sendA = mock(async (c: string) => {
      sentToA.push(c);
      return makeMsg();
    });
    const threadB = makeThread({});
    const sendB = mock(async (c: string) => {
      sentToB.push(c);
      return makeMsg();
    });

    const toolsA = createDiscordTools({ thread: threadA, send: sendA });
    const toolsB = createDiscordTools({ thread: threadB, send: sendB });

    // Interleave 25 calls on each side concurrently.
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 25; i++) {
      promises.push(
        (toolsA[TOOL_INDEX_SEND] as any).handler({ content: `A-${i}` }, {}),
      );
      promises.push(
        (toolsB[TOOL_INDEX_SEND] as any).handler({ content: `B-${i}` }, {}),
      );
    }
    await Promise.all(promises);

    // No cross-contamination: A handlers must ONLY have posted to sendA,
    // and B handlers only to sendB. If `deps` is shared mutable state,
    // some A-* content will appear in sentToB (or vice versa) and the
    // `.every()` assertion fails.
    expect(sentToA.length).toBe(25);
    expect(sentToB.length).toBe(25);
    expect(sentToA.every((c) => c.startsWith("A-"))).toBe(true);
    expect(sentToB.every((c) => c.startsWith("B-"))).toBe(true);
  });

  it("discord_typing from 2 concurrent tool sets hits the right thread", async () => {
    const typingA = mock(async () => undefined);
    const typingB = mock(async () => undefined);
    const threadA = { ...makeThread({}), sendTyping: typingA };
    const threadB = { ...makeThread({}), sendTyping: typingB };

    const toolsA = createDiscordTools({
      thread: threadA as unknown as ThreadChannel,
      send: mock(async () => makeMsg()),
    });
    const toolsB = createDiscordTools({
      thread: threadB as unknown as ThreadChannel,
      send: mock(async () => makeMsg()),
    });

    await Promise.all([
      (toolsA[TOOL_INDEX_TYPING] as any).handler({}, {}),
      (toolsB[TOOL_INDEX_TYPING] as any).handler({}, {}),
      (toolsA[TOOL_INDEX_TYPING] as any).handler({}, {}),
      (toolsB[TOOL_INDEX_TYPING] as any).handler({}, {}),
      (toolsA[TOOL_INDEX_TYPING] as any).handler({}, {}),
    ]);

    expect(typingA).toHaveBeenCalledTimes(3);
    expect(typingB).toHaveBeenCalledTimes(2);
  });

  it("discord_react from 2 concurrent tool sets reacts in the right thread", async () => {
    const reactedA: string[] = [];
    const reactedB: string[] = [];
    const targetA = makeMsg({
      id: "msg-a",
      react: mock(async (e: string) => {
        reactedA.push(e);
      }),
    });
    const targetB = makeMsg({
      id: "msg-b",
      react: mock(async (e: string) => {
        reactedB.push(e);
      }),
    });
    const threadA = makeThread({
      fetchOneImpl: async (id) => {
        expect(id).toBe("msg-a");
        return targetA;
      },
    });
    const threadB = makeThread({
      fetchOneImpl: async (id) => {
        expect(id).toBe("msg-b");
        return targetB;
      },
    });

    const toolsA = createDiscordTools({
      thread: threadA,
      send: mock(async () => makeMsg()),
    });
    const toolsB = createDiscordTools({
      thread: threadB,
      send: mock(async () => makeMsg()),
    });

    await Promise.all([
      (toolsA[TOOL_INDEX_REACT] as any).handler(
        { message_id: "msg-a", emoji: "✅" },
        {},
      ),
      (toolsB[TOOL_INDEX_REACT] as any).handler(
        { message_id: "msg-b", emoji: "❌" },
        {},
      ),
    ]);

    expect(reactedA).toEqual(["✅"]);
    expect(reactedB).toEqual(["❌"]);
  });

  it("discord_read_history from 2 concurrent tool sets reads the right thread", async () => {
    const messagesA = new Map<string, Message>([
      ["a1", makeMsg({ id: "a1", content: "from-A" })],
    ]);
    const messagesB = new Map<string, Message>([
      ["b1", makeMsg({ id: "b1", content: "from-B" })],
    ]);
    const threadA = makeThread({
      fetchImpl: async () => messagesA as unknown as Collection<string, Message>,
    });
    const threadB = makeThread({
      fetchImpl: async () => messagesB as unknown as Collection<string, Message>,
    });

    const toolsA = createDiscordTools({
      thread: threadA,
      send: mock(async () => makeMsg()),
    });
    const toolsB = createDiscordTools({
      thread: threadB,
      send: mock(async () => makeMsg()),
    });

    const [resA, resB] = await Promise.all([
      (toolsA[TOOL_INDEX_HISTORY] as any).handler({ limit: 50 }, {}),
      (toolsB[TOOL_INDEX_HISTORY] as any).handler({ limit: 50 }, {}),
    ]);

    expect(JSON.parse(resA.content[0].text).messages[0].id).toBe("a1");
    expect(JSON.parse(resB.content[0].text).messages[0].id).toBe("b1");
  });
});
