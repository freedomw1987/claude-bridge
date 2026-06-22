/**
 * Duration parser for `/project setMode auto <duration>`.
 *
 * Format (strict, digits + unit, no spaces, units in descending order):
 *   "30s"   → 30 seconds
 *   "30m"   → 30 minutes
 *   "2h"    → 2 hours
 *   "1d"    → 1 day
 *   "1h30m" → 1.5 hours
 *   "1d12h" → 1.5 days
 *
 * Returns `null` for:
 *   - empty / whitespace input
 *   - invalid format
 *   - zero
 *   - overflow > MAX_DURATION_MS (1 year)
 *   - any unit other than s/m/h/d
 *
 * Pure function, no I/O. Easy to unit-test.
 */

/** Hard ceiling to prevent accidental `setTimeout` blowups. */
export const MAX_DURATION_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

const UNIT_ORDER = ["d", "h", "m", "s"] as const;

/**
 * Parse a duration string into milliseconds.
 * @param input - the raw user input (e.g. "30m", "1h30m")
 * @returns milliseconds, or `null` if the input is invalid/empty/zero/overflow
 */
export function parseDuration(input: string | null | undefined): number | null {
  if (input == null) return null;
  const s = input.trim().toLowerCase();
  if (s.length === 0) return null;

  // Match a sequence of (digits+unit) pairs; the regex enforces unit order.
  // Examples: "1d12h", "30m", "2h", "1h30m", "90s"
  // We also accept a single bare number (interpreted as seconds for back-compat)
  // — actually we don't, ADR-0004 says strict digits+unit format.
  const re = /^(\d+)([dhms])/;
  let rest = s;
  let total = 0;
  let lastUnitRank = -1;

  while (rest.length > 0) {
    const m = re.exec(rest);
    if (!m) {
      // Bad segment after a valid one (e.g. "1h30" without unit, or "1h30x")
      return null;
    }
    const value = parseInt(m[1], 10);
    const unit = m[2];
    const rank = UNIT_ORDER.indexOf(unit as (typeof UNIT_ORDER)[number]);
    if (rank < 0) return null;
    if (rank <= lastUnitRank) {
      // Units must be strictly descending (no "30m1h" or "1m1m")
      return null;
    }
    total += value * UNIT_MS[unit];
    if (total > MAX_DURATION_MS) return null;
    lastUnitRank = rank;
    rest = rest.slice(m[0].length);
  }

  if (total <= 0) return null;
  return total;
}

/**
 * Format a millisecond duration back to a human-readable string.
 * Inverse of `parseDuration` for canonical inputs.
 * Examples: 1800000 → "30m", 5400000 → "1h30m", 90000 → "1m30s"
 *
 * Returns "0s" for falsy/zero/negative values.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  let remaining = Math.floor(ms / 1000); // seconds
  const days = Math.floor(remaining / 86400);
  remaining -= days * 86400;
  const hours = Math.floor(remaining / 3600);
  remaining -= hours * 3600;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining - minutes * 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.length > 0 ? parts.join("") : "0s";
}

/**
 * Format a millisecond duration as a Discord-friendly countdown "M:SS" or
 * "H:MM:SS" for the status embed. Strips leading zero on minutes for short
 * durations.
 *
 *   1500       → "0:01"
 *   90000      → "1:30"
 *   1800000    → "30:00"
 *   3600000    → "1:00:00"
 *   86400000   → "24:00:00"
 *   90061000   → "25:01:01"
 */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}
