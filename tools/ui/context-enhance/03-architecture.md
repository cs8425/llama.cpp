# 03 · 架構設計

## 1. 分層與模組劃分

原則:**規則(純)→ 協調(store)→ 呈現(component)** 三層,
純函式不 import 任何 store,store 不 import 任何 component。

```
src/lib/services/context/            ← 新增,純函式、無 store 依賴、可獨立單測
├── types.ts              # LlmContext、CompactionPlan、ContextBuildResult
├── context-builder.ts    # buildLlmContext(path) —— 唯一 choke point;effectiveCompactionPath(path)(N8:套用 cmp 後的 path = planning 輸入)
├── compaction-policy.ts  # planCompaction(B) / planCompactionRecentWindow(A) / deriveRealMessageTokens / messageSize(真實 token) / messageBytes
├── summarize.ts          # buildSummaryTranscript() / summarizeMessages()
└── index.ts

src/lib/services/database.service.ts ← 新增 createCompactionMessage()
src/lib/stores/chat/index.svelte.ts  ← 新增 compactConversation()、inspector 資料提供
src/lib/stores/agentic/index.svelte.ts ← flow 開始前改走 builder
src/lib/services/chat.service.ts     ← sendMessage / preEncode 改走 builder
src/lib/stores/agentic/gates.svelte.ts ← (雙 mode) 新增 compaction-decision gate(超標確認,兩 mode 共用,同 requestContinue 模式)
src/lib/services/chat.service.ts     ← (雙 mode) 非 streaming 回應解析 timings(summary 實際 token 數)
components: ChatMessageCompaction.svelte、DialogContextInspector.svelte、(雙 mode) ChatCompactionDecisionCard.svelte(超標確認卡片,與 agentic 卡片同風格)
settings: SETTINGS_KEYS + SETTINGS_REGISTRY 新 key、(雙 mode) contextCompactionMode / contextMaxContextOverride / contextKeepRecentTokens / contextSummaryMaxAttempts(共用)
```

### 為什麼 policy 與 builder 分開

- `planCompaction`(決定「切哪裡、要不要切」)只被**觸發邏輯**使用。
- `buildLlmContext`(套用「已有 cmp → 組裝 payload」)被**每次送出**使用。
- 兩者輸入輸出不同、測試向量不同、未來演進方向不同
  (policy 會升級成 token 校準/多策略;builder 的語義應盡量不動)。
  合在一起會讓「改觸發條件」的 diff 污染「改 payload 組裝」的測試。

## 2. 核心 API(型別草稿)

```ts
// services/context/types.ts
export interface CompactionPlan {
  /** 切在 path[i] 之前;role 必為 user 或 assistant(I4);system prompt 永遠不在 summarize 區;
   *  i = path.length = 切在最後一則訊息之後(空 kept,僅 split 切) */
  cutIndex: number;
  /** true = split user-message span(切在單一 span 內的 assistant,或切在最後一則之後) */
  isSplitTurn: boolean;
  /** id of path[cutIndex] —— 送出窗口的起點;**cutIndex = path.length(空 kept)時缺** */
  firstKeptMessageId?: string;
  toSummarize: DatabaseMessage[];   // path[1 .. cutIndex)
  kept: DatabaseMessage[];          // path[cutIndex .. end]
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  keptTokens: number;                        // kept 區真實 token(v4:成功判定用)
  realMessageTokens: Map<string, number>;    // plan 時逐則真實 map(v4)
}

export interface ContextBuildResult {
  /** 實際送出的 payload(已轉換,含 attachments → content parts);每行帶
   *  sourceId(來源 DB id;summary row = cmp entry id)供 inspector 映射回
   *  逐則真實 token(v4,§02-3.4);送出時該欄位被剝除、不上 wire */
  messages: (ApiChatMessageData & { sourceId?: string })[];
  /** 供 UI/inspector 使用:哪一筆 cmp 生效、drop 了幾則、斷點是否失效
   *  (firstKeptMessageId 缺 = 空 kept,是合法狀態,不是失效) */
  compaction:
    | { entryId: string; firstKeptMessageId?: string; droppedCount: number;
        boundaryValid: boolean }
    | null;
}
```

