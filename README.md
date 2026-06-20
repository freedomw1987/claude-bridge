# claude-bridge

Discord bot that bridges mentions to Claude Code development sessions.

Each Discord thread = one Claude Code task running on the host.

## What it does

1. You mention `@bot` in your dev channel
2. Bot creates a Discord thread for the task
3. Bot resolves a target: existing project name, `new <name>`, git URL, or local path
4. Claude Code CLI runs on the host (`claude -p --stream-json`) with that work directory
5. Streamed output flows back into the thread (in-place message edits, throttled)
6. Files are written directly to the work dir; session is resumed on follow-ups

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
via `claude --resume <sessionId>`.

### Slash-style commands (in threads)

| Command | Description |
|---------|-------------|
| `/repo <url\|path\|name>` | Set or change the target (git URL, local path, or project name) |
| `/projects` | List all known projects |
| `/kill` | Stop the session (subprocess killed; files stay on host) |
| `/status` | Show session info: thread ID, status, target, claude session, message count |

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

```
Discord thread message
  → bot: stores session in SQLite (thread_id ↔ claude_session_id)
  → bot: Bun.spawn(["claude", "-p", prompt, "--output-format", "stream-json",
                     "--verbose", "--resume", sessionId, ...])
         cwd = resolved work dir (project dir, local path, or TASKS_ROOT/<thread-id>)
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

## Layout

```
claude-bridge/
├── src/
│   ├── index.ts                       # entry point + graceful shutdown
│   ├── config.ts                      # env loading
│   ├── cleanup.ts                     # subprocess tracking + SIGTERM on exit
│   ├── logger.ts                      # structured logger
│   ├── types.ts                       # shared types
│   ├── agent/
│   │   ├── runner.ts                  # host-side Claude Code runner
│   │   ├── events.ts                  # stream-json event types
│   │   └── runner.test.ts             # unit tests
│   ├── discord/
│   │   ├── client.ts                  # discord.js setup
│   │   ├── parser.ts                  # mention + URL + project parser
│   │   └── handlers/
│   │       └── messageCreate.ts       # main bot logic
│   ├── projects/
│   │   └── registry.ts                # ~/www/ project discovery
│   ├── db/
│   │   ├── schema.sql
│   │   └── index.ts                   # bun:sqlite wrapper
│   └── utils/
│       ├── path.ts                    # tilde expansion
│       └── git.ts                     # git clone helper
├── deploy/
│   ├── com.claudebridge.bot.plist     # macOS launchd
│   ├── claude-bridge.service          # Linux systemd
│   └── DEPLOY.md                      # full deploy guide
├── docs/
│   ├── PRD.md
│   ├── ARCHITECTURE.md
│   ├── MILESTONES.md
│   └── taskboard.md
├── scripts/
│   └── migrate.ts
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
| `CLAUDE_DEFAULT_PERMISSION_MODE` | `acceptEdits` | Passed to `claude --permission-mode` |

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
bun test          # 50 unit tests
bun run typecheck # 0 errors
```

## License

Personal use.
