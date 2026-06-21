# claude-bridge

Discord bot that bridges mentions to Claude Code development sessions.

Each Discord thread = one Claude Code task running on the host.

For long-running development work, the **Hermes Agent** layer adds a
"project manager" mode where you state a high-level goal and Hermes
decomposes it into tasks, drives Claude Code through each one, and
self-assesses completion. See [Hermes Agent](#hermes-agent) below.

## What it does

### Quick mode (mention `@bot`)
1. You mention `@bot` in your dev channel
2. Bot creates a Discord thread for the task
3. Bot resolves a target: existing project name, `new <name>`, git URL, or local path
4. Claude Code CLI runs on the host (`claude -p --stream-json`) with that work directory
5. Streamed output flows back into the thread (in-place message edits, throttled)
6. Files are written directly to the work dir; session is resumed on follow-ups

### Hermes mode (`/project start`)
1. You type `@bot /project start "build a CLI todo app"` in your dev channel
2. Bot creates a Discord thread for the project
3. **Auto mode (default)**: Hermes (the PM agent) plans 3-10 tasks via an LLM call, invokes Claude Code for each, self-assesses completion.
   **Manual mode**: the goal is passed directly to Claude Code as a single prompt — equivalent to the original `@bot <prompt>` flow but invoked via `/project start`.
4. After Claude Code finishes (manual) or all tasks are done (auto), you can continue in the same thread — replies resume the session via the existing `forwardToClaude` flow.

## Stack

| Layer | Choice |
|-------|--------|
| Runtime | Bun 1.3+ |
| Language | TypeScript |
| Discord | discord.js v14 |
| DB | bun:sqlite (WAL) |
| Claude | Claude Code CLI 2.1.183 (host subprocess, `--stream-json`) |
| IPC | `Bun.spawn` + stdout pipe demux |

## Quick start (local dev)

```bash
# 1. Install
bun install

# 2. Configure
cp .env.example .env
# Edit .env — fill in DISCORD_TOKEN, DISCORD_CHANNEL_ID, DISCORD_USER_ID

# 3. Make sure `claude` is on PATH
which claude   # should resolve (e.g. /opt/homebrew/bin/claude)

# 4. Run
bun run dev
```

## Discord bot setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. **Bot** → Reset Token → copy to `DISCORD_TOKEN`
4. **Bot** → enable **Message Content Intent**
5. **OAuth2** → URL Generator → scopes: `bot` → permissions:
   - Send Messages
   - Create Public Threads
   - Send Messages in Threads
   - Read Message History
6. Use the generated URL to invite the bot to your server
7. In your server, get your user ID (enable Developer Mode → right-click your name → Copy User ID) → paste into `DISCORD_USER_ID`
8. Get the channel ID where you want the bot to listen → paste into `DISCORD_CHANNEL_ID`

## Usage

In your dev channel, mention the bot. The bot accepts four kinds of targets:

### 1. By project name (recommended for `~/www/` projects)

The bot auto-discovers subdirectories of `~/www/` (or `$PROJECTS_ROOT`):

```
@bot fix auth in claude-bridge
@bot work on ai-david-2
@bot review my-app
```

The bot matches by preposition (`in`, `on`, `for`, `use`, `with`) or by any word in your message.

### 2. New project creation

```
@bot new my-app build a CLI tool for image resizing
@bot create blog-cms: a static site generator in Next.js
@bot init landing-page
```

The bot will:
1. Create `~/www/<name>/` if it doesn't exist
2. `git init` inside it
3. Run Claude Code on the host with your prompt

If `<name>` already exists, you'll get a helpful error suggesting `in <name>` instead.

### 3. With a git URL (clones into per-thread dir)

```
@bot fix auth bug on github.com/foo/bar
@bot work on https://gitlab.com/team/proj
@bot ssh git@git.example.com:foo/bar.git
```

The bot clones into `~/www/discord-claude-tasks/<thread-id>/`.

### 4. With a local path (no clone)

```
@bot refactor /Users/david/code/foo
@bot fix bug in ~/www/my-project
@bot work on ./src
```

The bot runs Claude Code directly in your existing directory.

### Inside the thread

Just type messages — each one is forwarded to Claude Code:

```
add unit tests too
```

The thread shares one Claude Code session across messages; context is preserved
via `claude --resume <sessionId>` (CLI path) or the SDK's on-disk session
resume (SDK path — see [How it works](#how-it-works)).

By default, threads use the **SDK runner** (Phase 2). CC communicates via
four custom MCP tools exposed by the bot (`discord_send`, `discord_typing`,
`discord_react`, `discord_read_history`). Use `/use-cli` to fall back to
the legacy streaming runner per-thread.

### Slash-style commands (in threads)

| Command | Description |
|---------|-------------|
| `/repo <url\|path\|name>` | Set or change the target (git URL, local path, or project name) |
| `/projects` | List all known projects |
| `/kill` | Stop the session (CLI: marks DB row; SDK: also aborts the in-flight query) |
| `/status` | Show session info: thread ID, status, target, runner, claude session, message count |
| `/use-cli` | Switch this thread to the **CLI runner** (legacy `claude -p` subprocess) |
| `/use-sdk` | Switch this thread to the **SDK runner** (Claude Agent SDK + Discord tools) |

## Hermes Agent

Hermes is an autonomous "project manager" layer that sits on top of
Claude Code. Two modes:

- **Auto mode (default)**: Hermes plans 3-10 tasks via an LLM, drives
  Claude Code through each in dependency order, then self-assesses
  completion with a judge LLM. Best for non-trivial multi-step work.
- **Manual mode**: the goal is passed directly to Claude Code as a
  single prompt — equivalent to the original `@bot <prompt>` mention
  flow, but invoked via `/project start`. Best for short, single-step
  instructions where you want to keep the Hermes thread / status UI
  but skip the planning loop.

**Workflow:**

```
David (Chairman) ─── "build a CLI todo app" ──→ Hermes (PM) ──→ Claude Code (Engineer)
                              ▲                                    │
                              └────────── deliverable ─────────────┘
```

**Quick start:**

```
/project start "build a CLI todo app"            # auto mode (default)
/project start --mode=manual "refactor auth"     # manual mode (direct Claude Code)
/project start in ~/work "build a CLI todo"      # use existing dir
/project start --max-iterations=5 "quick fix"    # safety cap override
```

After Claude Code finishes (manual) or all tasks are done (auto), you
can continue in the same thread — replies resume the session via
`forwardToClaude`.

**In a project thread:**

| Command | Description |
|---------|-------------|
| `/project status` | Show current state, progress, cost, time |
| `/project plan` | Show the LLM-generated plan (auto mode only) |
| `/project setMode auto\|manual` | Switch mode (only on non-active projects) |
| `/project kill` | Mark the project killed; in-flight Claude Code run is aborted |
| `/project resume` | Re-run a killed or failed project (auto mode) |

**Channel-level (works anywhere):**

| Command | Description |
|---------|-------------|
| `/project start [flags] "goal"` | Start a new project (creates a thread) |
| `/project list` | List all Hermes projects |

**How it works:**

- State is persisted to `data/hermes/projects/<project-id>/state.json`
  (atomic write) and a human-readable `plan.md` + append-only
  `journal.log`.
- The orchestrator runs `planning → executing ⇄ judging → done | failed | killed` (auto mode), or a single `Claude Code invocation → done | failed` (manual mode).
- The Discord typing indicator is on for the entire run (8s refresh).
- Safety caps (per project, configurable):
  - `HERMES_MAX_ITERATIONS` (default 20)
  - `HERMES_MAX_COST_USD` (default 500 cents = $5.00)
  - `HERMES_MAX_WALL_HOURS` (default 4)
  - `HERMES_MAX_ATTEMPTS_PER_TASK` (default 3, auto mode only)
- Resume: if the bot restarts mid-project, `HERMES_RESUME_ON_STARTUP=1`
  re-fires the orchestrator for any non-terminal auto project.
- Rollback: Hermes is purely additive. Remove `src/hermes/` and
  `src/discord/handlers/hermesCommands.ts` to revert.

See [`docs/operations/0003-hermes-agent.md`](docs/operations/0003-hermes-agent.md)
for the full design ADR.

### Resolution order (parser)

When you mention the bot, it tries, in order:

1. `new <name> <prompt>` / `create <name>: <prompt>` — new project
2. Git URL (https://, git@) — clone
3. Local path (`/foo`, `~/foo`, `./foo`, `../foo`) — direct
4. Preposition + name match: "in foo", "use foo" — project lookup
5. Word match against known projects — project lookup
6. Otherwise: ask for target via `/repo`

## Production deploy

See [`deploy/DEPLOY.md`](deploy/DEPLOY.md) for full instructions. tl;dr:

```bash
# macOS
cp deploy/com.claudebridge.bot.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.claudebridge.bot.plist

# Linux
sudo cp deploy/claude-bridge.service /etc/systemd/system/
sudo systemctl enable --now claude-bridge
```

## How it works

Two runners are available. New threads default to the **SDK runner**
(`CLAUDE_USE_SDK=1`); use `/use-cli` per-thread to fall back to the
streaming CLI runner.

### SDK runner (default, Phase 2+)

```
Discord thread message
  → bot: stores session in SQLite (thread_id ↔ claude_session_id,
                                       runner_kind = "sdk")
  → bot: query({ prompt, options: { resume, cwd, mcpServers,
                                     systemPrompt, ... } })
         cwd = resolved work dir
  → CC consumes its own stream internally
  → CC calls mcp__discord-bridge__discord_send (and 3 other tools)
         → bot handler posts via SendQueue → Discord
  → CC's plain text responses are auto-surfaced to Discord by the bot
  → result message → bot edits placeholder with stats header
  → process exits; on-disk session persists for next /resume
```

The SDK exposes four custom tools to CC:

| Tool | Purpose |
|------|---------|
| `discord_send(content, reply_to_message_id?)` | Post a message to the thread |
| `discord_typing()` | Show the typing indicator |
| `discord_react(message_id, emoji)` | Add a reaction emoji |
| `discord_read_history(limit?)` | Fetch earlier messages from the thread |

### CLI runner (legacy, opt-in via `/use-cli`)

```
Discord thread message
  → bot: stores session in SQLite (runner_kind = "cli")
  → bot: Bun.spawn(["claude", "-p", prompt, "--output-format", "stream-json",
                     "--verbose", "--resume", sessionId, ...])
         cwd = resolved work dir
  → claude writes stream-json to its stdout
  → bot: stdout pipe demux → parseJsonLines → typed events
  → bot: throttle-edits a Discord message as text accumulates
  → bot: persists new session ID for next --resume
  → process exits, files remain on host
```

## Status

Weeks 1, 2, 4 complete:
- Week 1 — Discord skeleton ✅
- Week 2 — Claude Code CLI integration ✅
- Week 3 — Docker containerization ❌ abandoned (chose host-based CLI instead)
- Week 4 — Streaming, slash commands, graceful shutdown, deploy ✅

Phase 1 — Claude Agent SDK path (parallel to CLI, env-var opt-in) ✅
Phase 1 follow-up — System prompt prefix forcing CC to use `discord_send` ✅
Phase 2 — Per-thread runner control (`runner_kind` column + `/use-cli`/`/use-sdk`) ✅
Phase 2.5 — Hardening: CLAUDE_TURN_TIMEOUT + in-process RSS self-watchdog + RAM trace tools ✅
Phase 3 — Hermes Agent (autonomous PM layer) ✅

## Layout

```
claude-bridge/
├── src/
│   ├── index.ts                       # entry point + graceful shutdown
│   ├── config.ts                      # env loading
│   ├── cleanup.ts                     # subprocess tracking + SIGTERM on exit
│   ├── logger.ts                      # structured logger
│   ├── memoryMonitor.ts               # in-process RSS self-watchdog + trace writer
│   ├── types.ts                       # shared types
│   ├── agent/
│   │   ├── runner.ts                  # host-side Claude Code CLI runner
│   │   ├── sdkRunner.ts               # Claude Agent SDK runner (Phase 2 default)
│   │   ├── discordTool.ts             # four MCP tools exposed to CC
│   │   ├── systemPrompt.ts            # Discord-prefixed system prompt loader
│   │   └── events.ts                  # stream-json event types
│   ├── hermes/                        # Hermes Agent (Phase 3) — autonomous PM
│   │   ├── types.ts                   # ProjectState / Task / JournalEntry
│   │   ├── state.ts                   # atomic state.json I/O + journal append
│   │   ├── planner.ts                 # LLM goal decomposition (Haiku)
│   │   ├── judge.ts                   # LLM self-assessment (Haiku)
│   │   ├── executor.ts                # wraps runViaSdk with task semantics
│   │   ├── orchestrator.ts            # main state machine + resume
│   │   ├── typing.ts                  # Discord typing indicator helper
│   │   └── discord.ts                 # Discord embed/format helpers
│   ├── discord/
│   │   ├── client.ts                  # discord.js setup
│   │   ├── parser.ts                  # mention + URL + project parser
│   │   ├── sendQueue.ts               # throttled Discord message queue
│   │   ├── split.ts                   # message chunking
│   │   └── handlers/
│   │       ├── messageCreate.ts       # main bot logic (dispatch /project + @bot)
│   │       ├── commands.ts            # /kill /status /projects /repo /use-cli /use-sdk
│   │       ├── hermesCommands.ts      # /project start|status|list|plan|kill|resume
│   │       ├── streaming.ts           # CLI / SDK runner dispatch
│   │       ├── targets.ts             # project list + target resolution + repo clone
│   │       └── format.ts              # text/tool formatting helpers
│   ├── projects/
│   │   └── registry.ts                # ~/www/ project discovery
│   ├── db/
│   │   ├── schema.sql
│   │   └── index.ts                   # bun:sqlite wrapper
│   └── utils/
│       ├── path.ts                    # tilde expansion
│       └── git.ts                     # git clone helper
├── scripts/
│   ├── memory-watchdog.sh             # OS-level RSS watchdog (cron via launchd)
│   ├── ram-investigation.sh           # one-shot RAM diagnostic report
│   ├── ram-trace-summary.sh           # summarize BOT_RAM_TRACE=1 output
│   ├── notify-discord.sh              # Discord notification helper (used by watchdog)
│   └── migrate.ts                     # one-time DB additive migrations
├── deploy/
│   ├── com.claudebridge.bot.plist     # macOS launchd
│   ├── claude-bridge.service          # Linux systemd
│   └── DEPLOY.md                      # full deploy guide
├── docs/
│   ├── PRD.md
│   ├── ARCHITECTURE.md
│   ├── MILESTONES.md
│   ├── AUDIT.md
│   ├── taskboard.md
│   └── operations/
│       ├── 0001-bridge-silent-death.md
│       ├── 0002-bridge-long-task-memory-leak.md
│       └── 0003-hermes-agent.md
├── projects.json.example              # example project aliases/excludes
├── data/                              # SQLite + logs (gitignored)
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

## Configuration

### Environment

| Var | Default | Description |
|-----|---------|-------------|
| `DISCORD_TOKEN` | (required) | Bot token |
| `DISCORD_CHANNEL_ID` | (required) | Channel where bot listens |
| `DISCORD_USER_ID` | (required) | Your Discord user ID |
| `TASKS_ROOT` | `~/www/discord-claude-tasks` | Per-thread dir for cloned repos |
| `PROJECTS_ROOT` | `~/www` | Directory scanned for project names |
| `PROJECTS_CONFIG` | (empty) | Optional path to `projects.json` for aliases |
| `DATA_DIR` | `./data` | SQLite + logs |
| `IDLE_TIMEOUT_MIN` | `30` | (reserved) |
| `MAX_CONCURRENT_CONTAINERS` | `5` | Cap on simultaneous claude runs |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `CLAUDE_DEFAULT_PERMISSION_MODE` | `acceptEdits` | Passed to `claude --permission-mode` (CLI path only) |
| `CLAUDE_USE_SDK` | `0` | Phase 2: `1` enables the SDK path; `0` forces CLI globally. Per-thread `runner_kind` (set by `/use-sdk` / `/use-cli`) is honored when this is `1`. |
| `CLAUDE_SDK_MODEL` | (empty) | Optional model override for the SDK path (e.g. `claude-sonnet-4-6`) |
| `CLAUDE_SDK_PERMISSION_MODE` | `acceptEdits` | Permission mode passed to the SDK |
| `CLAUDE_SYSTEM_PROMPT_FILE` | `dev_agent/adapters/claude-code/agent.md` | Path to a Markdown file. On the SDK path, a Discord-specific instruction block is prepended automatically. |
| `CLAUDE_TURN_TIMEOUT_MS` | `3600000` | Hard cap on a single Claude run. The SDK aborts the query via native `AbortController` when exceeded. |
| `BOT_RSS_THRESHOLD_MB` | `800` | In-process RSS self-watchdog. Bot exits if its RSS exceeds this. Defense-in-depth if the OS-level watchdog is disabled. |
| `BOT_RSS_SAMPLE_INTERVAL_MS` | `30000` | Self-watchdog sample interval. |
| `BOT_RAM_TRACE` | `0` | `1` enables appending RSS + heap samples to `data/ram-trace.log` (CSV) for offline long-task validation. |
| `HERMES_DIR` | `<DATA_DIR>/hermes` | Where Hermes stores project state. |
| `HERMES_MODEL` | `claude-haiku-4-5` | Model for Hermes's planner + judge LLM calls. Cheap and fast. |
| `HERMES_MAX_ITERATIONS` | `20` | Per-project hard cap on total task attempts. |
| `HERMES_MAX_COST_USD` | `500` | Per-project cost cap, in cents ($5.00 default). |
| `HERMES_MAX_WALL_HOURS` | `4` | Per-project wall-clock cap. |
| `HERMES_MAX_ATTEMPTS_PER_TASK` | `3` | Retries per individual task before marking failed. |
| `HERMES_RESUME_ON_STARTUP` | `1` | `1` re-fires the orchestrator for non-terminal projects on bot start. |

### projects.json (optional)

```json
{
  "projects": {
    "my-project": "~/code/my-project",
    "secret-stuff": "/Volumes/External/work"
  },
  "exclude": ["old-projects"],
  "hidden": ["playground"]
}
```

- `projects`: aliases / paths outside `PROJECTS_ROOT`
- `exclude`: skip these subdirectory names when scanning
- `hidden`: still mountable but hidden from `/projects` output

## Tests

```bash
bun test          # 194 unit tests (138 legacy + 56 Phase 2.5/3)
bun run typecheck # 0 errors
```

## License

Personal use.
