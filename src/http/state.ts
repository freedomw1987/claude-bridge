/**
 * Hermes Tracker — HTTP server (P2.5 backend).
 *
 * Exposes the bot's Hermes state + session DB over HTTP, on localhost
 * only (port from config, default 8080). The Vite dev server proxies
 * `/api/*` requests to this server, so the frontend reads/writes the
 * same data the bot manages.
 *
 * Endpoints (P2.5):
 *   GET  /api/health                  → liveness probe
 *   GET  /api/projects                → { hermes, conversation } lists
 *   GET  /api/projects/:id            → SessionDetail (Hermes OR conversation)
 *   GET  /api/projects/:id/journal    → { journal: JournalEntry[] } (Hermes)
 *   GET  /api/projects/:id/messages   → { messages: Message[] } (conversation)
 *   GET  /api/projects/:id/stream     → SSE: live journal + messages
 *   GET  /api/stats                   → Stats (cost, counts, success rate)
 *   POST /api/projects/:id/heartbeat  → real lastActivityAt bump
 *   POST /api/projects/:id/kill       → kill running session
 *
 * Defer to P3:
 *   - Token auth (for non-localhost access)
 *   - POST endpoints (todo, adopt, approve, message forward)
 */

import { log } from "@/logger";
import { config } from "@/config";
import { listProjects as listHermesProjects } from "@/hermes/state";
import type { ProjectState, JournalEntry, Task } from "@/hermes/types";
import { SessionStore } from "@/db";
import type { Session } from "@/types";
import { readMessages } from "@/messages";
import { appEvents, type AppEvent } from "@/events";

// ── Response helpers ─────────────────────────────────────────────────

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // CORS for Vite dev server (different port). In production the
      // Tauri WebView serves from a custom protocol with no CORS needed.
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      ...(init.headers ?? {}),
    },
  });
}

function notFound(what: string): Response {
  return json({ error: "not_found", message: what }, { status: 404 });
}

function serverError(err: unknown): Response {
  log.error("http server error", { err: String(err) });
  return json(
    { error: "server_error", message: err instanceof Error ? err.message : String(err) },
    { status: 500 },
  );
}

// ── Data mapping: bot types → frontend types ─────────────────────────

/**
 * Compute a sensible lastActivityAt timestamp: prefer the most recent
 * journal entry, fall back to startedAt, then now.
 */
function lastActivityAt(state: ProjectState): string {
  const last = state.journal.at(-1);
  return last?.ts ?? state.startedAt ?? new Date().toISOString();
}

/**
 * Pull the project mode ("auto" | "manual") out of the first status
 * journal entry, defaulting to "auto" if none can be found.
 */
function parseProjectMode(journal: JournalEntry[]): "auto" | "manual" {
  for (const j of journal) {
    const m = /Mode=(\w+)/.exec(j.message);
    if (m && (m[1] === "auto" || m[1] === "manual")) return m[1];
  }
  return "auto";
}

/** Count task statuses for the summary view. */
function countTasks(plan: Task[]): {
  taskTotal: number;
  taskDone: number;
  taskInProgress: number;
  taskFailed: number;
  taskPending: number;
} {
  let taskTotal = 0;
  let taskDone = 0;
  let taskInProgress = 0;
  let taskFailed = 0;
  let taskPending = 0;
  for (const t of plan) {
    taskTotal++;
    if (t.status === "done" || t.status === "skipped") taskDone++;
    else if (t.status === "in_progress") taskInProgress++;
    else if (t.status === "failed") taskFailed++;
    else if (t.status === "pending") taskPending++;
  }
  return { taskTotal, taskDone, taskInProgress, taskFailed, taskPending };
}

