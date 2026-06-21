/**
 * Shared types.
 */

export type SessionStatus = "active" | "idle" | "killed" | "done";

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
}

export interface MentionParse {
  repoUrl: string | null;
  localPath: string | null;
  newProject: string | null;
  prompt: string;
  threadName: string;
}
