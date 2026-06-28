# Changelog — claude-bridge

所有重要改動嘅時序日誌。Tag 嘅 message 係呢份 file 嘅濃縮版。
詳細 discussion 睇 [docs/operations/](operations/) 入面嘅 ADR, retros 睇 [docs/retros/](retros/)。

---

## [v2.1.0] — 2026-06-27

**Phase 3 收尾 — 退役 CLI runner、refactor、hardening。**

呢個 minor release 將 codebase 由「v2.0 Hermes 加 SDK 過渡版」做一次完整 hardening:
- 退役 legacy CLI subprocess runner,單一 SDK path
- 大文件拆細,DX 大幅改善
- 修咗 3 個隱藏 bug(N3 真係 concurrency bug + appendJournal dead code + recursion → loop)
- 加咗 graceful shutdown + Discord warning
- RAM profile tooling 完整化

### 🎯 主要功能

- **Phase 3 — CLI runner 退役** — 刪 `runner.ts` / `events.ts` / `runner.test.ts`、`runner_kind` column、`/use-cli` `/use-sdk` commands、`CLAUDE_USE_SDK` env。Codebase -25%。
- **Codebase 重組** — `hermesCommands.ts` (1483 行) 拆 8 modules;`orchestrator.ts` (858 行) 拆 6 modules;`format.ts` dead code 清咗。
- **RAM profile tooling** — `scripts/ram-trace-analyze.ts` TypeScript analyzer + ASCII chart + Hermes-aware cross-correlation + `docs/operations/0004-ram-profiling.md` 使用指南。
- **Graceful shutdown (G1+G2+G3)** — `SHUTDOWN_GRACE_MS` env (default 30000),SIGTERM 期間 in-flight runs 仲可以 finish;Post Discord warning 畀每個有 in-flight work 嘅 thread。

### 🛡️ Reliability + Bug fixes

- **N3 真 concurrency bug** — 之前 `activeProcessCount()` 唔 count SDK runs → SDK path 繞過 `MAX_CONCURRENT_CONTAINERS` cap,可能 over-spawn。已 fix。
- **B1 appendJournal dead code** — 之前每次 append 都做多一次 sync `loadState` + JSON.parse,但 mutation 從來無 `saveState`,永遠被 overwrite。Hermes auto-mode 每 project ~20 浪費 disk reads。已清。
- **B2 recursion → loop** — `runProject` 之前用 recursive call 處理 judge verdict `needs_more`,5-10 task project = 5-10 層 call stack。已改成 `while(true) + continue outer` label。Stack bounded 1 frame。
- **Q1 registry statSync** — 之前每次 scan 都做 statSync(60 dirs = 60 syscalls)。`withFileTypes` 已經俾 `isDirectory()`,改為只 follow symlinks。
- **env 白名單** — runner.ts 用 `buildSafeEnv()` 而唔係 `...process.env`,防止 AWS/GitHub/NPM tokens leak 落 Claude subprocess。
- **SIGTERM grace + SIGKILL fallback** — cleanup.ts SIGTERM 2s grace + SIGKILL survivors,防止 orphaned processes。

### 🔧 Maintainability + DX

- **M1 void noise** — state.ts 3 處 `void _h;` 刪咗(TS 已經 accept `_` 開頭 destructured unused)。
- **M3 classifyError** — orchestrator catch block 由 ~50 行 nested ternary 變 ~10 行 typed helper。
- **T1 extractRawSnippet** — 同上,從 chained ternary 變兩行 instanceof check。
- **M4 dedupe stripMention** — 新 `src/discord/stripMention.ts`,hermes/matchers.ts + messageCreate.ts 共用(7 unit tests)。
- **B2 loopGuard 常數** — 改 `LOOP_GUARD_LIMIT` named constant。

### 🏗️ Infrastructure

- **SendQueue** 1100ms → 1000ms (+10% streaming throughput,仍然喺 Discord 5msg/5s limit 內)。
- **Restart bot** — `SHUTDOWN_GRACE_MS` env var(30s default),可 override。

### 📊 Scale

