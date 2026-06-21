/**
 * Tests for SessionStore.
 */

import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "./index";

const setup = (): { store: SessionStore; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "cb-db-"));
  const dbPath = join(dir, "sessions.db");
  // Schema is in src/db/schema.sql — relative to this test file
  const schemaPath = join(import.meta.dir, "schema.sql");
  const store = new SessionStore(dbPath, schemaPath);
  return { store, cleanup: () => store.close() };
};

test("create + get round-trips a session", () => {
  const { store, cleanup } = setup();
  try {
    const s = store.create({
      threadId: "t1",
      channelId: "c1",
      repoUrl: null,
      localPath: "/tmp/foo",
      repoPath: "/tmp/foo",
    });
    expect(s.threadId).toBe("t1");
    expect(s.status).toBe("active");
    const fetched = store.get("t1");
    expect(fetched).not.toBeNull();
    expect(fetched!.localPath).toBe("/tmp/foo");
  } finally {
    cleanup();
  }
});

test("findStale with future threshold returns all active sessions", () => {
  const { store, cleanup } = setup();
  try {
    store.create({
      threadId: "a",
      channelId: "c",
      repoUrl: null,
      localPath: null,
      repoPath: "/tmp/a",
    });
    store.create({
      threadId: "b",
      channelId: "c",
      repoUrl: null,
      localPath: null,
      repoPath: "/tmp/b",
    });
    const stale = store.findStale({ idleSinceMs: Date.now() + 1000 });
    expect(stale.length).toBe(2);
    const ids = stale.map((s) => s.threadId).sort();
    expect(ids).toEqual(["a", "b"]);
  } finally {
    cleanup();
  }
});

test("findStale with past threshold returns nothing", () => {
  const { store, cleanup } = setup();
  try {
    store.create({
      threadId: "a",
      channelId: "c",
      repoUrl: null,
      localPath: null,
      repoPath: "/tmp/a",
    });
    const stale = store.findStale({ idleSinceMs: Date.now() - 1000 });
    expect(stale.length).toBe(0);
  } finally {
    cleanup();
  }
});

test("findStale excludes sessions with non-active status", () => {
  const { store, cleanup } = setup();
  try {
    store.create({
      threadId: "t1",
      channelId: "c",
      repoUrl: null,
      localPath: null,
      repoPath: "/tmp/x",
    });
    store.setStatus("t1", "killed");
    const stale = store.findStale({ idleSinceMs: Date.now() + 1000 });
    expect(stale.length).toBe(0);
  } finally {
    cleanup();
  }
});

test("setStatus transitions through valid states", () => {
  const { store, cleanup } = setup();
  try {
    store.create({
      threadId: "t1",
      channelId: "c",
      repoUrl: null,
      localPath: null,
      repoPath: "/tmp/x",
    });
    expect(store.get("t1")!.status).toBe("active");
    store.setStatus("t1", "idle");
    expect(store.get("t1")!.status).toBe("idle");
    store.setStatus("t1", "killed");
    expect(store.get("t1")!.status).toBe("killed");
  } finally {
    cleanup();
  }
});

test("touch increments totalMessages and updates lastActivityAt", async () => {
  const { store, cleanup } = setup();
  try {
    store.create({
      threadId: "t1",
      channelId: "c",
      repoUrl: null,
      localPath: null,
      repoPath: "/tmp/x",
    });
    const before = store.get("t1")!.lastActivityAt;
    // Wait a bit so the timestamp differs
    await new Promise((r) => setTimeout(r, 5));
    store.touch("t1");
    const after = store.get("t1")!;
    expect(after.lastActivityAt).toBeGreaterThanOrEqual(before);
    expect(after.totalMessages).toBe(1);
    store.touch("t1");
    expect(store.get("t1")!.totalMessages).toBe(2);
  } finally {
    cleanup();
  }
});

test("list returns sessions sorted by last_activity_at DESC", () => {
  const { store, cleanup } = setup();
  try {
    store.create({
      threadId: "first",
      channelId: "c",
      repoUrl: null,
      localPath: null,
      repoPath: "/tmp/first",
    });
    // Wait then create another — newer should come first
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    return wait(5).then(() => {
      store.create({
        threadId: "second",
        channelId: "c",
        repoUrl: null,
        localPath: null,
        repoPath: "/tmp/second",
      });
      const all = store.list();
      expect(all.length).toBe(2);
      expect(all[0].threadId).toBe("second");
      expect(all[1].threadId).toBe("first");
      cleanup();
    });
  } catch (e) {
    cleanup();
    throw e;
  }
});