```ts
// services/context/context-builder.ts
/**
 * 唯一 choke point:path(root→currNode,DB 形態)→ 實際送出的 API 訊息。
 * 純函式(除 convert 內的 async image 處理外不碰 store/fetch),
 * sendMessage / preEncode / agentic / inspector 全部呼叫它。
 */
export async function buildLlmContext(
  path: DatabaseMessage[],
  opts?: { excludeReasoning?: boolean }   // 沿用現有開關的語義
): Promise<ContextBuildResult>;

// N8:套用既有 cmp 後的 path(= planning 輸入;與 buildLlmContext 共用窗口
// 解析,結構上保證「planning 輸入 == builder 輸入」)。無 cmp / boundary
// 失效(I3)→ 原 path;否則 → [system?, cmp, kept…]。
export function effectiveCompactionPath(path: DatabaseMessage[]): DatabaseMessage[];

// services/context/compaction-policy.ts
export function deriveRealMessageTokens(path: DatabaseMessage[]): Map<string, number>;  // 真實 per-message(assistant=predicted_n、段總和,§02-3.4)
export function messageSize(m: DatabaseMessage, real: Map<string, number>, isTail: boolean): number;  // 真實 ?? (尾端 ? bytes/4 : 0)
export function messageBytes(m: DatabaseMessage): number;  // byte 存取(只供 inspector 副欄 + bytes/4,§02-3.4)
export function planCompaction(
  path: DatabaseMessage[],
  budget: { keepBudgetTokens: number;
            minKeptUserTurns: number;   // 邊界切:kept 區 user 訊息下限
            minKeptMessages: number;    // split 切:kept 區訊息下限(預設 0 = 允許空 kept)
            minSummarizeTokens: number }
): CompactionPlan | null;               // mode B:上限(kept ≤ budget,§02-3.3.2)
export function planCompactionRecentWindow(
  path: DatabaseMessage[],
  opts: { keepRecentTokens: number;     // 下限目標(真實 token 加算,§02-3.3.1)
          minKeptUserTurns: number;     // 切點落 user 訊息時:kept user 數下限
          minKeptMessages: number;      // kept 訊息數下限(預設 0)
          minSummarizeTokens: number }
): CompactionPlan | null;               // mode A:下限(pi walk;A 不產生空 kept)

// services/context/summarize.ts
export function buildSummaryTranscript(msgs: DatabaseMessage[]): string;
export async function summarizeMessages(
  plan: CompactionPlan,
  model: string | null,
  signal?: AbortSignal,
  options?: SummarizeOptions   // maxTokens / mode / prompt / excludeReasoning(N4/N5 已實做)
): Promise<{ content: string; tokens: number | null }>;
// tokens = 回應 timings 的實際 completion tokens(server 沒回 → null;
// 成功判定改 byteLen(content) 代入,§02-3.4)
```

`buildLlmContext` 內部 = 「找最後一筆 cmp → 決定窗口 → 逐則
`ChatService.convertDbMessageToApiChatMessageData` → 插入 summary」,
即 02-data-model.md §2 的演算法。

### 2.1 Summary prompt 模式(prefix-stable 為 default,已實做)

v1(transcript 模式,保留為 fallback):`[system(壓縮指令), user(buildSummaryTranscript
扁平文字)]` — 指令當 system、被壓訊息拍平成一段文字。

**prefix-stable 模式(已實做、default)**:

```
[system]      對話的 system prompt(path 的 system head,原樣)
[...原始訊息]  前面所有要被壓縮的 message(逐則轉換,保留原 role/結構:
              user / assistant / tool、tool_calls、attachments)
[user]        要求壓縮的 prompt(指令)
```

關鍵約束：**前綴（system + 被壓縮訊息全文）保持完全一致,只有最後的
壓縮 prompt 不同**（default / 自訂 `contextSummaryPrompt`、正常 / split-turn
變體只換最後一則）→ 對同一 summarize 區的重複摘要（Re-summarize、同區
再壓）可重用 KV cache 前綴;且模型看到的是**原始訊息結構**而非扁平
transcript,摘要忠度更高。實做時兩點已定(使用者 2026-07-22,D1/D2 皆 A):

- **附件原樣送**(base64 照主對話 payload 送):前綴與主 payload byte 一致、
  摘要忠度最高;非 vision 模型由 `sendMessage` 既有的 vision filter 自動
  剝除 image parts(與主送出路徑同行為)。
- **`reasoning_content` 跟隨 `excludeReasoningFromContext` 開關**:summary
  呼叫把同一開關傳進 `sendMessage`,兩種設定下前綴都與主 payload 一致。

## 3. 整合點對照表(改動最小化)

