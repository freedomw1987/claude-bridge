---
title: "claude-bridge 系統總覽 — 架構與功能"
---

# 系統總覽(架構 + 功能)

**一句講晒**: claude-bridge 係一個 **Discord bot**, 將你嘅 Discord 對話室直接駁去 **Claude Code**(本機行嘅 AI 編程助手), 等你可以喺 Discord 上面直接叫 Claude 幫你寫 code、整 bug、改架構, 唔使再開 terminal。

---

## 🎯 佢做咩?

想像你而家嘅 workflow:

```
1. 開 Terminal
2. cd ~/www/myproject
3. claude (開 Claude Code)
4. 寫 prompt
5. 等 Claude 改 code
6. 睇 diff
7. 反覆 loop
```

用咗 claude-bridge 之後:

```
1. 喺 Discord 寫 @bot 我想加個 login page
2. Claude 自動喺 myproject 開 thread
3. 佢直接改你嘅 file
4. 改完貼 diff 喺 Discord
5. 你睇完直接話 "go" / 收工
```

**核心價值**:
- 唔使離開 Discord 就可以 pair-program
- 每個 prompt / 任務 = 一個獨立 thread(可以 archive)
- 自動 git clone + setup work dir,你唔使再 `cd` / `git pull`
- 可以 arm 一個 **Hermes agent** 幫你自動跑 project(planning → executing → judging 迴圈)

---

## 🏗️ 架構(三層)

```
┌─────────────────────────────────────────────────────┐
│  Discord                                            │
│  #dev channel  ──@bot <prompt>──►  new thread       │
│                                ──/project start──►  │
└─────────────────────────┬───────────────────────────┘
                          │ Discord WebSocket
┌─────────────────────────▼───────────────────────────┐
│  claude-bridge bot  (Node.js + bun)                 │
│  ┌─────────────────┐  ┌────────────────────────┐    │
│  │ @bot flow       │  │ /project  flow         │    │
│  │  - 1-shot       │  │  - Hermes orchestrator │    │
│  │  - 直接 forward │  │  - planner / judge     │    │
│  │  - session 保存 │  │  - executor / state    │    │
│  └────────┬────────┘  └──────────┬─────────────┘    │
│           └──────────┬───────────┘                  │
│                      ▼                              │
│            ┌─────────────────────┐                  │
│            │  runViaSdk()        │                  │
│            │  (Claude Code SDK)  │                  │
│            └──────────┬──────────┘                  │
└───────────────────────┼─────────────────────────────┘
                        │ JSON-RPC over stdin/stdout
┌───────────────────────▼────────────────────────────┐
│  Claude Code  (host subprocess)                    │
│  cwd = ~/www/myproject                             │
│  直接讀寫 host file system                         │
└────────────────────────────────────────────────────┘
```

**一句解**: Discord 收 message → bot 解析 → 揀 runner → spawn Claude Code 落本機行 → 結果 stream 返 Discord。

---

## 🧩 兩種工作模式

### 1️⃣ `@bot <prompt>` — 1-shot 模式 (簡單即用)

```
你:  @bot 我想加個 login page
bot:  (開新 thread "📋 login page")
bot:  (clone 你個 repo / 跳入 local dir)
bot:  (forward 個 prompt 畀 Claude Code)
CC:   我幫你整咗 src/components/Login.tsx, ...
bot:  (stream 返個 diff / 結果)
```

**特性**:
- 1 thread = 1 個 prompt
- 跟住落嚟你可以繼續 reply 對話(會 resume 同一個 Claude session)
- 唔使預先 commit goal,純 free chat

### 2️⃣ `/project start "<goal>"` — Hermes 自動模式 (多任務規劃)

```
你:  /project start "build a todo CLI app with auth"
bot:  (開 thread "📋 build a todo CLI app with auth")
bot:  🎯 Hermes project started
bot:  📋 Planning...
[Hermes planner LLM]
bot:  Plan ready: 5 tasks
      1. Init project structure
      2. Build CLI entry point
      3. Add auth module
      4. Add todo CRUD
      5. Write tests
bot:  🛠 Task #1: Init project structure
      (CC runs task 1)
      (judge LLM check: needs_more → task 6)
bot:  🛠 Task #2: Build CLI entry point
      ...
bot:  ✅ All done
```

