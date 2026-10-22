# 07 · Agentic Loop Guard：turns 無限制語義 + wall-time soft/hard limit

> **狀態（2026-10-19）：Phase A–D 完成並確認**（`npm run check` 0 錯 + unit `agentic-limits`/`agentic-gates` + client `agentic-limits` 全綠）；剩手動驗收（§5 清單，06-status §5j）
>
> 相鄰功能：agentic flow 的 loop guard，**不屬於** context compaction 工作流（01–06）；
> 單獨成文，實做時按本文 §5 執行。

## 1. 問題

### 1.1 現況

- agentic loop（`stores/agentic/index.svelte.ts:746` `while (true)`）**只有 turn 數限制、沒有任何時間限制**。
  - 慢 model / 長 tool（如 exec_shell_command）→ wall time 可無限消耗，user 不在時無任何保護。
- `agenticMaxTurns`（預設 10）**無法設成無限制**，被雙重擋掉：
  1. `SettingsChat.svelte:108`：`POSITIVE_INTEGER_FIELDS` clamp 到 `min ?? 1` → 0 存不進去。
  2. `stores/agentic/index.svelte.ts:222`：`Number(settings.agenticMaxTurns) || DEFAULT_AGENTIC_CONFIG.maxTurns` → `0` 是 falsy → 掉進 fallback 100。
- loop 只拿到 flow `signal`，拿不到 `AbortController`（`stores/chat/index.svelte.ts:95,502` 由 chatStore 持有）→ 無法從 loop 內主動中斷 in-flight 呼叫。

### 1.2 需求（user 確認，2026-10-19）

1. `Agentic turns`：`0` 或 `<0` = **無限制**（預設 10 不動，只改 help 說明）。
2. **soft wall-time limit**：到時間 → 等**整個 turn（LLM + tools）完成後**停下 → continue 卡片詢問是否繼續。
3. **hard wall-time limit**：**直接中斷 in-flight 的 /v1/chat/completions**；其餘處理**等同 user 手動按 Stop**。
4. 兩者都可設無限制（0），**預設皆無限制**。
5. 時間單位 user 自訂：秒 / 分 / 小時，**可小數**；單位預設 `m`。
6. 計時源 = `Date.now()`（wall time）。
7. Continue（soft 卡片）後**重設計時**（新一期，對齊 turn limit 的 `turn = 0`）。
8. 通知：**只要 in-chat 常駐通知列**（不要 toast）；
   **Resume = 用最後一個 tool result 或 assistant（= 路徑尾端）繼續執行 loop**。

## 2. 現況對照（code reference）

| 項目 | 位置 |
| --- | --- |
| maxTurns 設定 | `constants/settings-keys.constants.ts:8`、`constants/settings.constants.ts:496–503` |
| 設定儲存 clamp | `SettingsChat.svelte:99–121`（`lo = entry.min ?? 1`） |
| 設定欄渲染 | `SettingsChatFields.svelte:88–95`（`isPositiveInteger` → number input + `min`） |
| `getConfig` 解析 | `stores/agentic/index.svelte.ts:221–233` |
| loop + turn 檢查 | `stores/agentic/index.svelte.ts:744–762`（`turn` 0-based；檢查在 LLM 呼叫前；Continue → `turn = 0`） |
| 1 turn 的組成 | LLM 呼叫（`:793`）→ 0..n tool 執行（`:990` 起）→ compaction 檢查（`:1243`）→ `turn++`（`:1254`）；**無 tool calls = 最終 turn**（`:936`） |
| continue 卡片 gate | `stores/agentic/gates.svelte.ts:133–163`（`requestContinue`；`pendingContinueRequests` 純 boolean；abort → false） |
| continue 卡片 UI | `ChatMessageAgenticContent.svelte:70–92` + `ChatMessageActionCardContinueRequest.svelte`（條件 `isStreaming && isLastAssistantMessage`） |
| Stop 按鈕路徑 | `stores/chat/index.svelte.ts:1591–1608`（`savePartialResponseIfNeeded` → `cancelServerStream` → `clearStreamState` → `cancelResumeRetry` → `abortRequest` → loading/streaming cleanup → `clearPendingMessage`） |
| loop abort path | `stores/agentic/index.svelte.ts:876–888`（catch）/ `:908–918`（post-send；ChatService 吞掉 AbortError）→ `onAssistantTurnComplete`（**partial 存檔、toolCalls 不存**）+ `onFlowComplete` |
| 中斷訊息的 continue 分類 | `utils/agentic.ts:547–579`（無 toolCalls → `APPEND_TEXT` = `continue_final_message` 純文字、**無 tools**；toolCalls + trailing tool results → `NEXT_TURN` → `continueAsNextAgenticTurn`） |
| 從錨點開新 agentic turn | `stores/chat/flows.svelte.ts:688–739`（`continueAsNextAgenticTurn`，**private**：新 assistant branch 接錨點、path = root→錨點、`streamChatCompletion` → `runAgenticFlow`） |
| in-chat 常駐列模式 | `ChatMessageCompacting.svelte`（N7；掛 `ChatMessages.svelte:292` 尾端、綁 active conv、`role="status"`） |
| 新 generation 起點（clear 錨點） | `setChatLoading(convId, true)`：`chat/index.svelte.ts:1457`、`flows.svelte.ts:102/546/586/659/698/747`、`streams.svelte.ts:121/237` |

