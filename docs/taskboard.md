# Task Board

> Live status. Updated as work progresses.

## Current Phase: Weeks 1, 2, 4 complete ✅ + Project Registry ✅ — Week 3 abandoned

## Status

- [x] Decisions locked (stack, mount, auth, repo path)
- [x] PRD written (`docs/PRD.md`)
- [x] Architecture documented (`docs/ARCHITECTURE.md`)
- [x] Milestones broken down (`docs/MILESTONES.md`)
- [x] Project skeleton
- [x] **Week 1 deliverable** — Discord bot skeleton
- [x] **Week 2 deliverable** — Claude Code CLI integration (host-based)
- [~] **Week 3 deliverable** — Docker containerization — **abandoned** (see MILESTONES.md)
- [x] **Week 4 deliverable** — Streaming, slash commands, graceful shutdown, deploy
- [x] **Project registry** — Auto-discover `~/www/`, project name resolution, `new <name>` syntax

## Project Registry ✅

- [x] Auto-scan `~/www/` (configurable via `PROJECTS_ROOT`)
- [x] Optional `projects.json` for aliases / exclude / hidden
- [x] Parser resolves project names via preposition ("in foo") or word match
- [x] `new <name> <prompt>` syntax — creates dir + git init + runs Claude
- [x] `/projects` slash command to list
- [x] `~/`, `/`, `./` ad-hoc paths still work
- [x] Verified: bot scans 61 projects in `~/www/` on startup

## Final Smoke Tests

```
$ bun run typecheck           → 0 errors ✅
$ bun test                    → 42 pass / 0 fail ✅
$ bot startup                 → 61 projects scanned, Discord ready ✅
$ migration                   → schema applied ✅
$ end-to-end claude run       → stream-json parsed, --resume works ✅
```

## Project Layout

```
claude-bridge/
├── src/                        # bot code (host)
│   ├── index.ts                # entry + graceful shutdown
│   ├── config.ts               # env loading
│   ├── cleanup.ts              # subprocess PID tracking + SIGTERM on exit
│   ├── logger.ts               # structured logger
│   ├── types.ts                # shared types
│   ├── agent/                  # host-side runner + events + tests
│   ├── discord/                # discord.js client + handlers + parser
│   ├── db/                     # bun:sqlite wrapper + schema
│   ├── projects/               # ~/www/ auto-scan + projects.json
│   └── utils/                  # path, git helpers
├── deploy/
│   ├── com.claudebridge.bot.plist    # macOS
│   ├── claude-bridge.service         # Linux
│   └── DEPLOY.md
├── docs/
│   ├── PRD.md
│   ├── ARCHITECTURE.md
│   ├── MILESTONES.md
│   └── taskboard.md (this file)
├── scripts/migrate.ts
├── projects.json.example
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

## Going to production

1. Replace `.env` with real Discord credentials
2. Make sure `claude` is on the system PATH (e.g. `/opt/homebrew/bin`)
3. `cp deploy/com.claudebridge.bot.plist ~/Library/LaunchAgents/` (mac) — see `deploy/DEPLOY.md` for full steps
4. `launchctl load ~/Library/LaunchAgents/com.claudebridge.bot.plist`
5. In Discord: `@bot hello on github.com/foo/bar`

## Blockers

None. Project is feature-complete for v1 (host-based mode).

## Known limitations / future work

- No web dashboard
- No approval gate for dangerous ops (default is `acceptEdits`)
- No process isolation — `claude` runs with full user permissions on the host
  (the Docker isolation was abandoned; see MILESTONES.md)
- Multi-user support not built (single-user by design)
- Slack/Telegram adapters would share most of the core
- Auto-cleanup of old `~/www/discord-claude-tasks/*` not implemented
- `tsconfig.json` declares a `@/*` path alias but no runtime alias is configured
  (harmless — no `@/...` imports exist in the codebase)
