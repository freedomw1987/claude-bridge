# Regression Guard — claude-bridge

> 目的:追蹤所有修過嘅 bug + 所有 lock-in invariants,確保日後唔會重新踩坑。
> 規則:每個 bug fix 必須喺呢度留 entry(紅線 13)。M2 series 嘅 timer invariants
> 喺呢度 lock 埋,作為日後 refactor `armProjectTimer` / `softExit` 嘅防護。

## 索引

| Entry ID | 描述 | 發現日期 | 影響版本 | Root Cause / Invariant | Regression Test | 狀態 |
|----------|------|---------|---------|------------------------|-----------------|------|
| RG-001 | `/project setMode auto <duration>` timer integration 嘅 invariant set (M2.4–M2.11, ADR-0004) | 2026-06-22 | Phase 1.5 lock | [see](#rg-001) | `src/hermes/orchestrator.test.ts` E2E block (3 tests) | LOCKED |
| RG-002 | CC's `<ant_thinking>...</ant_thinking>` blocks leak into Discord if not stripped | 2026-06-22 | v1.1.0 (pre-fix) | [see](#rg-002) | `src/discord/handlers/format.test.ts` (15 tests) + `src/agent/discordTool.test.ts` (3 integration tests) | FIXED |

---

<a id="rg-001"></a>
### RG-001 — M2 timer-softExit integration invariants (ADR-0004)

**發現日期**: 2026-06-22
**發現者**: @Developer (M2.11 E2E lock-in)
**影響版本**: Phase 1.5 (M2.1–M2.11)
**修復版本**: Phase 1.5 (M2.11 commit, see commits `d47285b..a12c30d`)
**修復者**: @Developer
**Commits**: `d47285b`(M2.1)..`a12c30d`(M2.9); M2.11 e2e test in this commit

#### 症狀
呢個唔係 bug,係**invariant set** — 將 M2 series 嘅 timer 行為 lock 埋,防止日後 refactor 喺以下三個 scenario 走樣:

1. **Active project 嘅 timer 到期後冇 softExit**(bot 會無限跑,撞 cost cap)
2. **Soft-exit 寫咗 state.json 但 journal 冇 entry**(事後 audit 唔到)
3. **Bot 重啟後 timer 過咗 deadline 但冇觸發 softExit**(resume path leak)

#### Invariant Set(必須一齊保持)

| # | Invariant | Lock test |
|---|-----------|-----------|
| I-1 | `armProjectTimer` + 200ms deadline + callback → callback fires at 200ms (±50ms) | E2E test 1 |
| I-2 | callback path (resumeActiveProjects shape) re-loads state from disk → sees fresh status, bails if `!isActive(fresh)` | E2E test 1 |
| I-3 | `softExit(reason="duration_expired")` writes: `state.json` with `status=killed`, `killedReason="duration_expired"`, `timer=undefined`, `endedAt` set | E2E test 1 |
| I-4 | `softExit` writes a journal entry containing "auto-mode duration expired" + the requested duration string | E2E test 1 |
| I-5 | `softExit` posts exactly **one** Discord message with the `formatTimerExpired` text (⏱ header) | E2E test 1 |
| I-6 | `softExit(reason="manual_switch")` writes `killedReason="manual_switch"`, journal entry contains "manual switch cancelled auto-mode timer", Discord message contains "manual switch" | E2E test 2 |
| I-7 | `armProjectTimer` with `expiresAt <= now` returns `null` (no setTimeout) and fires callback via `queueMicrotask` | E2E test 3 + armProjectTimer unit tests |
| I-8 | `softExit` clears the live timer handle (calls `clearTimeout(state.timer.handle)` before mutating) | softExit unit test (existing) |

#### 防止再發(防護措施)

- [x] **Regression test (E2E)**: `src/hermes/orchestrator.test.ts` 入面個 `describe("E2E M2.11 — timer fires → softExit (duration_expired)")` block,3 個 test 覆蓋 invariants I-1..I-7
- [x] **Code comment**: `src/hermes/orchestrator.ts:170-187` 嘅 judge boundary check block 加咗 `// ADR-0004 M2.4: timer boundary check before invoking judge LLM.`
- [x] **Invariant statement**: ADR-0004 寫咗 "Why soft-exit at judge verdict, not at task boundary" 嘅 trade-off analysis
- [x] **No silent failure**: `softExit` throw `Error` from 個 callback 個 inner `.catch` (E2E test 1 用 `throw err` 確認 silent fail 會 surface 返出嚟)

#### Refactor Guard

任何涉及以下文件嘅 refactor 必須:
1. 跑 `bun test src/hermes/orchestrator.test.ts` 並確認 3 個 E2E test + 8 個 softExit/armProjectTimer unit test 全部 PASS
2. 對住 invariant table I-1..I-8 逐個 check 冇違反
3. 改 `softExit` 或 `armProjectTimer` 嘅 signature 必須 update 個 E2E test + 任何 caller(`resumeActiveProjects` 喺 `src/hermes/orchestrator.ts:482`)

#### 相關 Issue / Discussion
- ADR-0004: `docs/operations/0004-setmode-auto-duration.md`
- M2 series plan: `f04630f`
- `docs/MILESTONES.md` Phase 2 (M2.1–M2.11)

---

<a id="rg-002"></a>
### RG-002 — `<ant_thinking>...</ant_thinking>` leaks into Discord

**發現日期**: 2026-06-22
**發現者**: @David (用戶回報:「收到的訊息，都只有``」)
**影響版本**: v1.1.0 (Day 4 SDK migration, pre-fix)
**修復版本**: commit in this PR (post-Phase 1.5)
**修復者**: @Developer
**Commit**: (this commit)

#### 症狀
- User 喺 Discord thread send 一個 prompt
- CC 跑完,auto-post 一個 final answer
- User 收到嘅訊息入面**只有 raw `` 標籤 + thinking 文字**,冇 CC 嘅 final answer
- 或者: 個 raw 結構 leak 入 Discord,user 睇到 XML 標籤
- 仲有一個 side effect: `contentLength: 2102` 觸發 `discord_send` 嘅 max-length guard(1900 chars)→ tool return errorResult → CC 收到「split into multiple calls」error → CC retry 個 stripped version(783 chars)→ user 睇到嘅後段 + 冇前段 context

#### Root Cause(為何會壞)
1. CC / Anthropic extended thinking 用幾種 tag variants:
   - `<thinking>...</thinking>` (older CC, generic)
   - `<ant_thinking>...</ant_thinking>` (Anthropic extended, most common 2025-2026)
   - `<think>...</think>` (some 3rd-party mirrors)
2. `src/discord/handlers/format.ts` 入面 `stripThinkTags(text)` **只 strip 咗 `</think>` 單個 closing tag**,冇 strip opening `<thinking>` / `<ant_thinking>`,亦冇匹配成對 tag 嘅 content
3. `src/agent/discordTool.ts` 嘅 `discordSendTool` handler **冇 call `stripThinkTags`** —— 直接 forward `input.content` 去 `target.reply(content)` / `deps.send(content)`
4. `src/agent/sdkRunner.ts:293` 嘅 auto-post path 用 inline regex `/<thinking>[\s\S]*?<\/thinking>/g` —— **只識 `<thinking>`,唔識 `<ant_thinking>`**
5. `src/discord/handlers/streaming.ts:467` 用緊 `stripThinkTags` 個 broken version,一樣 leak

#### Invariants(必須一齊保持)

| # | Invariant | Lock test |
|---|-----------|-----------|
| I-1 | `stripThinkTags` strips all three variants (`<thinking>`, `<ant_thinking>`, `<think>`) | `format.test.ts` cases 2, 3, 4 |
| I-2 | `stripThinkTags` handles multi-line blocks (code fences, paragraphs) | `format.test.ts` case 5 |
| I-3 | `stripThinkTags` handles multiple blocks in one string | `format.test.ts` case 6 |
| I-4 | `stripThinkTags` strips dangling closing tag without opener (CC truncation case) | `format.test.ts` case 7 |
| I-5 | `stripThinkTags` strips dangling opening tag without closer (CC truncation case) | `format.test.ts` case 8 |
| I-6 | `stripThinkTags` is case-insensitive on tag names | `format.test.ts` case 13 |
| I-7 | `stripThinkTags` tolerates extra whitespace inside tag | `format.test.ts` case 14 |
| I-8 | `stripThinkTags` returns empty for input that is ONLY a thinking block | `format.test.ts` case 12 + 19:03:52 log line pin |
| I-9 | `discordSendTool` calls `stripThinkTags` BEFORE length check | `discordTool.test.ts` case 1 (ant_thinking) + 2 (thinking) + 3 (length reduction) |
| I-10 | `discordSendTool` posts the stripped content, not the raw | `discordTool.test.ts` case 3 (`expect(sentContent).toBe(finalAnswer)`) |
| I-11 | `sdkRunner.ts` auto-post path uses the same `stripThinkTags` helper (no inline regex) | grep `discordSendTool` & `sdkRunner.ts` for `stripThinkTags` import — must share |
| I-12 | `streaming.ts` CLI path uses the same `stripThinkTags` helper | grep `streaming.ts` for `stripThinkTags` import |

#### 防止再發(防護措施)
- [x] **Comprehensive regex** covers all 3 tag variants in `format.ts` (`THINKING_TAG_RE`)
- [x] **Defensive dangling-tag strip** for partial CC outputs
- [x] **`discordSendTool` wired** to call `stripThinkTags` BEFORE length check (saves CC from spurious "split into multiple" errors)
- [x] **`sdkRunner.ts` uses shared helper** (no inline regex duplication)
- [x] **15 unit tests** for `stripThinkTags` covering all variants + edge cases
- [x] **3 integration tests** in `discordTool.test.ts` proving the tool actually posts stripped content
- [x] **All 322 tests pass** + typecheck clean

#### Refactor Guard

任何涉及以下文件嘅 refactor 必須:
1. 跑 `bun test src/discord/handlers/format.test.ts` 並確認 15 個 `stripThinkTags` test 全部 PASS
2. 跑 `bun test src/agent/discordTool.test.ts` 確認 3 個 RG-002 integration test PASS
3. 對住 invariant table I-1..I-12 逐個 check 冇違反
4. 改 `stripThinkTags` 嘅 signature 必須 update 全部 3 個 caller(`discordSendTool`、`sdkRunner.ts`、`streaming.ts`)
5. 加新嘅 thinking tag variant(eg. `<claude_thinking>`)必須 extend `THINKING_TAG_RE` + 加 test case

#### Detection signal(出現以下即有 leak)
- 喺 Discord 見到任何含 `<think` / `<ant_think` / `<think>` 字串嘅訊息
- `data/bot.log` 入面 `discord_send called` event 嘅 `contentLength` 接近或超過 1900,跟住 retry
- 任何 user report「收到嘅訊息只有 thinking 冇 answer」

#### 相關 Issue / Discussion
- Original symptom: 2026-06-21T19:03:52 Discord thread(`<ant_thinking>...</ant_thinking>` leak)
- 2026-06-22T02:44:45 Discord thread(`contentLength: 2102` → max-length fail → retry stripped to 783)
- Both reproducible by `bun test src/discord/handlers/format.test.ts` "matches the actual log line" case
