/**
 * Active SDK run tracking + graceful shutdown.
 *
 * Phase 3 (2026-06-27): the CLI subprocess runner was retired, so this
 * file no longer needs to track raw PIDs. `activeProcessCount()` is now
 * a thin wrapper around `activeSdkRunCount()` from sdkRunner.ts,
 * re-exported so the streaming layer doesn't need to know which runner
 * is in use.
 *
 * `killAllProcesses()` is preserved for graceful shutdown — it forwards
 * to `abortAllSdkRuns()` to cancel in-flight SDK queries, with a brief
 * grace period to let them drain.
 */

import { log } from "./logger";
import { abortAllSdkRuns, activeSdkRunCount } from "./agent/sdkRunner";

/**
 * Total in-flight Claude Code runs (SDK only — Phase 3).
 * Used by MAX_CONCURRENT_CONTAINERS enforcement in streaming.ts.
 */
export function activeProcessCount(): number {
  return activeSdkRunCount();
}

const SIGTERM_GRACE_MS = 2000;

export async function killAllProcesses(): Promise<void> {
  const sdkCount = activeSdkRunCount();
  log.info("shutting down claude runs", {
    sdkCount,
    graceMs: SIGTERM_GRACE_MS,
  });
  // Abort all SDK queries (closes the AbortController + query).
  await abortAllSdkRuns();
  // Give in-flight SDK subprocesses a brief grace period to flush.
  await new Promise<void>((r) => setTimeout(r, SIGTERM_GRACE_MS));
}