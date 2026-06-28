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
 * SSE stream for a session — subscribes to the backend's
 * /api/projects/:id/stream endpoint and yields events as they arrive.
 * Returns an async iterable of journal + message events. Auto-
 * reconnects on disconnect via the browser's EventSource behavior.
 *
 * P2.5: real implementation. Polling is no longer needed.
 */
export type StreamEvent =
  | { kind: "journal"; projectId: string; entry: { ts: string; type: string; message: string } }
  | { kind: "message"; sessionId: string; message: { ts: string; role: "user" | "assistant"; content: string } }
  | { kind: "state"; sessionId: string; status: string };

export async function* streamSession(
  sessionId: string,
): AsyncIterable<StreamEvent> {
  if (USE_MOCKS) {
    // Mock mode: yield nothing (P3+ would simulate events here)
    return;
  }
  const res = await fetch(`/api/projects/${encodeURIComponent(sessionId)}/stream`);
  if (!res.ok || !res.body) {
    throw new Error(`streamSession: ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by \n\n. Each frame may have multiple
    // lines: "event: type" and "data: payload". We only care about data.
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = frame
        .split("\n")
        .find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      try {
        const payload = JSON.parse(dataLine.slice("data: ".length));
        if (payload.kind) yield payload as StreamEvent;
      } catch {
        // skip non-JSON frames (e.g. "ready" marker)
      }
    }
  }
}

// ── POST endpoints (P2.5 real heartbeat + kill) ──────────────────

/** Mark a session as actively in use. Bumps lastActivityAt on the server. */
export async function heartbeatSession(sessionId: string): Promise<{
  ok: boolean;
  lastActivityAt?: number;
}> {
  if (USE_MOCKS) return { ok: true };
  const res = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/heartbeat`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`heartbeatSession: ${res.status}`);
  return res.json();
}

/** Mark a Hermes project as killed (soft kill — P3 will also abort live tasks). */
export async function killSession(sessionId: string): Promise<{ ok: boolean; status?: string }> {
  if (USE_MOCKS) return { ok: true, status: "killed" };
  const res = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/kill`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`killSession: ${res.status}`);
  return res.json();
}

// Re-export the detail types so callers can import them from one place.
export type { SessionSummary, SessionDetail, ConversationDetail, HermesProjectDetail };