| Metric | v2.0.0 | v2.1.0 |
|--------|--------|--------|
| Source LoC | ~16,500 | **~8,700** (-47%) |
| Test count | 194 | **429** (+121%) |
| Test expects | ~570 | 1,055 (+85%) |
| Audit items closed | 11/44 | **25/44** (+14) |
| Hermes RG fixes | 11 | 11(stable) |
| Files > 500 LoC | 2 | **0** |
| Untracked files | 0 | 0 |

### 📚 文檔

- `docs/proposals/0001-hermes-tracker-app.html` — Desktop + Mobile tracker APP 規劃 proposal(Bun + React + Tauri stack)。
- `docs/operations/0004-ram-profiling.md` — RAM profile workflow + expected curve。
- `docs/ANALYSIS-2026-06-27.md` — 完整項目分析 + 優化建議。

### 🚀 Migration

純內部重構 + bug fixes,zero 對外 API 改動。`runner_kind` column 由 SQLite migration 自動 drop(下次 bot start 即清)。`/use-cli` `/use-sdk` commands 已退役,如要 fallback,請用 `CLAUDE_USE_SDK=0` env(仍然支援,但 default 已係 SDK)。

### 📌 Next

- **v2.2.0** — Hermes Tracker APP Phase 1(Backend HTTP API + SSE)
- 詳見 `docs/proposals/0001-hermes-tracker-app.html` 嘅 phased rollout plan

---

## [v2.0.0] — 2026-06-22

**Hermes 自動化開化 — 由「人手逐 task」進化到「David 講 goal, Hermes 自動拆 plan + 派 Claude Code + 自己 judge」**

呢個 milestone 將 claude-bridge 由 1-shot bridge 升級做 3-tier 自主 agent loop:
David (董事長) → Hermes Agent (PM) → Claude Code (工程師)。

### 🎯 主要功能

- **/project start** — David 喺 Discord channel 用一句話講 goal, Hermes 開新 thread + state machine 自動跑
- **/project list / status / plan / kill / resume** — 完整 project lifecycle 指令
- **3-tier agent loop** — David → Hermes → Claude Code, 每層有清晰 contract
- **Per-project state persistence** — `<hermesDir>/projects/<id>/` 下面 `state.json` + `plan.md` + `journal.log` + `artifacts/`, 寫入用 write-to-tmp + rename 確保 atomic
- **Orchestrator state machine** — `planning → executing → judging → done|failed|killed|timed_out|parse_error`, 9 個 terminal + non-terminal states
- **Auto-mode timer (ADR-0004)** — `/project setMode auto <duration>` 自動 re-arm, live countdown embed, kill reason = `duration_expired`
- **/project adopt** — 將 plain Claude Code thread 升級做 Hermes-managed, 保留原 session context
- **/project delete** — 清死 project (`--all-failed` bulk mode), active project refuse 保護
- **Discord interface** — 所有 Hermes message 加 `🪪 Hermes:` prefix 區分 Claude Code output

### 🛡️ Safety caps (per project)

| Cap | Default | Env var |
|---|---|---|
| Max iterations | 20 | `HERMES_MAX_ITERATIONS` |
| Max cost (cents) | 500 ($5.00) | `HERMES_MAX_COST_USD` |
| Max wall-clock (hours) | 4 | `HERMES_MAX_WALL_HOURS` |
| Max attempts per task | 3 | `HERMES_MAX_ATTEMPTS_PER_TASK` |
| Planner timeout | 15 min | `HERMES_PLANNER_TIMEOUT_MS` |

### 🔧 Reliability + UX (呢個 milestone 期間嘅 6 個 RG fix)

- **RG-002** — Strip `<ant_thinking>` + `<thinking>` 由 CC output, 避免 Discord 顯示噪音
- **RG-004** — `/project adopt` + thread-upgrade workflow + retroactive retrospective
- **RG-005** — Hermes runner send callbacks 用 `makeClaudeSend` 包, 防 race
- **RG-006** — `/project setMode auto` auto-resumes terminal project, 唔使人手 resume
- **RG-007** — `/project adopt` auto-kills same-repoRoot conflicts, 避免兩個 project 爭同一個 repo
- **RG-008** — Planner timeout → `status="timed_out"` + populated `killedReason` (解決 5-min 神秘 crash)
- **RG-009** — `/project delete` 完整 audit trail + active-project refusal
- **RG-010** — Planner JSON parse guard, `<think>` orphan-opener workaround

