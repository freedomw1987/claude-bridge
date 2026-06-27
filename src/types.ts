/**
 * Shared types.
 */

export type SessionStatus = "active" | "idle" | "killed" | "done";

/**
 * Autopilot mode (added in commit f70f6ea; types not previously updated).
 * `manual` is the default; `autopilot` lets the agent run a milestone loop.
 */
export type SessionMode = "manual" | "autopilot";

export interface Session {
  threadId: string;
  channelId: string;
  repoUrl: string | null;
  localPath: string | null;
  repoPath: string;
  claudeSession: string | null;
  status: SessionStatus;
  createdAt: number;
  lastActivityAt: number;
  totalMessages: number;
  // Autopilot (Phase 0). `mode` may be missing on rows that predate the
  // migration; `rowToSession` defaults to 'manual'.
  mode: SessionMode;
  milestoneGoal: string | null;
  milestoneCriteria: string | null;
}

export interface MentionParse {
  repoUrl: string | null;
  localPath: string | null;
  newProject: string | null;
  prompt: string;
  threadName: string;
}
