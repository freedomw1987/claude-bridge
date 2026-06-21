-- claude-bridge sessions table
-- One row per Discord thread that has been used for a task.

CREATE TABLE IF NOT EXISTS sessions (
  thread_id        TEXT PRIMARY KEY,
  channel_id       TEXT NOT NULL,
  repo_url         TEXT,        -- git URL (clone required) — null when local_path is set
  local_path       TEXT,        -- local filesystem path (no clone) — null when repo_url is set
  repo_path        TEXT NOT NULL,  -- resolved dir: TASKS_ROOT/<thread-id> or expand(local_path)
  claude_session   TEXT,
  status           TEXT NOT NULL DEFAULT 'active',
  created_at       INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  total_messages   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity_at);
