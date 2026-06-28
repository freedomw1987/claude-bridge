import { Link } from "react-router-dom";
import { MessagesSquare, GitBranch } from "lucide-react";
import { StatusPill } from "./StatusPill";
import { TimerLine } from "./TimerLine";
import { cn } from "@/lib/cn";
import { formatCents, formatRelative } from "@/lib/format";
import type { SessionMode, SessionSummary } from "@/types";

/**
 * ModeBadge — small pill that distinguishes conversation vs Hermes.
 * The pill color + icon make scanning the dashboard list easy:
 *   - Conversation: indigo/blue, chat icon
 *   - Hermes: violet/accent, branch icon
 */
function ModeBadge({ mode }: { mode: SessionMode }) {
  if (mode === "conversation") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-accent">
        <MessagesSquare className="h-3 w-3" />
        Conversation
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-warn/30 bg-warn/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-warn">
      <GitBranch className="h-3 w-3" />
      Hermes
    </span>
  );
}

/**
 * SessionCard — single session in the dashboard list.
 * Renders differently for conversation vs Hermes mode so the most
 * useful info bubbles up first.
 */
export function SessionCard({
  session,
  preview,
  className,
}: {
  session: SessionSummary;
  /** Conversation-mode: last assistant message preview. Optional. */
  preview?: string | null;
  className?: string;
}) {
  const isConversation = session.mode === "conversation";
  const isHermes = !isConversation;
  const isActive = session.status === "active" || session.status === "executing" || session.status === "judging" || session.status === "planning";
  const isAwaitingApproval = session.status === "awaiting_approval";

  return (
    <Link
      to={`/sessions/${session.id}`}
      className={cn(
        "block rounded-lg border border-border bg-bg-soft p-4 transition-colors hover:bg-bg-elev hover:border-fg-muted/30",
        isAwaitingApproval && "border-warn/40",
        isActive && "ring-1 ring-accent/20",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {/* Title row: goal + mode badge */}
          <div className="flex items-center gap-2">
            <ModeBadge mode={session.mode} />
            <h3 className="truncate font-mono text-xs text-fg-muted">{session.shortId}</h3>
          </div>
          <p className="mt-1 truncate text-sm font-medium">{session.goal}</p>
        </div>
        <StatusPill status={session.status} />
      </div>

      {/* Body — different content per mode */}
      {isConversation ? (
        <p className="mt-2 line-clamp-2 text-xs text-fg-dim">
          {preview ?? "No messages yet."}
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
          <div>
            <span className="text-fg-muted">Tasks</span>{" "}
            <span className="font-mono tabular-nums">
              {session.taskDone ?? 0}/{session.taskTotal ?? 0}
            </span>
          </div>
          <div>
            <span className="text-fg-muted">Cost</span>{" "}
            <span className="font-mono tabular-nums">{formatCents(session.costUsd)}</span>
          </div>
          <div>
            <span className="text-fg-muted">Iter</span>{" "}
            <span className="font-mono tabular-nums">{session.totalMessages}</span>
          </div>
        </div>
      )}

      {/* Footer — meta + timer for active Hermes */}
      <div className="mt-3 flex items-center justify-between text-xs text-fg-muted">
        <span>{formatRelative(session.lastActivityAt)}</span>
        {isHermes && session.timer && isActive ? (
          <TimerLine timer={session.timer} compact />
        ) : (
          <span>{formatCents(session.costUsd)}</span>
        )}
      </div>
    </Link>
  );
}