**特性**:
- 1 thread = 1 個 project(state machine: planning → executing ⇄ judging → done/failed/killed)
- LLM 自己拆 task、執行 task、自我審查(judge verdict)
- 有 safety cap: max iterations / cost / wall-hours
- Bot 重啟後自動 resume 啲 active project
- 可以 `/project setMode auto 1h` 限時 auto-run, 1h 後軟退出

---

## 📁 系統文件佈局

```
claude-bridge/
├─ src/
│  ├─ index.ts                    # 入口
│  ├─ config.ts                   # env vars
│  ├─ discord/                    # Discord handlers
│  │   ├─ client.ts
│  │   ├─ parser.ts               # parse @bot mention
│  │   └─ handlers/
│  │       ├─ messageCreate.ts    # 路由
│  │       ├─ streaming.ts        # CC runner orchestration
│  │       ├─ commands.ts         # /kill /status /projects
│  │       └─ hermesCommands.ts   # /project start|setMode|adopt|...
│  ├─ agent/                      # Claude Code integration
│  │   ├─ sdkRunner.ts            # SDK query() wrapper
│  │   ├─ runner.ts               # CLI fallback
│  │   └─ discordTool.ts          # CC 用的 Discord MCP tools
│  ├─ hermes/                     # 自動模式 brain
│  │   ├─ orchestrator.ts         # 主 state machine
│  │   ├─ planner.ts              # LLM 任務拆解
│  │   ├─ judge.ts                # LLM 自審
│  │   ├─ executor.ts             # 任務執行
│  │   ├─ state.ts                # state.json 持久化
│  │   ├─ types.ts
│  │   └─ duration.ts             # "30m" / "1h30m" parser
│  └─ db/                         # SQLite session store
├─ data/
│  ├─ sessions.db                 # Discord thread ↔ CC session 對照
│  ├─ bot.log
│  └─ hermes/
│     └─ projects/
│        └─ <uuid>/               # 每個 Hermes project 一個 dir
│           ├─ state.json         # 當前狀態
│           ├─ journal.log        # 決策 log
│           └─ plan.md
└─ ~/www/
   └─ <project>/                  # Claude Code 嘅實際 work dir
```

---

## ⚙️ 核心 sub-system 簡介

| Sub-system | 負責 | 點用 |
|---|---|---|
| **messageCreate** | 收 Discord message + 路由 | 自動, 你唔使理 |
| **@bot parser** | 解析 `@bot <prompt>` 個 prompt | 自動, prompt 第一句做 thread 名 |
| **runner (SDK / CLI)** | 落本機行 Claude Code | SDK 係 default, CLI 係 fallback |
| **Hermes orchestrator** | 自動模式 state machine | `/project start` 嗰陣 kick off |
| **planner + judge** | LLM 拆 task + 自審 | 內部 LLM (`claude-haiku-4-5`) |
| **state (disk)** | project 狀態持久化 | `data/hermes/projects/<uuid>/state.json` |
| **typing indicator** | Discord typing 燈 | 自動, 8s refresh |
| **memory monitor** | 自我 watchdog (RSS) | 自動, 超 800MB exit |

---

## 🛡️ Safety + Limits

| Cap | 默認值 | Env var |
|---|---|---|
| Max project iterations | 20 | `HERMES_MAX_ITERATIONS` |
| Max cost per project | $5 USD | `HERMES_MAX_COST_USD` |
| Max wall hours per project | 4h | `HERMES_MAX_WALL_HOURS` |
| Max attempts per task | 3 | `HERMES_MAX_ATTEMPTS_PER_TASK` |
| Bot RSS threshold | 800 MB | `BOT_RSS_THRESHOLD_MB` |
| Discord API rate limit | per Discord | n/a |

**Soft-exit model**: Timer 唔係 kill 個 task,而係喺 judge boundary 軟退出(保留所有 in-flight work)。 David 可以 `/project resume` 接手。

---

## 🚦 Discord Commands 速查