## 3. 已確認決定（決策記錄）

| # | 問題 | 決定 |
| --- | --- | --- |
| D1 | maxTurns 無限制 | `0`/`<0` = 無限制；**預設 10 不動**，只改 help |
| D2 | 時間單位 | user 自訂 `s`/`m`/`h`（SELECT），**可小數**；預設 `m` |
| D3 | hard limit 行為 | **直接中斷 in-flight request**；其餘處理**等同手動 Stop**（同一條 `stopGenerationForChat` 路徑）→ 不另做 rerun 卡片 / rerun gate |
| D4 | 計時源 | `Date.now()`（wall time；NTP 調鐘會影響，user 知情接受） |
| D5 | soft 檢查點 | **整個 turn 完成後**（loop 頂端 = 上一 turn 的 LLM + tools + compaction 全完成）。這是現行結構唯一可行點：tool_calls 與 tool_results 之間停下會留下非法 context |
| D6 | hard 在乾淨邊界（無 in-flight call，如長 tool 執行中已超時） | **直接停**，不彈卡片（否則不叫 hard）；以通知列告知 |
| D7 | Continue 後 | **重設計時**（新一期 budget），對齊 `turn = 0`；turns 卡片的 Continue 亦一併重設 `flowStart` |
| D8 | 通知形式 | **只要 in-chat 常駐通知列**（常駐 toast 被否：不綁對話 / F5 即失 / 堆疊） |
| D9 | Resume 語義 | **用路徑尾端（最後一個 tool result 或 assistant）繼續執行 loop** = 新 agentic turn（帶 tools）+ 全新 wall-time 預算；partial assistant **留在 context**（model 看到自己被中斷的輸出續跑） |
| D10 | soft 卡片文案 | 「Agentic soft time limit reached. Continue?」 |
| D11 | 數值欄 | text input（同 temperature 現況），無 `min` attribute；負數可輸入、解析當無限制 |

## 4. 規格

### 4.1 Settings（`constants/settings.constants.ts` AGENTIC section）

| key | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `agenticMaxTurns`（改） | INPUT、`isPositiveInteger` + **`min: 0`** | 10（不動） | help 加「0 或負數 = 無限制」。`min: 0` 使 `handleSave` clamp 與 input `min` 自動生效，**不需改 `SettingsChat.svelte`** |
| `agenticSoftTimeLimit`（新） | INPUT（**非** `isPositiveInteger` → 小數/0 可存、text input） | 0 | 0 = 無限制 |
| `agenticSoftTimeLimitUnit`（新） | SELECT `s`/`m`/`h`（照 `contextSummaryMode` 的 `options` 模式） | `m` | |
| `agenticHardTimeLimit`（新） | 同上 | 0 | 0 = 無限制 |
| `agenticHardTimeLimitUnit`（新） | SELECT | `m` | |

- `settings-keys.constants.ts` +4 key。
- `NUMERIC_FIELDS` 自動收編數值欄（`defaultValue` 為 number）→ `handleSave` 以 `Number()` 解析、不 round、不 clamp。
- `POSITIVE_INTEGER_FIELDS` 不收編時間數值欄（無 `isPositiveInteger`）→ 小數與 0 保留。
- `DEFAULT_AGENTIC_CONFIG`（`constants/agentic.constants.ts:30`）+ `softTimeLimitMs: 0, hardTimeLimitMs: 0`。

