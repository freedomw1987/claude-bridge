/**
 * Tests for `makeClaudeSend` (UX-3) — the Discord-send wrapper that
 * prefixes every Claude Code reply with "🤖 Claude Code:" so David
 * can visually distinguish CC engineering output from Hermes metadata.
 *
 * Scoped to:
 *   1. Short single-message reply — prefix lands on the first message
 *   2. Long reply that exceeds Discord's 2000-char limit — splits at
 *      splitForDiscord boundaries; prefix only on first chunk
 *   3. Empty content — throws (defensive: caller must check first)
 *   4. With a SendQueue — passes through queue's throttling wrapper
 */

import { describe, test, expect } from "bun:test";
import type { ThreadChannel } from "discord.js";
import { CLAUDE_PREFIX, makeClaudeSend } from "./streaming";
import { SendQueue } from "../sendQueue";
import { DISCORD_MAX } from "../split";

class FakeMessage {
  constructor(
    public readonly id: string,
    public readonly content: string,
  ) {}
}

interface FakeThread {
  sent: string[];
  lastMessage: FakeMessage | null;
  send: (content: string) => Promise<FakeMessage>;
}

function fakeThread(): FakeThread {
  const t: FakeThread = {
    sent: [],
    lastMessage: null,
    send: async (content: string) => {
      const m = new FakeMessage(`msg-${t.sent.length}`, content);
      t.sent.push(content);
      t.lastMessage = m;
      return m;
    },
  };
  return t;
}

function asThread(t: FakeThread): ThreadChannel {
  // Only the `send` method is consumed by makeClaudeSend. The cast is
  // safe for testing the prefix + chunking logic in isolation.
  return t as unknown as ThreadChannel;
}

describe("makeClaudeSend (UX-3)", () => {
  test("short single reply: prefix lands on the only message", async () => {
    const thread = fakeThread();
    const send = makeClaudeSend(asThread(thread));
    const reply = await send("Fixing the auth bug now.");
    expect(thread.sent).toHaveLength(1);
    expect(thread.sent[0]).toBe(`${CLAUDE_PREFIX} Fixing the auth bug now.`);
    expect(reply.id).toBe("msg-0");
  });

  test("long reply that exceeds Discord limit: splits, prefix only on first", async () => {
    const thread = fakeThread();
    const send = makeClaudeSend(asThread(thread));
    // 4500 chars → must split (DISCORD_MAX - prefix budget ≈ 1877)
    const longText = "x".repeat(4500);
    const reply = await send(longText);
    expect(thread.sent.length).toBeGreaterThanOrEqual(2);
    expect(thread.sent[0]).toBe(`${CLAUDE_PREFIX} ${"x".repeat(DISCORD_MAX - CLAUDE_PREFIX.length - 1)}`);
    // Continuation chunks are bare (no prefix)
    for (let i = 1; i < thread.sent.length; i++) {
      expect(thread.sent[i].startsWith(CLAUDE_PREFIX)).toBe(false);
    }
    // Reply returned is the first message (discordSendTool needs its ID)
    expect(reply.id).toBe("msg-0");
  });

  test("empty content throws so callers must check before invoking", async () => {
    const thread = fakeThread();
    const send = makeClaudeSend(asThread(thread));
    await expect(send("")).rejects.toThrow(/empty/);
    expect(thread.sent).toHaveLength(0);
  });

  test("with a SendQueue: every chunk goes through the queue", async () => {
    const thread = fakeThread();
    const queue = new SendQueue();
    const send = makeClaudeSend(asThread(thread), queue);
    // Three sequential sends — queue should space them out.
    const t0 = Date.now();
    await send("first");
    await send("second");
    await send("third");
    const elapsed = Date.now() - t0;
    // SendQueue default minIntervalMs is 1100 → at least ~2.2s of spacing
    // for the 2nd and 3rd sends.
    expect(elapsed).toBeGreaterThanOrEqual(2_000);
    expect(thread.sent).toHaveLength(3);
    expect(thread.sent[0]).toBe(`${CLAUDE_PREFIX} first`);
    expect(thread.sent[1]).toBe(`${CLAUDE_PREFIX} second`);
    expect(thread.sent[2]).toBe(`${CLAUDE_PREFIX} third`);
  });

  test("CLAUDE_PREFIX is stable (don't break Discord message identity)", () => {
    // Pinning the exact string so accidental rename gets caught by tests.
    expect(CLAUDE_PREFIX).toBe("🤖 **Claude Code:**");
  });
});
