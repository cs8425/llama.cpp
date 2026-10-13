# 06 · 實做狀態（continuity doc）

> 給「下一個繼續實做的 session」讀。規劃細節在 01–05，本檔只記錄
> **做到哪裡、做過的決策、接下來怎麼做**。

## 1. 進度總覽

| 階段 | 狀態 |
| ---- | ---- |
| Phase 0 — 純核心 | ✅ 完成（使用者已確認 `npm run check` + unit 全綠） |
| Phase 1 — 送出路徑接 builder + 手動壓縮 | 🚧 5.1–5.5 ✅(5.1–5.3 已確認;5.4/5.5 待編譯確認,見 §4);5.6–5.7 未開始 |
| Phase 2 — 自動觸發 + 人工介入 + flow 內再壓縮 | ⬜ |
| Phase 3 — 可選後續 | ⬜ |

## 2. Phase 0 已交付檔案

### 新增 `src/lib/services/context/`（純函式、零 store import、可獨立單測）

| 檔案 | 內容 |
| ---- | ---- |
| `types.ts` | `CompactionBudget`（keepBudgetTokens / minKeptUserTurns / minKeptMessages / minSummarizeTokens）、`CompactionPlan`、`ContextCompactionInfo`（entryId / firstKeptMessageId / droppedCount / boundaryValid）、`ContextBuildResult`（messages / compaction / estimatedTokens）、`ContextBuildOptions`（excludeReasoning） |
| `compaction-policy.ts` | `estimateTokens(msg)`：content/4 + toolCalls/4 + reasoningContent/4 + 附件（IMAGE 1000、AUDIO/VIDEO 3000、PDF 按頁數 1000/頁或 text/4、其餘 text/4）。`planCompaction(path, budget)`：兩階段選點（stage 1 = 最早的 user 邊界且 suffix ≤ budget；stage 2 = 最早的 user/assistant 合法切點 → `isSplitTurn`），再查 minSummarizeTokens 與 I5；suffix 用後綴和陣列 O(n) |
| `context-builder.ts` | `buildLlmContext(path, opts?)` — 唯一 choke point；`findLastCompactionEntry(path)`。轉換**複用** `ChatService.normalizeMessagesForApi`（不 fork）。`excludeReasoning` 時把 `reasoning_content` 設 undefined |
| `summarize.ts` | `buildSummaryTranscript(msgs)`（純；附件→佔位符、toolCalls→`[tool_calls: name, …]`、空則略過）；`summarizeMessages(plan, model, signal?, options?)`（非 streaming `ChatService.sendMessage`，max_tokens 1024 / temperature 0.2 / 可自訂 prompt；空回應或失敗一律 throw，呼叫端不得建 cmp）；`SUMMARY_CONTENT_PREFIX`、`DEFAULT_SUMMARY_PROMPT`、`SPLIT_TURN_SUMMARY_PROMPT` |
| `index.ts` | barrel（以上全部 + `SummarizeOptions`） |

### 修改

| 檔案 | 改動 |
| ---- | ---- |
| `src/lib/enums/chat.enums.ts` | `MessageType.COMPACTION = 'compaction'`（enum 成員按字母序排在最前 — perfectionist/sort-enums） |
| `src/lib/types/chat.d.ts` | **補上原本缺失的** `export type ChatRole = MessageRole;` 與 `export type ChatMessageType = MessageType;`（見 §3.1） |
| `src/lib/types/database.d.ts` | `CompactionMeta` interface（firstKeptMessageId / summarizedCount / isSplitTurn? / model? / estimatedTokensBefore?）+ `DatabaseMessage.compactionMeta?` |
| `src/lib/types/index.ts` | re-export `ChatRole`、`ChatMessageType`（chat.d 區塊）、`CompactionMeta`（database 區塊） |

### 測試（vitest unit project，node 環境）