### 4.2 Types（`types/agentic.d.ts`）

```ts
interface AgenticConfig {
  enabled: boolean;
  maxTurns: number;         // Infinity = unlimited
  softTimeLimitMs: number;  // 0 = unlimited（unit 已在 getConfig 折成 ms）
  hardTimeLimitMs: number;  // 0 = unlimited
}

interface AgenticFlowParams {
  // ...既有
  /** hard limit 在 in-flight LLM call 期間觸發時呼叫；實作 = 與 user 按 Stop 相同的中斷路徑 */
  onHardLimit?: () => void;
}
```

純函式（`utils/agentic.ts`，可單測）：

```ts
parseAgenticTurnLimit(value: unknown, fallback: number): number
  // NaN → fallback；≤ 0 → Infinity；> 0 → Math.round

parseAgenticTimeLimitMs(value: unknown, unit: unknown): number
  // unit 倍率 { s: 1, m: 60, h: 3600 }（invalid → 'm'）
  // NaN / ≤ 0 → 0（unlimited）；> 0 → value × 倍率 × 1000
```

`agenticStore.getConfig()`（`:221`）改走兩個 helper。

### 4.3 Loop 時序（`executeAgenticLoop`）

```
flowStart = Date.now()
hardLimitHit = false

while (true) {
  # ── turn 邊界（上一 turn 的 LLM + tools + compaction 全完成）──
  if (turn >= maxTurns) {                       # Infinity 時永不觸發
    card[turns]    → Continue: turn = 0; flowStart = now
                  → Stop / abort: 結束
  }
  if (softMs > 0 && elapsed ≥ softMs) {
    card[softTime] → Continue: flowStart = now
                  → Stop / abort: 結束
  }
  if (hardMs > 0 && elapsed ≥ hardMs) {
    setHardLimitNotice(convId, Date.now())      # 通知列
    onFlowComplete; return                      # 邊界直接停，不問（D6）
  }

  # ── LLM call（/v1/chat/completions stream）──
  if (hardMs > 0)
    hardTimer = setTimeout(() => {
      hardLimitHit = true
      onHardLimit()     # = stopGenerationForChat(convId)（D3：與 Stop 按鈕同一路徑）
    }, hardMs - elapsed)
  try { await ChatService.sendMessage(…, signal) }
  finally { clearTimeout(hardTimer) }           # timer 只在 LLM call 期間存在

  if (signal.aborted) {
    if (hardLimitHit) setHardLimitNotice(convId, Date.now())
    onAssistantTurnComplete(partial); onFlowComplete; return   # 既有 abort path，零改動
  }

  … tools → compaction → turn++
}
```

規則：

- 檢查順序 turns → soft → hard（hard 較小時由 in-flight timer 先攔；邊界 hard 檢查只處理「tool 執行中已超時」路徑）。
- `hardLimitHit` 只可能被 timer 設定 → 只有 LLM-call 中斷會設通知；user 手動 Stop / steering 中斷不會。
- gate 等待期間：時鐘照走、timer 不 arm；user 在卡片耗掉剩餘 budget 後按 Continue → 重設。
- soft/hard 卡片都走既有 `gates.requestContinue`（abort → false，Stop 按鈕照舊可用）。
- continue gate 的 pending state：`boolean` → `{ reason: 'turns' | 'softTime' } | null`；
  `requestContinue(convId, signal, reason = 'turns')`；getter 回 reason（唯一 UI 消費端 = `ChatMessageAgenticContent`）。

### 4.4 hard stop = 手動 Stop（路徑等價，D3）

`streamChatCompletion`（`chat/index.svelte.ts:1952`）傳入：

```ts
onHardLimit: () => { void this.stopGenerationForChat(convId); }
```

`stopGenerationForChat`（`:1591–1608`）完整執行：`savePartialResponseIfNeeded` →
`cancelServerStream`（**server 端也停**，非只斷 socket）→ `clearStreamState` →
`cancelResumeRetry` → `abortRequest` → loading/streaming cleanup → `clearPendingMessage`。
loop 的 abort path 再跑 `onAssistantTurnComplete`（存 partial、toolCalls 不存）+ `onFlowComplete`
（cleanup 冪等）——與手動 Stop 的執行序列**完全一致**，零新中斷邏輯。

