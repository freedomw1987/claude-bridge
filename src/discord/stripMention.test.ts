/**
 * Tests for the shared stripMention helper.
 *
 * Used by both `hermes/matchers.ts` and `messageCreate.ts` to detect
 * `/project` commands even when prefixed by a Discord user mention.
 */

import { describe, test, expect } from "bun:test";
import { stripMention } from "./stripMention";

describe("stripMention", () => {
  test("removes bot user mention", () => {
    expect(stripMention("<@123456789> /project start")).toBe("/project start");
  });

  test("removes nickname-style mention (<@!ID>)", () => {
    expect(stripMention("<@!987654321> /project list")).toBe("/project list");
  });

  test("removes all user mentions when more than one", () => {
    expect(stripMention("<@111> <@222> /project kill")).toBe("/project kill");
  });

  test("handles mention with no following text", () => {
    expect(stripMention("<@123>")).toBe("");
  });

  test("leaves plain text unchanged", () => {
    expect(stripMention("/project start")).toBe("/project start");
  });

  test("trims surrounding whitespace", () => {
    expect(stripMention("  /project status  ")).toBe("/project status");
  });

  test("handles mention with multiple whitespace after it", () => {
    expect(stripMention("<@123>     /project plan")).toBe("/project plan");
  });
});