| 消費點 | 現況 | 改動 |
| ------ | ---- | ---- |
| `ChatService.sendMessage`(`chat.service.ts:1022`) | `normalizeMessagesForApi(messages)` 後直接 POST | 入參是 DB path 時,先 `buildLlmContext(path)` 取代 normalize;入參已是 `ApiChatMessageData[]`(agentic session)時維持原路徑。**簽名不變** |
| `ChatService.preEncode`(`chat.service.ts:840`) | 同上 | 同上 —— **必改**,否則 KV 預熱與實際送出不一致 |
| `agenticStore.runAgenticFlow`(`agentic/index.svelte.ts:304,358`) | `normalizeMessagesForApi(messages)` 一次 | 改 `buildLlmContext(messages)`(取 `.messages`);迴圈內續加 `sessionMessages` 的邏輯不動 |
| `agenticStore.executeAgenticLoop` turn 邊界(`agentic/index.svelte.ts:432` 迴圈內) | — | (Phase 2)每 turn 落 DB 後、下一 turn 前:觸發檢查(mode 特定,§02-6)→ plan(A: planCompactionRecentWindow / B: planCompaction)→ summarize → 成功判定/重試/gate(共用,判定式 mode 特定)→ 建 cmp → 以 builder 重建 `sessionMessages` → 續跑;失敗即跳過(fail-open) |
| `chatStore.triggerPreEncode`(`stores/chat/index.svelte.ts:1402`) | 組 `[...allMessages, assistant]` 後呼叫 preEncode | 不動(builder 在 preEncode 內部) |
| `chatStore.streamChatCompletion`(`:799`) | 直接傳 `allMessages` | **不動** —— 組裝統一在 service 層,store 不感知 compaction |
| Inspector(新增) | — | `buildLlmContext(conversationsStore.activeMessages)` |
| `ChatService.handleNonStreamResponse`(`chat.service.ts:1481`)(雙 mode) | 非 streaming 回應不解析 `timings`(`onComplete` 收到 `undefined`) | 解析 `data.timings` 傳給 `onComplete`;`ApiChatCompletionResponse` 補 `timings` 欄位——summary 實際 completion tokens 的來源(成功判定用) |

> 關鍵可維護性論點:**store 層完全不知道 compaction 的存在**
> (除了「觸發 + 建立節點」的協調邏輯)。payload 組裝只有一個入口,
> 未來換更聰明的壓縮(例如保留式摘要、RAG 式檢索)只動 `services/context/`。

## 4. 流程時序

### 4.1 一般送出(有 cmp)

```
user 按送出
  chatStore.sendMessage
    → 建 user/assistant 節點(assistant 的 parent = cmp 節點)
    → streamChatCompletion(activeMessages, ...)
        → (agentic? runAgenticFlow : ChatService.sendMessage)
            → buildLlmContext(path)          ← 套用 cmp
                → [system, summary, kept...]
            → POST /chat/completions
    → onComplete/onFlowComplete
        → (自動壓縮檢查,見 4.2)
```

### 4.2 自動壓縮(手動壓縮同此路徑,多一個「不檢查 threshold」)

```
onFlowComplete(且 !isChatLoading && !agenticStore.isRunning)
  → 觸發檢查(mode 特定,§02-6;觸發值 = 真實 contextUsed,gauge 同源,v4):
      A: contextUsed > window − keepRecentTokens ?(window = min(n_ctx, override))
      B: contextUsed > n_ctx × threshold% ?
      → 未達? 結束
  → plan = mode A: planCompactionRecentWindow(effective path, keep)
           mode B: planCompaction(effective path, budget = (threshold − keepTarget)% × n_ctx)
     (effective path = buildLlmContext 套用既有 cmp 後的 path,N8/06-§3.27)
      → null? 結束(不壓)
  → summarizeMessages(plan)      (UI:「Compacting context…」)
      → 失敗? toast,結束(不壓)
  → 成功判定(mode 特定,§02-6;v4:system head 不計):
      A: summaryTokens + plan.keptTokens ≤ window − keepRecentTokens ?
      B: summaryTokens ≤ keepTarget% × n_ctx ?
      → 否 → 重發同一 request(contextSummaryMaxAttempts,預設 3 次總計;≤0 = 無限)
            → 仍超 → gate 問 user:[使用這次壓完 / 重壓 / 這次不壓]
              (use it → 繼續;retry → 嘗試次數重新計算後重跑;skip → 結束不壓)
      → DatabaseService.createCompactionMessage({
            convId, parentId: 路徑最後一則.id,
            content: summary,
            compactionMeta: { firstKeptMessageId(可缺 = 空 kept), summarizedCount,
                              model, estimatedTokensBefore }
        })
      → conversationsStore.addMessageToActive(cmp)
      → conversationsStore.updateCurrentNode(cmp.id)
      → (選)triggerPreEncode —— 用「新」context 預熱,下一輪直接命中
      → toast「Context compacted: ~X → ~Y tokens」
```

### 4.3 Inspector 人工介入

