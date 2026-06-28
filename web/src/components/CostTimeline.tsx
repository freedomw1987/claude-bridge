import { useMemo, useState } from "react";
import { formatCents } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { ProjectTimeline } from "@/mocks/activity";

/**
 * CostTimeline — line chart of cumulative cost over time for one
 * project. SVG-only, no chart library.
 *
 * Shows:
 *   - X axis: time (project start → end, or now if active)
 *   - Y axis: cumulative cost in cents
 *   - Line + filled area
 *   - Dots at each cost event (task_done, plan, ...) with hover tooltip
 */

const WIDTH = 720;
const HEIGHT = 180;
const PADDING = { top: 12, right: 16, bottom: 28, left: 56 };

interface ChartGeom {
  pathD: string;
  areaD: string;
  /** Day → cumulative cents (from timeline) plus screen coords */
  points: Array<{ date: string; cents: number; px: number; py: number }>;
  /** Event → screen coords for the dot */
  events: Array<{ e: ProjectTimeline["events"][number]; px: number; py: number }>;
  yLabels: Array<{ cents: number; py: number }>;
  xLabels: Array<{ label: string; px: number }>;
}

function buildGeom(timeline: ProjectTimeline): ChartGeom {
  const startMs = new Date(timeline.startedAt).getTime();
  const endMs = timeline.endedAt
    ? new Date(timeline.endedAt).getTime()
    : Date.now();
  const span = Math.max(1, endMs - startMs);
  const peak = Math.max(1, ...timeline.dailyCumulative.map((d) => d.cumulativeCents));

  const usableW = WIDTH - PADDING.left - PADDING.right;
  const usableH = HEIGHT - PADDING.top - PADDING.bottom;
  const x = (t: number) => PADDING.left + ((t - startMs) / span) * usableW;
  const y = (cents: number) => PADDING.top + (1 - cents / peak) * usableH;

  // Day → cumulative cents + screen coords
  const points = timeline.dailyCumulative.map((d) => ({
    date: d.date,
    cents: d.cumulativeCents,
    px: x(new Date(d.date).getTime()),
    py: y(d.cumulativeCents),
  }));

  // Path + area
  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.px.toFixed(1)} ${p.py.toFixed(1)}`)
    .join(" ");
  const areaD =
    `M ${points[0]?.px.toFixed(1) ?? x(startMs)} ${HEIGHT - PADDING.bottom} ` +
    points.map((p) => `L ${p.px.toFixed(1)} ${p.py.toFixed(1)}`).join(" ") +
    ` L ${points[points.length - 1]?.px.toFixed(1) ?? x(endMs)} ${HEIGHT - PADDING.bottom} Z`;

  // Y-axis labels: 5 ticks from 0 to peak
  const yLabels = [0, 0.25, 0.5, 0.75, 1].map((r) => ({
    cents: Math.round(peak * r),
    py: y(peak * r),
  }));

  // X-axis labels: start, 3 evenly-spaced, end (relative dates)
  const fmtDate = (ms: number) =>
    new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
  const xLabels = [0, 0.25, 0.5, 0.75, 1].map((r) => ({
    label: fmtDate(startMs + span * r),
    px: x(startMs + span * r),
  }));

  // Event dots — only those with non-zero cost
  const events = timeline.events
    .filter((e) => e.costCents > 0)
    .map((e) => {
      const dayKey = e.time.slice(0, 10);
      const dayPoint = points.find((p) => p.date === dayKey);
      if (!dayPoint) return null;
      return { e, px: dayPoint.px, py: dayPoint.py };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return { pathD, areaD, points, events, yLabels, xLabels };
}

export function CostTimeline({
  timeline,
  className,
}: {
  timeline: ProjectTimeline;
  className?: string;
}) {
  const [hovered, setHovered] = useState<{
    event: ProjectTimeline["events"][number];
    x: number;
    y: number;
  } | null>(null);

  const geom = useMemo(() => buildGeom(timeline), [timeline]);

  return (
    <div className={cn("relative", className)}>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-fg-muted">
          Cost over time
        </h3>
        <span className="font-mono text-sm tabular-nums">
          {formatCents(timeline.totalCents)}
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-bg-soft p-3">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          width="100%"
          style={{ minWidth: 320, maxWidth: "100%" }}
          role="img"
          aria-label="Cost timeline"
        >
          {/* Y-axis gridlines + labels */}
          {geom.yLabels.map((label, i) => (
            <g key={`y-${i}`}>
              <line
                x1={PADDING.left}
                x2={WIDTH - PADDING.right}
                y1={label.py}
                y2={label.py}
                className="stroke-border"
                strokeWidth={1}
                strokeDasharray="2 4"
              />
              <text
                x={PADDING.left - 6}
                y={label.py + 3}
                textAnchor="end"
                className="fill-fg-muted"
                fontSize={10}
              >
                {formatCents(label.cents)}
              </text>
            </g>
          ))}

          {/* Filled area under line */}
          <path d={geom.areaD} className="fill-accent/10" />

          {/* Line */}
          <path
            d={geom.pathD}
            className="stroke-accent fill-none"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* X-axis labels */}
          {geom.xLabels.map((l, i) => (
            <g key={`x-${i}`}>
              <line
                x1={l.px}
                x2={l.px}
                y1={HEIGHT - PADDING.bottom}
                y2={HEIGHT - PADDING.bottom + 4}
                className="stroke-fg-muted"
                strokeWidth={1}
              />
              <text
                x={l.px}
                y={HEIGHT - PADDING.bottom + 16}
                textAnchor="middle"
                className="fill-fg-muted"
                fontSize={10}
              >
                {l.label}
              </text>
            </g>
          ))}

          {/* Event dots */}
          {geom.events.map((ev, i) => (
            <circle
              key={`ev-${i}`}
              cx={ev.px}
              cy={ev.py}
              r={3.5}
              className="fill-accent stroke-bg"
              strokeWidth={1.5}
              style={{ cursor: "pointer" }}
              onMouseEnter={(me) => {
                const r = (me.currentTarget as SVGCircleElement).getBoundingClientRect();
                setHovered({
                  event: ev.e,
                  x: r.left + r.width / 2,
                  y: r.top,
                });
              }}
              onMouseLeave={() => setHovered(null)}
            />
          ))}
        </svg>

        {hovered && (
          <div
            className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-bg-elev px-2 py-1.5 text-xs shadow-elev"
            style={{ left: hovered.x, top: hovered.y - 8 }}
          >
            <div className="font-mono text-fg-muted">
              {new Date(hovered.event.time).toLocaleString([], {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </div>
            <div>
              <span className="rounded bg-bg px-1 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-dim">
                {hovered.event.type}
              </span>
              <span className="ml-1.5 font-medium tabular-nums">
                +{formatCents(hovered.event.costCents)}
              </span>
            </div>
            <div className="mt-0.5 max-w-xs truncate text-fg-muted">
              {hovered.event.message}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}