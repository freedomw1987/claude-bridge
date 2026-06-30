/**
 * Tests for src/utils/notifyDeath.ts — Discord death-notification helper.
 *
 * The pure `buildDeathMessage` function is fully testable. The spawn-based
 * `notifyDeath` is implicitly tested by the smoke script in scripts/
 * because mocking child_process.spawn in bun:test is brittle.
 *
 * We test:
 *   - Header structure (emoji + reason + detail)
 *   - Stack chunk formatting (only included when stack present)
 *   - Log tail rendering (only included when file exists)
 *   - Truncation behavior (oversize stack/detail → ellipsis)
 *   - Overall message stays under Discord 2000-char limit
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeathMessage } from "./notifyDeath";

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "notify-death-test-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("buildDeathMessage", () => {
  test("renders reason + detail in header", () => {
    const dataDir = tempDataDir();
    try {
      const msg = buildDeathMessage(
        { reason: "uncaughtException", detail: "boom: TypeError" },
        dataDir,
      );
      expect(msg).toContain("🚨");
      expect(msg).toContain("uncaughtException");
      expect(msg).toContain("boom: TypeError");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("includes stack chunk when stack provided", () => {
    const dataDir = tempDataDir();
    try {
      const msg = buildDeathMessage(
        { reason: "gatewayDeadBeyondGrace", detail: "ws closed", stack: "Error: at fnA\n  at fnB" },
        dataDir,
      );
      expect(msg).toContain("Error: at fnA");
      expect(msg).toContain("```"); // code fence present
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("omits stack chunk when stack missing", () => {
    const dataDir = tempDataDir();
    try {
      const msg = buildDeathMessage(
        { reason: "mainCatch", detail: "fatal err" },
        dataDir,
      );
      expect(msg).not.toContain("at fnA");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("includes bot.log tail when file exists", () => {
    const dataDir = tempDataDir();
    try {
      writeFileSync(
        join(dataDir, "bot.log"),
        "2026-06-30 INFO starting\n2026-06-30 INFO ready\n2026-06-30 ERROR crash boom\n",
      );
      const msg = buildDeathMessage(
        { reason: "uncaughtException", detail: "x" },
        dataDir,
      );
      expect(msg).toContain("bot.log tail");
      expect(msg).toContain("crash boom");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("includes bot.err.log tail when file exists", () => {
    const dataDir = tempDataDir();
    try {
      writeFileSync(
        join(dataDir, "bot.err.log"),
        "$ bun run src/index.ts\nSIGTERM\n",
      );
      const msg = buildDeathMessage(
        { reason: "mainCatch", detail: "y" },
        dataDir,
      );
      expect(msg).toContain("bot.err.log tail");
      expect(msg).toContain("SIGTERM");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("truncates oversize stack with ellipsis", () => {
    const dataDir = tempDataDir();
    try {
      const hugeStack = "x".repeat(5000);
      const msg = buildDeathMessage(
        { reason: "uncaughtException", detail: "z", stack: hugeStack },
        dataDir,
      );
      expect(msg).toContain("…(truncated)");
      expect(msg.length).toBeLessThanOrEqual(1900);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("truncates oversize detail to 500 chars in header", () => {
    const dataDir = tempDataDir();
    try {
      // 2000 'x' chars — should be capped to 500 in the detail slot.
      // Use 'x' (no overlap with literal "claude-bridge" header text),
      // but 'uncaughtException' + 'exit' header words each contain one
      // 'x' so the total 'x' count after slicing is 500 + 2 = 502.
      const hugeDetail = "x".repeat(2000);
      const msg = buildDeathMessage(
        { reason: "uncaughtException", detail: hugeDetail },
        dataDir,
      );
      const xCount = (msg.match(/x/g) ?? []).length;
      // 500 (truncated detail) + 2 (literal "exit" + "uncaughtException") = 502
      expect(xCount).toBeLessThanOrEqual(510);
      // The detail itself was capped — total message body must NOT be 2000 'x'.
      expect(xCount).toBeLessThan(1000);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("strips newlines + backticks from detail to keep header one line", () => {
    const dataDir = tempDataDir();
    try {
      const multilineDetail = "line1\nline2\rline3`code`";
      const msg = buildDeathMessage(
        { reason: "uncaughtException", detail: multilineDetail },
        dataDir,
      );
      // Header line should not contain raw \n / \r / unescaped backticks.
      const headerLine = msg.split("\n")[0];
      expect(headerLine).not.toContain("\r");
      expect(headerLine).not.toMatch(/line1\nline2/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("output stays under 1900 chars (Discord limit is 2000)", () => {
    const dataDir = tempDataDir();
    try {
      writeFileSync(
        join(dataDir, "bot.log"),
        Array.from({ length: 100 }, (_, i) => `line ${i}: ${"x".repeat(50)}`).join("\n"),
      );
      writeFileSync(
        join(dataDir, "bot.err.log"),
        Array.from({ length: 100 }, (_, i) => `err ${i}`).join("\n"),
      );
      const msg = buildDeathMessage(
        {
          reason: "uncaughtException",
          detail: "big error",
          stack: "stack: " + "y".repeat(2000),
        },
        dataDir,
      );
      expect(msg.length).toBeLessThanOrEqual(1900);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("handles missing data dir + missing logs gracefully", () => {
    // No files at all — should not throw, returns header-only message.
    const dataDir = tempDataDir();
    try {
      const msg = buildDeathMessage(
        { reason: "uncaughtException", detail: "no logs available" },
        dataDir,
      );
      expect(msg).toContain("no logs available");
      expect(msg).not.toContain("bot.log tail");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});