/**
 * Hermes Tracker APP — API client.
 *
 * P2 (2026-06-27): reads from the live bot backend at
 *   http://127.0.0.1:8080/api/*
 * via Vite's dev proxy (or directly in production via Tauri's
 * localhost bridge).
 *
 * Fallback: if `USE_MOCKS = true`, the local mocks in
 * `src/mocks/{conversations,projects}.ts` are served instead. This is
 * useful for:
 *   - Quick UI iteration without the bot running
 *   - Seeing rich mock data (e.g. the 4 conversation transcripts in
 *     mocks/conversations.ts have realistic message histories; the
 *     bot's sessions.db has no message archive yet — P3 work)
 *
 * The backend returns Hermes projects from `data/hermes/projects/`
 * and conversations from `data/sessions.db`. Hermes projects on disk
 * will show full data; conversations always have empty `messages[]`
 * in the live backend (until P3 adds message archive).
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
  MOCK_CONVERSATIONS,
  listConversationSummaries,
  getConversationDetail,
} from "@/mocks/conversations";
import {
  MOCK_HERMES_PROJECTS,
  listHermesSummaries,
  getHermesDetail,
} from "@/mocks/projects";

/**
 * Toggleable: defaults to `false` (live backend). Set to `true` to
 * use local mocks — useful for UI development without the bot running
 * or for showcasing the rich conversation transcripts in mocks.
 */
const USE_MOCKS = false;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Mock fetches (only used when USE_MOCKS = true) ──────────────────

async function fetchSessionsMock(): Promise<SessionSummary[]> {
  await delay(80);
  const conv = listConversationSummaries();
  const herm = listHermesSummaries();
  const all = [...conv, ...herm];
  return all.sort(
    (a, b) =>
      new Date(b.lastActivityAt).getTime() -
      new Date(a.lastActivityAt).getTime(),
  );
}

async function fetchSessionMock(id: string): Promise<SessionDetail> {
  await delay(80);
  const herm = getHermesDetail(id);
  if (herm) return herm;
  const conv = getConversationDetail(id);
  if (conv) return conv;
  throw new Error(`Session not found: ${id}`);
}

async function fetchStatsMock(): Promise<Stats> {
  await delay(80);
  const all = [...MOCK_CONVERSATIONS, ...MOCK_HERMES_PROJECTS];
  const totalCost = all.reduce((sum, s) => sum + s.costUsd, 0);
  const hermesStatuses = all
    .filter((s) => s.mode === "hermes")
    .map((s) => s.status);
  const done = hermesStatuses.filter((s) => s === "done").length;
  const terminal = hermesStatuses.filter(
    (s) => s === "done" || s === "failed" || s === "killed",
  ).length;
  const hermesSuccessRate = terminal === 0 ? 0 : Math.round((done / terminal) * 100);
  return {
    totalCostUsd: totalCost,
    cost24hUsd: 85,
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

// ── Public API ──────────────────────────────────────────────────────

/** Optional `mode` filter to fetch only conversation or Hermes sessions. */
export async function fetchSessions(
  opts: { mode?: SessionMode } = {},
): Promise<SessionSummary[]> {
  if (USE_MOCKS) {
    const all = await fetchSessionsMock();
    return opts.mode ? all.filter((s) => s.mode === opts.mode) : all;
  }
  const res = await fetch("/api/projects");
  if (!res.ok) throw new Error(`fetchSessions: ${res.status}`);
  const data = (await res.json()) as {
    hermes: SessionSummary[];
    conversation: SessionSummary[];
  };
  const all = [...data.hermes, ...data.conversation].sort(
    (a, b) =>
      new Date(b.lastActivityAt).getTime() -
      new Date(a.lastActivityAt).getTime(),
  );
  return opts.mode ? all.filter((s) => s.mode === opts.mode) : all;
}

export async function fetchSession(id: string): Promise<SessionDetail> {
  if (USE_MOCKS) return fetchSessionMock(id);
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`fetchSession: ${res.status}`);
  return res.json();
}

export async function fetchStats(): Promise<Stats> {
  if (USE_MOCKS) return fetchStatsMock();
  const res = await fetch("/api/stats");
  if (!res.ok) throw new Error(`fetchStats: ${res.status}`);
  return res.json();
}

/**
 * SSE stream for the session journal.
 *
 * P2 placeholder: returns a no-op async iterable. P3 connects to
 * /api/projects/:id/journal?stream=sse via EventSource and yields
 * each journal event as it arrives.
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
