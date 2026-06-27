/**
 * Tests for scripts/ram-trace-analyze.ts.
 *
 * Focus areas:
 *   - parseTrace tolerates the comment header, the column header, and
 *     malformed lines (truncated, non-numeric).
 *   - summarize computes percentiles correctly and assigns verdicts
 *     against the threshold.
 *   - asciiLineChart produces a fixed-width string even for very few
 *     samples.
 *   - asciiHistogram bucketizes correctly.
 *   - tagSamplesByProject attributes each sample to the right project
 *     based on timestamp overlap.
 */

import { describe, expect, test } from "bun:test";
import {
  parseTrace,
  summarize,
  asciiLineChart,
  asciiHistogram,
  tagSamplesByProject,
  type Sample,
  type HermesProject,
} from "./ram-trace-analyze";

describe("parseTrace", () => {
  test("parses valid samples", () => {
    const text = `# ts,rssMB,heapUsedMB
2026-06-27T10:00:00.000Z,100,40
2026-06-27T10:00:30.000Z,110,42
2026-06-27T10:01:00.000Z,120,45
`;
    const samples = parseTrace(text);
    expect(samples.length).toBe(3);
    expect(samples[0].rssMB).toBe(100);
    expect(samples[0].heapUsedMB).toBe(40);
    expect(samples[0].iso).toBe("2026-06-27T10:00:00.000Z");
  });

  test("skips header comment and column header", () => {
    const text = `# this is a comment
ts,rssMB,heapUsedMB
2026-06-27T10:00:00.000Z,100,40
`;
    const samples = parseTrace(text);
    expect(samples.length).toBe(1);
  });

  test("skips malformed lines without throwing", () => {
    const text = `2026-06-27T10:00:00.000Z,100,40
garbage line
2026-06-27T10:00:30.000Z,notanumber,40
2026-06-27T10:01:00.000Z,120,45
`;
    const samples = parseTrace(text);
    expect(samples.length).toBe(2); // garbage + non-numeric skipped
  });

  test("returns empty array for empty input", () => {
    expect(parseTrace("")).toEqual([]);
  });
});

describe("summarize", () => {
  const samples: Sample[] = [
    { ts: 0, iso: "2026-06-27T10:00:00.000Z", rssMB: 100, heapUsedMB: 40 },
    { ts: 30_000, iso: "2026-06-27T10:00:30.000Z", rssMB: 150, heapUsedMB: 50 },
    { ts: 60_000, iso: "2026-06-27T10:01:00.000Z", rssMB: 200, heapUsedMB: 60 },
  ];

  test("computes min/max/avg correctly", () => {
    const s = summarize(samples, 800);
    expect(s.count).toBe(3);
    expect(s.min).toBe(100);
    expect(s.max).toBe(200);
    expect(s.avg).toBe(150);
  });

  test("computes percentiles", () => {
    const s = summarize(samples, 800);
    expect(s.p50).toBe(150);
    // p95/p99 of 3 samples [100,150,200] → both at index 1 = 150
    expect(s.p95).toBe(150);
  });

  test("verdict 'ok' when max < 500", () => {
    const s = summarize(samples, 800);
    expect(s.verdict).toBe("ok");
  });

  test("verdict 'warning' when max ≥ 500", () => {
    const highSamples: Sample[] = [
      ...samples,
      { ts: 90_000, iso: "2026-06-27T10:01:30.000Z", rssMB: 600, heapUsedMB: 100 },
    ];
    const s = summarize(highSamples, 800);
    expect(s.verdict).toBe("warning");
  });

  test("verdict 'critical' when any sample exceeds threshold", () => {
    const critSamples: Sample[] = [
      ...samples,
      { ts: 90_000, iso: "2026-06-27T10:01:30.000Z", rssMB: 850, heapUsedMB: 200 },
    ];
    const s = summarize(critSamples, 800);
    expect(s.verdict).toBe("critical");
    expect(s.above_threshold).toBe(1);
  });

  test("returns zeroed summary for empty samples", () => {
    const s = summarize([], 800);
    expect(s.count).toBe(0);
    expect(s.max).toBe(0);
    expect(s.verdict).toBe("ok");
  });

  test("counts samples above 500MB and 700MB", () => {
    const high: Sample[] = [
      { ts: 0, iso: "t0", rssMB: 100, heapUsedMB: 40 },
      { ts: 1, iso: "t1", rssMB: 600, heapUsedMB: 100 },
      { ts: 2, iso: "t2", rssMB: 750, heapUsedMB: 150 },
    ];
    const s = summarize(high, 800);
    expect(s.above_500).toBe(2);
    expect(s.above_700).toBe(1);
  });
});