### 4.5 in-chat 常駐通知列（D8）

**State**（`stores/agentic/gates.svelte.ts`，per convId）：

```ts
hardLimitNotices: SvelteMap<string, { at: number } | null>
```

- **設**：§4.3 兩處 hard-stop（in-flight `hardLimitHit` + 邊界）。
- **清**：
  1. Dismiss（列上按鈕）
  2. Resume（新 flow 啟動前）
  3. `setChatLoading(convId, true)`（**所有**新 generation 起點的 choke point，§2 清單）
  4. `gates.clear()`（該對話新 flow 啟動時）
  5. 對話刪除（既有 `onConversationsDeleted` 清理路徑）
- `agenticStore` facade：`getHardLimitNotice(convId)` / `clearHardLimitNotice(convId)`。

**UI**（新 `components/app/chat/ChatMessages/ChatMessageHardLimitNotice.svelte`，
pattern = `ChatMessageCompacting.svelte`）：

- render 在 `ChatMessages.svelte:292` 同一尾端位置；**只在 active conversation 擁有 notice 時顯示**。
- `role="status"`；內容：`⏱ Agentic hard time limit reached — flow stopped at HH:MM`（`at` 的時間）。
- 按鈕：**[Resume]** + **[Dismiss]**；`chatStore.isLoading`（該 conv）時 Resume disabled（同 `actionsBlocked` 模式）。
- Dismiss = `clearHardLimitNotice`。

### 4.6 Resume 語義（D9）

**錨點 = 對話路徑尾端（currNode）**。hard stop 後尾端三種形態：

| hard stop 情形 | 尾端 | Resume 行為 |
| --- | --- | --- |
| in-flight 中斷 | 被中斷 assistant（partial、無 toolCalls） | 從它之後開新 agentic turn；**partial 留在 context**（model 看到自己被中斷的輸出續跑） |
| 邊界停止 | 最後一個 tool result | 從它之後開新 agentic turn |
| 邊界停止 + 剛跑過 in-loop compaction | **cmp entry** | 接在 cmp 之下（**必須**，否則 summary 掉出 context，違反 N10/N11 不變式） |

實作 = 既有 `continueAsNextAgenticTurn(anchorIndex)`（`flows.svelte.ts:688`，**private → 公開**
或包 public wrapper）：新 assistant branch 接錨點下 → path = root→錨點 →
`streamChatCompletion` → `runAgenticFlow` → **完整 agentic loop（帶 tools）+ 全新 wall-time 預算**。

- 新增 public 入口（供通知列呼叫）：`chatStore.resumeAgenticFlowFromTail()` —
  解析 active conversation 的尾端 index → `this.flows.continueAsNextAgenticTurn(tailIndex)`。
- **不能用 `continueAssistantMessage`**：in-flight 中斷訊息無 toolCalls → 分類成 `APPEND_TEXT`
  → `continue_final_message` 純文字續寫、**request 不帶 tools** → 不是 loop 續跑。
- Resume 後：notice 清除（§4.5）；新 flow 從 turn 0、`flowStart = now` 重新計。

### 4.7 邊界情境與已知限制

| 情境 | 行為 / 限制 |
| --- | --- |
| 空 partial（abort 前未收到任何 chunk） | 尾端 = 空 assistant；Resume 正常（model 從 tool results 重產）。模板若拒空 assistant content → user 可手刪該訊息再 continue（範圍外） |
| 非 active 對話觸發 hard limit | 通知列要等 user 打開該對話才看得到（toast 被否，D8 接受此 gap） |
| F5 / tab 重開 | notice 消失（in-memory）；被中斷訊息 + 訊息上的 Continue 按鈕仍是持久痕跡 |
| 背景 tab | 瀏覽器 throttle `setTimeout`（hidden tab 長延遲最慢 ~60s）→ in-flight hard abort 可能延遲；邊界檢查（計算式）不受影響 |
| 系統調鐘（NTP） | `Date.now()` 會跳（D4 user 知情接受） |
| 多次觸發 | 每次 hard stop 覆蓋該 conv 的 notice（`SvelteMap` 單值）；新 flow 啟動即清 |
| Resume 時的 preEncode | `continueAsNextAgenticTurn` 頂端已有 `cancelPreEncode`；若舊 preEncode 已完成 → 新 flow 首 turn cache miss（自我修正、不影響正確性） |

