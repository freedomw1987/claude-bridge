import { Sparkles } from "lucide-react";

/**
 * AI-generated project summary card. In P1 this is a static
 * placeholder; in P2.5 we'll call the bot's
 * /api/projects/:id/summary endpoint (a haiku-powered summarizer).
 */
export function AISummaryCard({ summary }: { summary: string }) {
  return (
    <div className="rounded-lg border border-accent/30 bg-accent/5 p-4">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-accent">
        <Sparkles className="h-3.5 w-3.5" />
        AI Summary
      </div>
      <p className="text-sm leading-relaxed text-fg-dim">{summary}</p>
    </div>
  );
}