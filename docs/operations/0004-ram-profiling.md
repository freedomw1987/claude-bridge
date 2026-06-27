# 0004 — Hermes RAM Profiling Guide

> **Status**: tooling shipped (commit `5b9f7a1` + this ADR)
> **Audience**: David (and anyone running Hermes auto-mode for the first time)

Hermes auto-mode runs Claude Code for multiple tasks back-to-back. If the
SDK + orchestrator code regresses, memory could grow unboundedly across
tasks. This ADR documents the **profiling workflow** that detects such
regressions before they hit production.

---

## Quick start

```bash
# 1. Enable tracing (in .env):
BOT_RAM_TRACE=1

# 2. Restart the bot
launchctl kickstart -k gui/$(id -u)/com.claudebridge.bot

# 3. Run a Hermes auto-mode project
/project start --mode=auto "build a hello-world CLI"

# 4. While running (or after it finishes):
bun run scripts/ram-trace-analyze.ts

# Optional: pretty JSON for scripting
bun run scripts/ram-trace-analyze.ts --json > /tmp/ram-report.json
```

The analyzer reads `data/ram-trace.log` (CSV: `ts,rssMB,heapUsedMB`),
cross-references it with Hermes project state in `data/hermes/projects/`,
and prints a one-page report with:

- Summary stats (min / p50 / p95 / p99 / max)
- ASCII line chart of RSS over time (with the threshold marked)
- ASCII histogram of RSS distribution (25 MB buckets)
- Per-project breakdown: which task used how much memory

---

## What the report looks like

```
═══════════════════════════════════════════════════════════════════════════════
  Hermes RAM Trace Analysis
═══════════════════════════════════════════════════════════════════════════════

Trace:     87 samples, 4m 12s elapsed
Window:    2026-06-27T10:00:00.000Z  →  2026-06-27T10:04:12.000Z

── Summary ──
  min       80 MB
  p50      142 MB
  avg      158 MB
  p95      312 MB
  p99      358 MB
  max      362 MB

  >500MB      0 samples  0.0%
  >700MB      0 samples  0.0%
  >800MB (threshold)  0 samples  0.0%

✅  Peak RSS is healthy — within ADR-0002 O(1) target.

── RSS over time ──
...
── RSS distribution (25MB buckets) ──
...

── Per-project breakdown ──
  short-id     status       peak-RSS   samples   cost       goal
  abc12345     done            312 MB     45    $  0.12    build a hello-world CLI
```

---

## Verdicts

| Verdict | Meaning | Action |
|---------|---------|--------|
| `✅ ok` | Peak < 500 MB, no sample exceeded threshold | Healthy — no action |
| `⚠️  warning` | Peak ≥ 500 MB (but < threshold) | Look at the per-project breakdown — was one task responsible? |
| `🔴 critical` | Any sample exceeded `BOT_RSS_THRESHOLD_MB` (default 800) | The bot would have been auto-killed. Investigate ASAP. |

The thresholds correspond to:
- **500 MB**: rule-of-thumb "this is bigger than expected". A single
  long Claude run can spike here briefly; sustained 500 MB+ across
  many samples is the warning sign.
- **700 MB**: getting close to the 800 MB threshold. Definitely investigate.
- **800 MB** (`BOT_RSS_THRESHOLD_MB`): the bot self-exits and the
  launchd plist respawns it.

---

## What "healthy" looks like (SDK era)

Based on prior runs of single-task mentions (`@bot <prompt>`):

- Baseline RSS at idle: **80–120 MB** (Bun runtime + discord.js + SDK imports)
- During a single CC turn: **150–350 MB** (SDK subprocess + accumulated JSONL buffer)
- After turn ends (cleanup): drops back toward baseline within ~30s

Hermes auto-mode (5-10 tasks back-to-back) should look like a **series
of spikes** — one per task — each dropping back to baseline before
the next task starts. If you see a **monotonically increasing curve**
that doesn't drop between tasks, that's the leak pattern.

---

## When to run

1. **Before deploying any SDK update** — verify the new code doesn't
   regress the streaming fix from ADR-0002.
2. **After a Hermes auto-mode project completes** — verify peak RSS
   stayed well within the budget.
3. **When `/project status` shows `costUsd` growing unexpectedly** —
   sometimes memory and cost correlate (a runaway SDK loop).
4. **Investigating OS watchdog kills** — `data/memwatch.log` records
   the system-wide free RAM drop; `data/ram-trace.log` shows what
   the bot was doing at the same time.

---

## Tool internals

`scripts/ram-trace-analyze.ts` (TypeScript):

- `parseTrace(text)` — CSV parser that tolerates the `# ts,...` header
  comment, the column header, and malformed lines.
- `summarize(samples, threshold)` — returns `{ min, p50, avg, p95, p99,
  max, count, above_500, above_700, above_threshold, verdict }`.
- `asciiLineChart(samples, width, height, threshold)` — bucketizes
  samples into `width` columns, renders with Unicode blocks
  (▁▂▃▄▅▆▇█), marks the threshold line.
- `asciiHistogram(samples, max)` — 25 MB buckets, normalized bar chart.
- `tagSamplesByProject(samples, projects)` — reads `state.json` from
  each Hermes project and attributes each sample to whichever project
  was running at that timestamp.

CLI flags:
- `--trace PATH` — override trace file location
- `--threshold N` — override the 800 MB threshold
- `--journal-dir PATH` — override Hermes journal dir
- `--json` — emit JSON instead of pretty text
- `--width N` / `--height N` — chart size

The shell wrapper `scripts/ram-trace-summary.sh` still works as a
quick check (calls this script with default args).

---

## Tests

`scripts/ram-trace-analyze.test.ts` (19 cases) covers:
- CSV parsing edge cases (header, comment, malformed lines)
- Summary statistics (percentiles, thresholds, empty samples)
- ASCII chart output (row count, threshold marker, empty case)
- Histogram bucketization (25 MB boundaries)
- Sample-to-project attribution (overlapping projects, no projects)

---

## Out of scope (deliberate non-goals)

1. **Live dashboard**. The analyzer is post-hoc only. A live RSS
   counter in Discord would be a useful add-on but lives elsewhere.
2. **Cross-process memory**. We measure the bot's own RSS only. OS-wide
   free RAM is the OS watchdog's job (`scripts/memory-watchdog.sh`).
3. **Hermes library extraction (L3)**. Reusing the orchestrator code
   outside Discord is a separate, larger effort. ADR L3 is open but
   unstarted.