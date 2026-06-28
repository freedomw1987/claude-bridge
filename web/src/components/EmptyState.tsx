import { Inbox } from "lucide-react";

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-bg-soft px-6 py-12 text-center">
      <Inbox className="mb-3 h-10 w-10 text-fg-muted opacity-50" />
      <p className="text-sm text-fg-muted">{message}</p>
    </div>
  );
}