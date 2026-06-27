#!/usr/bin/env bun
/**
 * ram-trace-analyze.ts — Hermes-aware RAM trace analyzer.
 *
 * Reads `data/ram-trace.log` (CSV: `ts,rssMB,heapUsedMB`) and produces:
 *   1. Summary statistics (min/max/avg/percentiles)
 *   2. ASCII line chart of RSS over time
 *   3. Per-segment breakdown (using Hermes journal.log to mark
 *      project boundaries, if available)
 *   4. Verdict against `BOT_RSS_THRESHOLD_MB`
 *
 * Usage:
 *   bun run scripts/ram-trace-analyze.ts              # default paths
 *   bun run scripts/ram-trace-analyze.ts --trace PATH
 *   bun run scripts/ram-trace-analyze.ts --threshold N
 *   bun run scripts/ram-trace-analyze.ts --json        # machine-readable
 *
 * Why a separate script (instead of inline in the bash summary)?
 *   - The CSV parsing + chart math is easier to unit-test in TypeScript
 *   - The summary script becomes a 5-line shim that just calls this
 *   - Same code can power a future dashboard / Discord command
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = "data";
const DEFAULT_TRACE = join(DATA_DIR, "ram-trace.log");
const DEFAULT_JOURNAL_DIR = join(DATA_DIR, "hermes", "projects");
const DEFAULT_THRESHOLD_MB = 800;

export interface Sample {
  ts: number;
  iso: string;
  rssMB: number;
  heapUsedMB: number;
}

interface Args {
  tracePath: string;
  thresholdMB: number;
  journalDir: string;
  json: boolean;
  width: number;
  height: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    tracePath: DEFAULT_TRACE,
    thresholdMB: DEFAULT_THRESHOLD_MB,
    journalDir: DEFAULT_JOURNAL_DIR,
    json: false,
    width: 80,
    height: 16,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case "--trace":
        args.tracePath = next;
        i++;
        break;
      case "--threshold":
        args.thresholdMB = Number(next);
        i++;
        break;
      case "--journal-dir":
        args.journalDir = next;
        i++;
        break;
      case "--json":
        args.json = true;
        break;
      case "--width":
        args.width = Number(next);
        i++;
        break;
      case "--height":
        args.height = Number(next);
        i++;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`ram-trace-analyze — Hermes-aware RAM trace analyzer

USAGE
  bun run scripts/ram-trace-analyze.ts [options]

OPTIONS
  --trace PATH        path to ram-trace.log (default: data/ram-trace.log)
  --threshold N       RSS cap in MB for verdict (default: 800)
  --journal-dir PATH  Hermes journal dir (default: data/hermes/projects)
  --json              emit JSON instead of pretty text
  --width N           ASCII chart width in chars (default: 80)
  --height N          ASCII chart height in lines (default: 16)
  -h, --help          show this help
`);
}

interface Segment {
  projectId: string;
  shortId: string;
  goal: string;
  startedAt: number;
  endedAt: number | null;
  status: string;
  samples: Sample[];
  peakRssMB: number;
  costUsd: number;
}

/**
 * Parse a trace file into samples. Skips the `# ts,...` header comment
 * and the (optional) column header line.
 */
