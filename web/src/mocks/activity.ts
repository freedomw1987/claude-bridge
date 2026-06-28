/**
 * Hermes Tracker APP — mock activity data.
 *
 * Aggregates per-day activity from all mock sessions (Hermes +
 * conversations, see projects.ts and conversations.ts) so the contribution
 * graph + cost timeline have realistic shapes. In P2 this is replaced by
 * `/api/activity?days=30` and `/api/sessions/:id/activity`.
 *
 * Shapes:
 *   - DailyActivity:  one bucket per day, with event count + cost
 *   - ProjectActivity: derived per-session timeline with cumulative cost
 */

import { MOCK_HERMES_PROJECTS, getHermesDetail } from "./projects";
import { MOCK_CONVERSATIONS } from "./conversations";
import type { JournalEntry } from "@/types";

const NOW = Date.UTC(2026, 5, 27, 14, 30, 0); // matches projects.ts

/** "YYYY-MM-DD" in UTC. */
function dateKey(iso: string): string {
  return iso.slice(0, 10);
}

function isoDay(offsetDays: number): string {
  // offsetDays: 0 = today, -1 = yesterday, etc.
  return new Date(NOW + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** Per-day aggregated activity across all projects. */
export interface DailyActivity {
  date: string;
  eventCount: number;
  costCents: number;
}

/**
 * Build the last `days` of aggregated activity from all mock projects
 * + their journal entries. Cost per day is approximated by distributing
 * the project's total cost across its journal entries (task_done +
 * task_fail weighted more than plan / status).
 */
export function buildDailyActivity(days: number = 84): DailyActivity[] {
  // weight each journal entry by approximate cost contribution
  const WEIGHT: Record<string, number> = {
    plan: 0.05,
    status: 0.02,
    task_start: 0.0,
    task_done: 0.4,
    task_fail: 0.3,
    judge: 0.05,
    escalate: 0.0,
    timer: 0.0,
    adopt: 0.1,
  };

  // Accumulate per-date (eventCount + weightedCostRatio). Both Hermes
  // journal entries and conversation message timestamps contribute so
  // the heatmap reflects overall user activity, not just orchestration.
  const buckets = new Map<string, { eventCount: number; weightedRatio: number }>();
  for (const project of MOCK_HERMES_PROJECTS) {
    for (const entry of project.journal) {
      const k = dateKey(entry.ts);
      const prev = buckets.get(k) ?? { eventCount: 0, weightedRatio: 0 };
      prev.eventCount += 1;
      prev.weightedRatio += WEIGHT[entry.type] ?? 0;
      buckets.set(k, prev);
    }
  }
  // Conversation messages are lower-weight than journal entries (they
  // don't carry orchestration decisions), but still count.
  for (const conv of MOCK_CONVERSATIONS) {
    for (const msg of conv.messages) {
      const k = dateKey(msg.ts);
      const prev = buckets.get(k) ?? { eventCount: 0, weightedRatio: 0 };
      prev.eventCount += 1;
      prev.weightedRatio += 0.05; // conversation message weight
      buckets.set(k, prev);
    }
  }

  // Normalize cost: scale so the busiest day's weightedRatio maps to
  // ~$2.50 (250 cents). Realistic-feeling without overshooting.
  const peak = Math.max(1, ...Array.from(buckets.values()).map((b) => b.weightedRatio));
  const result: DailyActivity[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = isoDay(-i);
    const b = buckets.get(date);
    const costCents = b ? Math.round((b.weightedRatio / peak) * 250) : 0;
    result.push({
      date,
      eventCount: b?.eventCount ?? 0,
      costCents,
    });
  }
  return result;
}

/** Per-project timeline data — daily cumulative cost + event markers. */
export interface ProjectTimeline {
  projectId: string;
  startedAt: string;
  endedAt: string | null;
  /** Per-day cumulative cost. */
  dailyCumulative: Array<{ date: string; cumulativeCents: number }>;
  /** Individual events that bumped the cost (plan, task_done, ...). */
  events: Array<{
    time: string;
    type: JournalEntry["type"];
    costCents: number;
    message: string;
  }>;
  totalCents: number;
}

const EVENT_WEIGHT: Record<string, number> = {
  plan: 0.05,
  status: 0.02,
  task_start: 0.0,
  task_done: 0.4,
  task_fail: 0.3,
  judge: 0.05,
  escalate: 0.0,
  timer: 0.0,
  adopt: 0.1,
};

export function buildProjectTimeline(projectId: string): ProjectTimeline | null {
  const detail = getHermesDetail(projectId);
  if (!detail) return null;

  const total = detail.costUsd;
  // Distribute total cost across events by EVENT_WEIGHT.
  let totalWeight = 0;
  for (const e of detail.journal) totalWeight += EVENT_WEIGHT[e.type] ?? 0;

  const events: ProjectTimeline["events"] = detail.journal.map((e) => ({
    time: e.ts,
    type: e.type as JournalEntry["type"],
    costCents: totalWeight === 0
      ? 0
      : Math.round(total * ((EVENT_WEIGHT[e.type] ?? 0) / totalWeight)),
    message: e.message,
  }));

  // Daily cumulative cost
  const byDate = new Map<string, number>();
  let running = 0;
  for (const ev of events) {
    running += ev.costCents;
    const k = dateKey(ev.time);
    byDate.set(k, running);
  }
  // Fill in dates between project start and now/end, carrying forward
  const startMs = new Date(detail.startedAt).getTime();
  const endMs = detail.endedAt
    ? new Date(detail.endedAt).getTime()
    : Date.now();
  const dailyCumulative: ProjectTimeline["dailyCumulative"] = [];
  for (let t = startMs; t <= endMs; t += 86_400_000) {
    const k = new Date(t).toISOString().slice(0, 10);
    const cum = byDate.get(k);
    dailyCumulative.push({
      date: k,
      // For dates with no events, carry forward the last known cumulative
      // so the line chart shows the running total smoothly.
      cumulativeCents: cum ?? dailyCumulative[dailyCumulative.length - 1]?.cumulativeCents ?? 0,
    });
  }

  return {
    projectId,
    startedAt: detail.startedAt,
    endedAt: detail.endedAt,
    dailyCumulative,
    events,
    totalCents: total,
  };
}