import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import type { DailyActivity } from "@/mocks/activity";

/**
 * GitHub-style contribution graph — heatmap of per-day activity.
 *
 * Layout: 7 rows (Sun-Sat) × N columns (weeks). Each cell colored
 * by activity intensity (event count + cost). Hover shows tooltip
 * with date + count + cost.
 *
 * Sizing follows GitHub's actual proportions: 11×11px cells with 3px
 * gaps, 7 rows = 98px tall + 16px month-label band = ~114px total.
 * Pure SVG, no chart library. Responsive via `viewBox`.
 */

const DAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];
const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const CELL = 11;
const GAP = 3;
// GitHub's contribution graph sizing reference:
//   - cells are 11×11 viewBox units
//   - 3-unit gap between cells (= 3px at natural render)
//   - 7-day column × N-week row layout
// At natural render this gives cells that LOOK ~11px on screen,
// matching github.com. The previous `minWidth: W` on the SVG was
// forcing it to stretch to the container width and scale up to
// 60×60px cells — visually wrong. The fix: don't force width;
// let the SVG render at viewBox natural size and only shrink if
// the container is narrower (e.g. on mobile).
const MONTH_LABEL_BAND = 14; // band reserved above cells for month names

function intensityClass(costCents: number, peakCents: number): string {
  if (costCents === 0) return "fill-bg-elev";
  const ratio = costCents / Math.max(1, peakCents);
  if (ratio < 0.25) return "fill-accent/25";
  if (ratio < 0.5) return "fill-accent/45";
  if (ratio < 0.75) return "fill-accent/70";
  return "fill-accent";
}

export function ContributionGraph({
  days,
  className,
}: {
  days: DailyActivity[];
  className?: string;
}) {
  const [hovered, setHovered] = useState<{ day: DailyActivity; x: number; y: number } | null>(null);

  // Group days into weeks (columns). Pad the start so the first column
  // aligns to the correct weekday (so Sat/Sun/etc. line up).
  const firstDate = days[0] ? new Date(days[0].date) : new Date();
  const firstDow = firstDate.getUTCDay(); // 0 = Sun
  const padded: Array<DailyActivity | null> = [
    ...Array(firstDow).fill(null),
    ...days,
  ];
  const weekCount = Math.ceil(padded.length / 7);
  const peakCents = useMemo(
    () => Math.max(1, ...days.map((d) => d.costCents)),
    [days],
  );

  // Month label positions — show month name at the first column of
  // each new month.
  const monthLabelPositions: Array<{ week: number; month: number }> = [];
  let lastMonth = -1;
  for (let w = 0; w < weekCount; w++) {
    const idx = w * 7;
    const cell = padded[idx];
    if (!cell) continue;
    const m = new Date(cell.date).getUTCMonth();
    if (m !== lastMonth) {
      monthLabelPositions.push({ week: w, month: m });
      lastMonth = m;
    }
  }

  const W = weekCount * (CELL + GAP);
  const H = MONTH_LABEL_BAND + 7 * (CELL + GAP);

  return (
    <div className={cn("relative", className)}>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-fg-muted">
          Activity
        </h3>
        <div className="flex items-center gap-1 text-[10px] text-fg-muted">
          <span>Less</span>
          {[0, 0.25, 0.5, 0.75, 1].map((r) => (
            <span
              key={r}
              className={cn(
                "inline-block h-2.5 w-2.5 rounded-sm",
                intensityClass(r * peakCents, peakCents),
              )}
            />
          ))}
          <span>More</span>
        </div>
      </div>

      <div className="flex">
        {/* Day-of-week labels — height matches CELL so rows align */}
        <div className="mr-1.5 mt-[14px] flex flex-col gap-[3px] text-[10px] text-fg-muted">
          {DAY_LABELS.map((l, i) => (
            <div key={i} style={{ height: CELL }}>{l}</div>
          ))}
        </div>

        <div className="overflow-x-auto">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            width={W}
            height={H}
            style={{ maxWidth: "100%", height: "auto" }}
            role="img"
            aria-label="Contribution graph"
          >
            {/* Month labels (top) */}
            {monthLabelPositions.map(({ week, month }) => (
              <text
                key={`${week}-${month}`}
                x={week * (CELL + GAP)}
                y={11}
                className="fill-fg-muted"
                fontSize={9}
              >
                {MONTH_LABELS[month]}
              </text>
            ))}
            {/* Cells — start below the month-label band */}
            {padded.map((day, i) => {
              const w = Math.floor(i / 7);
              const dow = i % 7;
              const x = w * (CELL + GAP);
              const y = MONTH_LABEL_BAND + dow * (CELL + GAP);
              if (!day) {
                return (
                  <rect
                    key={`empty-${i}`}
                    x={x}
                    y={y}
                    width={CELL}
                    height={CELL}
                    rx={2}
                    className="fill-transparent"
                  />
                );
              }
              return (
                <rect
                  key={day.date}
                  x={x}
                  y={y}
                  width={CELL}
                  height={CELL}
                  rx={2}
                  className={cn(
                    intensityClass(day.costCents, peakCents),
                    "cursor-pointer transition-opacity hover:opacity-80",
                  )}
                  onMouseEnter={(e) => {
                    const rect = (e.target as SVGElement).getBoundingClientRect();
                    setHovered({
                      day,
                      x: rect.left + rect.width / 2,
                      y: rect.top,
                    });
                  }}
                  onMouseLeave={() => setHovered(null)}
                />
              );
            })}
          </svg>
        </div>
      </div>

      {/* Tooltip */}
      {hovered && (
        <div
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-bg-elev px-2 py-1.5 text-xs shadow-elev"
          style={{ left: hovered.x, top: hovered.y - 8 }}
        >
          <div className="font-mono text-fg-muted">{hovered.day.date}</div>
          <div>
            <span className="font-medium">{hovered.day.eventCount}</span>{" "}
            <span className="text-fg-muted">events</span>
          </div>
          <div>
            <span className="font-medium tabular-nums">
              ${(hovered.day.costCents / 100).toFixed(2)}
            </span>{" "}
            <span className="text-fg-muted">spent</span>
          </div>
        </div>
      )}
    </div>
  );
}