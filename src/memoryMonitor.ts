/**
 * Internal memory monitor — RSS self-watchdog + optional trace writer.
 *
 * Defense-in-depth for the long-task memory leak fixed in ADR-0002. If
 * `process.memoryUsage().rss` exceeds the configured threshold, the bot
 * logs and exits so launchd KeepAlive respawns it cleanly. This is the
 * in-process counterpart to the OS-level watchdog at
 * `scripts/memory-watchdog.sh` — useful when the OS watchdog plist is
 * disabled or unavailable (e.g. Linux without systemd, dev runs).
 *
 * Trace mode: when `tracePath` is set, every sample is appended to a
 * CSV file (`ts,rssMB,heapUsedMB`) for offline analysis. Use to verify
 * the SDK migration didn't regress long-task RAM behavior.
 *
 * "Silent on healthy runs" — only logs when the threshold is crossed
 * or the periodic debug sample fires. Matches ADR-0002's pattern.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./logger";

export interface MemoryMonitorOpts {
  /** RSS cap in MB. If exceeded, the bot logs and exits with code 1. */
  thresholdMB: number;
  /** How often to sample `process.memoryUsage()`. */
  intervalMs: number;
  /** Optional path to append CSV samples `{ts,rssMB,heapUsedMB}` per tick. */
  tracePath?: string;
  /** How often to emit a debug-level "memory sample" log. Default 30s. */
  logIntervalMs?: number;
}

export function startMemoryMonitor(opts: MemoryMonitorOpts): () => void {
  const { thresholdMB, intervalMs, tracePath, logIntervalMs = 30_000 } = opts;

  if (tracePath) {
    try {
      mkdirSync(dirname(tracePath), { recursive: true });
      // Header only on first init — append-only on subsequent restarts.
      appendFileSync(tracePath, `# ts,rssMB,heapUsedMB\n`);
    } catch (err) {
      log.warn("memory monitor: failed to init trace file", {
        tracePath,
        err: String(err),
      });
    }
  }

  let lastLogAt = 0;
  const exited = { value: false };

  const sample = (): void => {
    if (exited.value) return;

    const mem = process.memoryUsage();
    const rssMB = Math.round(mem.rss / 1024 / 1024);
    const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);

    if (tracePath) {
      try {
        appendFileSync(
          tracePath,
          `${new Date().toISOString()},${rssMB},${heapUsedMB}\n`,
        );
      } catch (err) {
        // Trace write failures should not crash the bot. Log once at warn
        // level and continue; the OS watchdog is the safety net.
        log.warn("memory monitor: trace write failed", {
          tracePath,
          err: String(err),
        });
      }
    }

    if (rssMB > thresholdMB) {
      exited.value = true;
      log.error("memory threshold exceeded, exiting", {
        rssMB,
        heapUsedMB,
        thresholdMB,
      });
      // Give the logger 250ms to flush, then exit so launchd KeepAlive
      // respawns. Mirrors the uncaughtException handler in index.ts.
      setTimeout(() => process.exit(1), 250);
      return;
    }

    const now = Date.now();
    if (now - lastLogAt >= logIntervalMs) {
      lastLogAt = now;
      log.debug("memory sample", { rssMB, heapUsedMB, thresholdMB });
    }
  };

  const handle = setInterval(sample, intervalMs);
  // Don't keep the process alive solely for this timer.
  if (typeof (handle as { unref?: () => void }).unref === "function") {
    (handle as { unref: () => void }).unref();
  }

  return () => clearInterval(handle);
}