| 檔案 | 用例數 | 重點 |
| ---- | ---- | ---- |
| `tests/unit/context-builder.test.ts` | 12 | `vi.mock('$lib/services/chat.service')` 以忠實替身（{content, role, reasoning_content} + 空 system 過濾）。無 cmp 回歸、單 cmp `[system, summary, kept]`、雙 cmp I2（含舊 cmp 落 kept 區按 user 送出）、fail-open I3（id 不存在 / 缺 meta / boundary 指向 system）、system 恆第一 I1、**entry 自身不重送**、cmp 之後追加的訊息保留、excludeReasoning |
| `tests/unit/compaction-policy.test.ts` | 13 | estimate 各附件型別；不超 budget → null；boundary 切（kept 恰好 4 user 訊息）；minKeptUserTurns 拒絕；split 切（kept 以 ass(tool_calls)+tool 開頭）；純 ass/tool 交替絕不切 tool；巨幅 user 訊息 → split；連 split 都放不下 → null；minSummarizeTokens；無 system prompt 路徑 |
| `tests/unit/summarize.test.ts` | 6 | transcript：`[role] content`、toolCalls→名稱、malformed→`unparsed`、附件佔位符（不帶 base64）、空訊息略過 |
| `tests/unit/conversation-export.test.ts` | +1 | cmp 節點 export/import round-trip（type / content / compactionMeta 完整） |

## 2b. Phase 1 已交付檔案（5.1–5.3，已確認）

### 修改

| 檔案 | 改動 |
| ---- | ---- |
| `src/lib/constants/settings-keys.constants.ts` | 8 個 `CONTEXT_*` key（字母序插在 `CONVERSATION_TABS` 前，帶 `// Context management` 註解） |
| `src/lib/constants/settings.constants.ts` | General section 末尾 8 個 registry 條目（4 個 numeric 用 `isPositiveInteger` + `min`/`max`；in-loop 與 threshold 帶 `dependsOn: CONTEXT_AUTO_COMPACTION`） |
| `src/lib/services/chat.service.ts` | import `buildLlmContext`（`$lib/services/context`，位置在 `$lib/enums` 後、`$lib/stores` 前）；新增公開 `static resolveOutgoingMessages(messages, excludeReasoning)`（DB path 判别 + 分派，見 §3.7/§3.8）；`sendMessage` / `preEncode` 改走它；`normalizeMessagesForApi` 參數放大為 per-element union |
| `src/lib/stores/agentic/index.svelte.ts` | `runAgenticFlow` 初始 normalize 改 `ChatService.resolveOutgoingMessages(messages, false)` |

### 零改動（重要）

- `types/settings.d.ts`（`SettingsConfigType` 由 registry 派生）、`SettingsChatFields.svelte`（通用渲染）
- `sendMessage` / `preEncode` 對外簽名、後段 vision 過濾、request body reasoning 過濾
- agentic `executeAgenticLoop` 的 `sessionMessages` 續加邏輯（Phase 2 才動）
- `conversationsStore` 路徑邏輯、`branching.ts`、import/export 服務、`convertDbMessageToApiChatMessageData`

### 2c. Phase 1 已交付檔案（5.4–5.5，待確認）

| 檔案 | 改動 |
| ---- | ---- |
| `src/lib/services/database.service.ts` | `createCompactionMessage({ convId, parentId, content, compactionMeta })`：照 `createSystemMessage` 模式（transaction + 驗證 parent + `addChildToParent`），role=USER / type=COMPACTION / children=[]；**不**動 currNode（store 層負責）；同路徑的兩筆 type import 合併為一筆 |
| `src/lib/stores/chat/context-stats.svelte.ts` | `compacting = $state(false)`：summary 呼叫進行中狀態（gauge popup 的「Compacting context…」列在 Phase 2 讀它） |
| `src/lib/stores/chat/index.svelte.ts` | `compactConversation(convId, { auto })`（流程見 §5.5；I7 guard → path 解析 → n_ctx → auto threshold gate → `planCompaction` → `summarizeMessages` → `createCompactionMessage` → active/non-active 分派 currNode → preEncode 預熱 → toast）；private `getContextSizeForConversation` / `resolveCompactionModel`；常數 `MIN_SUMMARIZE_TOKENS = 2000`；新 import：`$lib/services/context`（value + type 兩筆）、`contextStatsStore`、`filterByLeafNodeId`、`toast` |

