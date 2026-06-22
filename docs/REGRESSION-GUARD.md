# Regression Guard — claude-bridge

> 目的:追蹤所有修過嘅 bug + 所有 lock-in invariants,確保日後唔會重新踩坑。
> 規則:每個 bug fix 必須喺呢度留 entry(紅線 13)。M2 series 嘅 timer invariants
> 喺呢度 lock 埋,作為日後 refactor `armProjectTimer` / `softExit` 嘅防護。

## 索引

| Entry ID | 描述 | 發現日期 | 影響版本 | Root Cause / Invariant | Regression Test | 狀態 |
|----------|------|---------|---------|------------------------|-----------------|------|
| RG-001 | `/project setMode auto <duration>` timer integration 嘅 invariant set (M2.4–M2.11, ADR-0004) | 2026-06-22 | Phase 1.5 lock | [see](#rg-001) | `src/hermes/orchestrator.test.ts` E2E block (3 tests) | LOCKED |

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
