import type { Status } from "@/types";
import { cn } from "@/lib/cn";

/**
 * StatusPill — unified pill for both conversation and Hermes statuses.
 * Conversation statuses ("active", "idle") sit alongside the Hermes
 * lifecycle statuses so the same component renders both kinds.
 */
const STATUS_STYLES: Record<Status, { label: string; classes: string }> = {
  // Conversation statuses
  active: {
    label: "Active",
    classes: "bg-accent/15 text-accent border-accent/30",
  },
  idle: {
    label: "Idle",
    classes: "bg-bg-elev text-fg-dim border-border",
  },
  // Hermes statuses
  planning: {
    label: "Planning",
    classes: "bg-bg-elev text-fg-dim border-border",
  },
  awaiting_approval: {
    label: "Awaiting approval",
    classes: "bg-warn/10 text-warn border-warn/30",
  },
  executing: {
    label: "Executing",
    classes: "bg-accent/15 text-accent border-accent/30",
  },
  judging: {
    label: "Judging",
    classes: "bg-accent/15 text-accent border-accent/30",
  },
  done: {
    label: "Done",
    classes: "bg-success/15 text-success border-success/30",
  },
  failed: {
    label: "Failed",
    classes: "bg-danger/15 text-danger border-danger/30",
  },
  killed: {
    label: "Killed",
    classes: "bg-fg-muted/15 text-fg-muted border-fg-muted/30",
  },
  timed_out: {
    label: "Timed out",
    classes: "bg-warn/15 text-warn border-warn/30",
  },
  parse_error: {
    label: "Parse error",
    classes: "bg-danger/15 text-danger border-danger/30",
  },
  judge_timed_out: {
    label: "Judge timed out",
    classes: "bg-warn/15 text-warn border-warn/30",
  },
  judge_parse_error: {
    label: "Judge parse error",
    classes: "bg-danger/15 text-danger border-danger/30",
  },
};

export function StatusPill({ status, className }: { status: Status; className?: string }) {
  const s = STATUS_STYLES[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        s.classes,
        className,
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-60" />
      {s.label}
    </span>
  );
}