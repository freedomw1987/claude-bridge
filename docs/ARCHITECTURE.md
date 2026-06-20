# claude-bridge — System Architecture

## High-Level Diagram

```
┌────────────────────────────────────────────────────────────┐
│ Discord                                                     │
│  Channel: #dev                                              │
│  └─ Thread #1 "Fix auth bug on foo/bar"                     │
│       ├─ Mention message: "@bot ..."                       │
│       └─ Reply stream: claude output (edited in-place)     │
└──────────────────────┬─────────────────────────────────────┘
                       │ Discord WebSocket
┌──────────────────────▼─────────────────────────────────────┐
│ Host: claude-bridge bot (Bun + TypeScript + discord.js)    │
│                                                            │
│  ┌─────────────────┐  ┌──────────────────┐  ┌───────────┐ │
│  │ mention parser  │→ │ session manager  │→ │  agent    │ │
│  │ (extract URL,   │  │ (thread_id ↔     │  │  runner   │ │
│  │  parse intent)  │  │  claude_session) │  │  (Bun.    │ │
│  └─────────────────┘  └──────────────────┘  │   spawn)  │ │
│                                              └─────┬─────┘ │
│  ┌──────────────────────────────────────────────┐  │       │
│  │ bun:sqlite (sessions.db)                     │  │       │
│  └──────────────────────────────────────────────┘  │       │
└────────────────────────────────────────────────────┼───────┘
                                                     │ stdout pipe
                                                     │ stream-json
                       ┌─────────────────────────────┘
                       │
┌──────────────────────▼─────────────────────────────────────┐
│ Host subprocess: claude CLI                                 │
│                                                            │
│  cwd = <work dir>   (project dir, local path, or           │
│                      TASKS_ROOT/<thread-id>)                │
│                                                            │
│  Process:                                                  │
│    claude -p <prompt> --output-format stream-json \        │
│          --verbose --permission-mode <mode> \              │
│          --resume <claudeSessionId>                        │
│                                                            │
│  Writes stream-json events to stdout (inherited by bot).   │
│  Files are written directly to <work dir> on the host.     │
└────────────────────────────────────────────────────────────┘
```

## File / Data Flow

```
Discord message
   │
   ▼
[bot] parse mention → { threadName, repoUrl|localPath, prompt }
   │
   ▼
[bot] CREATE thread (autoArchiveDuration: 60)
   │
   ▼
[bot] INSERT INTO sessions (thread_id, repo_url|local_path, repo_path, ...)
   │
   ▼
[bot] if repoUrl: git clone <url> → TASKS_ROOT/<thread-id>/
   │
   ▼
[bot] Bun.spawn(["claude", "-p", prompt,
                  "--output-format", "stream-json",
                  "--verbose", "--permission-mode", mode,
                  "--resume", claudeSessionId], cwd: repoPath)
   │
   ▼ (streamed JSON events on stdout)
[bot] parseJsonLines → typed events
[bot] throttle-edits a Discord message in the thread
[bot] on completion: UPDATE sessions SET claude_session = <newId>
   │
   ▼
[claude] writes files to <work dir> on the host (no mount)
[claude] exits → process reaped → tracking removed

user can: cd <work dir> && code .
```

## Component Responsibilities

| Component | Responsibility |
|-----------|----------------|
| `src/index.ts` | Entry point: load config, open DB, start Discord client, install signal handlers |
| `src/config.ts` | Load + validate env vars |
| `src/logger.ts` | Structured logging (dev = pretty, prod = JSON) |
| `src/cleanup.ts` | Track active `claude` subprocess PIDs; SIGTERM them on bot shutdown |
| `src/discord/client.ts` | discord.js client setup, intent config |
| `src/discord/handlers/messageCreate.ts` | Detect @bot mention in channel, route thread replies |
| `src/discord/parser.ts` | Extract target (URL / local path / project name / new project) from mention |
| `src/db/index.ts` | bun:sqlite wrapper, schema migration, typed CRUD on sessions |
| `src/db/schema.sql` | sessions table schema |
| `src/agent/runner.ts` | `Bun.spawn` wrapper around `claude -p --stream-json`; parses stream-json events |
| `src/agent/events.ts` | TypeScript types for `claude --output-format stream-json` events |
| `src/agent/runner.test.ts` | Unit tests for parser, registry, event type guards |
| `src/projects/registry.ts` | Auto-scan `PROJECTS_ROOT`; load optional `projects.json` aliases |
| `src/utils/path.ts` | `~` → `$HOME` expansion |
| `src/utils/git.ts` | `git clone` host-side helper (only used for git URL targets) |

