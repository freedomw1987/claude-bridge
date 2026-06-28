/**
 * Hermes Tracker APP — API client.
 *
 * P1: wraps fetch() against mock data (mocks/projects.ts + mocks/conversations.ts).
 * P2: swaps to live HTTP calls when the bot exposes /api/sessions,
 *     /api/sessions/:id, /api/sessions/:id/journal (SSE), /api/stats.
 *
 * Vite proxies /api → http://127.0.0.1:8080 in dev (see vite.config.ts).
 */

import type {
  ConversationDetail,
  HermesProjectDetail,
  SessionDetail,
  SessionMode,
  SessionSummary,
  Stats,
} from "@/types";
import {
  listConversationSummaries,
  getConversationDetail,
} from "@/mocks/conversations";
import {
  listHermesSummaries,
  getHermesDetail,
} from "@/mocks/projects";

/** Toggleable: set to false once Phase 2 backend is wired in. */
const USE_MOCKS = true;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch all sessions. Optionally filter by mode (conversation | hermes).
 * Sorted by lastActivityAt descending.
 */
export async function fetchSessions(opts: { mode?: SessionMode } = {}): Promise<SessionSummary[]> {
  if (USE_MOCKS) {
    await delay(80);
    const conv = listConversationSummaries();
    const herm = listHermesSummaries();
    const all = [...conv, ...herm];
    const filtered = opts.mode ? all.filter((s) => s.mode === opts.mode) : all;
    return filtered.sort(
      (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
    );
  }
  const params = new URLSearchParams();
  if (opts.mode) params.set("mode", opts.mode);
  const res = await fetch(`/api/sessions?${params}`);
  if (!res.ok) throw new Error(`fetchSessions: ${res.status}`);
  return res.json();
}

export async function fetchSession(id: string): Promise<SessionDetail> {
  if (USE_MOCKS) {
    await delay(80);
    const herm = getHermesDetail(id);
    if (herm) return herm;
    const conv = getConversationDetail(id);
    if (conv) return conv;
    throw new Error(`Session not found: ${id}`);
  }
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`fetchSession: ${res.status}`);
  return res.json();
}

export async function fetchStats(): Promise<Stats> {
  if (USE_MOCKS) {
    await delay(80);
    const all = [...listConversationSummaries(), ...listHermesSummaries()];
    const totalCost = all.reduce((sum, s) => sum + s.costUsd, 0);
    const hermesStatuses = all.filter((s) => s.mode === "hermes").map((s) => s.status);
    const done = hermesStatuses.filter((s) => s === "done").length;
    const terminal = hermesStatuses.filter(
      (s) => s === "done" || s === "failed" || s === "killed",
    ).length;
    const hermesSuccessRate = terminal === 0 ? 0 : Math.round((done / terminal) * 100);
    const last24hMs = Date.now() - 24 * 60 * 60 * 1000;
    return {
      totalCostUsd: totalCost,
      cost24hUsd: all
        .filter((s) => new Date(s.lastActivityAt).getTime() > last24hMs)
        .reduce((sum, s) => sum + s.costUsd, 0),
      hermesSuccessRate,
      countByMode: {
        conversation: all.filter((s) => s.mode === "conversation").length,
        hermes: all.filter((s) => s.mode === "hermes").length,
      },
      countByStatus: all.reduce(
        (acc, s) => {
          acc[s.status] = (acc[s.status] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      ),
    };
  }
  const res = await fetch("/api/stats");
  if (!res.ok) throw new Error(`fetchStats: ${res.status}`);
  return res.json();
}

/**
 * SSE stream for the session journal.
 *
 * P1: stub. P2 connects to /api/sessions/:id/journal via EventSource.
 */
export async function* streamJournal(
  _sessionId: string,
  _sinceEntryCount = 0,
): AsyncIterable<{ ts: string; type: string; message: string }> {
  if (false as boolean) {
    yield { ts: "", type: "", message: "" };
  }
}

// Re-export the detail types so callers can import them from one place.
export type { SessionSummary, SessionDetail, ConversationDetail, HermesProjectDetail };