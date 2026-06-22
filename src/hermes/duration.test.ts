/**
 * Tests for hermes/duration.ts — pure-function parser and formatters.
 */

import { describe, test, expect } from "bun:test";
import {
  formatCountdown,
  formatDuration,
  MAX_DURATION_MS,
  parseDuration,
} from "./duration";

describe("parseDuration — single-unit", () => {
  test("30s → 30,000", () => {
    expect(parseDuration("30s")).toBe(30_000);
  });

  test("30m → 1,800,000", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
  });

  test("2h → 7,200,000", () => {
    expect(parseDuration("2h")).toBe(7_200_000);
  });

  test("1d → 86,400,000", () => {
    expect(parseDuration("1d")).toBe(86_400_000);
  });
});

describe("parseDuration — multi-unit (descending order)", () => {
  test("1h30m → 5,400,000", () => {
    expect(parseDuration("1h30m")).toBe(5_400_000);
  });

  test("1d12h → 1.5 days in ms", () => {
    expect(parseDuration("1d12h")).toBe(36 * 60 * 60 * 1000);
  });

  test("2h30m45s", () => {
    expect(parseDuration("2h30m45s")).toBe(
      2 * 3_600_000 + 30 * 60_000 + 45_000,
    );
  });
});

describe("parseDuration — case insensitive", () => {
  test("30M → 1,800,000", () => {
    expect(parseDuration("30M")).toBe(1_800_000);
  });

  test("  2H  (with surrounding whitespace)", () => {
    expect(parseDuration("  2H  ")).toBe(7_200_000);
  });
});

describe("parseDuration — invalid inputs return null", () => {
  test("empty string", () => {
    expect(parseDuration("")).toBeNull();
  });

  test("whitespace only", () => {
    expect(parseDuration("   ")).toBeNull();
  });

  test("null", () => {
    expect(parseDuration(null)).toBeNull();
  });

  test("undefined", () => {
    expect(parseDuration(undefined)).toBeNull();
  });

  test("plain number (no unit)", () => {
    expect(parseDuration("30")).toBeNull();
  });

  test("random text", () => {
    expect(parseDuration("hello")).toBeNull();
  });

  test("unknown unit", () => {
    expect(parseDuration("30x")).toBeNull();
  });

  test("zero value", () => {
    expect(parseDuration("0m")).toBeNull();
  });

  test("trailing garbage", () => {
    expect(parseDuration("30m!")).toBeNull();
  });

  test("out-of-order units (1m1h)", () => {
    expect(parseDuration("1m1h")).toBeNull();
  });

  test("duplicate units (1m1m)", () => {
    expect(parseDuration("1m1m")).toBeNull();
  });

  test("truncated multi-unit (1h30 missing m)", () => {
    expect(parseDuration("1h30")).toBeNull();
  });

  test("negative number", () => {
    expect(parseDuration("-30m")).toBeNull();
  });
});

describe("parseDuration — overflow guard", () => {
  test("999d exceeds MAX_DURATION_MS (1 year) → null", () => {
    expect(parseDuration("999d")).toBeNull();
  });

  test("exactly 365d → MAX_DURATION_MS (boundary, allowed)", () => {
    // 365d = 365 * 86400000 = MAX_DURATION_MS exactly.
    // Spec says "> MAX_DURATION_MS" is rejected, so 365d is allowed.
    expect(parseDuration("365d")).toBe(MAX_DURATION_MS);
  });

  test("365d1h → null (just over)", () => {
    expect(parseDuration("365d1h")).toBeNull();
  });
});

describe("formatDuration — inverse of parseDuration for canonical inputs", () => {
  test("30,000 → '30s'", () => {
    expect(formatDuration(30_000)).toBe("30s");
  });

  test("1,800,000 → '30m'", () => {
    expect(formatDuration(1_800_000)).toBe("30m");
  });

  test("7,200,000 → '2h'", () => {
    expect(formatDuration(7_200_000)).toBe("2h");
  });

  test("5,400,000 → '1h30m'", () => {
    expect(formatDuration(5_400_000)).toBe("1h30m");
  });

  test("86,400,000 → '1d'", () => {
    expect(formatDuration(86_400_000)).toBe("1d");
  });

  test("0 → '0s'", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  test("negative → '0s'", () => {
    expect(formatDuration(-1)).toBe("0s");
  });

  test("NaN → '0s'", () => {
    expect(formatDuration(NaN)).toBe("0s");
  });
});

describe("formatCountdown — Discord-friendly M:SS / H:MM:SS", () => {
  test("1500ms → '0:01'", () => {
    expect(formatCountdown(1500)).toBe("0:01");
  });

  test("0 → '0:00'", () => {
    expect(formatCountdown(0)).toBe("0:00");
  });

  test("90,000ms → '1:30'", () => {
    expect(formatCountdown(90_000)).toBe("1:30");
  });

  test("1,800,000ms → '30:00'", () => {
    expect(formatCountdown(1_800_000)).toBe("30:00");
  });

  test("3,600,000ms → '1:00:00'", () => {
    expect(formatCountdown(3_600_000)).toBe("1:00:00");
  });

  test("86,400,000ms → '1d 00:00:00'", () => {
    expect(formatCountdown(86_400_000)).toBe("1d 00:00:00");
  });

  test("90,061,000ms (1d 1h 1m 1s) → '1d 01:01:01'", () => {
    expect(formatCountdown(90_061_000)).toBe("1d 01:01:01");
  });

  test("negative → '0:00'", () => {
    expect(formatCountdown(-100)).toBe("0:00");
  });

  test("NaN → '0:00'", () => {
    expect(formatCountdown(NaN)).toBe("0:00");
  });
});