describe("asciiLineChart", () => {
  test("returns placeholder for empty samples", () => {
    expect(asciiLineChart([], 40, 5, 800)).toBe("(no samples)");
  });

  test("produces chart with correct row count", () => {
    const samples: Sample[] = Array.from({ length: 10 }, (_, i) => ({
      ts: i * 1000,
      iso: `t${i}`,
      rssMB: 100 + i * 10,
      heapUsedMB: 40 + i,
    }));
    const chart = asciiLineChart(samples, 40, 5, 800);
    const lines = chart.split("\n");
    // 5 height rows + 1 x-axis line + 1 x-label line
    expect(lines.length).toBe(7);
  });

  test("includes threshold marker", () => {
    const samples: Sample[] = [
      { ts: 0, iso: "t0", rssMB: 100, heapUsedMB: 40 },
      { ts: 1000, iso: "t1", rssMB: 200, heapUsedMB: 50 },
    ];
    const chart = asciiLineChart(samples, 40, 10, 800);
    expect(chart).toContain("threshold");
  });
});

describe("asciiHistogram", () => {
  test("returns placeholder for empty samples", () => {
    expect(asciiHistogram([], 800)).toBe("(no samples)");
  });

  test("bucketizes samples into 25MB buckets", () => {
    const samples: Sample[] = [
      { ts: 0, iso: "t0", rssMB: 50, heapUsedMB: 20 },
      { ts: 1, iso: "t1", rssMB: 75, heapUsedMB: 25 },
      { ts: 2, iso: "t2", rssMB: 300, heapUsedMB: 100 },
    ];
    const hist = asciiHistogram(samples, 300);
    // Each sample lands in the bucket equal to floor(rss/25)*25
    expect(hist).toContain("  50-  75 MB");
    expect(hist).toContain("  75- 100 MB");
    expect(hist).toContain("300- 325 MB");
  });
});

describe("tagSamplesByProject", () => {
  test("attributes each sample to the project running at that ts", () => {
    const samples: Sample[] = [
      { ts: 1_000_000, iso: "t0", rssMB: 100, heapUsedMB: 40 },
      { ts: 2_000_000, iso: "t1", rssMB: 200, heapUsedMB: 50 },
      { ts: 3_000_000, iso: "t2", rssMB: 300, heapUsedMB: 60 },
    ];
    // Use a fixed ms epoch
    const baseMs = 1_700_000_000_000; // 2023-11-14 in ms
    const projectSamples: Sample[] = [
      { ts: baseMs + 0, iso: "t0", rssMB: 100, heapUsedMB: 40 },
      { ts: baseMs + 1000, iso: "t1", rssMB: 200, heapUsedMB: 50 },
    ];
    const projectProjects: HermesProject[] = [
      {
        id: "p1",
        goal: "test",
        status: "executing",
        startedAt: new Date(baseMs - 5000).toISOString(),
        endedAt: null,
        costUsd: 0,
        journal: [],
        stateMtime: 0,
      },
    ];
    const segments = tagSamplesByProject(projectSamples, projectProjects);
    expect(segments.length).toBe(1);
    expect(segments[0].projectId).toBe("p1");
    expect(segments[0].samples.length).toBe(2);
    expect(segments[0].peakRssMB).toBe(200);
    // The first set of samples (1_000_000 ms = way before baseMs) should not match.
    expect(tagSamplesByProject(samples, projectProjects).length).toBe(0);
  });

  test("returns empty when no projects", () => {
    const samples: Sample[] = [
      { ts: 1_000_000, iso: "t0", rssMB: 100, heapUsedMB: 40 },
    ];
    expect(tagSamplesByProject(samples, [])).toEqual([]);
  });

  test("handles two non-overlapping projects", () => {
    const baseMs = 1_700_000_000_000;
    const samples: Sample[] = [
      { ts: baseMs + 100, iso: "t0", rssMB: 100, heapUsedMB: 40 },
      { ts: baseMs + 5_000, iso: "t1", rssMB: 200, heapUsedMB: 50 },
    ];
    const projects: HermesProject[] = [
      {
        id: "p1",
        goal: "first",
        status: "done",
        startedAt: new Date(baseMs).toISOString(),
        endedAt: new Date(baseMs + 1_000).toISOString(),
        costUsd: 50,
        journal: [],
        stateMtime: 0,
      },
      {
        id: "p2",
        goal: "second",
        status: "executing",
        startedAt: new Date(baseMs + 4_000).toISOString(),
        endedAt: null,
        costUsd: 30,
        journal: [],
        stateMtime: 0,
      },
    ];
    const segments = tagSamplesByProject(samples, projects);
    expect(segments.length).toBe(2);
    expect(segments[0].projectId).toBe("p1");
    expect(segments[0].samples.length).toBe(1);
    expect(segments[0].samples[0].rssMB).toBe(100);
    expect(segments[1].projectId).toBe("p2");
    expect(segments[1].samples.length).toBe(1);
    expect(segments[1].samples[0].rssMB).toBe(200);
  });
});