## SQLite Schema

```sql
CREATE TABLE sessions (
  thread_id        TEXT PRIMARY KEY,           -- Discord snowflake
  channel_id       TEXT NOT NULL,
  repo_url         TEXT,                       -- git URL (clone required) — null when local_path is set
  local_path       TEXT,                       -- local filesystem path (no clone) — null when repo_url is set
  repo_path        TEXT NOT NULL,              -- resolved work dir: TASKS_ROOT/<thread-id> or expand(local_path)
  container_id     TEXT,                       -- (forward-compat; cleared on /kill in host-based mode)
  claude_session   TEXT,                       -- Claude Code session ID for --resume
  status           TEXT NOT NULL DEFAULT 'active',  -- active | idle | killed | done
  created_at       INTEGER NOT NULL,           -- unix ms
  last_activity_at INTEGER NOT NULL,
  total_messages   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_last_activity ON sessions(last_activity_at);
```

## IPC: Bot ↔ Claude

The bot reads Claude's stdout directly (no intermediary):

```
[bot]  ─── stdout pipe ──→  [parseJsonLines]  ─── events ──→  [discord edit]
         stream-json
```

`runner.ts` (host-side):
```typescript
const proc = Bun.spawn({
  cmd: ["claude", "-p", prompt, "--output-format", "stream-json",
        "--verbose", "--permission-mode", mode, "--resume", sessionId],
  cwd: repoPath,
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env },
});

for await (const event of parseJsonLines(proc.stdout)) {
  // dispatch to callbacks (onTextDelta, onToolUse, onThinking, onResult)
}
```

The subprocess is tracked in `cleanup.ts` so SIGTERM on the bot propagates
to in-flight `claude` runs (no orphan processes).

## Host Paths

| Purpose | Path |
|---------|------|
| Bot repo | `~/Sites/localhost/claude-bridge/` |
| Session DB | `<repo>/data/sessions.db` |
| Per-thread work dir (git URL targets) | `~/www/discord-claude-tasks/<thread-id>/` |
| Per-thread work dir (project / local path) | the resolved project / path itself |
| Claude config (shared) | `~/.claude/` (read by `claude` directly) |

## Configuration (env vars)

| Var | Default | Description |
|-----|---------|-------------|
| `DISCORD_TOKEN` | (required) | Bot token from Discord dev portal |
| `DISCORD_CHANNEL_ID` | (required) | Channel where bot listens |
| `DISCORD_USER_ID` | (required) | Your Discord user ID (only allow your mentions) |
| `TASKS_ROOT` | `~/www/discord-claude-tasks` | Per-thread work dirs parent (git URL targets) |
| `PROJECTS_ROOT` | `~/www` | Directory scanned for project names |
| `PROJECTS_CONFIG` | (empty) | Optional `projects.json` for aliases / exclude / hidden |
| `DATA_DIR` | `./data` | SQLite + logs |
| `IDLE_TIMEOUT_MIN` | `30` | (reserved) |
| `MAX_CONCURRENT_CONTAINERS` | `5` | Cap on simultaneous claude runs |
| `LOG_LEVEL` | `info` | debug / info / warn / error |
| `CLAUDE_DEFAULT_PERMISSION_MODE` | `acceptEdits` | Passed to `claude --permission-mode` |

## Security Boundary

```
[Discord]        ── bot process ──  [claude subprocess on host]
 untrusted                              semi-trusted
                          │
                          └─ runs with the bot user's permissions
                          └─ can read/write <work dir> (project or TASKS_ROOT/<thread>)
                          └─ reads ~/.claude/ (config, skills, creds)
                          └─ has network access (for git, npm, claude API)
                          └─ CAN see the rest of the user's home dir
                             (no isolation — this is the trade-off for
                              skipping Docker)
```

If you need stronger isolation, see the abandoned Week 3 milestone
in `MILESTONES.md` for the original Docker plan.
