/**
 * SQLite wrapper. bun:sqlite.
 * Owns the sessions table; exposes typed CRUD.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Session, SessionMode, SessionStatus } from "../types";

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

    // Forward migration FIRST: add columns that the schema declares but an
    // older sessions.db (created before the column was added) doesn't have.
    // This must run BEFORE schema.sql because schema.sql contains
    // CREATE INDEX statements that reference those columns — referencing a
    // non-existent column throws "no such column" and aborts exec() before
    // we get to the additive block below.
    const additiveColumns: Array<{ name: string; ddl: string }> = [
      {
        name: "mode",
        ddl: "ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'manual'",
      },
      {
        name: "milestone_goal",
        ddl: "ALTER TABLE sessions ADD COLUMN milestone_goal TEXT",
      },
      {
        name: "milestone_criteria",
        ddl: "ALTER TABLE sessions ADD COLUMN milestone_criteria TEXT",
      },
    ];
    for (const col of additiveColumns) {
      try {
        this.db.exec(col.ddl);
      } catch {
        // Column already exists — fresh install or already migrated
      }
    }

    const sql = readFileSync(schemaPath, "utf-8");
    this.db.exec(sql);

    // Forward cleanup: drop vestigial columns from abandoned features.
    // Wrapped in try-catch because the column may not exist on fresh installs
    // or after a prior cleanup run. SQLite supports DROP COLUMN since 3.35.
    try {
      this.db.exec("ALTER TABLE sessions DROP COLUMN container_id");
    } catch {
      // Column doesn't exist — fresh install or already dropped
    }

    // Backward migration: add autopilot columns to pre-Phase-0 installs.
    // CREATE TABLE IF NOT EXISTS in schema.sql is a no-op when the table
    // already exists, so older DBs miss the new columns. ALTER TABLE
    // ADD COLUMN with IF NOT EXISTS is a no-op when the column exists.
    // SQLite supports IF NOT EXISTS on ADD COLUMN since 3.35.0.
    const additiveMigrations: ReadonlyArray<string> = [
      "ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'manual';",
      "ALTER TABLE sessions ADD COLUMN milestone_goal TEXT;",
      "ALTER TABLE sessions ADD COLUMN milestone_criteria TEXT;",
      "CREATE INDEX IF NOT EXISTS idx_sessions_mode ON sessions(mode);",
    ];
    for (const stmt of additiveMigrations) {
      try {
        this.db.exec(stmt);
      } catch (err) {
        // Idempotent: only fail loudly if the error isn't a duplicate-column.
        // "duplicate column name" / "already exists" are expected on re-runs.
        const msg = String(err);
        if (!/duplicate column|already exists/i.test(msg)) {
          throw err;
        }
      }
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

  /**
   * Switch a session between manual and autopilot mode. Autopilot = the
   * thread represents a PM-controlled milestone (see `setMilestone`).
   */
  setMode(threadId: string, mode: SessionMode): void {
    this.db
      .prepare(`UPDATE sessions SET mode = ? WHERE thread_id = ?`)
      .run(mode, threadId);
  }

  /**
   * Set the milestone goal + criteria. Also flips the session into
   * autopilot mode (a milestone without autopilot mode is incoherent).
   * Pass empty strings or null for criteria to clear.
   */
  setMilestone(
    threadId: string,
    goal: string,
    criteria: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE sessions
            SET milestone_goal = ?,
                milestone_criteria = ?,
                mode = 'autopilot'
          WHERE thread_id = ?`,
      )
      .run(goal, criteria, threadId);
  }

  /**
   * Clear the milestone + revert to manual mode. Used by /cancel-autopilot.
   */
  clearMilestone(threadId: string): void {
    this.db
      .prepare(
        `UPDATE sessions
            SET milestone_goal = NULL,
                milestone_criteria = NULL,
                mode = 'manual'
          WHERE thread_id = ?`,
      )
      .run(threadId);
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
      // Autopilot (Phase 0). `mode` may be missing on a row that predates
      // the migration in very rare race conditions; fall back to 'manual'.
      mode: (row.mode as SessionMode | undefined) ?? "manual",
      milestoneGoal: (row.milestone_goal as string | null) ?? null,
      milestoneCriteria: (row.milestone_criteria as string | null) ?? null,
    };
  }

  close(): void {
    this.db.close();
  }
}