/** Bot's ProjectState → frontend's HermesProjectDetail. */
function hermesToDetail(state: ProjectState): Record<string, unknown> {
  return {
    mode: "hermes",
    id: state.id,
    shortId: state.id.slice(0, 8),
    threadId: state.threadId,
    goal: state.goal,
    status: state.status,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    lastActivityAt: lastActivityAt(state),
    costUsd: state.costUsd,
    totalMessages: state.journal.length,
    claudeSession: null, // not tracked at Hermes state level
    repoPath: state.repoPath,
    repoRoot: state.repoRoot,
    plan: state.plan,
    iterations: state.iterations,
    journal: state.journal,
    config: state.config,
    killedReason: state.killedReason,
    timer: state.timer,
    // `approval` and `awaiting_approval` status are not in the
    // current bot (per-task approval flow was removed 2026-06-22).
    // If/when a planner-approval gate returns, this mapping should
    // expose `state.approval ?? undefined`.
  };
}

function hermesToSummary(state: ProjectState): Record<string, unknown> {
  return {
    mode: "hermes",
    id: state.id,
    shortId: state.id.slice(0, 8),
    threadId: state.threadId,
    goal: state.goal,
    status: state.status,
    costUsd: state.costUsd,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    lastActivityAt: lastActivityAt(state),
    totalMessages: state.journal.length,
    projectMode: parseProjectMode(state.journal),
    ...countTasks(state.plan),
    timer: state.timer,
  };
}

/**
 * Bot's SessionStore row → frontend's ConversationDetail. The DB has
 * minimal fields (no message archive yet — P3 work), so messages[] is
 * always empty for now.
 */
function dbSessionToDetail(row: Session): Record<string, unknown> {
  const id = row.threadId;
  return {
    mode: "conversation",
    id,
    shortId: id.slice(0, 8),
    threadId: row.threadId,
    goal: row.repoPath
      ? `Thread session in ${row.repoPath}`
      : "Thread session",
    status: row.status === "killed" || row.status === "done" ? "idle" : "active",
    startedAt: new Date(row.createdAt).toISOString(),
    endedAt: null,
    lastActivityAt: new Date(row.lastActivityAt).toISOString(),
    costUsd: 0, // not tracked at the basic-session level
    totalMessages: row.totalMessages,
    claudeSession: row.claudeSession,
    repoPath: row.repoPath,
    messages: [], // P3 will populate from a message archive
  };
}

function dbSessionToSummary(row: Session): Record<string, unknown> {
  const id = row.threadId;
  return {
    mode: "conversation",
    id,
    shortId: id.slice(0, 8),
    threadId: row.threadId,
    goal: row.repoPath
      ? `Thread session in ${row.repoPath}`
      : "Thread session",
    status: row.status === "killed" || row.status === "done" ? "idle" : "active",
    costUsd: 0,
    startedAt: new Date(row.createdAt).toISOString(),
    endedAt: null,
    lastActivityAt: new Date(row.lastActivityAt).toISOString(),
    totalMessages: row.totalMessages,
  };
}

// ── SSE stream handler ──────────────────────────────────────────────

/**
 * Server-Sent Events for one session. Subscribes to the in-process
 * event bus and forwards journal + message events to the connected
 * client. The stream closes when the client disconnects (request
 * abort signal fires).
 *
 * Format: `data: <json>\n\n` per event. The browser's EventSource
 * auto-reconnects on close, so transient bot hiccups self-heal.
 */