## 3. 決策記錄（與規劃文件的差異，實做 Phase 1 前必讀）

### 3.1 既有 broken state：`ChatRole` / `ChatMessageType` 原本未定義
`app.d.ts`、`api.d.ts`、`database.d.ts`、`chat.service.ts` 都引用這兩個型別，
但全專案沒有定義（`chat.d.ts` 沒 export）。已補：
- `chat.d.ts`：`export type ChatRole = MessageRole; export type ChatMessageType = MessageType;`
- `types/index.ts`：re-export（app.d.ts 從 `$lib/types` import 它們）。

> 注意：`chat.service.ts` 等舊檔案**不 import** `DatabaseMessage` / `ChatRole` 等，
> 是靠 `app.d.ts` 的 `declare global { export { … } }` 全域型別。新檔案一律用
> 顯式 import（context/ 目錄全部顯式 import）。

### 3.2 builder 會把「生效中的 entry 節點自己」從 kept 區排除
規劃 pseudocode `kept = path[i..end]` 會把 cmp 節點（通常就是路徑最後一筆）
**再送一次**（summary 重覆）。對照 README 圖示（payload = `system │ summary │ kept…`），
實作為 `kept = path.slice(keptIndex).filter(m => m.id !== entry.id)`。
cmp 之後追加的新訊息（正常壓縮後續聊）仍然保留。

### 3.3 額外 fail-open guard
boundary id 指向 system prompt 本身（損毀資料；policy 與 inspector 都不會產生）
→ 也走 fail-open 全量送出，避免 system prompt 重送。

### 3.4 `SUMMARY_CONTENT_PREFIX` 在建節點時加上，不是 builder 加
builder 保持 WYSIWYG（送出 = 節點存的 content）。Phase 1 的
`compactConversation` 建節點時 `content = SUMMARY_CONTENT_PREFIX + summary`。

### 3.5 `estimateTokens` 多算了 `reasoningContent`
規劃 §3.4 只列 content + 附件 + toolCalls；實做把 reasoningContent 也計入
（它預設會被送出，方向偏保守，對「要不要壓/切哪裡」是安全方向）。

### 3.6 `summarizeMessages` 簽名
`(plan, model, signal?, options?: { maxTokens?, temperature?, prompt? })` —
比規劃多一個 options（對接 `contextSummaryMaxTokens` / `contextSummaryPrompt`）。

### 3.7 `resolveOutgoingMessages` 是公開 static（非 private）
規劃原本建議寫成 `chat.service.ts` 內的私有 helper；因為 5.3 規定 agentic
「直接呼叫該 helper，維持組裝只有一個入口」，所以公開為
`ChatService.resolveOutgoingMessages(messages, excludeReasoning)`。

### 3.8 `normalizeMessagesForApi` / `resolveOutgoingMessages` 參數放大為 per-element union
原簽名 `ApiChatMessageData[] | (DatabaseMessage & { extra? })[]`（union of arrays）
無法接受 `AgenticFlowParams.messages` 的 `(ApiChatMessageData | (DatabaseMessage & { extra? }))[]`
（array of union；TS 不互推）。兩者都放大到 per-element union：所有既有呼叫點
（`DatabaseMessage[]` / `ApiChatMessageData[]` / union 陣列）皆可指派，
`normalizeMessagesForApi` 內部本来就是逐則判别，行為不變。
`sendMessage` / `preEncode` 對外簽名維持原樣（plan 要求）。

### 3.9 agentic 初始 normalize 傳 `excludeReasoning: false`
`runAgenticFlow` 的初始 `normalizedMessages`（sessionMessages 基底）傳 `false`，
與現行 `normalizeMessagesForApi`（從不 strip reasoning）行為一致；
逐 turn 的 reasoning strip 仍在 `sendMessage` 的 request body mapping
（`options.excludeReasoningFromContext`）發生，不動。

### 3.10 `compactConversation` 實做細節（對規劃的補充）
- **進行中雙重 guard**：I7（`isChatLoading` + `agenticStore.isRunning`）之外再加
  `contextStatsStore.compacting`，避免兩個 summary 呼叫並行（手動連點）。
