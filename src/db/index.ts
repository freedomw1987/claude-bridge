/**
 * SQLite wrapper. bun:sqlite.
 * Owns the sessions table; exposes typed CRUD.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Session, SessionStatus } from "../types";

export class SessionStore {
  private db: Database;

  constructor(dbPath: string, schemaPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate(schemaPath);
  }

  private migrate(schemaPath: string): void {
    if (!existsSync(schemaPath)) {
      throw new Error(`Schema file not found: ${schemaPath}`);
    }
    const sql = readFileSync(schemaPath, "utf-8");
    this.db.exec(sql);

    // Forward cleanup: drop vestigial columns from abandoned features.
    // Wrapped in try-catch because the column may not exist on fresh installs
    // or after a prior cleanup run. SQLite supports DROP COLUMN since 3.35.
    try {
      this.db.exec("ALTER TABLE sessions DROP COLUMN container_id;");
    } catch {
      // Column doesn't exist — fresh install or already dropped
    }
  }

  create(input: {
    threadId: string;
    channelId: string;
    repoUrl: string | null;
    localPath: string | null;
    repoPath: string;
  }): Session {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions
          (thread_id, channel_id, repo_url, local_path, repo_path, status, created_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        input.threadId,
        input.channelId,
        input.repoUrl,
        input.localPath,
        input.repoPath,
        now,
        now,
      );
    return this.get(input.threadId)!;
  }

  get(threadId: string): Session | null {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE thread_id = ?`)
      .get(threadId) as Record<string, unknown> | null;
    return row ? this.rowToSession(row) : null;
  }

  list(opts: { status?: SessionStatus } = {}): Session[] {
    let sql = `SELECT * FROM sessions`;
    const params: (string | number)[] = [];
    if (opts.status) {
      sql += ` WHERE status = ?`;
      params.push(opts.status);
    }
    sql += ` ORDER BY last_activity_at DESC`;
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.rowToSession(r));
  }

  /**
   * Find active sessions whose last activity is older than `idleSinceMs`.
   * Used by the idle sweep to mark timed-out sessions.
   */
  findStale(opts: { idleSinceMs: number }): Session[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
          WHERE status = 'active' AND last_activity_at < ?`,
      )
      .all(opts.idleSinceMs) as Record<string, unknown>[];
    return rows.map((r) => this.rowToSession(r));
  }

  touch(threadId: string, delta = 1): void {
    this.db
      .prepare(
        `UPDATE sessions
            SET last_activity_at = ?,
                total_messages = total_messages + ?,
                status = 'active'
          WHERE thread_id = ?`,
      )
      .run(Date.now(), delta, threadId);
  }

  setStatus(threadId: string, status: SessionStatus): void {
    this.db
      .prepare(`UPDATE sessions SET status = ? WHERE thread_id = ?`)
      .run(status, threadId);
  }

  setClaudeSession(threadId: string, claudeSession: string): void {
    this.db
      .prepare(`UPDATE sessions SET claude_session = ? WHERE thread_id = ?`)
      .run(claudeSession, threadId);
  }

  setRepoUrl(threadId: string, repoUrl: string): void {
    this.db
      .prepare(`UPDATE sessions SET repo_url = ?, local_path = NULL WHERE thread_id = ?`)
      .run(repoUrl, threadId);
  }

  setLocalPath(threadId: string, localPath: string, resolvedPath: string): void {
    this.db
      .prepare(
        `UPDATE sessions SET local_path = ?, repo_url = NULL, repo_path = ? WHERE thread_id = ?`,
      )
      .run(localPath, resolvedPath, threadId);
  }

  delete(threadId: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE thread_id = ?`).run(threadId);
  }

  countActive(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM sessions WHERE status = 'active'`)
      .get() as { c: number };
    return row.c;
  }

  private rowToSession(row: Record<string, unknown>): Session {
    return {
      threadId: row.thread_id as string,
      channelId: row.channel_id as string,
      repoUrl: (row.repo_url as string | null) ?? null,
      localPath: (row.local_path as string | null) ?? null,
      repoPath: row.repo_path as string,
      claudeSession: (row.claude_session as string | null) ?? null,
      status: row.status as SessionStatus,
      createdAt: row.created_at as number,
      lastActivityAt: row.last_activity_at as number,
      totalMessages: row.total_messages as number,
    };
  }

  close(): void {
    this.db.close();
  }
}
