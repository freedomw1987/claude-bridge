/**
 * notifyDeath — fire-and-forget Discord webhook for process exit events.
 *
 * Background (2026-06-30 zombie incident):
 *   The bot went silent at 06:29:59 HKT (SIGTERM from launchd) and stayed
 *   dead for hours. David only noticed because he happened to run
 *   `bash deploy/restart.sh --update`. The macOS osascript banner that
 *   the wrapper used to fire is unreliable when David is offline (the
 *   notification center may suppress background banners from unsigned
 *   daemons, and Discord online status never reflects "bot process
 *   crashed, only the running keep-alive wrapper").
 *
 *   This helper bridges the gap by calling scripts/notify-discord.sh
 *   via Bun's child_process.spawn with `detached: true` + `unref()` so
 *   the notification fires-and-forgets — process.exit(1) 250 ms later
 *   does NOT kill the in-flight curl subprocess.
 *
 * Why shell out instead of using Discord.js directly:
 *   - Gateway-dead exit path runs because `client` is dead. We can't
 *     use Discord.js to notify about its own death.
 *   - notify-discord.sh reads .env directly, so the death notifier
 *     works even after the Discord gateway connection has died.
 *   - Hermes secret-detection redacts tokens from shell stdout, but
 *     the script uses urllib (not curl) with token from .env → never
 *     echoed. See scripts/notify-discord.sh for details.
 *
 * Why we read the last N lines of bot.log/bot.err.log:
 *   Discord notifications get eyeballed. Including the tail of the log
 *   files means David can diagnose without SSH-ing into the box. We
 *   intentionally cap at 10 lines (about 1.5 KB) to stay well below
 *   Discord's 2000-char message limit after the rest of the header.
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";

export type DeathReason =
  | "uncaughtException"
  | "unhandledRejection"
  | "gatewayDeadBeyondGrace"
  | "mainCatch"
  | "test";

export interface DeathEvent {
  reason: DeathReason;
  /** Short human-readable detail (typically the error message or status). */
  detail: string;
  /** Optional stack trace, truncated to ~1 KB to stay under Discord limit. */
  stack?: string;
}

/** Tail the last `n` lines of a file, joined with newlines. Empty string if missing. */
function tailLines(path: string, n: number): string {
  try {
    if (!existsSync(path)) return "";
    const content = readFileSync(path, "utf8");
    const lines = content.split("\n");
    return lines.slice(-n).join("\n").trim();
  } catch {
    return "";
  }
}

/**
 * Truncate a string to `max` chars with an ellipsis marker if cut.
 * Discord rejects messages > 2000 chars; we leave headroom for the header.
 */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n…(truncated)";
}

/**
 * Build the Discord message body. Pure function so it's trivially testable.
 *
 * Format:
 *   🚨 **claude-bridge exit** — `<reason>`
 *   <detail>
 *
 *   **bot.log tail (5)**
 *   ```
 *   <last 5 lines>
 *   ```
 *
 *   **bot.err.log tail (5)**
 *   ```
 *   <last 5 lines>
 *   ```
 */
export function buildDeathMessage(event: DeathEvent, dataDir: string): string {
  // Strip newlines + Discord-breaking markdown from detail so the header
  // stays on one line and doesn't accidentally trigger block formatting.
  // This caps the "visible length" of detail at 500.
  const safeDetail = event.detail.replace(/[\n\r`]/g, " ").slice(0, 500);

  const header =
    `🚨 **claude-bridge exit** — \`${event.reason}\`\n${safeDetail}`;

  const stackChunk = event.stack
    ? `\n\n\`\`\`\n${truncate(event.stack, 800)}\n\`\`\``
    : "";

  const logTail = tailLines(join(dataDir, "bot.log"), 5);
  const errTail = tailLines(join(dataDir, "bot.err.log"), 5);

  const logSection = logTail
    ? `\n\n**bot.log tail**\n\`\`\`\n${truncate(logTail, 600)}\n\`\`\``
    : "";
  const errSection = errTail
    ? `\n\n**bot.err.log tail**\n\`\`\`\n${truncate(errTail, 600)}\n\`\`\``
    : "";

  return (header + stackChunk + logSection + errSection).slice(0, 1900);
}

/**
 * Fire a Discord notification about the bot's impending death.
 *
 * This is fire-and-forget by design:
 *   - `spawn` returns immediately (no await).
 *   - `subprocess.unref()` detaches the child from the parent so
 *     process.exit(1) in 250 ms does NOT kill it.
 *   - The shell script uses `urllib` with a 5 s timeout, so even if
 *     Discord is unreachable, the script exits cleanly.
 *
 * Never throws. Errors are swallowed because the caller is already on
 * the way to a `process.exit(1)` and any exception here would be
 * doubly-silent.
 */
export function notifyDeath(event: DeathEvent): void {
  try {
    const repoRoot = join(import.meta.dir, "..", "..");
    const script = join(repoRoot, "scripts", "notify-discord.sh");
    if (!existsSync(script)) return;

    const msg = buildDeathMessage(event, config.paths.dataDir);

    const child = spawn("bash", [script, msg], {
      detached: true,
      stdio: "ignore",
      // Inherit PATH from parent so the script can find python3.
      env: process.env,
    });
    // Unref so the parent can exit without waiting on the child.
    child.unref();
  } catch {
    // Intentionally swallow — see jsdoc.
  }
}