- **n_ctx 解析**：active conv 用 `contextStatsStore.contextTotal`（canonical
  resolution 在 `modelsStore.activeModelId`）；非 active conv 用
  `getConversationModel(path) ?? modelsStore.activeModelId` →
  `modelsStore.props.getModelContextSize`。未知時：auto 靜默回（02-§6 前置
  「n_ctx 已知」）；**手動 toast「Model context size unknown」**（規劃未指定，
  取「手動操作要有回饋」）。
- **model 解析**（`resolveCompactionModel`）：ROUTER →
  `selectedModelName ?? getConversationModel(path)`（mirror
  `streamChatCompletion` 的 `modelOverride || selectedModelName || conversationModel`，
  此處無 modelOverride）；single-model 模式 → `null`（server 只有一個模型）。
- **preEncode 預熱**：`triggerPreEncode(preCompactionPath, cmp, cmp.content, model)`，
  其中 `preCompactionPath` 是壓縮**前**的 path snapshot。原因：active conv 的
  `path` 就是 `activeMessages` 陣列本身，`addMessageToActive(cmp)` 會 push 進同一
  個陣列；若不 snapshot，pre-encode 的 payload 會變成 `[..., cmp, cmp]`，
  builder 的 kept 區會把舊 cmp 當一般 user 訊息再送一次（summary 重覆）。
  snapshot 後 payload = 舊 path + cmp = 新 DB path，buildLlmContext 產出
  `[system, summary, kept…]` 正是新的前綴。
- **第二次壓縮**：舊 cmp 節點在 path 上、在斷點之前時，policy 把它當一般
  user 訊息（role=user）處理，自然進 summarize 區被新 summary 涵蓋（I2）；
  斷點落在舊 cmp 之後時它留在新 kept 區按 user 送出（I2）— 皆零特殊處理。
- **循環 import**：`chat/index.svelte.ts ↔ context-stats.svelte.ts` 雙向（context-stats
  原本就 import chatStore）。兩邊都只在 call time / derived 求值時引用對方，
  模組評估期不碰 binding，安全。

## 4. 驗證狀態（目前停在這）

- Phase 0：使用者已跑 `npm run check` + 4 支 unit，**全綠**。
- Phase 1 5.1/5.2/5.3：使用者已跑 3 條指令（`npm run check` + 4 支 unit +
  `tests/client/settings-registry-invariants.svelte.test.ts`），**全綠**。
- Phase 1 5.4/5.5：**code 完成，待使用者編譯確認**。請跑：
  ```bash
  npm run check
  npm run test:unit -- --run tests/unit/context-builder.test.ts tests/unit/compaction-policy.test.ts tests/unit/summarize.test.ts tests/unit/conversation-export.test.ts
  ```
  （5.4/5.5 無新增 unit：`DatabaseService` 是 Dexie 層、`compactConversation`
  是 store 協調邏輯，皆不在 unit project 範圍；依 05-§5 驗收標準 5，store 層
  diff 已控制在 `compactConversation` + 兩個 private helper + `compacting` 欄位）
- **下一步：5.6 `ChatMessageCompaction.svelte` + 分派 + grouping**（規格見 §5.6），
  完成後請使用者跑 `npm run check`（+ 5.6 若加 client 測試則一併跑）。

## 5. Phase 1 執行清單（依序做；每完成一項可請使用者編譯確認）

> 原則：store 層不感知 compaction（除了觸發+建節點的協調邏輯）；
> payload 組裝只動 service 層。簽名全部不變。

### 5.1 Settings 8 個 key（先加，其他項依赖它）✅
`src/lib/constants/settings-keys.constants.ts` + `settings.constants.ts` 的
`SETTINGS_REGISTRY`（放 General section 末尾）+ 必要時 `types/settings.d.ts`：

