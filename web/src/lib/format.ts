/**
 * Hermes Tracker APP — formatters.
 *
 * Pure functions for display. Keep all "how to render" logic here so
 * components stay declarative.
 */

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function formatCentsBudget(cents: number, budgetCents: number): string {
  return `${formatCents(cents)} / ${formatCents(budgetCents)}`;
}

/** Compact duration like "1h 23m" or "42m" or "8s". */
export function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  const hr = Math.floor(sec / 3600);
  const min = Math.floor((sec % 3600) / 60);
  return `${hr}h ${min}m`;
}

/** "5m ago", "2h ago", "3d ago" — relative time. */
export function formatRelative(iso: string, now = Date.now()): string {
  const ts = new Date(iso).getTime();
  const diff = now - ts;
  if (diff < 0) return "just now"; // future timestamps (clock skew)
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

/** Timer countdown — "1h 23m remaining" or "expired". */
export function formatTimerRemaining(expiresAt: number, now = Date.now()): string {
  const diff = expiresAt - now;
  if (diff <= 0) return "expired";
  return `${formatDuration(diff)} remaining`;
}

/** Truncate a string for compact display. */
export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** Compute % done (0-100). */
export function percent(num: number, denom: number): number {
  if (denom === 0) return 0;
  return Math.round((num / denom) * 100);
}