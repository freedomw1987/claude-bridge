import type { Task, TaskStatus } from "@/types";
import { cn } from "@/lib/cn";
import { Check, Circle, Loader2, MinusCircle, X } from "lucide-react";

const ICON: Record<TaskStatus, typeof Check> = {
  done: Check,
  in_progress: Loader2,
  pending: Circle,
  failed: X,
  skipped: MinusCircle,
};

const ICON_CLASS: Record<TaskStatus, string> = {
  done: "text-success",
  in_progress: "text-accent animate-spin",
  pending: "text-fg-muted",
  failed: "text-danger",
  skipped: "text-fg-muted",
};

export function TaskList({ tasks }: { tasks: Task[] }) {
  if (tasks.length === 0) {
    return (
      <p className="text-sm text-fg-muted italic">
        Plan not generated yet.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border rounded-lg border border-border bg-bg-soft">
      {tasks.map((t) => {
        const Icon = ICON[t.status];
        return (
          <li
            key={t.id}
            className={cn(
              "flex items-start gap-3 px-4 py-3 transition-colors hover:bg-bg-elev",
              t.status === "failed" && "bg-danger/5",
            )}
          >
            <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", ICON_CLASS[t.status])} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs text-fg-muted">{t.id}</span>
                <span className="font-medium">{t.title}</span>
                {t.attempts > 1 && (
                  <span className="text-xs text-warn">
                    attempt {t.attempts}
                  </span>
                )}
              </div>
              {t.description && (
                <p className="mt-0.5 text-sm text-fg-dim">{t.description}</p>
              )}
              {t.lastError && (
                <p className="mt-1 text-xs text-danger">
                  {t.lastError}
                </p>
              )}
              {t.lastResult && t.status === "done" && (
                <p className="mt-1 font-mono text-xs text-fg-muted">
                  {t.lastResult}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}