# claude-bridge — System Architecture

## High-Level Diagram

Two runners are available, selected per-thread via the `runner_kind`
column in `sessions` and overridable globally via `CLAUDE_USE_SDK`:

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
│  │ mention parser  │→ │ session manager  │→ │  runner   │ │
│  │ (extract URL,   │  │ (thread_id ↔     │  │  (CLI or  │ │
│  │  parse intent)  │  │  claude_session, │  │   SDK)    │ │
│  └─────────────────┘  │  runner_kind)    │  └─────┬─────┘ │
│                       └──────────────────┘        │       │
│  ┌──────────────────────────────────────────────┐  │       │
│  │ bun:sqlite (sessions.db)                     │  │       │
│  └──────────────────────────────────────────────┘  │       │
└────────────────────────────────────────────────────┼───────┘
                                                     │
                          ┌──────────────────────────┴─────┐
                          │ runner_kind = "cli"              │ runner_kind = "sdk"
                          ▼                                 ▼
       ┌────────────────────────────────┐    ┌──────────────────────────────────────┐
       │  Bun.spawn("claude -p --       │    │  query({ prompt, options: {        │
       │    stream-json")               │    │    resume, cwd, mcpServers,        │
       │  → parseJsonLines              │    │    systemPrompt, ... } })          │
       │  → pendingText + SendQueue     │    │  → SDK consumes its own stream     │
       │  → throttle-edits placeholder  │    │  → CC calls discord_send tool      │
       │                                │    │    (handler posts to Discord)      │
       │                                │    │  → CC's plain text is              │
       │                                │    │    auto-surfaced by the bot        │
       └────────────────────────────────┘    └──────────────────────────────────────┘
                          │                                 │
                          ▼                                 ▼
       ┌─────────────────────────────────────────────────────────────────────────────────┐
       │  Claude Code (host subprocess in either case)                                  │
       │  cwd = <work dir>   (project dir, local path, or TASKS_ROOT/<thread-id>)       │
       │  Files are written directly to <work dir> on the host.                         │
       └─────────────────────────────────────────────────────────────────────────────────┘
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
| `src/config.ts` | Load + validate env vars (Discord, paths, SDK options, kill switch `CLAUDE_USE_SDK`) |
| `src/logger.ts` | Structured logging (dev = pretty, prod = JSON) |
| `src/cleanup.ts` | Track active `claude` subprocess PIDs; SIGTERM them on bot shutdown (CLI path only) |
| `src/discord/client.ts` | discord.js client setup, intent config |
| `src/discord/handlers/messageCreate.ts` | Detect @bot mention in channel, route thread replies, dispatch CLI vs SDK runner |
| `src/discord/handlers/streaming.ts` | Runner orchestrator (CLI: stream parsing + SendQueue + placeholder; SDK: `query()` + tool dispatch + auto-surface CC plain text) |
| `src/discord/handlers/commands.ts` | Slash command matchers + handlers (`/kill`, `/status`, `/projects`, `/repo`, `/help`, `/use-cli`, `/use-sdk`) |
| `src/discord/parser.ts` | Extract target (URL / local path / project name / new project) from mention |
| `src/db/index.ts` | bun:sqlite wrapper, schema migration (additive for `mode`, `runner_kind`, etc.), typed CRUD on sessions |
| `src/db/schema.sql` | sessions table schema (base columns; additive migrations applied at boot) |
| `src/agent/runner.ts` | CLI runner: `Bun.spawn` wrapper around `claude -p --stream-json`; parses stream-json events |
| `src/agent/sdkRunner.ts` | SDK runner: wraps `query()` from `@anthropic-ai/claude-agent-sdk`; manages per-thread active queries; auto-surfaces CC's plain text replies |
| `src/agent/discordTool.ts` | The four custom tools (`discord_send`, `discord_typing`, `discord_react`, `discord_read_history`) exposed to CC via `createSdkMcpServer()` |
| `src/agent/systemPrompt.ts` | Loads the user's system prompt file and prepends a Discord-specific instruction block on the SDK path |
| `src/agent/events.ts` | TypeScript types for `claude --output-format stream-json` events (CLI path) |
| `src/agent/*.test.ts` | Unit tests for runners, tool handlers, system prompt, DB migration |
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
  total_messages   INTEGER NOT NULL DEFAULT 0,
  -- Phase 0 (autopilot feature, added in commit f70f6ea):
  mode             TEXT NOT NULL DEFAULT 'manual',  -- manual | autopilot
  milestone_goal   TEXT,
  milestone_criteria TEXT,
  -- Phase 2: per-thread runner selection
  runner_kind      TEXT NOT NULL DEFAULT 'sdk'     -- 'cli' | 'sdk'
);

CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_last_activity ON sessions(last_activity_at);
CREATE INDEX idx_sessions_runner_kind ON sessions(runner_kind);
```

`runner_kind` is added by an additive migration at boot (mirroring
the `mode` pattern). Legacy rows created before the migration read as
`'cli'` via `rowToSession`'s `?? 'cli'` fallback, preserving prior
behavior until the user explicitly switches them with `/use-sdk`.

## IPC: Bot ↔ Claude

Two paths depending on the runner:

### CLI runner (`runner_kind = "cli"`)

The bot reads Claude's stdout directly (no intermediary):

```
[bot]  ─── stdout pipe ──→  [parseJsonLines]  ─── events ──→  [discord edit]
         stream-json
```

`src/agent/runner.ts` (host-side):
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

### SDK runner (`runner_kind = "sdk"`)

The bot uses `@anthropic-ai/claude-agent-sdk`'s `query()` function, which
spawns a `claude` subprocess internally. The SDK manages the stream and
dispatches MCP tool calls to our registered handlers.

```
[bot]  ─── query({ prompt, options }) ───→  [SDK subprocess (managed)]
                                                       │
       for-await SDKMessage ◄─── stream-json events ───┘
              │
              ├─ assistant (text block)     → strip <thinking>, auto-post to Discord
              ├─ assistant (tool_use block) → SDK calls our handler (e.g. discord_send)
              │                                  handler.posts via SendQueue → Discord
              ├─ system/init (session_id)    → persist for resume
              └─ result (success/error)      → edit placeholder with stats header
```

`src/agent/sdkRunner.ts` (host-side):
```typescript
const mcpServer = createSdkMcpServer({
  name: "discord-bridge",
  tools: allDiscordTools, // [discordSendTool, discordTypingTool, ...]
});

const q = query({
  prompt,
  options: {
    cwd: session.repoPath,
    resume: session.claudeSession,
    mcpServers: { "discord-bridge": mcpServer },
    systemPrompt: await readSystemPrompt(), // prepended with Discord block
    permissionMode: config.claude.sdkPermissionMode,
    canUseTool: async (name) =>
      name.startsWith("mcp__discord-bridge__")
        ? { behavior: "allow" }
        : { behavior: "allow" },
  },
});

for await (const msg of q) {
  // track sessionId, tool count, auto-surface CC text
}
```

Sessions persist on disk under `~/.claude/projects/<encoded-cwd>/` and
are resumed by passing `options.resume = <sessionId>` on subsequent
runs. Active queries are tracked in an in-memory `Map<threadId, Query>`
so `/kill` can call `query.close()` to abort mid-flight.

#### Why a Zod 3 pin is required

The `@modelcontextprotocol/sdk` that the agent SDK embeds uses
`zod-to-json-schema@^3` to convert tool schemas to JSON Schema for the
MCP protocol. That library is Zod 3 only — it reads `_def.typeName`,
which doesn't exist on Zod 4 schemas (they have `_def.type` and a
`_zod` field). Mixing Zod 4 with the MCP layer produces "Zod validation
error" at the permission layer and every tool call fails.

`package.json` therefore pins `"zod": "^3.25"` and adds an
`overrides` entry so the entire dependency tree resolves to a single
Zod 3. The startup diagnostic in `sdkRunner.ts` logs the resolved
zod version so regressions are easy to spot.

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
