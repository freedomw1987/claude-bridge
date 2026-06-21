/**
 * Tests for the rate-limited Discord send queue.
 */

import { test, expect } from "bun:test";
import { SendQueue } from "./sendQueue";

test("SendQueue sends first message immediately", async () => {
  const q = new SendQueue(50); // 50ms gap to make timing observable
  const calls: { content: string; at: number }[] = [];
  const start = Date.now();
  await q.send(async (c) => {
    calls.push({ content: c, at: Date.now() - start });
    return c;
  }, "first");
  expect(calls.length).toBe(1);
  expect(calls[0].content).toBe("first");
  // First send is immediate — no waiting
  expect(calls[0].at).toBeLessThan(20);
});

test("SendQueue spaces subsequent sends by minIntervalMs", async () => {
  const q = new SendQueue(80);
  const calls: { content: string; at: number }[] = [];
  const start = Date.now();
  // Fire 3 sends back-to-back
  const promises = [
    q.send(async (c) => {
      calls.push({ content: c, at: Date.now() - start });
      return c;
    }, "a"),
    q.send(async (c) => {
      calls.push({ content: c, at: Date.now() - start });
      return c;
    }, "b"),
    q.send(async (c) => {
      calls.push({ content: c, at: Date.now() - start });
      return c;
    }, "c"),
  ];
  await Promise.all(promises);

  expect(calls.length).toBe(3);
  expect(calls[0].at).toBeLessThan(20); // first immediate
  // Each subsequent send must wait at least ~80ms after the previous one
  expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(70);
  expect(calls[2].at - calls[1].at).toBeGreaterThanOrEqual(70);
});

test("SendQueue preserves caller's return type", async () => {
  const q = new SendQueue();
  interface Foo {
    id: number;
  }
  const result = await q.send<Foo>(async () => ({ id: 42 }), "x");
  expect(result.id).toBe(42);
});

test("SendQueue swallows send errors — chain continues", async () => {
  const q = new SendQueue(20);
  const calls: string[] = [];
  // First send throws
  const p1 = q
    .send(async () => {
      calls.push("first");
      throw new Error("boom");
    }, "1")
    .catch(() => "caught");
  // Second send should still run
  const p2 = q.send(async (c) => {
    calls.push("second:" + c);
    return c;
  }, "2");

  await Promise.all([p1, p2]);
  expect(calls).toEqual(["first", "second:2"]);
});

test("SendQueue with 0 interval sends as fast as possible", async () => {
  const q = new SendQueue(0);
  const calls: number[] = [];
  const start = Date.now();
  await Promise.all([
    q.send(async () => {
      calls.push(Date.now() - start);
    }, "a"),
    q.send(async () => {
      calls.push(Date.now() - start);
    }, "b"),
    q.send(async () => {
      calls.push(Date.now() - start);
    }, "c"),
  ]);
  expect(calls.length).toBe(3);
  // All within a small window — no artificial spacing
  const span = Math.max(...calls) - Math.min(...calls);
  expect(span).toBeLessThan(100);
});

test("SendQueue handles 10 sequential sends within ~1s", async () => {
  const q = new SendQueue(110); // 110ms * 9 gaps = ~990ms for 10 sends
  const start = Date.now();
  let count = 0;
  for (let i = 0; i < 10; i++) {
    await q.send(async () => {
      count++;
    }, `msg-${i}`);
  }
  const elapsed = Date.now() - start;
  expect(count).toBe(10);
  // Should take at least 9 * 110 = 990ms
  expect(elapsed).toBeGreaterThanOrEqual(900);
  // But not absurdly longer (allow some scheduling slack)
  expect(elapsed).toBeLessThan(2000);
});