| Command | 做咩 |
|---|---|
| `@bot <prompt>` | 1-shot CC run(開新 thread) |
| `/project start "goal"` | 開 Hermes-managed project |
| `/project start in ~/work "goal"` | 指定 local dir |
| `/project start "goal" auto 1h` | 開 project 同時限時 1h auto-run |
| `/project adopt "goal" [auto/manual]` | 將 plain thread 升級做 Hermes project |
| `/project status` | 查當前 project 狀態 |
| `/project plan` | 睇個 plan |
| `/project setMode auto 30m` | 中途 arm auto timer |
| `/project setMode manual` | 停 auto timer, 改 manual |
| `/project kill` | 立即停 project |
| `/project resume` | 重啟 killed / failed project |
| `/project list` | 列出所有 project |
| `/kill` | 殺 CC subprocess(thread 保留) |
| `/status` | 查 session 狀態 |
| `/projects` | 列出 known projects |
| `/help` | 完整指令 list |

---

## 🔌 Claude Code 嘅 Discord 工具(SDK 模式)

Claude Code 喺 run 期間可以主動用 4 個 Discord MCP tools:

| Tool | 做咩 |
|---|---|
| `discord_send` | 喺 thread 發新 message |
| `discord_typing` | 維持 typing 燈 |
| `discord_react` | 對 message 加 emoji reaction |
| `discord_read_history` | 讀 thread 過往 message |

**用途**: 當 CC 做完嘢想主動通知(唔等 David reply),可以 `discord_send` 出嚟。

---

## 🧪 Testing + Docs

- **344 個 unit / integration tests**(bun:test, ~5s 全跑)
- **20 個 invariant** 喺 `docs/REGRESSION-GUARD.md` (防 bug 翻發)
- **8 份核心 doc**: PRD, ARCHITECTURE, MILESTONES, REGRESSION-GUARD, AUDIT, taskboard, retros/, operations/
- **3 條 launchd watchdog**: bot crash 自動 respawn (KeepAlive)
- **無 secrets commit**: `.env` gitignore + Hermes redact 機制

---

## 💡 適合咩場景用?

| 場景 | 啱唔啱 |
|---|---|
| 多人協作開發(有 Discord 頻道) | ✅ 完美 |
| 個人 side project | ✅ 方便 |
| 需要 audit trail(公司 review) | ✅ state.json + journal.log 全部有 |
| Quick 1-shot 改 file | ✅ @bot 最快 |
| 多步任務自動跑過夜 | ✅ /project start auto 4h |
| 純粹 command line 開發 | ⚠️ 仲用返 Claude Code CLI 直接 |
| 沙盒環境(Docker / 隔離) | ❌ CC 寫 host file 唔隔離 |

---

## ❓ 常見問題

**Q: 點解唔直接用 Claude Code 個 CLI?**
A: CLI 要你離開 Discord 開 terminal。 claude-bridge 將對話收埋喺 Discord thread, **history 自然 preserve**, 多人睇得到, reply 用 emoji/go 掣做得到。

**Q: Hermes mode 同 @bot mode 點揀?**
A: 簡單 prompt / debug 用 `@bot`, 多步規劃任務(整 feature、refactor)用 `/project start`。

**Q: Bot crash 點算?**
A: launchd 自動 respawn (KeepAlive),in-flight project 會喺 boot 時 `resumeActiveProjects()` 自動接手。

**Q: Claude Code 寫錯 file 點算?**
A: 佢有 git access(透過 work dir)。 David 可以直接 `git diff` 喺 host, 唔啱就 `git checkout` 復原。**建議開始 Hermes project 之前 commit 一次 baseline**。

**Q: 點睇返舊時 Hermes 嘅決策?**
A: `cat data/hermes/projects/<uuid>/journal.log` + `cat data/hermes/projects/<uuid>/state.json`。**全部 disk 上**,冇 DB vendor lock-in。

---

## 📚 延伸閱讀

- 詳細架構: `docs/ARCHITECTURE.md`
- 用戶 PRD: `docs/PRD.md`
- 開發 milestones: `docs/MILESTONES.md`
- 防 bug 翻發: `docs/REGRESSION-GUARD.md`
- 各 retro: `docs/retros/*.md`
- 設計決策: `docs/operations/*.md`