```
開 DialogContextInspector
  → buildLlmContext(activeMessages)   ← 與送出同源,保證 WYSIWYG
  顯示:視覺化訊息列 + 每則主欄真實 token(system `-`/尾端 `est.`)+ 副欄
  bytes + 總和條 = 真實 contextUsed(＝gauge)+ 原始 JSON
  編輯:
    - summary 文字 → updateMessage(cmpId, { content })
    - 斷點下拉(只有「user 訊息」選項)
        前移 → 只改 compactionMeta.firstKeptMessageId
        後移 → 提示重新 summary(呼叫 summarizeMessages 覆寫 content)
    - 「Compact now」/「Expand(還原,需確認)」/「Copy payload JSON」
```

### 4.4 agentic turn 之間的再壓縮(split span 的主要動機)

```
executeAgenticLoop turn k 結束(tool results 已落 DB + activeMessages)
  → 觸發檢查(mode 特定):A: contextUsed > window − keep ? B: contextUsed > n_ctx × threshold% ?(contextUsed = 真實 KV,gauge 同源)
      → plan(mode A: planCompactionRecentWindow / mode B: planCompaction,該 conv 的 **effective path**(N8))
          → null / 失敗? 續跑
      → summarize(plan)  (UI:「Compacting context…」,signal = flow abort)
      → 成功判定/重試/gate(共用;判定式 mode 特定,§02-6)
          超標 → 重試(contextSummaryMaxAttempts)→ 仍超 → gate 問 user
          (flow 暫停等 user,同 maxTurns;abort = skip)
      → createCompactionMessage(parent = 路徑最後一則)
      → addMessageToActive + updateCurrentNode
      → sessionMessages = toAgenticMessages(buildLlmContext(路徑).messages)
      → 續跑 turn k+1(前綴已是 summary+kept,KV 會 miss 一次)
```

- cmp 落 DB 後,即使 flow 中斷/頁面重載,狀態仍一致
  (重載後路徑含 cmp,重建即用)。
- flow 建訊息用 `lastCreatedInFlow` 當 parent(不用 currNode),
  所以 mid-flow 移動 currNode 不影響 flow 本身的 parent 鏈。
- summary 呼叫與 flow 共用同一 model;ROUTER 模式下 model 已在
  `runAgenticFlow` 開頭確保 loaded。

## 5. 替代方案比較(為什麼不那樣做)

| 方案 | 問題 |
| ---- | ---- |
| **conversation 欄位存「裁切點/summary」** | 與樹式 branching 衝突(§02-1.2);import/export 要動 schema;舊版相容差 |
| **只裁不壓(直接 drop 舊訊息,不存節點)** | 資料看似還在 UI 上、實際沒送 → 「UI 顯示」與「實際送出」永久分岔,正是題主要避免的;無法還原、無法審計 |
| **in-memory 壓縮(每次送出時現算 summary,不落 DB)** | 每輪都要再跑一次 summary LLM 呼叫(慢且貴);inspector 看到的與「下一輪」不一致;崩潰/換裝置即失 |
| **server 端 compaction** | llama-server 無此機制;跨專案改動大;UI 無法展示中間態。第一版明確不做 |
| **把 builder 放 store 層** | store 已高度耦合;純函式放 service 層可被 inspector / 未來其它消費點直接 import,且單測不需 mock store |

## 6. 與既有模式的對齊(降低認知成本)

| 新東西 | 抄哪個既有模式 |
| ------ | ------------ |
| cmp 樹節點 | `createSystemMessage` / `isSynthetic` cwd 訊息 |
| 側邊 LLM 呼叫(summary) | `generateTitleWithLLM` |
| 渲染特判 | `ChatMessage.svelte` 的 `{#if ... isSynthetic}` 分派 |
| 刪除 + 子節點重掛 | `reparentDirectChildren` |
| Settings | `SETTINGS_REGISTRY` 表列式新增 |
| 測試 | `tests/unit/branching.test.ts`、`tests/client/*.svelte.test.ts` |

## 7. 執行期成本小結

- 無 cmp 時:`buildLlmContext` = 現行 `normalizeMessagesForApi` + 一次線性找 cmp
  (O(n),n 通常 < 幾百),可忽略。
- 有 cmp 時:每輪省掉 drop 區的 prompt tokens(主要收益);
  代價是**每次 compaction 後的一次 KV cache miss**(前綴改變),
  由 compaction 後立即 preEncode 彌補。
- summary 呼叫:每次 compaction 一次非 streaming 呼叫,
  輸入 = 被 summarize 區(可能不小)→ 這是主要的新增延遲,
  發生在 flow 之間或 turn 之間、不阻塞使用者輸入。
- mid-flow 再壓縮:每次多一次 summary 呼叫,暫停 agentic 迴圈
  (使用者輸入不受阻);換來 flow 不會因 context 爆掉而中斷。