| key | 型別 | 預設 |
| ---- | ---- | ---- |
| `contextAutoCompaction` | CHECKBOX | `false` |
| `contextAutoCompactionInLoop` | CHECKBOX（dependsOn: contextAutoCompaction） | `false` |
| `contextCompactionThreshold` | INPUT 1–100（dependsOn: contextAutoCompaction） | `80` |
| `contextKeepMinUserTurns` | INPUT 1–50 | `4` |
| `contextKeepMinMessages` | INPUT 2–50 | `2` |
| `contextSummaryMaxTokens` | INPUT 128–4096 | `1024` |
| `contextShowCompactionEntries` | CHECKBOX | `true` |
| `contextSummaryPrompt` | TEXTAREA | `''`（空 = 用內建預設） |

照既有 registry 條目的寫法抄（含 `SettingsChatFields.svelte` 的欄位呈現）。

> 實做備註：`SettingsConfigType` 由 `SETTING_CONFIG_DEFAULT`（registry 派生）定義，
> `SettingsChatFields.svelte` 通用渲染 registry — 兩處都**零改動**，只動兩個
> constants 檔。4 個 numeric key 用 `isPositiveInteger` + `min`/`max`
> （進 `POSITIVE_INTEGER_FIELDS` clamp）。

### 5.2 `ChatService.sendMessage`（chat.service.ts:1022）與 `preEncode`（:840）✅
- 兩處現在都直接 `normalizeMessagesForApi(messages)`（:1074-1075 / :846-847）。
- 改法：用與 `normalizeMessagesForApi` 相同的判别式
  （`'id' in msg && 'convId' in msg && 'timestamp' in msg`）判斷入參是 DB path：
  - DB path → `const { messages: normalizedMessages } = await buildLlmContext(path, { excludeReasoning })`
  - `ApiChatMessageData[]` → 維持原 `normalizeMessagesForApi` 路徑。
- `sendMessage` 傳 `excludeReasoning: options.excludeReasoningFromContext`；
  `preEncode` 傳它自己的 `excludeReasoning` 參數。
- 既有後段邏輯（vision 過濾 :1078-1103、request body 的 reasoning 過濾 :1115）
  **不動**（對 builder 路徑是 no-op）。
- ⚠️ 循環 import：`chat.service.ts → context/context-builder.ts → chat.service.ts`
  是安全的（`ChatService` 只在 call time 被引用），Phase 0 已註明。
- 建議把「DB path vs API 訊息」的判别 + 分派寫成 `chat.service.ts` 內的私有
  helper（如 `resolveOutgoingMessages`），sendMessage / preEncode 共用，
  避免兩份判斷式漂移。→ 已做（見 §3.7/§3.8：公開 static + per-element union）。

### 5.3 `agenticStore.runAgenticFlow`（stores/agentic/index.svelte.ts:358）✅
- `AgenticFlowParams.messages` 是 `(ApiChatMessageData | DatabaseMessage)[]` union。
- :358 `ChatService.normalizeMessagesForApi(messages)` → 改
  `buildLlmContext(messages)` 取 `.messages`（union 判别與 5.2 相同；
  可放 5.2 的共用 helper 或 builder 內處理 — **建議放 5.2 的 helper**，
  agentic 直接呼叫該 helper，維持「組裝只有一個入口」）。
- `executeAgenticLoop` 的 `sessionMessages` 續加邏輯不動（Phase 2 才在
  turn 之間插再壓縮）。

### 5.4 `DatabaseService.createCompactionMessage()`（database.service.ts）
照 `createSystemMessage`（:232）模式（transaction + 驗證 parent + addChildToParent，
**不**動 currNode — currNode 由 store 層更新）：
```ts
static async createCompactionMessage(params: {
  convId: string;
  parentId: string;          // 壓縮前路徑的最後一則（I6）
  content: string;           // SUMMARY_CONTENT_PREFIX + summary（store 層拼好）
  compactionMeta: CompactionMeta;
}): Promise<DatabaseMessage>
// role: MessageRole.USER, type: MessageType.COMPACTION, children: [], timestamp: Date.now()
```
> Phase 2 的 expand（還原）需要「刪 cmp + 子節點重掛到 cmp.parent + currNode 回 parent」。
> 現有 `deleteMessage`（:317）只把自己從 parent.children 移除，**不會**重掛子節點；
> `reparentDirectChildren`（:657）是 conversation 層（forkedFromConversationId），
> 不是 message 層。→ Phase 2 需新增 `expandCompactionMessage(convId, cmpId)`
> （transaction：子節點 parent 改指 cmp.parent、children 陣列搬移、刪 cmp、
> currNode 更新）。Phase 1 先不做。