export function parseTrace(text: string): Sample[] {
  const lines = text.split("\n");
  const samples: Sample[] = [];
  for (const line of lines) {
    if (!line || line.startsWith("#") || line.startsWith("ts,")) continue;
    const parts = line.split(",");
    if (parts.length < 3) continue;
    const iso = parts[0];
    const rss = Number(parts[1]);
    const heap = Number(parts[2]);
    if (Number.isNaN(rss) || Number.isNaN(heap)) continue;
    samples.push({
      ts: Date.parse(iso),
      iso,
      rssMB: rss,
      heapUsedMB: heap,
    });
  }
  return samples;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

interface Summary {
  count: number;
  firstAt: string | null;
  lastAt: string | null;
  durationMs: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  above_500: number;
  above_700: number;
  above_threshold: number;
  verdict: "ok" | "warning" | "critical";
}

export function summarize(samples: Sample[], thresholdMB: number): Summary {
  if (samples.length === 0) {
    return {
      count: 0,
      firstAt: null,
      lastAt: null,
      durationMs: 0,
      min: 0,
      max: 0,
      avg: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      above_500: 0,
      above_700: 0,
      above_threshold: 0,
      verdict: "ok",
    };
  }
  const rssValues = samples.map((s) => s.rssMB).sort((a, b) => a - b);
  const total = rssValues.reduce((a, b) => a + b, 0);
  const above500 = rssValues.filter((r) => r > 500).length;
  const above700 = rssValues.filter((r) => r > 700).length;
  const aboveT = rssValues.filter((r) => r > thresholdMB).length;
  const max = rssValues[rssValues.length - 1];
  const min = rssValues[0];
  const verdict: Summary["verdict"] = aboveT > 0
    ? "critical"
    : max >= 500
      ? "warning"
      : "ok";
  return {
    count: samples.length,
    firstAt: samples[0].iso,
    lastAt: samples[samples.length - 1].iso,
    durationMs: samples[samples.length - 1].ts - samples[0].ts,
    min,
    max,
    avg: total / samples.length,
    p50: percentile(rssValues, 50),
    p95: percentile(rssValues, 95),
    p99: percentile(rssValues, 99),
    above_500: above500,
    above_700: above700,
    above_threshold: aboveT,
    verdict,
  };
}

/**
 * Build a horizontal ASCII line chart of RSS over time.
 * The y-axis is RSS in MB (scaled to data range), x-axis is sample index.
 * Uses `▁▂▃▄▅▆▇█` Unicode blocks for sub-character resolution.
 */
export function asciiLineChart(
  samples: Sample[],
  width: number,
  height: number,
  thresholdMB: number,
): string {
  if (samples.length === 0) return "(no samples)";
  // Bucketize samples into `width` columns.
  const buckets: number[][] = Array.from({ length: width }, () => []);
  const step = samples.length / width;
  for (let i = 0; i < samples.length; i++) {
    const col = Math.min(width - 1, Math.floor(i / step));
    buckets[col].push(samples[i].rssMB);
  }
  // For each column, compute max — that's the column's RSS.
  const colMax = buckets.map((b) => (b.length === 0 ? 0 : Math.max(...b)));
  const overallMax = Math.max(...colMax, thresholdMB);
  // Round up to nearest 100MB for nicer y-axis labels.
  const yMax = Math.ceil(overallMax / 100) * 100;
  const blocks = "▁▂▃▄▅▆▇█";
  // Build chart from top to bottom.
  const lines: string[] = [];
  for (let row = height - 1; row >= 0; row--) {
    const yLabel = Math.round((yMax * (row + 1)) / height);
    let line = `${String(yLabel).padStart(4)} MB │`;
    for (const rss of colMax) {
      if (rss === 0) {
        line += " ";
        continue;
      }
      const ratio = rss / yMax;
      const blockIdx = Math.min(blocks.length - 1, Math.floor(ratio * blocks.length));
      line += blocks[blockIdx];
    }
    // Mark threshold if it falls in this row.
    if (
      thresholdMB > (yMax * row) / height &&
      thresholdMB <= (yMax * (row + 1)) / height
    ) {
      // Add a marker at the right edge for the threshold line.
      line = line + ` ← ${thresholdMB}MB threshold`;
    }
    lines.push(line);
  }
  // Bottom axis
  const xAxis = "     │" + "─".repeat(width);
  const totalSec = Math.round((samples[samples.length - 1].ts - samples[0].ts) / 1000);
  const xLabel = `     0s` + " ".repeat(Math.max(0, width - 12)) + `+${totalSec}s elapsed`;
  lines.push(xAxis);
  lines.push(xLabel);
  return lines.join("\n");
}

/**
 * Build an ASCII histogram of RSS distribution (10 MB buckets).
 * Shows which RSS range the bot spent the most time in.
 */
export function asciiHistogram(samples: Sample[], max: number): string {
  if (samples.length === 0) return "(no samples)";
  const BUCKET_SIZE = 25; // MB
  const bucketCount = Math.max(1, Math.ceil(max / BUCKET_SIZE) + 1);
  const buckets: number[] = new Array(bucketCount).fill(0);
  for (const s of samples) {
    const idx = Math.min(bucketCount - 1, Math.floor(s.rssMB / BUCKET_SIZE));
    buckets[idx]++;
  }
  const peak = Math.max(...buckets);
  const WIDTH = 40;
  const lines: string[] = [];
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i] === 0 && i > 0 && i < buckets.length - 1) continue;
    const lo = i * BUCKET_SIZE;
    const hi = lo + BUCKET_SIZE;
    const bar = "█".repeat(Math.round((buckets[i] / peak) * WIDTH));
    const pct = (buckets[i] / samples.length * 100).toFixed(1);
    lines.push(
      `${String(lo).padStart(4)}-${String(hi).padStart(4)} MB │ ${bar.padEnd(WIDTH)} ${buckets[i]} (${pct}%)`,
    );
  }
  return lines.join("\n");
}

