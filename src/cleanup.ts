/**
 * Active process tracking + graceful shutdown.
 *
 * Each message spawns a `claude -p` subprocess. If the bot gets SIGTERM
 * while claude is running, we kill the process so it doesn't get orphaned.
 *
 * Two registries are unified here:
 *   - `activeProcesses` (below): legacy CLI PIDs tracked via trackProcess()
 *   - `activeSdkRunCount()` (sdkRunner.ts): the SDK runner's in-process
 *     query registry, since SDK runs are not separate PIDs
 *
 * `activeProcessCount()` returns the sum so the MAX_CONCURRENT_CONTAINERS
 * cap (checked in streaming.ts) applies to BOTH runners. Without this
 * unification, SDK runs would bypass the cap (10 concurrent threads
 * could spawn 10 SDK queries without any warn).
 */

import { log } from "./logger";
import { activeSdkRunCount } from "./agent/sdkRunner";

const activeProcesses = new Set<number>();

export function trackProcess(pid: number): void {
  activeProcesses.add(pid);
}

export function untrackProcess(pid: number): void {
  activeProcesses.delete(pid);
}

/**
 * Total in-flight claude runs (CLI + SDK).
 * Used by MAX_CONCURRENT_CONTAINERS enforcement in streaming.ts.
 */
export function activeProcessCount(): number {
  return activeProcesses.size + activeSdkRunCount();
}

const SIGTERM_GRACE_MS = 2000;

export async function killAllProcesses(): Promise<void> {
  const pids = [...activeProcesses];
  log.info("killing active claude processes on shutdown", {
    cliCount: pids.length,
    sdkCount: activeSdkRunCount(),
    graceMs: SIGTERM_GRACE_MS,
  });
  // Phase 1: SIGTERM everyone
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have already exited
    }
  }
  // Phase 2: wait up to grace period for graceful exit
  await new Promise<void>((r) => setTimeout(r, SIGTERM_GRACE_MS));
  // Phase 3: SIGKILL any survivors that didn't honor SIGTERM
  for (const pid of pids) {
    if (activeProcesses.has(pid)) {
      try {
        process.kill(pid, "SIGKILL");
        log.warn("force-killed claude process (did not exit on SIGTERM)", { pid });
      } catch {
        // Already dead
      }
    }
  }
  activeProcesses.clear();
}