### 5.5 `chatStore.compactConversation(convId, { auto })`（stores/chat/index.svelte.ts）
流程（03-§4.2；auto=false 即手動「Compact now」）：
1. I7 guard：`isChatLoading(convId)` 或 `agenticStore.isRunning(convId)` → 直接回。
2. path：active conv 用 `conversationsStore.activeMessages`；非 active 用
   `getConversationMessages(convId)` + `filterByLeafNodeId(all, conv.currNode, false)`。
3. 預算：`n_ctx` 從 contextStatsStore/modelsStore（`contextTotal`）；
   `keepBudgetTokens = n_ctx × (1 - threshold/100) - summaryReserve`
   （summaryReserve ≈ `contextSummaryMaxTokens × 1.5`，02-§3.3）。
   budget 其餘欄位：`contextKeepMinUserTurns` / `contextKeepMinMessages` /
   minSummarizeTokens（建議常數 2000，02-§3.3 的例值）。
4. auto=true 時額外檢查：`lastPrompt = 最後一則 assistant 的 timings.prompt_n
   ?? estimateTokens 總和` ≥ `n_ctx × threshold%`，否則不壓。
   auto=false（手動）跳過 threshold 檢查。
5. `plan = planCompaction(path, budget)`；null → auto: 靜默；手動: toast
   「沒有可壓縮的範圍」。
6. 進行中狀態（gauge「Compacting context…」、訊息列）→ 放 contextStatsStore
   新欄位（`compacting: boolean`；05 把 gauge 列列在 Phase 2，Phase 1 至少要有
   store 欄位 + toast 收尾）。
7. `summary = await summarizeMessages(plan, model, undefined,
   { maxTokens: contextSummaryMaxTokens, prompt: contextSummaryPrompt || undefined })`。
   model 解析照 `generateTitleWithLLM`（:1274，ROUTER 模式帶 selectedModelName）。
   失敗 → toast、**不建 cmp**（fail-open）。
8. `cmp = await DatabaseService.createCompactionMessage({ convId,
   parentId: path[path.length - 1].id,
   content: SUMMARY_CONTENT_PREFIX + summary,
   compactionMeta: { firstKeptMessageId: plan.firstKeptMessageId,
     summarizedCount: plan.toSummarize.length,
     isSplitTurn: plan.isSplitTurn || undefined,
     model, estimatedTokensBefore: plan.estimatedTokensBefore } })`。
9. active conv：`conversationsStore.addMessageToActive(cmp)`（:76）；
   `conversationsStore.updateCurrentNode(cmp.id)`（:723，走
   `DatabaseService.updateCurrentNode`）。非 active conv 只更新 DB currNode。
10. （選做）`triggerPreEncode`（stores/chat/index.svelte.ts:1402）用新 context 預熱。
11. toast「Context compacted: ~X → ~Y tokens」
    （X = plan.estimatedTokensBefore；Y = system + summary + kept 估計）。

### 5.6 `ChatMessageCompaction.svelte` + 分派 + grouping
- 新檔：`src/lib/components/app/chat/ChatMessages/ChatMessage/ChatMessageCompaction/ChatMessageCompaction.svelte`。
- `ChatMessage.svelte`（分派鏈 ~:407，與 isSynthetic 同位級）：
  `{:else if message.type === MessageType.COMPACTION}` → `<ChatMessageCompaction {message} />`。
- 視覺：中央細條、muted、不像 user 氣泡（04-§1.2）；收合式（本地 $state）。
  Phase 1 只有「展開摘要」動作（+ 顯示 summarizedCount / estimatedTokensBefore /
  保留起點訊息預覽）；編輯/重新摘要/還原 = Phase 2。
- `contextShowCompactionEntries = false` → 整列不顯示（在 ChatMessages 的
  displayMessages 過濾；送出邏輯不受影響）。
