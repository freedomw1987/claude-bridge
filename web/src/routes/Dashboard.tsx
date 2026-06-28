import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useSessions, useStats } from "@/hooks/useSessions";
import { SessionCard } from "@/components/SessionCard";
import { EmptyState } from "@/components/EmptyState";
import { RequirementInput, type Attachment } from "@/components/RequirementInput";
import { ContributionGraph } from "@/components/ContributionGraph";
import { Loader2, MessagesSquare, GitBranch, Clock } from "lucide-react";
import { formatCents } from "@/lib/format";
import { cn } from "@/lib/cn";
import { buildDailyActivity } from "@/mocks/activity";
import { getConversationPreview } from "@/mocks/conversations";
import type { SessionMode, SessionSummary } from "@/types";

/**
 * Filter mode for the dashboard list:
 *   "all"          — conversation + Hermes, all statuses
 *   "conversation" — only 1-on-1 conversations
 *   "hermes"       — only Hermes-orchestrated projects
 *
 * Sessions are filtered by mode (not by Hermes status) because the
 * Hermes ↔ conversation distinction is the fundamental model split;
 * Hermes status (active/awaiting/done/...) is a secondary dimension
 * surfaced via the per-card status pill + the "awaiting approval"
 * banner at the top of the page.
 */
type FilterMode = "all" | SessionMode;

const FILTERS: { key: FilterMode; label: string }[] = [
  { key: "all", label: "All" },
  { key: "conversation", label: "Conversations" },
  { key: "hermes", label: "Hermes" },
];

