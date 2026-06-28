import { formatCents, percent } from "@/lib/format";
import { cn } from "@/lib/cn";

export function CostBadge({
  used,
  budget,
  className,
}: {
  used: number;
  budget: number;
  className?: string;
}) {
  const pct = percent(used, budget);
  const overBudget = pct >= 80;
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-bg-elev">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            overBudget ? "bg-warn" : "bg-accent",
            pct >= 100 && "bg-danger",
          )}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-fg-dim">
        {formatCents(used)} / {formatCents(budget)}
      </span>
    </div>
  );
}