- `ChatMessages.svelte` grouping（:136）確認：cmp 是 user role 不會被 TOOL skip；
  確認 agentic grouping 的 while 不會把 cmp 之後的訊息併入同一組；補測試。
- export：`components/app/chat/index.ts`。

### 5.7 Inspector 只讀版 `DialogContextInspector.svelte`
- 新檔：`src/lib/components/app/dialogs/DialogContextInspector.svelte`（+ export 到
  `components/app/dialogs/index.ts`）。
- 資料：`buildLlmContext(conversationsStore.activeMessages)` →
  `messages`（payload 列）+ `compaction`（droppedCount / boundaryValid）+
  `estimatedTokens`；n_ctx / 百分比色級複用 context-gauge（`colorLevelFromPercent`）。
- 內容（04-§2.2 的只讀子集）：
  - 頂部：model、n_ctx、估計送出 tokens + 百分比條。
  - payload 訊息列：role badge、content 單行截斷（點開全文）、每則估計 token。
  - 「已裁切」區：drop 的訊息灰階列出（= path 上在 boundary 之前、非 head 的
    訊息；可從 `path` + `compaction.firstKeptMessageId` 算出）。
  - `boundaryValid === false` → 紅色警告條「斷點訊息已不存在，目前全量送出」。
  - Copy JSON 按鈕：`ApiChatMessageData[]`，base64 以佔位符替換。
- 顯示狀態：chat store 加 `showContextInspector`（$state）；
  **入口 Phase 1 只做一个**：`ContextGaugePopup.svelte` body 底部文字連結
  （04-§2.3）。ChatFormActions icon + 快捷鍵 = Phase 2。
- streaming 中顯示「本輪已送出」快照（送出前抓一份存 chat store；
  04-§2.1）— 若 Phase 1 時間緊可先只在非 streaming 時啟用（disabled + 提示）。

### 5.8 驗收（05-§1 Phase 1 ✅ 列）
1. 有 cmp 的對話：送出 payload = inspector 顯示 = devtools 抓包（附件佔位符除外逐欄位一致）。
2. 手動「Compact now」可產生 cmp（聊天列出現 entry；下一輪 payload 含 summary）。
3. 無 cmp 對話行為與現行完全一致（context-builder.test.ts 的回归測試保證）。

## 6. 專案慣例 / 陷阱（Phase 1 寫碼前速讀）

- **格式**：tabs、single quote、printWidth 100、無 trailing comma。
- **eslint 嚴格的幾條**：
  - `perfectionist/sort-objects`：物件 literal 的 key 必須字母序（含嵌套、
    含 test 的 fixture）。
  - `perfectionist/sort-enums`：enum 成員字母序。
  - `simple-import-sort/imports`：單一群組全字母序（`$lib/…` 在 `./…` 前；
    同路徑 value import 在 type import 前）。
  - `padding-line-between-statements`：return/throw 前空行；if 前後空行；
    連續兩個獨立 if 之間空行；連續 const 之間**不**空行。
- **unit test**（vitest `unit` project，node 環境）：
  - import 到會拉 svelte store 的 service 時用 `vi.mock` 整個 module
    （見 context-builder.test.ts 的 ChatService 替身寫法）。
  - `DatabaseMessageExtraPdfFile.base64Data` 是**必填**（test fixture 別漏）。
  - tool call 結構：`{ id, type: 'function', function: { name, arguments } }`。
- **store 慣例**：`.svelte.ts` runes（$state/$derived）；`conversationsStore`
  的路徑邏輯（`filterByLeafNodeId`）對新 type 透明，**不要**改 `branching.ts`。
- **不要 import/export 改動**：`conversationsStore` 路徑邏輯、`branching.ts`、
  import/export service、`convertDbMessageToApiChatMessageData`（builder 複用它）。
- **編譯/測試由使用者執行**：每完成一個可獨立驗證的單位（建議 5.1 / 5.2+5.3 /
  5.4+5.5 / 5.6 / 5.7 各一段）就停下來請使用者跑 `npm run check` +
  相關 `npm run test:unit -- --run <files>`，確認後再继续。