export function Dashboard() {
  const [searchParams, setSearchParams] = useSearchParams();
  // The default filter can be overridden via `?mode=hermes` (from the
  // Projects nav item). The filter state lives in the URL so the
  // browser back/forward works correctly and the filter survives reload.
  const filterFromUrl = (searchParams.get("mode") as FilterMode | null);
  const initialFilter: FilterMode =
    filterFromUrl === "hermes" || filterFromUrl === "conversation"
      ? filterFromUrl
      : "all";
  const [filter, setFilter] = useState<FilterMode>(initialFilter);

  // Keep URL in sync when user clicks a tab.
  useEffect(() => {
    const urlMode = searchParams.get("mode");
    const wantMode = filter === "all" ? null : filter;
    if (urlMode !== wantMode) {
      setSearchParams(wantMode ? { mode: wantMode } : {}, { replace: true });
    }
  }, [filter, searchParams, setSearchParams]);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const sessions = useSessions();
  const stats = useStats();

  const visible = sessions.data
    ? sessions.data.filter((s) => filter === "all" || s.mode === filter)
    : [];

  // Counts per filter for the tab badges.
  const counts = useMemo(() => {
    const c: Record<FilterMode, number> = { all: 0, conversation: 0, hermes: 0 };
    for (const s of sessions.data ?? []) {
      c.all++;
      c[s.mode]++;
    }
    return c;
  }, [sessions.data]);

  // Build activity heatmap from mock data (Phase 2: real API).
  // 365 days = 52 weeks ≈ GitHub's default "last year" view.
  const dailyActivity = useMemo(() => buildDailyActivity(365), []);

  /**
   * P1 mock: receive a new conversation start. Phase 3 wires this to
   * POST /api/sessions — the new entry appears at the top of the list.
   */
  async function handleNewConversation(text: string, attachments: Attachment[]) {
    setIsSubmitting(true);
    try {
      await new Promise((r) => setTimeout(r, 600));
      toast.success("Conversation started (mock)", {
        description:
          `Goal: "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"\n` +
          `Attachments: ${attachments.length}\n` +
          `→ Real backend ships in Phase 3.`,
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  // Surface awaiting-approval projects at the top.
  const awaitingProjects = (sessions.data ?? []).filter(
    (s) => s.mode === "hermes" && s.status === "awaiting_approval",
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
        <p className="mt-1 text-sm text-fg-dim">
          Conversations with Claude Code and Hermes-managed projects —
          past, present, and awaiting review.
        </p>
      </header>

      {/* New conversation input — this is the default action in the
          new "conversation-first" model. Hermes projects are created
          via /project start or by adopting a conversation. */}
      <RequirementInput
        placeholder="Start a new conversation… Type, drop files, or hold the mic to speak."
        submitLabel="New conversation"
        onSubmit={handleNewConversation}
        isSubmitting={isSubmitting}
      />

      {/* Stats bar */}
      {stats.data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            label="Total spent"
            value={formatCents(stats.data.totalCostUsd)}
          />
          <StatCard
            label="Last 24h"
            value={formatCents(stats.data.cost24hUsd)}
          />
          <StatCard
            label="Hermes success"
            value={`${stats.data.hermesSuccessRate}%`}
            accent={stats.data.hermesSuccessRate >= 70 ? "success" : "warn"}
          />
          <StatCard
            label="Active"
            value={String(
              (stats.data.countByStatus.executing ?? 0) +
                (stats.data.countByStatus.judging ?? 0) +
                (stats.data.countByStatus.active ?? 0) +
                (stats.data.countByStatus.planning ?? 0),
            )}
          />
        </div>
      )}

      {/* Contribution graph — last 365 days across all sessions */}
      <div className="rounded-lg border border-border bg-bg-soft p-4">
        <ContributionGraph days={dailyActivity} />
      </div>

      {/* Awaiting-approval banner — only shown when there are pending
          Hermes plans (the user's main call-to-action: review & approve). */}
      {awaitingProjects.length > 0 && (
        <AwaitingBanner projects={awaitingProjects} />
      )}

      {/* Filter tabs — mode-based grouping */}
      <div className="flex items-center gap-1 rounded-lg border border-border bg-bg-soft p-1">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              filter === f.key
                ? "bg-bg-elev text-fg shadow-sm"
                : "text-fg-dim hover:text-fg",
            )}
          >
            <span className="inline-flex items-center gap-1.5">
              {f.key === "conversation" && <MessagesSquare className="h-3.5 w-3.5" />}
              {f.key === "hermes" && <GitBranch className="h-3.5 w-3.5" />}
              {f.label}
              {sessions.data && (
                <span className="ml-1 text-xs text-fg-muted">{counts[f.key]}</span>
              )}
            </span>
          </button>
        ))}
      </div>

      {/* Loading / error / content */}
      {sessions.isLoading && (
        <div className="flex items-center justify-center py-12 text-fg-muted">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="ml-2 text-sm">Loading sessions…</span>
        </div>
      )}

      {sessions.isError && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 p-4 text-sm text-danger">
          Failed to load sessions: {String(sessions.error)}
        </div>
      )}

      {sessions.data && visible.length === 0 && (
        <EmptyState
          message={
            filter === "conversation"
              ? "No active conversations. Start one above."
              : filter === "hermes"
                ? "No Hermes projects yet. /project start in Discord, or adopt a conversation."
                : "No sessions yet."
          }
        />
      )}

      {visible.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {visible.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              preview={s.mode === "conversation" ? getConversationPreview(s.id) : null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "success" | "warn";
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-soft p-3">
      <div className="text-xs uppercase tracking-wider text-fg-muted">{label}</div>
      <div
        className={cn(
          "mt-1 text-xl font-semibold tabular-nums",
          accent === "success" && "text-success",
          accent === "warn" && "text-warn",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function AwaitingBanner({ projects }: { projects: SessionSummary[] }) {
  return (
    <div className="rounded-lg border border-warn/30 bg-warn/5 p-4">
      <div className="mb-2 flex items-center gap-2">
        <Clock className="h-4 w-4 text-warn" />
        <span className="font-medium">Hermes plans awaiting your review</span>
        <span className="text-xs text-fg-muted">({projects.length})</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {projects.map((p) => (
          <Link
            key={p.id}
            to={`/sessions/${encodeURIComponent(p.id)}`}
            className="inline-flex items-center gap-2 rounded-md border border-warn/30 bg-bg px-3 py-1.5 text-sm hover:bg-bg-elev"
          >
            <span className="font-mono text-xs text-fg-muted">{p.shortId}</span>
            <span className="truncate max-w-xs">{p.goal}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}