### 🏗️ Infrastructure

- **Turn timeout** (60 min default) — 防止單個 CC run hang 死成個 bot
- **RSS self-watchdog** — process RSS > 800MB 自動 exit, 配合 OS-level watchdog 做 defense-in-depth
- **RAM tracing** — `BOT_RAM_TRACE=1` 開 CSV log, 方便 debug SDK-era long-task 行為
- **SendQueue** — Discord sends rate-limited, 防止 429

### 📊 Scale

| Metric | v1.3.0 | v2.0.0 |
|---|---|---|
| Hermes 模組 LOC | — | ~1900 |
| 新 file | — | 12 |
| Test count | 109 | 182 (+73) |
| State files | — | 4 (state.json + plan.md + journal.log + artifacts/) |

### 📚 文檔

- `docs/operations/0003-hermes-agent.md` — ADR-0003 (核心架構決策)
- `docs/operations/0004-setmode-auto-duration.md` — ADR-0004 (auto-mode timer)
- `docs/ARCHITECTURE.md` — 已更新到 3-tier agent model
- `docs/MILESTONES.md` — M2.1–M2.11 + RG-001~RG-010 timeline
- `docs/retros/2026-06-22-m2-phase-1.5.md` — Hermes phase retrospective
- `docs/retros/2026-06-22-rg004-thread-adopt.md` — `/project adopt` retro
- `docs/claude-bridge-overview.html` — Boss-facing system overview, 可直接 Discord share

### 🚀 Migration / Rollback

純 additive。新嘅 `HERMES_*` env vars 全部 namespaced, 唔會撞舊 config。
Rollback = `git revert v2.0.0` 或 `rm -rf src/hermes/ src/discord/handlers/hermesCommands.ts`。
舊 `@bot` mention flow 完全唔受影響。

---

## [v1.3.0] — 2026-06-22

**Bridge runner migrate to Claude Agent SDK + memory fixes**

由 `Bun.spawn` CLI subprocess path 換做 `@anthropic-ai/claude-agent-sdk` in-process transport。
Structured tools (`discordTool.ts`) 讓 agent 喺 turn 內 post/edit/kill Discord message。
詳見 `git show v1.3.0` 同 ADR 內部 notes。

---

## [v1.2.0] — 2026-06-21

**Drop memory check (personal use, hard cap sufficient)**

移除晒所有 memory-based preflight / retry / dynamic-cap logic。
Single-user deployment 唔再 spuriously reject, OOM protection 改由 `MAX_CONCURRENT_CONTAINERS` 行 hard cap。

---

## [v1.1.0] — 2026-06-21

**Production hardening + UX + reliability**

Phase 1 audit (`docs/AUDIT.md`) follow-up + user UX feedback。

Highlights:
- `MAX_CONCURRENT_CONTAINERS` 真正 enforce, idle sweep mark timed-out sessions, git clone 有 timeout
- stderr drained in parallel with stdout (唔再撞 64KB pipe deadlock)
- Discord sends rate-limited via `SendQueue` (唔再 429)
- `/help` slash command + helpful error messages
- Subprocess memory preflight (防 OOM)
- Split 851-line `messageCreate.ts` 入 5 個 focused modules
- Test coverage 42 → 109 (+159%)

---

## [v1.0.0] — 2026-06-21

**First stable release**

Discord-to-Claude-Code bridge, post-supervisor re-baseline。
737035c initial bridge 基礎上加入:
- `deploy/restart.sh` cross-platform (launchd / systemd) service helper
- `splitForDiscord` stream-preserving splitter, long CC response 唔再 truncated
- 9 unit tests for splitter (73 tests total pass, typecheck clean)

Supersedes supervisor-era experimental work (preserved on `abandoned/supervisor-wip` branch)。