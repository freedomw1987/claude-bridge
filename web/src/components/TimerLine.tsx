import { formatTimerRemaining } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { ProjectTimer } from "@/types";

/**
 * TimerLine — shows remaining time on an auto-mode Hermes project.
 *
 * Two variants:
 *   - default: full card with icon + remaining + budget (used in
 *     ProjectDetail / SessionDetail for the active project header)
 *   - compact: inline text only, used in SessionCard on the dashboard
 *     to avoid visual weight
 */
export function TimerLine({
  timer,
  compact = false,
}: {
  timer: ProjectTimer;
  compact?: boolean;
}) {
  const remaining = formatTimerRemaining(timer.expiresAt);
  if (compact) {
    return (
      <span className={cn("font-mono tabular-nums text-warn")}>
        ⏱ {remaining}
      </span>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm">
      <span className="text-warn">⏱</span>
      <span className="font-mono tabular-nums">{remaining}</span>
      <span className="text-fg-muted">·</span>
      <span className="text-fg-muted">{timer.requestedDuration} budget</span>
    </div>
  );
}