// ── Hermes journal correlation ─────────────────────────────────────────

interface JournalEntry {
  ts: string;
  type: string;
  message: string;
}

export interface HermesProject {
  id: string;
  goal: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  costUsd: number;
  journal: JournalEntry[];
  stateMtime: number;
}

/**
 * Walk the Hermes projects directory and read each project's journal.log
 * + state.json mtime. Returns one entry per project.
 */
export function loadHermesProjects(journalDir: string): HermesProject[] {
  if (!existsSync(journalDir)) return [];
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const dirs = readdirSync(journalDir);
  const projects: HermesProject[] = [];
  for (const d of dirs) {
    const statePath = join(journalDir, d, "state.json");
    if (!existsSync(statePath)) continue;
    const st = statSync(statePath);
    try {
      const stateRaw = readFileSync(statePath, "utf-8");
      const state = JSON.parse(stateRaw) as {
        id: string;
        goal: string;
        status: string;
        startedAt: string;
        endedAt: string | null;
        costUsd: number;
      };
      projects.push({
        id: state.id,
        goal: state.goal,
        status: state.status,
        startedAt: state.startedAt,
        endedAt: state.endedAt,
        costUsd: state.costUsd,
        journal: [],
        stateMtime: st.mtimeMs,
      });
    } catch {
      // skip unreadable
    }
  }
  return projects;
}

/**
 * Tag each sample with the projectId that was running at that timestamp.
 * Returns segments (continuous runs of the same project) for the
 * per-project breakdown.
 */
export function tagSamplesByProject(
  samples: Sample[],
  projects: HermesProject[],
): Segment[] {
  if (projects.length === 0) return [];
  // Build a flat list of (start, end, project) — sort by start time.
  const intervals = projects
    .map((p) => ({
      project: p,
      start: Date.parse(p.startedAt),
      end: p.endedAt ? Date.parse(p.endedAt) : Number.POSITIVE_INFINITY,
    }))
    .filter((iv) => iv.end > iv.start)
    .sort((a, b) => a.start - b.start);

  // Greedy assignment: for each sample, find the first interval that
  // contains it. Most samples belong to one project at a time.
  const segments: Segment[] = [];
  for (const iv of intervals) {
    const slice = samples.filter(
      (s) => s.ts >= iv.start && s.ts <= iv.end,
    );
    if (slice.length === 0) continue;
    const peak = slice.reduce((m, s) => Math.max(m, s.rssMB), 0);
    segments.push({
      projectId: iv.project.id,
      shortId: iv.project.id.slice(0, 8),
      goal: iv.project.goal,
      startedAt: iv.start,
      endedAt: Number.isFinite(iv.end) ? iv.end : null,
      status: iv.project.status,
      samples: slice,
      peakRssMB: peak,
      costUsd: iv.project.costUsd,
    });
  }
  return segments;
}

// ── Report rendering ──────────────────────────────────────────────────

function fmtMB(n: number): string {
  return `${n.toString().padStart(4)} MB`;
}

function fmtPct(n: number, total: number): string {
  if (total === 0) return "0.0%";
  return `${(n / total * 100).toFixed(1).padStart(5)}%`;
}

function fmtDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ${sec % 60}s`;
  const hr = Math.floor(sec / 3600);
  const min = Math.floor((sec % 3600) / 60);
  return `${hr}h ${min}m`;
}

function renderTextReport(
  samples: Sample[],
  summary: Summary,
  segments: Segment[],
  thresholdMB: number,
  width: number,
  height: number,
): string {
  const lines: string[] = [];
  lines.push("═".repeat(width));
  lines.push("  Hermes RAM Trace Analysis");
  lines.push("═".repeat(width));
  lines.push("");
  lines.push(`Trace:     ${samples.length} samples, ${fmtDuration(summary.durationMs)} elapsed`);
  if (summary.firstAt && summary.lastAt) {
    lines.push(`Window:    ${summary.firstAt}  →  ${summary.lastAt}`);
  }
  lines.push("");
  lines.push("── Summary ──");
  lines.push(`  min      ${fmtMB(summary.min)}`);
  lines.push(`  p50      ${fmtMB(summary.p50)}`);
  lines.push(`  avg      ${fmtMB(Math.round(summary.avg))}`);
  lines.push(`  p95      ${fmtMB(summary.p95)}`);
  lines.push(`  p99      ${fmtMB(summary.p99)}`);
  lines.push(`  max      ${fmtMB(summary.max)}`);
  lines.push("");
  lines.push(`  >500MB   ${summary.above_500} samples ${fmtPct(summary.above_500, summary.count)}`);
  lines.push(`  >700MB   ${summary.above_700} samples ${fmtPct(summary.above_700, summary.count)}`);
  lines.push(`  >${thresholdMB}MB (threshold)  ${summary.above_threshold} samples ${fmtPct(summary.above_threshold, summary.count)}`);
  lines.push("");

  // Verdict
  const verdictIcon = summary.verdict === "ok"
    ? "✅"
    : summary.verdict === "warning"
      ? "⚠️ "
      : "🔴";
  const verdictText = summary.verdict === "ok"
    ? "Peak RSS is healthy — within ADR-0002 O(1) target."
    : summary.verdict === "warning"
      ? "Peak RSS is elevated (≥500MB). Investigate which task caused the spike."
      : `Peak RSS exceeds ${thresholdMB}MB threshold! The bot would have been auto-killed.`;
  lines.push(`${verdictIcon}  ${verdictText}`);
  lines.push("");

  // ASCII chart
  lines.push("── RSS over time ──");
  lines.push(asciiLineChart(samples, width, height, thresholdMB));
  lines.push("");

  // Histogram
  lines.push("── RSS distribution (25MB buckets) ──");
  lines.push(asciiHistogram(samples, summary.max));
  lines.push("");

  // Per-project segments (if Hermes data available)
  if (segments.length > 0) {
    lines.push("── Per-project breakdown ──");
    lines.push("  short-id     status       peak-RSS   samples   cost       goal");
    for (const seg of segments) {
      const goalShort = seg.goal.length > 32 ? seg.goal.slice(0, 31) + "…" : seg.goal;
      lines.push(
        `  ${seg.shortId}   ${seg.status.padEnd(11)} ${fmtMB(seg.peakRssMB)}   ${String(seg.samples.length).padStart(5)}   $${(seg.costUsd / 100).toFixed(2).padStart(6)}    ${goalShort}`,
      );
    }
    lines.push("");
  } else if (samples.length > 0) {
    lines.push("── Per-project breakdown ──");
    lines.push("  (no Hermes project state files found — bot is running in plain mode)");
    lines.push("");
  }

  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  if (!existsSync(args.tracePath)) {
    console.error(`No trace file at ${args.tracePath}`);
    console.error("Set BOT_RAM_TRACE=1 in .env and restart the bot to enable tracing.");
    process.exit(0);
  }

  const text = readFileSync(args.tracePath, "utf-8");
  const samples = parseTrace(text);
  const summary = summarize(samples, args.thresholdMB);
  const projects = loadHermesProjects(args.journalDir);
  const segments = tagSamplesByProject(samples, projects);

  if (args.json) {
    console.log(JSON.stringify({ summary, segments }, null, 2));
    return;
  }

  console.log(renderTextReport(samples, summary, segments, args.thresholdMB, args.width, args.height));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("ram-trace-analyze failed:", err);
    process.exit(1);
  });
}