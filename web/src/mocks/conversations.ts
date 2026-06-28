/**
 * Hermes Tracker APP — conversation-only session mocks.
 *
 * A conversation is a 1-on-1 user ↔ Claude Code session with NO Hermes
 * orchestration. This mirrors the default Discord thread state before
 * `/project adopt` or `/project start` is invoked.
 *
 * Shapes match `ConversationDetail` / `SessionSummary` from types.ts.
 *
 * In P2 the bot's `sessions.db` provides these — for now we ship 4
 * realistic conversations covering active/idle and short/long histories.
 */

import type { ConversationDetail, SessionSummary } from "@/types";

const NOW = Date.UTC(2026, 5, 27, 14, 30, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const MOCK_CONVERSATIONS: ConversationDetail[] = [
  {
    mode: "conversation",
    id: "c-001-add-api-tests",
    shortId: "c001adda",
    threadId: "thread-conv-api-tests",
    goal: "Add unit tests to the API server's auth middleware",
    status: "active",
    startedAt: new Date(NOW - 2 * HOUR).toISOString(),
    endedAt: null,
    lastActivityAt: new Date(NOW - 4 * MIN).toISOString(),
    costUsd: 12,
    totalMessages: 18,
    claudeSession: "conv-session-uuid-001",
    repoPath: "~/www/api-server",
    messages: [
      { ts: new Date(NOW - 2 * HOUR).toISOString(), role: "user", content: "I want to add unit tests to the auth middleware. We don't have any right now and the last deploy broke because of a missing test case." },
      { ts: new Date(NOW - 2 * HOUR + 1 * MIN).toISOString(), role: "assistant", content: "Got it. Let me look at the auth middleware first to understand what we need to cover." },
      { ts: new Date(NOW - 2 * HOUR + 3 * MIN).toISOString(), role: "assistant", content: "I see we have `src/auth/middleware.ts` with the main logic. The current setup uses Jest based on the package.json. I'd suggest covering: (1) valid token → next() called, (2) expired token → 401, (3) malformed token → 401, (4) missing Authorization header → 401, (5) wrong scheme (e.g. Basic instead of Bearer) → 401, (6) edge cases for the JWT clock skew." },
      { ts: new Date(NOW - 2 * HOUR + 5 * MIN).toISOString(), role: "user", content: "Yes, please add all 6. Use the existing test patterns in src/auth/__tests__/." },
      { ts: new Date(NOW - 1.5 * HOUR).toISOString(), role: "assistant", content: "Done. Added 6 tests in src/auth/__tests__/middleware.test.ts. All passing. Should I also add tests for the rate limiter middleware next?" },
      { ts: new Date(NOW - 1.5 * HOUR + 30_000).toISOString(), role: "user", content: "Yes — and add an integration test for the full auth flow (login → middleware → protected route)." },
      { ts: new Date(NOW - 1 * HOUR).toISOString(), role: "assistant", content: "Integration test added. Suite has 14 tests, all green in 3.2s. Ready for review when you are." },
      { ts: new Date(NOW - 30 * MIN).toISOString(), role: "user", content: "Reviewed. Two nitpicks on the integration test — can you rename `test_user` to `alice` and add a comment about why we use vi.useFakeTimers()?" },
      { ts: new Date(NOW - 28 * MIN).toISOString(), role: "assistant", content: "Renamed + comment added. Want me to push?" },
      { ts: new Date(NOW - 25 * MIN).toISOString(), role: "user", content: "Yes, push to a branch." },
      { ts: new Date(NOW - 4 * MIN).toISOString(), role: "assistant", content: "Pushed to branch `auth-tests-2026-06-27`. PR link: github.com/api-server/pull/482." },
    ],
  },

  {
    mode: "conversation",
    id: "c-002-investigate-mem-leak",
    shortId: "c002inve",
    threadId: "thread-conv-mem-leak",
    goal: "Investigate memory leak in v1 deployment (RSS climbs 50MB/hour)",
    status: "idle",
    startedAt: new Date(NOW - 3 * DAY).toISOString(),
    endedAt: null,
    lastActivityAt: new Date(NOW - 8 * HOUR).toISOString(),
    costUsd: 47,
    totalMessages: 24,
    claudeSession: "conv-session-uuid-002",
    repoPath: "~/www/claude-bridge",
    messages: [
      { ts: new Date(NOW - 3 * DAY).toISOString(), role: "user", content: "The v1 bot has a memory leak — RSS grows ~50MB/hour. The OS watchdog keeps killing it. Can you help me figure out why?" },
      { ts: new Date(NOW - 3 * DAY + 5 * MIN).toISOString(), role: "assistant", content: "Classic leak pattern. A few suspects: (1) the stream-json parser buffering text in `pendingText` (we saw this before, fixed in v2), (2) per-message Discord cache that never evicts, (3) Hermes orchestrator's journal.log appendFileSync without fsync. Want me to run a heap snapshot?" },
      { ts: new Date(NOW - 3 * DAY + 30 * MIN).toISOString(), role: "assistant", content: "Heap snapshot taken at 800MB RSS. Top retainers: 240MB in String (from accumulated Discord message objects — old log channels), 180MB in Buffer (stream-json queue), 90MB in Map (Hermes state cache). The String retainer is suspicious — suggests we're keeping references to old messages somewhere." },
      { ts: new Date(NOW - 2 * DAY).toISOString(), role: "user", content: "Ok I think I see — the Hermes journal.log mapping keeps every entry in memory, even though we only ever read the latest one. Let me commit a fix that stops mirroring journal entries into state.json." },
      { ts: new Date(NOW - 2 * DAY + 10 * MIN).toISOString(), role: "assistant", content: "Patched. Let me deploy and watch." },
      { ts: new Date(NOW - 1 * DAY).toISOString(), role: "user", content: "Looking good. RSS is stable at 120MB now. But there's still a slow leak in the Discord client — let me check that next." },
      { ts: new Date(NOW - 8 * HOUR).toISOString(), role: "assistant", content: "I'll take a look tomorrow. Dropping a note here so we don't lose context." },
    ],
  },

  {
    mode: "conversation",
    id: "c-003-deployment-options",
    shortId: "c003depl",
    threadId: "thread-conv-deploy",
    goal: "Discuss deployment options for the dashboard app",
    status: "active",
    startedAt: new Date(NOW - 25 * MIN).toISOString(),
    endedAt: null,
    lastActivityAt: new Date(NOW - 2 * MIN).toISOString(),
    costUsd: 4,
    totalMessages: 6,
    claudeSession: "conv-session-uuid-003",
    repoPath: "~/www/dashboard",
    messages: [
      { ts: new Date(NOW - 25 * MIN).toISOString(), role: "user", content: "What are the tradeoffs between Tauri vs Electron for the Hermes Tracker desktop app?" },
      { ts: new Date(NOW - 24 * MIN).toISOString(), role: "assistant", content: "Tauri: ~10MB binary, Rust backend, smaller attack surface, faster cold start. Electron: ~150MB binary, mature ecosystem, lots of plugins. For a single-user tool where size/startup matter, Tauri wins." },
      { ts: new Date(NOW - 20 * MIN).toISOString(), role: "user", content: "What about PWA for mobile?" },
      { ts: new Date(NOW - 19 * MIN).toISOString(), role: "assistant", content: "PWA works on iOS Safari (limited — no install prompt, can't use MediaRecorder reliably) and full-fat on Android/Desktop Chromium. For Hermes Tracker the mobile use case is 'glance at progress' which PWA handles fine. Tauri Mobile is early-stage and not worth the build pain." },
      { ts: new Date(NOW - 5 * MIN).toISOString(), role: "user", content: "Ok let's go Tauri for desktop and defer mobile to PWA later. Can you scaffold the project structure?" },
      { ts: new Date(NOW - 2 * MIN).toISOString(), role: "assistant", content: "Working on it. Need a moment to check what the existing monorepo has." },
    ],
  },

  {
    mode: "conversation",
    id: "c-004-quick-question",
    shortId: "c004qust",
    threadId: "thread-conv-q",
    goal: "Quick question about Bun.spawn env handling",
    status: "idle",
    startedAt: new Date(NOW - 5 * DAY).toISOString(),
    endedAt: null,
    lastActivityAt: new Date(NOW - 4 * DAY).toISOString(),
    costUsd: 1,
    totalMessages: 3,
    claudeSession: "conv-session-uuid-004",
    repoPath: "~/www/claude-bridge",
    messages: [
      { ts: new Date(NOW - 5 * DAY).toISOString(), role: "user", content: "Does Bun.spawn inherit env from process.env by default?" },
      { ts: new Date(NOW - 5 * DAY + 30_000).toISOString(), role: "assistant", content: "Yes, by default. Pass `env: {}` to start from scratch, or `env: { ...process.env, FOO: 'bar' }` to inherit and override. Note: if you pass a literal `env:`, you lose PATH/USER/etc. — usually you want `...process.env`." },
      { ts: new Date(NOW - 4 * DAY).toISOString(), role: "user", content: "Got it, thanks." },
    ],
  },
];

/** Map of conversation id → last assistant message (for card preview). */
function lastAssistantPreview(detail: ConversationDetail): string {
  for (let i = detail.messages.length - 1; i >= 0; i--) {
    const m = detail.messages[i];
    if (m && m.role === "assistant") return m.content;
  }
  return detail.goal;
}

/** All session summaries — covers both conversation and Hermes sessions. */
export function listConversationSummaries(): SessionSummary[] {
  return MOCK_CONVERSATIONS.map((d) => ({
    id: d.id,
    threadId: d.threadId,
    shortId: d.shortId,
    mode: "conversation",
    goal: d.goal,
    status: d.status,
    costUsd: d.costUsd,
    startedAt: d.startedAt,
    endedAt: d.endedAt,
    lastActivityAt: d.lastActivityAt,
    totalMessages: d.totalMessages,
  }));
}

export function getConversationDetail(id: string): ConversationDetail | null {
  return MOCK_CONVERSATIONS.find((c) => c.id === id) ?? null;
}

/** Preview the last assistant message — useful for card display. */
export function getConversationPreview(id: string): string | null {
  const detail = getConversationDetail(id);
  if (!detail) return null;
  return lastAssistantPreview(detail);
}
