/**
 * Active process tracking + graceful shutdown.
 *
 * Each message spawns a `claude -p` subprocess. If the bot gets SIGTERM
 * while claude is running, we kill the process so it doesn't get orphaned.
 */

import { log } from "./logger";

const activeProcesses = new Set<number>();

export function trackProcess(pid: number): void {
  activeProcesses.add(pid);
}

export function untrackProcess(pid: number): void {
  activeProcesses.delete(pid);
}

export function activeProcessCount(): number {
  return activeProcesses.size;
}

export async function killAllProcesses(): Promise<void> {
  const pids = [...activeProcesses];
  log.info("killing active claude processes on shutdown", { count: pids.length });
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have already exited
    }
  }
  activeProcesses.clear();
}