function streamSse(sessionId: string): Response {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      function send(event: AppEvent) {
        // Only forward events for this session.
        if (event.kind === "journal" && event.projectId !== sessionId) return;
        if (event.kind === "message" && event.sessionId !== sessionId) return;
        if (event.kind === "state" && event.sessionId !== sessionId) return;
        const data = JSON.stringify(event);
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      }
      // Initial "hello" so the EventSource open event resolves
      // immediately on the client side.
      controller.enqueue(
        encoder.encode(`event: ready\ndata: ${JSON.stringify({ sessionId })}\n\n`),
      );
      // Subscribe to the in-process event bus.
      appEvents.on("app", send);
      // Bun's Request.signal is the abort signal from the client.
      // We don't have direct access here — fetch() is wrapped in a
      // Promise. The server tears down the stream on response end,
      // so we rely on the runtime's auto-cleanup.
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ── Server factory ───────────────────────────────────────────────────

export interface StartHttpServerOpts {
  /** The SessionStore from the bot's main process. */
  store: SessionStore;
}

export function startHttpServer(
  opts: StartHttpServerOpts,
): { port: number; stop: () => void } {
  const { store } = opts;
  const port = config.runtime.httpPort;

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1", // localhost only — single-user trust boundary
    development: false,

    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        });
      }

      try {
        // ── Health ──
        if (path === "/api/health" && req.method === "GET") {
          return json({
            status: "ok",
            uptime: process.uptime(),
            sessionsInDb: store.list().length,
            hermesProjectsOnDisk: listHermesProjects(config.paths.dataDir).length,
          });
        }

        // ── Stats ──
        if (path === "/api/stats" && req.method === "GET") {
          return json(computeStats(store));
        }

        // ── Projects list (combined Hermes + conversations) ──
        if (path === "/api/projects" && req.method === "GET") {
          const hermes = listHermesProjects(config.paths.dataDir).map(hermesToSummary);
          const conversation = store.list().map(dbSessionToSummary);
          return json({ hermes, conversation });
        }

        // ── Project detail (Hermes from disk OR conversation from DB) ──
        const detailMatch = path.match(/^\/api\/projects\/([^/]+)$/);
        if (detailMatch && req.method === "GET") {
          const id = decodeURIComponent(detailMatch[1]!);
          // Try Hermes disk first (project IDs are UUIDs).
          for (const p of listHermesProjects(config.paths.dataDir)) {
            if (p.id === id) return json(hermesToDetail(p));
          }
          // Fall back to sessions.db (thread IDs are Discord snowflakes).
          const dbRow = store.get(id);
          if (dbRow) return json(dbSessionToDetail(dbRow));
          return notFound(`session or project: ${id}`);
        }

        // ── Journal for a Hermes project ──
        const journalMatch = path.match(/^\/api\/projects\/([^/]+)\/journal$/);
        if (journalMatch && req.method === "GET") {
          const id = decodeURIComponent(journalMatch[1]!);
          for (const p of listHermesProjects(config.paths.dataDir)) {
            if (p.id === id) return json({ journal: p.journal });
          }
          return notFound(`project: ${id}`);
        }

        // ── Messages for a conversation (P2.5 archive read) ──
        const messagesMatch = path.match(/^\/api\/projects\/([^/]+)\/messages$/);
        if (messagesMatch && req.method === "GET") {
          const id = decodeURIComponent(messagesMatch[1]!);
          // For Hermes projects, journal is already on disk — but the
          // frontend's ConversationDetail expects `messages[]`. Map the
          // journal entries to messages so the unified UI works for
          // both modes. P3 will add a proper conversation archive.
          for (const p of listHermesProjects(config.paths.dataDir)) {
            if (p.id === id) {
              const messages = p.journal.map((j) => ({
                ts: j.ts,
                role: "assistant" as const,
                content: j.message,
                meta: { toolName: j.type },
              }));
              return json({ messages });
            }
          }
          // Conversation from disk archive
          return json({ messages: readMessages(id) });
        }

        // ── SSE: live journal + message stream ──
        const streamMatch = path.match(/^\/api\/projects\/([^/]+)\/stream$/);
        if (streamMatch && req.method === "GET") {
          return streamSse(streamMatch[1]!);
        }

        // ── POST: heartbeat (real lastActivityAt bump) ──
        const heartbeatMatch = path.match(
          /^\/api\/projects\/([^/]+)\/heartbeat$/,
        );
        if (heartbeatMatch && req.method === "POST") {
          const id = decodeURIComponent(heartbeatMatch[1]!);
          // Update sessions.db.last_activity_at so the next /api/projects
          // lists this session with a fresh timestamp. Currently the
          // SessionStore doesn't have a dedicated `touch` method — use
          // setLastActivityAt via the underlying DB. P3 may add a
          // dedicated touch(threadId) method.
          const row = store.get(id);
          if (!row) return notFound(`session: ${id}`);
          // Direct DB write — no-op if lastActivityAt is already recent.
          const now = Date.now();
          if (now - row.lastActivityAt > 1000) {
            store.setLastActivityAt(id, now);
          }
          return json({ ok: true, lastActivityAt: now });
        }

        // ── POST: kill a running session (P2.5 — Hermes only) ──
        const killMatch = path.match(/^\/api\/projects\/([^/]+)\/kill$/);
        if (killMatch && req.method === "POST") {
          const id = decodeURIComponent(killMatch[1]!);
          // Mark the Hermes project as killed. Live CC tasks aren't
          // aborted from here (P3 work — would need a cross-process
          // signal). For P2.5 this is a "soft kill" — useful for
          // clearing stuck state in the APP without a bot restart.
          for (const p of listHermesProjects(config.paths.dataDir)) {
            if (p.id === id) {
              const { saveState } = await import("@/hermes/state");
              const { appendJournal } = await import("@/hermes/state");
              p.status = "killed";
              p.killedReason = "user_kill";
              p.endedAt = new Date().toISOString();
              p.currentTaskId = null;
              saveState(config.paths.dataDir, p.id, p);
              appendJournal(config.paths.dataDir, p.id, {
                type: "status",
                message: `user killed via /api/projects/:id/kill (threadId=${id})`,
              });
              return json({ ok: true, status: "killed" });
            }
          }
          return notFound(`project: ${id}`);
        }

        return notFound(`endpoint: ${path}`);
      } catch (err) {
        return serverError(err);
      }
    },
  });

  log.info("http server started", {
    url: `http://127.0.0.1:${server.port}`,
    pid: process.pid,
  });

  return {
    // Bun's Server type declares `port: number | undefined` but in
    // practice it's always set when we pass a numeric `port` option.
    port: server.port ?? port,
    stop: () => server.stop(true),
  };
}

