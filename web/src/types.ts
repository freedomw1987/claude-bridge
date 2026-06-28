/**
 * Hermes Tracker APP — TypeScript types.
 *
 * Mirrors the bot's `src/hermes/types.ts` + `src/discord/handlers/hermes/dispatch.ts`
 * mental model:
 *   - A **Session** is the basic unit (mirrors a Discord thread).
 *   - A session runs in one of two **modes**:
 *       "conversation" — 1-on-1 user ↔ Claude Code, no orchestration
 *       "hermes"      — opt-in orchestration (auto/manual plan + execute + judge)
 *   - The dashboard shows both kinds; the detail page branches on mode.
 *
 * Discriminated union on `mode` lets TypeScript narrow the data shape:
 *   `if (session.mode === "hermes") session.plan` — type-safe access to Hermes-only fields.
 */

// ── Mode + status ─────────────────────────────────────────────────────

export type SessionMode = "conversation" | "hermes";

/** Status values for a plain conversation (1-on-1 with Claude Code). */
export type ConversationStatus = "active" | "idle";

/** Status values for a Hermes-orchestrated project. */
export type HermesStatus =
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "judging"
  | "done"
  | "failed"
  | "killed"
  | "timed_out"
  | "parse_error"
  | "judge_timed_out"
  | "judge_parse_error";

/** Unified status — covers both modes. */
export type Status = ConversationStatus | HermesStatus;

/** Hermes auto/manual mode (only present when session.mode === "hermes"). */
export type ProjectMode = "auto" | "manual";

/** Reasons a Hermes project ended up `killed`. */
export type KilledReason = "user_kill" | "duration_expired" | "manual_switch";

// ── Hermes-specific building blocks ─────────────────────────────────────

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "failed"
  | "skipped";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  attempts: number;
  dependsOn: string[];
  lastResult?: string;
  lastError?: string;
}

export interface JournalEntry {
  ts: string;
  type: string;
  message: string;
}

export interface ProjectTimer {
  expiresAt: number;
  requestedDuration: string;
  effectiveMs: number;
  clamped: boolean;
}

export interface ApprovalRequest {
  docPath: string;
  docMtime: number;
  requestedAt: string;
  reviewerNotes?: string;
  approvedAt?: string;
  rejectedAt?: string;
  rejectionReason?: string;
}

// ── Conversation-specific building blocks ────────────────────────────

export interface Message {
  ts: string;
  role: "user" | "assistant";
  content: string;
}

// ── Dashboard list summary (works for both modes) ─────────────────────

export interface SessionSummary {
  id: string;
  threadId: string;
  shortId: string;
  mode: SessionMode;
  goal: string;
  status: Status;
  costUsd: number;
  startedAt: string;
  endedAt: string | null;
  lastActivityAt: string;
  totalMessages: number;
  /** Hermes-only. Absent for conversation mode. */
  taskTotal?: number;
  taskDone?: number;
  taskInProgress?: number;
  taskFailed?: number;
  taskPending?: number;
  /** Hermes-only. Absent for conversation mode. */
  timer?: ProjectTimer;
  /** Hermes-only. Absent for conversation mode. */
  projectMode?: ProjectMode;
}

// ── Detail (discriminated union) ─────────────────────────────────────

export type SessionDetail = ConversationDetail | HermesProjectDetail;

export interface ConversationDetail {
  mode: "conversation";
  id: string;
  shortId: string;
  threadId: string;
  goal: string;
  status: ConversationStatus;
  startedAt: string;
  endedAt: string | null;
  lastActivityAt: string;
  costUsd: number;
  totalMessages: number;
  claudeSession: string | null;
  repoPath: string;
  messages: Message[];
}

export interface HermesProjectDetail {
  mode: "hermes";
  id: string;
  shortId: string;
  threadId: string;
  goal: string;
  status: HermesStatus;
  startedAt: string;
  endedAt: string | null;
  lastActivityAt: string;
  costUsd: number;
  totalMessages: number;
  claudeSession: string | null;
  repoPath: string;
  repoRoot: string;
  /** Hermes-only fields. */
  plan: Task[];
  iterations: number;
  journal: JournalEntry[];
  config: {
    maxIterations: number;
    maxCostUsd: number;
    maxWallHours: number;
    maxAttemptsPerTask: number;
  };
  /** Set when status === "killed". */
  killedReason?: KilledReason;
  /** Set in auto mode with active timer. */
  timer?: ProjectTimer;
  /** Set when status === "awaiting_approval". */
  approval?: ApprovalRequest;
}

// ── Stats (kept stable, dashboard-wide) ───────────────────────────────

export interface Stats {
  totalCostUsd: number;
  cost24hUsd: number;
  /** (done / (done + failed + killed)) × 100 — Hermes projects only. */
  hermesSuccessRate: number;
  countByMode: {
    conversation: number;
    hermes: number;
  };
  countByStatus: Record<Status, number>;
}

// ── SSE events ─────────────────────────────────────────────────────────

export interface SseJournalEvent {
  sessionId: string;
  entry: JournalEntry;
  /** Snapshot of the session at the time of the event. */
  state: SessionSummary;
}

export interface SseMessageEvent {
  sessionId: string;
  message: Message;
}