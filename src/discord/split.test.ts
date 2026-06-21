/**
 * Tests for src/discord/split.ts — message splitting for Discord's 2000-char limit.
 */

import { describe, it, expect } from "bun:test";
import { splitForDiscord, DISCORD_MAX } from "./split";

describe("splitForDiscord", () => {
  it("returns a single chunk when text fits", () => {
    const text = "short text";
    expect(splitForDiscord(text)).toEqual(["short text"]);
  });

  it("returns a single chunk when text is exactly at limit", () => {
    const text = "a".repeat(DISCORD_MAX);
    const chunks = splitForDiscord(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].length).toBe(DISCORD_MAX);
  });

  it("returns empty array for empty text (preserves falsy chunk filter downstream)", () => {
    // Note: the function itself returns [text] for empty; downstream filters
    // empty chunks. This is a behavioral contract test.
    expect(splitForDiscord("")).toEqual([""]);
  });

  it("splits at paragraph boundary when one exists in the first half", () => {
    const para1 = "a".repeat(800);
    const para2 = "b".repeat(800);
    const text = `${para1}\n\n${para2}`;
    const chunks = splitForDiscord(text);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]).toContain(para1);
    expect(chunks.join("\n")).toContain(para2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(DISCORD_MAX);
    }
  });

  it("falls back to line break when no paragraph break in range", () => {
    const lines: string[] = [];
    // 50 short lines → 60 chars each → no \n\n at all
    for (let i = 0; i < 50; i++) lines.push(`line ${i} ${"x".repeat(50)}`);
    const text = lines.join("\n"); // no \n\n anywhere
    const chunks = splitForDiscord(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(DISCORD_MAX);
    }
  });

  it("falls back to space when no line break in range", () => {
    const words: string[] = [];
    for (let i = 0; i < 1000; i++) words.push(`word${i}`);
    const text = words.join(" ");
    const chunks = splitForDiscord(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(DISCORD_MAX);
    }
  });

  it("hard-cuts a single very long unbroken string (no spaces)", () => {
    const text = "a".repeat(DISCORD_MAX * 2 + 100);
    const chunks = splitForDiscord(text);
    expect(chunks.length).toBeGreaterThan(1);
    // Total content is preserved (allowing for trimEnd)
    expect(chunks.join("").length).toBeGreaterThanOrEqual(DISCORD_MAX * 2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(DISCORD_MAX);
    }
  });

  it("respects a custom maxLen smaller than DISCORD_MAX", () => {
    // Header prepending shrinks the available body size
    const text = "lorem ipsum ".repeat(200); // 2400 chars
    const max = 100;
    const chunks = splitForDiscord(text, max);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(max);
    }
  });

  it("preserves all content (no data loss) when splitting", () => {
    const text =
      "First paragraph with details.\n\n" +
      "Second paragraph with more text.\n\n" +
      "Third paragraph finalizing things. ".repeat(50);
    const chunks = splitForDiscord(text);
    // Reconstructed content should match (modulo trim)
    const reconstructed = chunks.join("\n").replace(/\s+/g, " ").trim();
    const original = text.replace(/\s+/g, " ").trim();
    expect(reconstructed).toBe(original);
  });
});