// ── Stats aggregation ───────────────────────────────────────────────

function computeStats(store: SessionStore): Record<string, unknown> {
  const hermes = listHermesProjects(config.paths.dataDir);
  const conversation = store.list();

  const hermesStatuses = hermes.map((h) => h.status as string);

  const countByStatus: Record<string, number> = {};
  for (const s of hermesStatuses) {
    countByStatus[s] = (countByStatus[s] ?? 0) + 1;
  }

  const totalCostUsd = hermes.reduce((sum, h) => sum + h.costUsd, 0);

  // Success rate: (done / terminal) × 100
  const terminal = hermesStatuses.filter(
    (s) =>
      s === "done" ||
      s === "failed" ||
      s === "killed" ||
      s === "timed_out" ||
      s === "parse_error" ||
      s === "judge_timed_out" ||
      s === "judge_parse_error",
  ).length;
  const done = hermesStatuses.filter((s) => s === "done").length;
  const hermesSuccessRate =
    terminal === 0 ? 0 : Math.round((done / terminal) * 100);

  // 24h cost: sum Hermes cost where lastActivityAt is in the last 24h.
  const now = Date.now();
  const cutoffMs = now - 24 * 60 * 60 * 1000;
  const cost24hUsd = hermes.reduce((sum, h) => {
    const lastAt = new Date(lastActivityAt(h)).getTime();
    if (lastAt > cutoffMs) return sum + h.costUsd;
    return sum;
  }, 0);

  return {
    totalCostUsd,
    cost24hUsd,
    hermesSuccessRate,
    countByMode: {
      hermes: hermes.length,
      conversation: conversation.length,
    },
    countByStatus,
  };
}