## 5. 實做規劃（已完成，Phase A–D；實做明細見 06-status §3.33/§5j）

### Phase A — settings / types / 解析（無行為改變）

1. `constants/settings-keys.constants.ts`（+4 key）
2. `constants/settings.constants.ts`（maxTurns `min: 0` + help；+4 entries）
3. `constants/agentic.constants.ts`（`DEFAULT_AGENTIC_CONFIG` +2 = 0）
4. `types/agentic.d.ts`（`AgenticConfig` +2、`AgenticFlowParams` + `onHardLimit`）
5. `utils/agentic.ts`（`parseAgenticTurnLimit` / `parseAgenticTimeLimitMs`）
6. `stores/agentic/index.svelte.ts`（`getConfig` 改走 helper）

### Phase B — 行為

7. `stores/agentic/gates.svelte.ts`（continue reason；`hardLimitNotices` + 清除路徑）
8. `stores/agentic/index.svelte.ts`（loop 邊界 3 檢查、hard timer、設 notice、facade）
9. `stores/chat/index.svelte.ts`（傳 `onHardLimit`；`setChatLoading(true)` 清 notice；`resumeAgenticFlowFromTail`）
10. `stores/chat/flows.svelte.ts`（`continueAsNextAgenticTurn` 公開）

### Phase C — UI

11. `ChatMessageActionCardContinueRequest.svelte`（`reason` prop → 2 種文案：turns 現文案 / softTime D10）
12. `ChatMessageAgenticContent.svelte`（`pendingContinue` 改讀 reason 並傳給卡片）
13. `ChatMessageHardLimitNotice.svelte`（新；Resume / Dismiss）
14. `ChatMessages.svelte`（尾端 render 通知列，`:292` 旁）

### Phase D — 測試 + 文檔

15. `tests/unit/agentic-limits.test.ts`（新）：
    - `parseAgenticTurnLimit`：`10 / '10' / 10.7 / 0 / -3 / '' / NaN`
    - `parseAgenticTimeLimitMs`：`90+s / 1.5+m / 2+h / 90.5+s / 0 / -1 / '' / invalid unit`
16. `tests/client/`：
    - continue 卡片 2 種文案（turns / softTime）
    - 通知列：只對 active conv 顯示 / Dismiss 清除 / Resume 呼叫 `resumeAgenticFlowFromTail`（mock）/ 新 generation 啟動時清除 / loading 時 Resume disabled
    - `settings-registry-invariants` 為 generic、新 4 key 自動覆蓋
17. `context-enhance/06-status.md`：實做後補決策記錄 + 執行清單（repo 慣例）
18. 驗證：`npm run check` + unit + 相關 client suites

### 手動驗收清單

- `maxTurns = 0` → 跑超過 10 turns 不彈卡片
- soft = `0.5`（m）→ 某 turn 完成後彈 soft 卡片（D10 文案）；Continue 後計時重設、再 0.5m 再彈
- hard = `10`（s）→ in-flight streaming 被中斷（**server 端也停**）、partial 存檔、flow 結束、該對話尾端出現通知列（含時間戳）
- hard 在長 tool 執行中已超時 → 邊界直接停 + 通知列，不啟動新 LLM call
- 通知列 **Resume**（in-flight 中斷後）→ 新 assistant 接在 partial 之後、context 含 partial、完整 agentic loop（帶 tools）、新計時；**邊界停止後** → 新 assistant 接在最後 tool result（或 cmp entry）之後
- 通知列 **Dismiss** → 消失；該對話再發新訊息（任何 generation）→ notice 清除
- 小數 + 三種單位：`0.5 m` / `90 s` / `0.5 h` 皆生效
- 三者皆 0 → 無限行為（回歸）
- soft 卡片顯示期間按 Stop 按鈕 → 照舊中止（gate abort → false）
- 非 active 對話觸發 hard limit → 打開該對話後通知列在

## 6. 範圍外

- 常駐 toast（D8 已否）
- notice 跨 F5 持久化（in-memory 即可，§4.7）
- 背景 tab 的 timer 精度（瀏覽器限制）
- 空 assistant content 的模板相容性（§4.7）
- per-conversation 覆蓋 / 多組 limit（第一版單組）
