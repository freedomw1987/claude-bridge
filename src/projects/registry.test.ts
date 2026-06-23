/**
 * Tests for ProjectRegistry TTL cache.
 *
 * Background: ~/www/ has 60+ project subdirectories. Each `@bot <msg>`
 * mention goes through `resolve()` and/or `list()` — without caching
 * every keystroke would re-stat 60+ directories. With TTL=60s we expect
 * one scan per minute per bot process, regardless of traffic.
 *
 * These tests use a throwaway tmp dir + TTL=100ms so we can exercise
 * the cache hit / miss / invalidate paths in milliseconds.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRegistry } from "./registry";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "registry-ttl-"));
  // Seed two subdirectories so scan finds something
  mkdirSync(join(tmpRoot, "alpha"));
  mkdirSync(join(tmpRoot, "beta"));
  writeFileSync(join(tmpRoot, "alpha", "README.md"), "# alpha");
});

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe("ProjectRegistry TTL cache", () => {
  test("initial scan happens once in the constructor", () => {
    const reg = new ProjectRegistry({ root: tmpRoot }, 60_000);
    expect(reg.cacheStats().scanCount).toBe(1);
    expect(reg.list().map((p) => p.name)).toEqual(["alpha", "beta"]);
  });

  test("second list() within TTL does NOT re-scan", () => {
    const reg = new ProjectRegistry({ root: tmpRoot }, 60_000);
    const before = reg.cacheStats().scanCount;
    reg.list();
    reg.list();
    reg.resolve("alpha");
    expect(reg.cacheStats().scanCount).toBe(before); // still 1
  });

  test("after TTL expires, next read re-scans", async () => {
    const reg = new ProjectRegistry({ root: tmpRoot }, 50); // 50ms TTL
    const before = reg.cacheStats().scanCount;
    // wait past TTL
    await new Promise((r) => setTimeout(r, 80));
    reg.list();
    expect(reg.cacheStats().scanCount).toBe(before + 1);
  });

  test("invalidate() forces next read to re-scan", () => {
    const reg = new ProjectRegistry({ root: tmpRoot }, 60_000);
    expect(reg.cacheStats().scanCount).toBe(1);
    reg.invalidate();
    reg.list();
    expect(reg.cacheStats().scanCount).toBe(2);
  });

  test("invalidate() then add directory then list picks up new entry", () => {
    const reg = new ProjectRegistry({ root: tmpRoot }, 60_000);
    expect(reg.resolve("gamma")).toBeNull();
    // Simulate "user created new project" — add a directory on disk
    mkdirSync(join(tmpRoot, "gamma"));
    // Without invalidating, resolve still returns null (cached)
    expect(reg.resolve("gamma")).toBeNull();
    // After invalidating, the next read picks it up
    reg.invalidate();
    expect(reg.resolve("gamma")?.name).toBe("gamma");
  });

  test("ttlMs=0 disables cache — every call re-scans", () => {
    const reg = new ProjectRegistry({ root: tmpRoot }, 0);
    expect(reg.cacheStats().scanCount).toBe(1);
    reg.list();
    reg.list();
    reg.resolve("alpha");
    expect(reg.cacheStats().scanCount).toBe(4); // 1 constructor + 3 calls
  });

  test("case-insensitive resolve still benefits from TTL cache", () => {
    const reg = new ProjectRegistry({ root: tmpRoot }, 60_000);
    const before = reg.cacheStats().scanCount;
    reg.resolve("ALPHA");
    reg.resolve("alpha");
    reg.resolve("Alpha");
    expect(reg.cacheStats().scanCount).toBe(before); // cache warm
  });

  test("cacheStats reports age + ttl", async () => {
    const reg = new ProjectRegistry({ root: tmpRoot }, 100);
    const s1 = reg.cacheStats();
    expect(s1.ageMs).toBeGreaterThanOrEqual(0);
    expect(s1.ageMs).toBeLessThan(100); // just scanned
    expect(s1.ttlMs).toBe(100);
    await new Promise((r) => setTimeout(r, 60));
    const s2 = reg.cacheStats();
    expect(s2.ageMs).toBeGreaterThanOrEqual(50);
  });

  test("default TTL is 60s when not specified", () => {
    const reg = new ProjectRegistry({ root: tmpRoot });
    expect(reg.cacheStats().ttlMs).toBe(60_000);
  });

  test("hidden projects are excluded from default list", () => {
    // Pre-existing implementation behavior: hidden entries are
    // filtered out during the scan phase (registry.ts reload() line
    // ~116), so they never enter `byName` at all. `list({includeHidden})`
    // therefore never surfaces them either — it's a defensive no-op
    // that exists in case future refactors populate `byName` first
    // and filter later. This test pins the current behavior so any
    // semantic change is intentional.
    mkdirSync(join(tmpRoot, "secret"));
    const configPath = join(tmpRoot, "projects.json");
    writeFileSync(configPath, JSON.stringify({ hidden: ["secret"] }));
    const reg = new ProjectRegistry({ root: tmpRoot, configPath }, 60_000);
    expect(reg.list().map((p) => p.name).sort()).toEqual(["alpha", "beta"]);
    expect(reg.list({ includeHidden: true }).map((p) => p.name).sort()).toEqual([
      "alpha",
      "beta",
    ]);
    // `secret` is not resolvable at all because it's never added to byName
    expect(reg.resolve("secret")).toBeNull();
  });
});