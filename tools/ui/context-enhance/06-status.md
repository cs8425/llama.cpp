# 06 · 實做狀態（continuity doc）

> 給「下一個繼續實做的 session」讀。規劃細節在 01–05，本檔只記錄
> **做到哪裡、做過的決策、接下來怎麼做**。

> **恢復點（最新）**：**P2.5 ✅ 完成並確認**——cmp entry 動作
> （`ChatMessageCompaction.svelte` 展開區動作列：[Edit]/[Re-summarize]/
> [Restore all context]，皆走 P2.3 的 chatStore 方法、`compacting` /
> `chatStore.isLoading` 時 disabled；boundary 失效時 Re-summarize disabled；
> 變更見 §2o）。使用者已跑 3 條指令全綠：`npm run check` + compaction client
> suite（**10/10** = 4 既有 + 6 支 P2.5 新）+ inspector client suite
> （**10/10** 回歸，元件改動未破 inspector）。
> 第一件要做的事：實做 **P2.6**——gauge 列 + 第三入口 + 快捷鍵（規格見 §5b
> P2.6）。完成後照慣例請使用者跑 `npm run check` + 相關 client 測試。

## 1. 進度總覽

| 階段 | 狀態 |
| ---- | ---- |
| Phase 0 — 純核心 | ✅ 完成（使用者已確認 `npm run check` + unit 全綠） |
| Phase 1 — 送出路徑接 builder + 手動壓縮 | 🚧 5.1–5.7 ✅ 全部完成並確認（見 §4）；只剩 5.8 手動驗收 |
| Phase 2 — 自動觸發 + 人工介入 + flow 內再壓縮 | 🚧 P2.1 ✅ 完成並確認（見 §4）；P2.2 ✅ 完成並確認（見 §2h/§4）；P2.3 ✅ 完成並確認（見 §2i/§4）；P2.4 ✅ 完成並確認（client 10/10 + check 全綠，見 §4/§2j/§2m/§2n）；P2.5 ✅ 完成並確認（compaction 10/10 + inspector 10/10 回歸 + check 全綠，見 §4/§2o）；**下一步 P2.6**（§5b） |
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

### 2c. Phase 1 已交付檔案（5.4–5.5，已確認）

| 檔案 | 改動 |
| ---- | ---- |
| `src/lib/services/database.service.ts` | `createCompactionMessage({ convId, parentId, content, compactionMeta })`：照 `createSystemMessage` 模式（transaction + 驗證 parent + `addChildToParent`），role=USER / type=COMPACTION / children=[]；**不**動 currNode（store 層負責）；同路徑的兩筆 type import 合併為一筆 |
| `src/lib/stores/chat/context-stats.svelte.ts` | `compacting = $state(false)`：summary 呼叫進行中狀態（gauge popup 的「Compacting context…」列在 Phase 2 讀它） |
| `src/lib/stores/chat/index.svelte.ts` | `compactConversation(convId, { auto })`（流程見 §5.5；I7 guard → path 解析 → n_ctx → auto threshold gate → `planCompaction` → `summarizeMessages` → `createCompactionMessage` → active/non-active 分派 currNode → preEncode 預熱 → toast）；private `getContextSizeForConversation` / `resolveCompactionModel`；常數 `MIN_SUMMARIZE_TOKENS = 2000`；新 import：`$lib/services/context`（value + type 兩筆）、`contextStatsStore`、`filterByLeafNodeId`、`toast` |

## 2d. Phase 1 已交付檔案（5.6，已確認）

| 檔案 | 改動 |
| ---- | ---- |
| `src/lib/components/app/chat/ChatMessages/ChatMessage/ChatMessageCompaction/ChatMessageCompaction.svelte` | 新元件：中央細條（`max-w-xl`、muted、`RefreshCw` icon、`role="status"`）、標題「Context compacted」+ 時間戳、split 時加「(mid-turn)」、第二行「Summarized N messages (~X → ~Y tokens)」（Y = `estimateTokens(cmp)`，與 policy 同一 estimator）、收合式（本地 `$state`，`aria-expanded`）。展開後：summary 全文（`SUMMARY_CONTENT_PREFIX` 剝掉、mono 可捲動）+「Kept from: #N (role: …)」邊界預覽（`conversationsStore.findMessageIndex` 對 `activeMessages` 解析；assistant 邊界顯示 `tool_calls name`；boundary 失效時 amber 警告「全量送出」）+ split 註記「此 turn 的使用者請求已含於摘要」。Phase 1 無 store 動作（編輯/重新摘要/還原 = Phase 2） |
| `src/lib/components/app/chat/ChatMessages/ChatMessage/ChatMessage.svelte` | 分派鏈 SYSTEM 之後加 `{:else if message.type === MessageType.COMPACTION}` → `<ChatMessageCompaction class={className} {message} />`；import 加 `ChatMessageCompaction` + `MessageType` |
| `src/lib/components/app/chat/ChatMessages/ChatMessages.svelte` | `displayMessages`：`filteredMessages` 追加 filter（`contextShowCompactionEntries=false` → 整列不顯示，送出邏輯不受影響）；grouping 確認零改動（cmp 是 user role：TOOL skip 不中、agentic `while` 只吃 TOOL/ASSISTANT 所以 cmp 會 break 迴圈成獨立 entry）；`isLastUserMessage` 與 `nextAssistantMessage` 兩個迴圈各加一句「cmp 不是 user turn」guard（props 對 cmp 無用，但保持語義正確） |
| `src/lib/components/app/chat/index.ts` | export `ChatMessageCompaction`（JSDoc 同既有格式） |
| `tests/client/chat-message-compaction.svelte.test.ts` | 4 用例（`ChatMessagesPerfWrapper` 掛真實 list + 真實 store）：cmp 獨立 row（6 rows、tool result 文字不洩入 cmp row）；展開/收合（summary 全文 + prefix 剝除 + 「Kept from: #6 (user: …)」）；`contextShowCompactionEntries=false` 整列消失（6→5 rows）；split-turn（「(mid-turn)」標題 + `assistant: tool_calls edit_file` 邊界預覽 + in-turn 註記） |
| `tests/stories/ChatMessageCompaction.stories.svelte` | 4 stories：Collapsed / Expanded / BoundaryLost（amber 警告）/ SplitTurn；`play` 內設 `conversationsStore.activeMessages` 供邊界預覽解析 |

> 零改動：`LazyChatMessage`（cmp row 走一般 lazy 掛載）、`ChatMessageActions`（cmp 無動作列）、
> `flows.svelte.ts` / `streams.svelte.ts` 的 user-role 搜尋（cmp.parent 永不為 root；stream
> attach 的 lastUser fallback 只在「全對話無 assistant」時觸發，corner case 下 placeholder
> 掛在 cmp 之下反而是正確樹形）。

## 2e. Phase 1 已交付檔案（5.7，已確認全綠；第一輪修復見 §2f）

| 檔案 | 改動 |
| ---- | ---- |
| `src/lib/components/app/dialogs/DialogContextInspector.svelte` | 新元件（只讀 inspector）：頂部 model / n_ctx / 估計送出 tokens + 百分比條（複用 `colorLevelFromPercent`）；payload 訊息列（role badge、單行截斷、點開全文、每則 `~N tok`，summary 行獨立 `summary` badge）；「Compacted out」灰階列（boundary 之前、非 head 的訊息 + 1-based 序號）；`boundaryValid === false` 時紅色 `role="alert"` 警告條；Copy JSON（base64 → `[image: ~N KB]` 佔位符、成功換「Copied」label、失敗 toast） |
| `src/lib/components/app/dialogs/index.ts` | export `DialogContextInspector`（JSDoc 同既有格式） |
| `src/lib/services/context/compaction-policy.ts` | `estimateApiMessageTokens(msg: ApiChatMessageData)`：string content/4 + content parts（TEXT/4、IMAGE 1000、AUDIO/VIDEO 3000）+ tool_calls JSON/4 + reasoning/4（與 `estimateTokens` 同 heuristic，API form 版） |
| `src/lib/services/context/index.ts` | barrel 加 `estimateApiMessageTokens` |
| `src/lib/stores/chat/index.svelte.ts` | `showContextInspector = $state(false)`（`errorDialogState` 旁） |
| `src/lib/components/app/chat/ChatForm/ChatFormContextGauge/ContextGaugePopup.svelte` | body 底部「Inspect what the LLM sees →」文字連結（Phase 1 唯一入口；mobile drawer 與 desktop card 共用 body snippet 所以兩端都有）；`chatStore.isLoading` 時 `disabled` + title 提示（Phase 1 不做 streaming 快照，05-5.7 允許的 fallback） |
| `src/lib/components/app/chat/ChatScreen/ChatScreenDialogsAndAlerts.svelte` | 掛 `<DialogContextInspector bind:open={chatStore.showContextInspector} />` |
| `tests/unit/compaction-policy.test.ts` | +3 用例（`estimateApiMessageTokens`：string content + reasoning + tool_calls；content parts 各型別 flat 計價；image+text 組合） |
| `tests/client/context-inspector.svelte.test.ts` | 4 用例：compaction payload 列（badge / 每則 token / dropped 3 則 / **列 token 總和 == header 估計**；tool result 不在 payload 列）；點開列顯示全文 + 再收合；fail-open（boundary 失效 → 紅條 + 全量 4 則 + 無 dropped 區）；Copy JSON（mock `navigator.clipboard`、summary 以 user role 送出且含 prefix、無 base64 漏出、「Copied」feedback） |

> 5.7 設計細節：
> - 資料在 open 時抓 `buildLlmContext(conversationsStore.activeMessages)`（與送出同源，WYSIWYG）；
>   入口在 streaming 時 disabled，所以 dialog 開啟期間 path 穩定（Phase 2 改送出前快照）。
> - summary 行 = system head 之後第一則（`boundaryValid` 時），`kind` 標成 `summary` 而非 `user`；
>   cmp 節點本身不在 payload（builder 已排除）。
> - 「Compacted out」= `path.slice(headLength, boundaryIndex)` 再排除 in-effect entry
>   本身（它是 summary、不是被摘要涵蓋的訊息；見 §2f）；失效時不顯示、改紅條。
> - Copy JSON 的佔位符只換 `data:` 開頭的 image_url 與 input_audio/input_video 的 data；
>   非 data: 的 URL 原樣保留。
> - `n_ctx` / `model` 讀 `contextStatsStore.contextTotal` / `activeModelId`（canonical 在 modelsStore）；
>   未知時顯示「—」、不畫百分比條。
> - **與 05-§3 測試計畫的偏差**：inspector 的 Storybook story（05 列的「正常 / 斷點失效 /
>   進行中」三態）**未建**——只讀版行為已由 4 支 client 測試覆蓋；
>   留到 Phase 2 編輯動作落地時一併補（屆時「進行中」態也有意義）。

## 2f. 5.7 第一輪確認的修復（重跑已確認全綠）

第一輪跑 `npm run check` + 2 支測試：unit 16/16 綠；check 抓到 2 型別錯 + 1 warning；
client 4 支掛 1 支（dropped 區把 in-effect entry 自己也算進「Compacted out」，顯示
4 則而非 3 則）。全數已修、使用者重跑 4 條指令全綠：

| 檔案 | 問題 | 修復 |
| ---- | ---- | ---- |
| `DialogContextInspector.svelte` | 「Compacted out」列把 in-effect cmp entry 自己也算進去（`path.slice(headLength, boundaryIndex)` 含 entry；entry 是 summary 本身、不是被涵蓋的訊息）→ fixture 顯示 4 則而非 3 則 | `droppedRows` 先 map 出 1-based index 再 `.filter((row) => row.message.id !== compaction.entryId)`（index 用 filter **前**的 offset 算，避免過濾後編號漂移） |
| `context-builder.ts` + `types.ts` | `droppedCount = keptIndex - head.length` 在「entry 落在 head..boundary 之間」時會把 entry 數進去（與 inspector「covered by the summary」語義不一致；真實流程 entry 恆在 boundary 之後所以數值不變） | 改 `path.slice(head.length, keptIndex).filter((m) => m.id !== entry.id).length`；JSDoc 補註。既有 builder 測試期望值（2/0/2）不變 |
| `DialogContextInspector.svelte:320` | svelte warning：非 void element 自我關閉 `<div />`（`element_invalid_self_closing_tag`） | 改 `<div …></div>` |
| `tests/client/context-inspector.svelte.test.ts:243` | 型別錯：`.find()` 回 `HTMLButtonElement \| undefined`，自訂 `waitFor` 要 `Node \| null` | 箭尾加 `?? null` |
| `tests/unit/compaction-policy.test.ts:139` | 型別錯：`format: 'wav'` 字面量不能指派給 `AudioInputFormat`（= `FileTypeAudio.WAV \| FileTypeAudio.MP3`） | 改 `FileTypeAudio.WAV`（import 加 `FileTypeAudio`） |

## 2g. Phase 2 已交付檔案（P2.1，已確認；第一輪修復見 §4）

| 檔案 | 改動 |
| ---- | ---- |
| `src/lib/services/context/compaction-policy.ts` | `MIN_SUMMARIZE_TOKENS = 2000` 常數（原在 chat store，上移為 policy 擁有）；`CompactionSettings`（structural pick，policy 不 import settings 型別）；`computeCompactionBudget(nCtx, settings)`（02-§3.3 公式） |
| `src/lib/services/context/index.ts` | barrel 加 `computeCompactionBudget` / `MIN_SUMMARIZE_TOKENS` / `CompactionSettings` |
| `src/lib/stores/chat/index.svelte.ts` | `compactConversation` auto gate 加 `contextAutoCompaction` 總開關（auto 時先查；手動照樣跳過開關與 threshold）；budget 改走 `computeCompactionBudget`（刪本機 `MIN_SUMMARIZE_TOKENS` 常數與 `CompactionBudget` import）；`streamChatCompletion` 兩個觸發點（fire-and-forget + catch）：①非 agentic `onComplete` 最末（pending 重送之後）②agentic `agenticResult.handled` 區塊末（pending steering 之後）——不在 `onFlowComplete` 回調內，因該時點 `isRunning` 仍 true 會被 I7 guard 擋 |
| `tests/unit/compaction-policy.test.ts` | +2 用例（`computeCompactionBudget`：keep budget 公式 floor(32768×0.2)−1536；min 欄位透傳 + `minSummarizeTokens` pin 到常數）；`CompactionSettings` import 改自 `$lib/services/context/compaction-policy`（見 §4 第一輪修復） |

> 觸發語義：`compactConversation(convId, { auto: true })` 內部依序查
> I7（isChatLoading / isRunning / compacting）→ `contextAutoCompaction`
> → threshold → plan。任一不過即靜默回，所以兩個觸發點可無條件 fire。

## 2h. Phase 2 已交付檔案（P2.2，已確認）

| 檔案 | 改動 |
| ---- | ---- |
| `src/lib/stores/agentic/index.svelte.ts` | 新 private `compactBetweenTurns({ conversationId, lastPrompt, model, sessionMessages, signal })`（private 方法字母序放在 `buildFinalTimings` 與 `executeAgenticLoop` 之間）：gate `contextAutoCompaction && contextAutoCompactionInLoop` → path 解析（同 `compactConversation` 形狀：active → `activeMessages`；非 active → DB + `filterByLeafNodeId`）→ n_ctx（mirror `getContextSizeForConversation`：active → `contextStatsStore.contextTotal`；非 active → `getConversationModel(path) ?? modelsStore.activeModelId` → `getModelContextSize`，未知靜默回）→ threshold gate（`lastPrompt ?? Σ estimateApiMessageTokens(sessionMessages)` ≥ `nCtx × threshold%`）→ `planCompaction`（null 續跑）→ `preCompactionPath` snapshot（§3.10）→ `contextStatsStore.compacting` 包裹 → `summarizeMessages(plan, model \|\| null, signal, { maxTokens: contextSummaryMaxTokens, prompt: contextSummaryPrompt \|\| undefined })`（共享 flow model + abort signal）→ `createCompactionMessage`（parent = 路徑最後一則）→ active：`addMessageToActive` + `updateCurrentNode`；非 active：DB `updateCurrentNode` + `applyConversationUpdate` → `updateConversationTimestamp` → **重建 `sessionMessages`**：`buildLlmContext([...preCompactionPath, cmp], { excludeReasoning: false })`（§3.9：reasoning 不 strip）→ `toAgenticMessages(messages)` 原地 `splice` → toast「Context compacted: ~X → ~Y」；catch：abort 靜默、其餘 `toast.error`，舊 sessionMessages 續跑（fail-open）；finally：`compacting = false`。呼叫點：`executeAgenticLoop` loop body 最末（steering check 之後、`turn++` 之前），`lastPrompt: turnTimings?.prompt_n ?? null`、`model: effectiveModel`、`signal` 綁 flow abort。不做 in-loop preEncode（下一 turn 立刻 re-encode 新前綴） |
| （同檔 imports） | `$lib/services/context`（`buildLlmContext` / `computeCompactionBudget` / `estimateApiMessageTokens` / `planCompaction` / `summarizeMessages` / `SUMMARY_CONTENT_PREFIX`）、`$lib/services/database.service`（`DatabaseService`）、`$lib/stores/chat/context-stats.svelte`（`contextStatsStore`，direct import 非 barrel）、`$lib/utils` 加 `filterByLeafNodeId` / `getConversationModel`、`svelte-sonner`（`toast`） |

> 要點：
> - 不能重用 `compactConversation`：其 I7 guard 查 `agenticStore.isRunning(convId)`，
>   in-loop 時恆為 true 會被擋掉——所以獨立方法（規格 §5b P2.2）。
> - summary 呼叫共享 flow 的 `effectiveModel`（03-§4.4「與 flow 共用同一 model」；
>   single-model 模式即 `modelsStore.models[0]`）。
> - `preCompactionPath` snapshot：active conv 的 `path` 就是 `activeMessages` 陣列本身，
>   `addMessageToActive(cmp)` 會 push 進同一陣列（§3.10 陷阱）。builder 的 kept filter
>   會按 id 濾掉重複 entry（結果正確），但 snapshot 與 `compactConversation` 一致、防漂移。
> - 新循環 import `agentic ↔ context-stats`（context-stats 原本就 import agenticStore；
>   agentic 新增 import contextStatsStore）——兩邊都只在 call time / derived 求值時引用，
>   模組評估期不碰 binding，安全（同 §3.10 的 `chat ↔ context-stats`）。
> - 非 active conv：`conversation.currNode` 是記憶體值（flow 期間只更新 DB、不更新記憶體），
>   path 可能解析到舊 leaf——與 `compactConversation` 同行為（已知限制；要修則兩邊一起修）。
> - 重建走 `toAgenticMessages`（規格明定）：其 TOOL 分支只保留 string content
>   （array parts → `''`）。這與 flow 開頭 `toAgenticMessages(normalizedMessages)`
>   的初始 session build 語義一致（兩邊都丟 tool image parts）；live push 的 parts
>   （vision tool result）在 compaction 後會回到 mapper 語義——窄邊界情境，記錄在此。
> - 無新純邏輯（policy / builder / summarize 皆既有）→ 無新 unit；store 層照慣例不 unit 測。

## 2i. Phase 2 已交付檔案（P2.3，已確認）

### 修改

| 檔案 | 改動 |
| ---- | ---- |
| `src/lib/services/database.service.ts` | `expandCompactionMessage(convId, cmpId)`：transaction（conversations + messages）內驗證 convId 相符、`type === COMPACTION`、parent 存在（違反即 throw）→ 子節點 bulkGet 後逐則 re-attach 到 `cmp.parent`（順序保留、缺漏 id 略過）→ `parent.children` 以 flatMap 把 cmp 替換成它的子節點 → 刪 cmp 列 → `conv.currNode === cmpId` 時回 `cmp.parent`（同 transaction）→ 回新 currNode id；caller 負責 in-memory mirror |
| `src/lib/stores/chat/index.svelte.ts` | 4 個新 public 方法（皆 I7 guard + active/non-active 雙路徑 mirror，明細見下表）＋ 5 個新 private helper：`resolveConversationPath(convId)`（從 `compactConversation` 提出的 path 解析：active → `activeMessages`、非 active → DB + `filterByLeafNodeId`、conv 不存在回 null；`compactConversation` 改走它，行為不變）、`findCompactionEntry(path, cmpId)`（id + `type === COMPACTION` 雙驗證，回 `{entry, index}`）、`boundaryIndexOf(path, entry)`（I3：失效回 -1）、`headLengthOf(path)`（I1 system head）、`summarizeRegion(path, boundaryIndex, isSplitTurn)`（recompact 與斷點後移共用：組 `CompactionPlan`（`toSummarize = path[head..boundary)`、I2 含舊 cmp；token 估計用同一 estimator）→ `summarizeMessages`（model 走 `resolveCompactionModel`、options 走 `contextSummaryMaxTokens` / `contextSummaryPrompt`）） |
| （同檔 imports） | 移除 unused `MIN_SUMMARIZE_TOKENS`（P2.1 常數上移後的殘留 import，全檔無引用）；`$lib/services/context` import 加 `type CompactionPlan` |

### 四個 public 方法（皆 fail-safe、無靜默資料遺失）

| 方法 | 行為 |
| ---- | ---- |
| `updateCompactionSummary(convId, cmpId, plainText)` | `content = SUMMARY_CONTENT_PREFIX + ' ' + trimmed`（與建節點同一拼法）；`compactionMeta` 不動（02-§4）；空文字 no-op；DB `updateMessage` + active mirror `updateMessageAtIndex`；toast |
| `recompactConversationEntry(convId, cmpId)` | 對**同一 summarize 區**（`path[head..boundary)`、I2 含舊 cmp）重跑 summary → **更新同一節點** content + meta（`model` / `estimatedTokensBefore` 重算；`firstKeptMessageId` / `summarizedCount` / `isSplitTurn` 保持）；boundary 失效 → toast 回；`compacting` 包裹；失敗 → toast、節點不變（fail-open） |
| `expandCompactionEntry(convId, cmpId)` | 走 `DatabaseService.expandCompactionMessage`；active conv：`applyConversationUpdate({ currNode })` + `refreshActiveMessages()`（照 delete flow 的 mirror 模式重建 path）；非 active 只 mirror；toast |
| `moveCompactionBoundary(convId, cmpId, newFirstKeptMessageId)` | I4 驗證（新路徑上須為 user/assistant；tool/system toast 拒）；同位置 no-op；**前移**（kept 變長）只改 meta（`firstKeptMessageId` / `summarizedCount` / `isSplitTurn` 跟隨新邊界 role；02-§4：舊 summary 多涵蓋一點、無害）；**後移**（kept 變短）走 `summarizeRegion` 對擴大區強制重摘要（防靜默遺失）＋更新 content + meta；`compacting` 包裹 |

> 要點：
> - 無 preEncode：P2.3 規格未要求（prefix 改變由下一輪自然 re-encode；一次性成本可接受）。
> - 無新純邏輯（builder / policy / summarize 皆複用）→ 無新 unit；DB 層是 Dexie、
>   store 協調層照慣例不 unit 測（同 5.4/5.5 先例）。
> - `compactConversation` 的 path 解析 refactor：原樣移入 `resolveConversationPath`
>   （行為不變；4 個新方法共用，防雙路徑 mirror 漂移）。
> - 型別安全：`compactionMeta` 是 optional，spread `CompactionMeta | undefined` 會產出
>   無法指派給 `CompactionMeta` 的 union 型別 → recompact / move 都以 `baseMeta`
>   顯式 guard（同時防損毀節點；boundary 有效時 meta 恆在，guard 只跑型別收斂）。

## 2j. Phase 2 已交付檔案（P2.4，已確認）

| 檔案 | 改動 |
| ---- | ---- |
| `src/lib/components/app/dialogs/DialogContextInspector.svelte` | 只讀版 → 完整版（04-§2.2）：① summary 列加鉛筆「Edit」→ 就地 `Textarea`（`SUMMARY_CONTENT_PREFIX` 剝除後預填）+ [Save]/[Cancel]，存檔走 `chatStore.updateCompactionSummary`；② 新增「Advanced」區——斷點 `Select`（I4 候選 = 路徑上 `index > headLength` 的 user/assistant 訊息，分兩組「Turn boundaries (user)」「Within a turn (assistant)」，tool/system 不列；label 含 1-based 序號 + role + 預覽，assistant tool_calls 顯示名稱）→ `moveCompactionBoundary`；[Compact now]（`compactConversation auto:false`）/ [Expand]（`DialogConfirmation` 確認框，description 顯示「~X → ~Y tokens」增回估算，Y = 全路徑 `estimateTokens` 總和）/ [Re-summarize]（boundary 失效時 disabled）；③ `contextStatsStore.compacting` 時顯示 spinner 列「Compacting context…」（`role="status"`）且全部動作 disabled（`actionsBlocked = compacting || chatStore.isLoading || 無 active conv`；store 的 I7 guard 仍是最後防線）；④ boundary 失效紅條加 [Compact now] 按鈕（04-§2.2「建議重新壓縮 + 按鈕」）；⑤ **每次動作後重抓 payload**：`refreshTick` $state 進 `$effect` 依賴 + store 動作本來就 mirror 進 `activeMessages`（effect 已追蹤 `path`，tick 使重抓顯式化）；重抓期間保留舊 result 不閃空白（`{#if !result}` 才顯示 spinner），build 失敗改 toast（原本會永久卡 spinner）；⑥ row 結構重組：row `<button>` 外層包 `<div class="flex">` 放 Edit 按鈕（避免 button 巢狀 button）；⑦ import 加 `chatStore`（barrel）、`estimateTokens` / `SUMMARY_CONTENT_PREFIX`（context barrel）、`Select` / `Textarea` / `DialogConfirmation` UI 元件、`Shrink` / `Pencil` / `RefreshCw` / `UnfoldVertical` icons（原寫 `Compress`，本機 `@lucide/svelte` v1.46.0 無此 icon，已改 `Shrink`，見 §2k） |
| `tests/client/context-inspector.svelte.test.ts` | 4 支既有用例保留（改走共用 `openInspector()` helper；fixture 回傳加 `cmp` / `user`）；新增 6 支（P2.4，chatStore store spy）：summary 就地編輯（prefix 剝除預填 → clear+type → Save → `updateCompactionSummary(convId, cmpId, text)`）；Compact now → `compactConversation(convId, { auto: false })`；Expand → 確認框（含「3 compacted messages」+ tokens 文案）→ `expandCompactionEntry(convId, cmpId)`；Re-summarize → `recompactConversationEntry(convId, cmpId)`；斷點 select（trigger 顯示現行 boundary 預覽 → 點開 portaled options → 選前段 user boundary → `moveCompactionBoundary(convId, cmpId, userId)`）；`compacting=true` 時 spinner 列 + 全部動作 disabled（Compact/Expand/Re-summarize/Edit/select trigger）；`afterEach` 加 `activeConversation = null` / `compacting = false` 重置；新增 `setActiveConversation()` helper（inspector 的 convId 來自 `activeConversation`） |

> 要點：
> - 無新純邏輯（builder / policy / summarize / store 方法皆 P2.3 既有）→ 無新 unit；UI 層走 client 測試（同 5.6/5.7 先例）。
> - 斷點候選集 = store `moveCompactionBoundary` 的 I4 驗證集（user/assistant、index > head），UI 不另創新規則；cmp entry 本身（user role）也在候選內（boundary 指向自己 =「只留 summary」，builder 的 kept filter 自然處理）。
> - `Select.Item` 只傳 `label` prop（不傳 children，同 ModelsManagerFilters 慣例）。
> - inspector 只對 active conv 操作（`convId = activeConversation?.id`），非 active conv 無入口（同 Phase 1）。
> - `DialogConfirmation` 掛在 `Dialog.Root` 內（Content 的 sibling）；其 `onConfirm` 不自動關框，由 `handleExpandConfirmed` 設 `showExpandConfirm = false`。

## 2k. P2.4 第一輪確認的修復（重跑待確認）

第一輪跑 `npm run check`（4 錯）+ vitest（suite 無法 import、0 test）：
根因全是 `@lucide/svelte`（本機 v1.46.0）**沒有 `Compress` icon**——check 抓
到 import 錯，vitest 連帶整個 suite 的 module graph 炸掉（test 檔 import
`DialogContextInspector.svelte`，Vite deps optimizer 的 `@lucide_svelte.js`
不提供 `Compress` export），所以 6 支新用例根本沒跑到。其餘 3 錯是 test 檔型別。
全數已修：

| 檔案 | 問題 | 修復 |
| ---- | ---- | ---- |
| `DialogContextInspector.svelte` | `@lucide/svelte` v1.46.0 無 `Compress`（只有 `Compass`；icon 集隨版本變動，`Compress` 是新版才有） | 「Compact now」兩處（red 警告條 + Advanced 動作列）改 `Shrink`（v1.46.0 有、語義相符），import 字母序插位（`RefreshCw` 後、`UnfoldVertical` 前） |
| `tests/client/context-inspector.svelte.test.ts:407` | `trigger`（`querySelector` 回 `HTMLButtonElement \| null`）在 `expect(trigger).not.toBeNull()` 後未收斂 | 改 `trigger!.textContent`（同該檔 `userEvent.click(trigger!)` 既有寫法） |
| `tests/client/context-inspector.svelte.test.ts:438/441` | `document.querySelector(...)` 回 `Element`，無 `disabled` 屬性 | 加 generic `querySelector<HTMLButtonElement>(...)`（Edit summary 按鈕 + select trigger 兩處） |

> 要點：icon 換名**零行為改動**；test 三處皆型別收斂、零行為改動。
> 因 suite 第一輪完全沒跑過，6 支 P2.4 新用例是**首次執行**——重跑若有用例
> 掛，屬首次 runtime 驗證（bits-ui Select portal / DialogConfirmation 互動），
> 非本次修復引入。

## 2l. P2.4 診斷記錄（**已結案**；根因與修復見 §2m，TEMP-DIAG 已全數移除）

> §4 有逐輪歷史；本節保留診斷過程供日後查考。結論：**不是 runtime
> 反應性問題**——selector 撞了 P2.4 新增的 Select trigger；「pathLen 0 重跑」
> 是 afterEach 紅鵝（見 §2m）。

### 已確立的事實（診斷期第一~四輪；第五輪結案見 §2m）

- `npm run check` ✅ 全綠（§2k 修復後）。
- suite 可載入；10/10 全掛在 `openInspector()` 等 4 支 payload row（5s timeout）。
- `[inspector-diag]`：**effect 跑兩次**、皆 `instanceId: 1`（無 double mount）：
  1. `pathLen: 7` → `built {messages: 4, boundaryValid: true, droppedCount: 3}`；
     DOM 確實渲染 4 行 + Advanced 區（`[diag]` 的 5 支 `aria-expanded` 按鈕
     = 4 payload 行 + bits-ui Select trigger——trigger 帶 `aria-expanded`）。
  2. `pathLen: 0` → `built {messages: 0, compaction: null}`；`result` 被覆蓋成
     空 payload，但 **DOM 停在 4 則狀態**（當時視為「state-DOM desync」；結案後
     確認是紅鵝——DOM dump 拍在 afterEach 之前，見 §2m）。
- 無 console error → `buildLlmContext` 沒 reject（catch 會 `console.error`）。
- builder / policy / converter 純函式、已靜態驗證（fixture 無附件走最簡路徑）。
- **非 reassign、非 in-place mutation**：
  - prototype setter patch（包 `activeMessages`）只抓到我們自己的
    `watchArrayMutations` 寫入（`SET (len=7)` + stack），無其他 SET log；
  - array 外層 logging proxy（set/deleteProperty）：無任何 `[diag] MUTATE`；
  - 全 repo `activeMessages` 寫入點皆顯式方法（delete/load/refresh/slice/create）；
    `conversationsStore` 無 `$effect`/`$derived`；`vitest-browser-svelte` 的
    `cleanup` 只跑 `beforeEach`；`vitest-setup-client.ts` 只 mock fetch。
- → （當時推論）值變化發生在 **state signal 層**（機制見下）；元兇待第五輪
  `watchSignalValue` 指認。**第五輪結案：無元兇**——「值變化」是
  `afterEach` 的合法重置打在還掛著的元件上（見 §2m）。

### Svelte 5 機制（已讀 compiler + runtime 源碼確認，不必重查）

- `$state` class 字段編譯（`svelte/src/compiler/phases/3-transform/client/visitors/ClassBody.js`）：
  own property（field initializer，存 **signal 物件**）+ prototype getter/setter；
  getter = `$.get(this.x)`、setter = `$.set(this.x, v, true)`。
- runtime（`reactivity/sources.js` + `batch.js`）：`$.set` → `internal_set` →
  `batch.capture` → **`source.v = value`**（直接寫 signal 物件的 `v` 屬性，
  繞過 prototype setter）；值經 `proxy()` 包成深 proxy（`should_proxy = true`）。
- effect 追蹤 proxy 的 `length`（讀 `path.length`）→ in-place mutation 會觸發
  重跑（setter 不被呼叫）；值替換走 `source.v = value`。
- `internal_set` 呼叫點（`svelte/src/internal/client` 全搜）：公開 `set()`
  （sources.js:171）、`deriveds.js:227/244`（derived 寫自己的值）、`await.js`/
  `boundary.js`/`each.js:314-315`（block 內部）、`legacy.js:44`（legacy 模式）。
  store 的 signal 理論上只會走 `set()`（= patched setter）或直接
  `source.v = value`。

### TEMP-DIAG 清單（✅ 已全數移除；兩檔搜 `TEMP-DIAG` 應零結果）

| 檔案 | 內容（已移除） |
| ---- | ---- |
| `tests/client/context-inspector.svelte.test.ts` | ① `waitFor` timeout 的 `describeDom()`；② `patchActiveMessagesSetter()` / `unpatchActiveMessagesSetter()`；③ `watchArrayMutations()`；④ `watchSignalValue()`；⑤ `openInspector()` 開頭的 ②③④ 呼叫、`afterEach` 的 `unpatchActiveMessagesSetter()` |
| `src/lib/components/app/dialogs/DialogContextInspector.svelte` | module-scope `instanceCounter` / `instanceId` / `lastPathRef`；effect 開頭 / `.then` / `.catch` 三筆 `[inspector-diag]` `console.log` |

> 移除日期：根因結案同日（見 §2m）。全部診斷皆唯讀 / 打 log，移除後零行為差異；
> 唯一保留的測試改動是 `payloadRowButtons()` 的 selector 修正（非診斷代碼）。

### 結案對照（第五輪輸出 → 結論）

- 第五輪輸出（`SET (len=7)` 僅一筆 = 我們自己的 `watchArrayMutations` 寫入；
  `own property is not a signal`；無 `SIGNAL.v SET`；effect 第二次 `pathLen: 0`）
  當時對照決策樹會走向「signal 物件被換」——**全部錯誤導向**。
- 真正解讀見 §2m：5 支 `aria-expanded` 按鈕（DOM dump 早就印出來了）才是 timeout
  的直接原因；`pathLen 0` 是 `afterEach` 的合法重置打在還掛著的元件上。

### 重跑指令（整支 suite、~40s）

```bash
npx vitest --project=client --run tests/client/context-inspector.svelte.test.ts
npm run check
```

把完整輸出貼回來。10/10 綠 + check 綠 → P2.4 確認、進 P2.5。

## 2m. P2.4 根因與修復（client 測試 10/10 timeout）

### 根因（一行）

`payloadRowButtons()` 用 `[role="dialog"] button[aria-expanded]` 選 payload 列，
但 P2.4 新增的 Advanced 區 bits-ui `Select.Trigger` 也是 dialog 內的
`button[aria-expanded]` → 數到 **5** 支，`openInspector()` 的
`waitFor(() => payloadRowButtons().length === 4)` 永遠不成立 → 5s timeout →
10 支用例全掛在 `openInspector()`。DOM dump 的 `[diag] payload row buttons: 5`
就是答案（第四輪已印出，當時被 pathLen 0 的煙霧彈帶走）。

### 「pathLen 0 重跑」是紅鵝（afterEach 假象）

- 測試在 `openInspector()` 的 `waitFor` 就 throw，**`unmount()` 沒跑到**，
  元件仍掛在 DOM 上。
- vitest 接著跑 `afterEach`：`conversationsStore.activeMessages = []`（合法重置）
  → 還掛著的元件 effect 重跑 → `pathLen: 0` → `buildLlmContext([])` →
  `built {messages: 0, compaction: null}`。
- 這解釋了所有「異常」觀察：timeout DOM dump 在 afterEach **之前**拍 → 仍顯示
  4 則狀態（不是 state-DOM desync）；`built {messages: 0}` log 出現在 FAIL 區塊前
  （afterEach 的 console 仍歸屬該 test）；無 `SET` log（afterEach 先
  `unpatchActiveMessagesSetter()` 才寫，走原始 setter）；`sameRef: false`
  （`[]` 是新陣列）。
- 五層 TEMP-DIAG（setter patch / mutation proxy / signal.v watch）全都在追一個
  不存在的 bug：值變化是測試自己的 teardown，且發生在 patch 解除之後。

### 修復（兩檔，零行為改動）

| 檔案 | 改動 |
| ---- | ---- |
| `tests/client/context-inspector.svelte.test.ts` | ① `payloadRowButtons()` 改 `[role="dialog"] li button[aria-expanded]`（payload 列都在 `<li>` 內；Select trigger 不在——dropped 區 `ul` 無 button，不影響）；② 移除全部 TEMP-DIAG（`describeDom` / `patchActiveMessagesSetter` / `unpatchActiveMessagesSetter` / `watchArrayMutations` / `watchSignalValue` / `openInspector` 開頭三呼叫 / `afterEach` 的 unpatch）；`waitFor` 還原成 `throw new Error('Timed out waiting for element')` |
| `src/lib/components/app/dialogs/DialogContextInspector.svelte` | 移除 TEMP-DIAG（`instanceCounter` / `instanceId` / `lastPathRef` + 3 筆 `[inspector-diag]` log）；保留「refresh 期間舊 result 不閃空白」設計註解（誤刪後已還原） |

> 要點：元件零改動（selector 問題純在測試端）；診斷代碼全移除、兩檔搜
> `TEMP-DIAG` 零結果。bits-ui 的 `DismissibleLayerState`「responsible layer」
> 機制（topmost layer 才處理 outside interaction）已確認：巢狀 AlertDialog /
> Select 互動不會誤關外層 inspector dialog（靜態查 `use-dismissable-layer.svelte.js`
> `isResponsibleLayer` / `getTopMostDismissableLayer`）。

### 風險與下一步

- 6 支 P2.4 新用例是**首次 runtime 執行**（bits-ui Select portal、
  DialogConfirmation、userEvent 互動）——selector 修好後若仍有掛，才是真問題。
- 重跑：整支 suite（10 支）+ `npm run check`。全綠 → P2.4 確認、進 P2.5。

## 2n. P2.4 boundary-select 用例根因與修復（9/10 → 10/10 已確認）

重跑整支 suite 後 9/10 綠，唯一掛的是「moves the kept-from boundary through the
grouped select」——`waitFor` 5s timeout 等 `[role="option"]` 含 `'help me fix the bug'`。

### 根因（一行）

該用例要選的 `'help me fix the bug'` 是 **system head 之後第一則（idx 1）**，而
boundary 候选集在兩端都排除 `index <= headLength`：

- 元件 `boundaryOptions`：`if (index <= headLength) return;`
- store `moveCompactionBoundary`：`if (newIndex <= this.headLengthOf(path))` →
  toast "Nothing to summarize"

語義正確：boundary 是 `firstKeptMessageId`（kept 起點），若放在 head 後首則，
摘要涵蓋區 `path.slice(head, boundary)` = 0 則 → 無意義。故**首則 user 永遠當
不了 boundary**。該 option 從未渲染 → `waitFor` timeout。非 portal / 反應性問題
（同 describe 的 Expand 用例走 portaled AlertDialog 已綠）。

### 修復（單檔，零元件/store 改動）

| 檔案 | 改動 |
| ---- | ---- |
| `tests/client/context-inspector.svelte.test.ts` | ① `buildCompactedFixture()` 回傳加 `assistant`（tool_calls 那則，idx 2）；② 該用例改選**最早合法**的 assistant `tool_calls` 邊界（"Within a turn (assistant)" 組），搜尋文字 `'help me fix the bug'` → `'read_file'`，期望 `moveCompactionBoundary('insp-conv', cmp.id, assistant.id)`；補註解說明「head 後首則不可為 boundary」 |

> 要點：元件與 store 的候选集本就一致（都排除 `index <= headLength`），錯在測試
> 選了一個不存在的 option。改選 assistant 邊界同時驗證了「Within a turn」分組。
> 其餘 9 支（含 4 支 Phase 1）零改動。bits-ui 受控 Select 已確認：點 item →
> `toggleItem` → 設 value box → box setter 觸發 `onValueChange(v)`（`select.svelte`
> 49–53 行），故 spy 必收到 `assistant.id`。

### 風險與下一步

- 重跑：整支 suite（10 支）+ `npm run check`。全綠 → P2.4 確認、進 P2.5。

## 2o. Phase 2 已交付檔案（P2.5，已確認）

| 檔案 | 改動 |
| ---- | ---- |
| `src/lib/components/app/chat/ChatMessages/ChatMessage/ChatMessageCompaction/ChatMessageCompaction.svelte` | 展開區加動作列（04-§1.2）：① [Edit] → 就地 `Textarea`（`summaryText` 預填 = prefix 已剝除）+ [Save]/[Cancel]，Save 走 `chatStore.updateCompactionSummary(message.convId, message.id, text)`（`convId` 直接用 entry 的，不依賴 activeConversation）；② [Re-summarize] → `chatStore.recompactConversationEntry`；③ [Restore all context] → `DialogConfirmation` 確認框（title 同 inspector「Restore the full context?」，description 顯示「3 compacted messages… grows from ~X back to ~Y tokens」，X = `Σ path estimate − Σ dropped 區 estimate`（entry 本身排除）、Y = 全路徑 `estimateTokens` 總和，與 policy 同 estimator；boundary 失效時改 fallback 文案，與 inspector 同源措辭）→ `chatStore.expandCompactionEntry`。`actionsBlocked = contextStatsStore.compacting || chatStore.isLoading` 時三鍵全 disabled（store 的 I7 guard 仍是最後防線）；另 `boundaryValid === false`（同 builder 的 I1/I3 規則：id 不存在或指向 system head）時 Re-summarize 單鍵 disabled（同 inspector；Edit/Restore 照樣可用，store 端 fail-open）。收合/展開、邊界預覽、split 註記等 Phase 1 行為零改動 |
| `tests/client/chat-message-compaction.svelte.test.ts` | 既有 4 支零改動（`buildFixture()` 回傳加 `cmp`，`{ kept }` 解構相容）；新增 `openExpandedEntry()`（展開 cmp 行）/ `findRowButton()` helpers + `afterEach`（`vi.restoreAllMocks` + `activeMessages = []` + `compacting = false`）；新增 6 支（P2.5，chatStore store spy，convId = fixture 的 `'cmp-conv'`）：summary 就地編輯（prefix 剝除預填 → clear+type → Save → `updateCompactionSummary('cmp-conv', cmp.id, text)`）；Cancel（pre 回來、store 未被呼叫）；Re-summarize → `recompactConversationEntry('cmp-conv', cmp.id)`；Restore → 確認框（`[role="alertdialog"]` 含「3 compacted messages」+ tokens 文案）→ `expandCompactionEntry('cmp-conv', cmp.id)`；`compacting=true` 時三鍵全 disabled；boundary 失效（`firstKeptMessageId: 'missing-id'`）時 Re-summarize disabled、Edit/Restore 仍可用 |

> 要點：
> - 無新純邏輯（builder / policy / summarize / store 方法皆 P2.3 既有）→ 無新 unit；UI 層走 client 測試（同 5.6/P2.4 先例）。
> - `DialogConfirmation`（bits-ui AlertDialog）在聊天列 row 內獨立使用（非 dialog 內嵌）——portaled 到 body，同 inspector 的掛法；client 測試環境已驗證可開可關（inspector 先例）。
> - 確認框 token 數是**同步估算**（path 上直接加總，不跑 `buildLlmContext`）——04-§3 明定「純顯示用途、與 policy 同 estimator」；cmp 行是聊天列輕量元件，不為確認框做 async build。
> - icon 全用本機 `@lucide/svelte` v1.46.0 確有者：`Check` / `Pencil` / `RefreshCw`（既有）/ `UnfoldVertical`（同 inspector P2.4 換名後的慣例，避免再踩 `Compress` 缺失的坑，見 §2k）。
> - 故事檔 `ChatMessageCompaction.stories.svelte` 零改動（Expanded story 會自然顯示新動作列；動作只點才觸發）。

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

### 3.11 cmp row 的「Kept from」預覽解析
`ChatMessageCompaction` 用 `conversationsStore.findMessageIndex(firstKeptMessageId)` 對
`activeMessages` 解析邊界訊息（1-based 顯示 `#N`）。cmp 通常只出現在 active 對話的
list 中（branch/regenerate 後的路徑），非 active 對話不渲染 list，故無跨路徑解析問題。
boundary 失效（`-1`）時顯示 amber 警告而非靜默——與 builder 的 fail-open 行為對應。

## 4. 驗證狀態（目前停在這）

- Phase 0：使用者已跑 `npm run check` + 4 支 unit，**全綠**。
- Phase 1 5.1/5.2/5.3：使用者已跑 3 條指令（`npm run check` + 4 支 unit +
  `tests/client/settings-registry-invariants.svelte.test.ts`），**全綠**。
- Phase 1 5.4/5.5：使用者已跑 `npm run check` + 4 支 unit，**全綠**。
  （5.4/5.5 無新增 unit：`DatabaseService` 是 Dexie 層、`compactConversation`
  是 store 協調邏輯，皆不在 unit project 範圍；依 05-§5 驗收標準 5，store 層
  diff 已控制在 `compactConversation` + 兩個 private helper + `compacting` 欄位）
- Phase 1 5.6：使用者已跑 `npm run check` +
  `npx vitest --project=client --run tests/client/chat-message-compaction.svelte.test.ts`（4/4），
  **全綠**。（第一輪 check 抓到 4 個型別錯：test fixture 的 `type` string literal 不能
  指派給 `MessageType` enum——已改 enum 成員，story 檔一併改；陷阱見 §6。）
  5.6 無新增 unit（純 UI 層；grouping 邏輯由 client 測試覆蓋）。
- Phase 1 5.7 第一輪：使用者跑了 `npm run check` +
  `npx vitest --project=unit --run tests/unit/compaction-policy.test.ts`（16/16 綠）+
  `npx vitest --project=client --run tests/client/context-inspector.svelte.test.ts`（3/4）。
  check 抓到 2 型別錯 + 1 warning；client 掛的那支是 dropped 區把 in-effect entry
  算進「Compacted out」（4 則 vs 3 則）。已全數修完（§2f）。
- Phase 1 5.7 重跑：使用者跑了 `npm run check`（0 錯 0 警告）+
  `npx vitest --project=unit --run tests/unit/compaction-policy.test.ts` +
  `npx vitest --project=unit --run tests/unit/context-builder.test.ts` +
  `npx vitest --project=client --run tests/client/context-inspector.svelte.test.ts`（4/4），
  **全綠**。5.7 完成。
- **Phase 1 目前只剩 5.8 手動驗收**（05-§1 Phase 1 ✅ 列；與 Phase 2 並行不阻塞）：
  1. 有 cmp 的對話：送出 payload = inspector 顯示 = devtools 抓包（附件佔位符除外逐欄位一致）。
  2. 手動「Compact now」可產生 cmp（聊天列出現 entry；下一輪 payload 含 summary）。
  3. 無 cmp 對話行為與現行完全一致（context-builder.test.ts 的回归測試保證）。
  > ⚠️ **5.8 項目 1–2 待 P2.4 編譯確認後即可驗收**：P2.4 已在 inspector 提供「Compact now」入口（§2j）；
  > P2.6 再補其餘入口（表單 icon + 快捷鍵 + gauge 列）。項目 3 已由 unit 回歸覆蓋。
- **Phase 2 P2.1 ✅ 完成**：變更見 §2g。
  - 第一輪：使用者跑了 `npm run check` +
    `npx vitest --project=unit --run tests/unit/compaction-policy.test.ts`（18/18 綠）。
    check 抓到 2 型別錯：`CompactionSettings` 在 `compaction-policy.ts` 定義
    （structural pick 決策，§2g），但 barrel `index.ts` 與 test 檔都從
    `./types` import → 已修（barrel 改 `export type { CompactionSettings } from
    './compaction-policy'`；test 改自 `compaction-policy` import）。無行為改動。
  - 重跑：使用者跑了 `npm run check`（0 錯 0 警告）+
    `npx vitest --project=unit --run tests/unit/compaction-policy.test.ts`（18/18 綠），
    **全綠**。P2.1 完成。
- **Phase 2 P2.2 ✅ 完成**：使用者跑了 `npm run check`，確認全綠
  （無新增 unit——P2.2 無新純邏輯，見 §5b P2.2 註；store 層照慣例不 unit 測）。
- **Phase 2 P2.3 第一輪**：使用者跑了 `npm run check`，1 個型別錯：
  `database.service.ts:373` `expandCompactionMessage` 的
  `parent.children.flatMap((childId) => …)` 參數 `childId` implicit any
  （Dexie `.get()` 結果的 `children` 對回調無 contextual typing；本檔既有
  慣例是顯式註解，見 §6）。已修：改 `(childId: string)`，無行為改動。
  （無新增 unit——P2.3 無新純邏輯，DB 層是 Dexie、
  store 協調層照慣例不 unit 測，同 5.4/5.5 先例）
- **Phase 2 P2.3 重跑**：使用者跑了 `npm run check`，**全綠**。P2.3 完成
  （變更見 §2i）。
- **Phase 2 P2.4 第一輪**：使用者跑了 `npm run check`（4 個型別錯）+
  `npx vitest --project=client --run tests/client/context-inspector.svelte.test.ts`
  （suite import 失敗、0 test）。4 錯：`@lucide/svelte` v1.46.0 無 `Compress`
  icon（vitest 的 module graph 因此整 suite 炸掉）+ test 檔 3 個型別錯
  （`trigger` 未收斂 null、2 處 `Element` 無 `disabled`）。已全數修完（§2k）。
- **Phase 2 P2.4 第二輪**：使用者跑了 `npm run check`（**全綠**）+ vitest
  10/10 掛（全在 `openInspector()` 等 4 支 payload row，無 console error）。
  加第一層 TEMP-DIAG（`waitFor` timeout 的 `[diag]` DOM 摘要 + 元件 effect 的
  `[inspector-diag]` console trace）。
- **Phase 2 P2.4 第三輪**：單支重跑。`[inspector-diag]` 顯示 **effect 跑兩次**：
  pathLen 7 → built 4 messages（DOM 有 4 則 + 5 支 `aria-expanded` 按鈕 =
  4 行 + Select trigger），**其後 `activeMessages` 被清成 `[]`** → 重跑
  pathLen 0 → `result` 被 0 messages 覆蓋（DOM 停在 4 則）。加第二層
  TEMP-DIAG（prototype setter patch + `instanceId` counter）。
- **Phase 2 P2.4 第四輪**：單支重跑。`instanceId` 皆 1（無 double mount）；
  setter patch 運作正常（抓到 `watchArrayMutations` 自己的寫入 `SET (len=7)`），
  但 **無其他 SET**（非 reassign）；加第三層 logging proxy 也 **無
  `[diag] MUTATE`**（非 in-place mutation）。查 Svelte runtime `batch.capture`：
  `source.v = value` 直接寫 signal 的 `v`（繞過 setter）。加第四層 TEMP-DIAG
  （signal `v` wrapper `watchSignalValue()` + `sameRef` probe）。
- **Phase 2 P2.4 診斷中**（綜合狀態見 §2l）：待使用者跑
  `npx vitest --project=client --run tests/client/context-inspector.svelte.test.ts -t "lists the compacted payload"`
  （單支、~15s），依 §2l 決策樹對照輸出。全綠前**不移除** TEMP-DIAG；
  全綠後依 §2l 清單移除。注意：P2.4 的 UI（inspector 的「Compact now」入口）
  落地後，Phase 1 的 5.8 手動驗收項目 1–2 可一併做（有 cmp 的對話
  payload = inspector = 抓包；手動 Compact now 可產生 cmp）。
- **Phase 2 P2.4 第五輪 → 結案**：使用者貼回單支輸出——`SET (len=7)` 僅一筆
  （自己的 `watchArrayMutations`）、`own property is not a signal`
  （own property descriptor 為 `undefined`）、無 `SIGNAL.v SET`、無 `MUTATE`、
  effect 第二次 `pathLen: 0`。**回頭看第四輪 DOM dump 早已印出答案**：
  `[diag] payload row buttons: 5` = 4 支 payload 列 + P2.4 新增的 bits-ui
  Select trigger（也是 `button[aria-expanded]`）→ `waitFor(length === 4)`
  永遠不成立 → 5s timeout。`pathLen 0` 是 **afterEach 紅鵝**（測試掛在
  `openInspector()`、`unmount()` 沒跑到，`afterEach` 的 `activeMessages = []`
  在還掛著的元件上重跑 effect）。非 runtime 問題、非反應性 bug。已修：
  selector 改 `[role="dialog"] li button[aria-expanded]`；五層 TEMP-DIAG 全數
  移除（見 §2m）。待使用者重跑整支 suite（10 支）+ `npm run check` 確認。
- **Phase 2 P2.4 第六輪（selector 修復後重跑）**：使用者跑了整支 suite——
  9/10 綠，唯一掛「moves the kept-from boundary through the grouped select」
  （`waitFor` 等 `[role="option"]` 含 `'help me fix the bug'`，5s timeout）。
  根因（§2n）：該 option 是 system head 後第一則（idx 1），被 boundary 候选集
  兩端（元件 `boundaryOptions` + store `moveCompactionBoundary` 的
  `index <= headLength` guard）排除、從未渲染——非 portal / 反應性問題。已修：
  fixture 回傳 `assistant`、用例改選 assistant `tool_calls` 邊界（idx 2，
  "Within a turn" 組）、期望 `moveCompactionBoundary('insp-conv', cmp.id,
  assistant.id)`。
- **Phase 2 P2.4 ✅ 完成並確認**：使用者跑了整支 suite（**10/10 綠**）+
  `npm run check`（**全綠**）。P2.4 兩層測試根因（§2m selector、§2n
  boundary-select）皆結案。Phase 2 現剩 P2.5 / P2.6（§5b）。
- **下一步（P2.5）**：cmp entry 動作（`ChatMessageCompaction.svelte` 展開區
  動作列：[編輯]/[重新摘要]/[還原全部上下文]，皆走 P2.3 的 chatStore 方法、
  進行中 `compacting` disabled；client 測試
  `chat-message-compaction.svelte.test.ts` 擴編。規格見 §5b P2.5）。
- **Phase 2 P2.5 ✅ 完成並確認**：使用者跑 3 條指令全綠——`npm run check` +
  compaction client suite（**10/10**，4 既有 + 6 支 P2.5 新）+ inspector
  client suite（**10/10** 回歸）。Phase 2 現剩 P2.6（§5b）。
- **下一步（P2.6）**：gauge 列（compacting spinner / Compacted 節省列）+
  `ChatFormActions` 第三入口（Eye icon 按鈕）+ `Shift+Ctrl/Cmd+I` 快捷鍵
  （規格見 §5b P2.6）。

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

### 5.4 `DatabaseService.createCompactionMessage()`（database.service.ts）✅
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

### 5.5 `chatStore.compactConversation(convId, { auto })`（stores/chat/index.svelte.ts）✅
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

### 5.6 `ChatMessageCompaction.svelte` + 分派 + grouping ✅
> 交付明細見 §2d。規格要點全數落實：分派 branch、中央細條視覺、收合式
> （Phase 1 只有「展開摘要」）、`contextShowCompactionEntries=false` 整列不顯示、
> grouping 確認（零改動 + 兩個語義 guard）、client 測試、export。
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

### 5.7 Inspector 只讀版 `DialogContextInspector.svelte` ✅（已確認全綠；交付明細見 §2e、第一輪修復見 §2f）
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

## 5b. Phase 2 執行清單（依序做；每完成一個單位請使用者編譯確認）

> 原則同 Phase 1：純邏輯進 `services/context/`（unit 可測）；store 層只做
> 觸發 + 協調；UI 走既有元件慣例。每單位獨立可編譯、可回退。

### P2.1 自動觸發（flow 之間）✅
- `compaction-policy.ts`：新增純函式 `computeCompactionBudget(nCtx, settings)`
  （02-§3.3 公式：`floor(nCtx × (1 − threshold%) − summaryMaxTokens × 1.5)` +
  三個 min 欄位）+ `MIN_SUMMARIZE_TOKENS = 2000` 常數上移到 policy（原在
  chat store）；`CompactionSettings` 結構型別（structural pick，policy 不 import
  settings 型別）。
- `chatStore.compactConversation`：auto gate 加 `contextAutoCompaction` 總開關
  （`auto: true` 時先查；`auto: false` 手動照樣跳過 threshold 與開關）；
  budget 改走 `computeCompactionBudget`。
- `streamChatCompletion` 兩個觸發點（皆 fire-and-forget + catch；
  `compactConversation` 內部 I7 guard 防競態）：
  1. 非 agentic：`onComplete` 最末（pending message 重送之後）；
  2. agentic：`if (agenticResult.handled)` 區塊末（pending steering 之後）——
     **不在** `onFlowComplete` 回調內，因為該時點 `agenticStore.isRunning`
     仍為 true，I7 guard 會擋掉。
- unit：`computeCompactionBudget` 公式 + 欄位透傳。

### P2.2 agentic 迴圈 turn 之間再壓縮（03-§4.4）✅
- `agenticStore` 新 private `compactBetweenTurns({ conversationId, lastPrompt,
  model, sessionMessages, signal })`：
  - gate：`contextAutoCompaction && contextAutoCompactionInLoop`、n_ctx 已知、
    `lastPrompt ≥ nCtx × threshold%`（lastPrompt = 該 turn 的
    `turnTimings.prompt_n ?? Σ estimateApiMessageTokens(sessionMessages)`）。
  - path 解析同 `compactConversation`（active → `activeMessages`；非 active →
    DB + `filterByLeafNodeId`）——flow 可能跑到使用者切離 active 之後。
  - `planCompaction` → null 續跑；`summarizeMessages(plan, model, signal, …)`
    （signal = flow abort，中斷即 fail-open）→ `createCompactionMessage`
    （parent = 路徑最後一則）→ active：`addMessageToActive` +
    `updateCurrentNode`；非 active：DB `updateCurrentNode` +
    `applyConversationUpdate` → `updateConversationTimestamp`。
  - **重建 `sessionMessages`**：`toAgenticMessages(buildLlmContext([...path, cmp],
    { excludeReasoning: false }).messages)` 原地 splice（§3.9：reasoning 不 strip，
    逐 turn strip 仍在 request mapping）。
  - `contextStatsStore.compacting` 包裹；toast；任何失敗（含 abort）回 null、
    舊 sessionMessages 續跑（fail-open）。
  - 呼叫點：loop body 最末（steering check 之後、`turn++` 之前）。
  - 不做 in-loop preEncode（下一 turn 立刻 re-encode 新前綴）。
- 無新純邏輯（policy/builder/summarize 皆既有）→ 無新 unit；store 層照慣例不 unit 測。

### P2.3 expand + chatStore 人工介入動作（DB + store）✅ 完成並確認（變更見 §2i）
- `DatabaseService.expandCompactionMessage(convId, cmpId)`：transaction 內
  子節點 `parent` 改指 `cmp.parent`、`parent.children` 以子節點替換 cmp、
  刪 cmp 列、`conv.currNode === cmp.id` 時回 `cmp.parent`（同 transaction 直接
  update conversations 表）；回新 currNode id。非 COMPACTION 型別 → throw。
- `chatStore` 新方法（皆 I7 guard + active/non-active 雙路徑 mirror）：
  - `updateCompactionSummary(convId, cmpId, plainText)`：content =
    `SUMMARY_CONTENT_PREFIX + ' ' + text`（與建節點同一拼法）。
  - `recompactConversationEntry(convId, cmpId)`：對**同一 summarize 區**（
    `path[head..boundary)`，I2 含舊 cmp）重跑 summary，**更新同一節點**
    content + meta（model / estimatedTokensBefore）；boundary 失效 → toast 回。
  - `expandCompactionEntry(convId, cmpId)`：走新 DB 方法；active conv 同步
    更新 `activeMessages`（照 delete flow 的 mirror 模式）。
  - `moveCompactionBoundary(convId, cmpId, newFirstKeptMessageId)`：
    前移（kept 變長）只改 meta；後移（kept 變短）對擴大後的區強制重摘要
    （02-§4 防靜默遺失）；新邊界必須是路徑上的 user/assistant（I4）。
  - recompact 與後移共用 private `summarizeRegion` helper。
- unit：DB 層是 Dexie、store 協調層不 unit 測（同 5.4/5.5 先例）。

### P2.4 Inspector 編輯 + 動作（04-§2.2 完整版）✅ 完成並確認（client 10/10 + check 全綠；變更見 §2j、第一輪修復見 §2k、診斷結案見 §2l/§2m）
- `DialogContextInspector.svelte`：
  - summary 列「編輯」→ 就地 textarea（prefix 剝除後預填）→ 存檔走
    `updateCompactionSummary` → 重新 buildLlmContext 刷新 WYSIWYG。
  - 「進階」區：斷點選擇器（Select；I4 合法斷點分兩組：回合邊界 user /
    turn 內 assistant）→ `moveCompactionBoundary`；[Compact now]
    （`compactConversation auto:false`）/ [Expand]（確認對話框）/ [重新摘要]。
  - `contextStatsStore.compacting` 時：spinner 列 + 動作全 disabled。
  - 每次動作後重抓 payload（dialog 開啟期間 path 已可被動作改變，Phase 1 的
    「open 時抓一次」前提不再成立）。
- client 測試：`tests/client/context-inspector.svelte.test.ts` 擴編（store spy）。

### P2.5 cmp entry 動作（04-§1.2）✅ 完成並確認（變更見 §2o）
- `ChatMessageCompaction.svelte` 展開區加動作列：[編輯]（就地 textarea）/
  [重新摘要] / [還原全部上下文]（確認對話框）；皆走 P2.3 的 chatStore 方法
  （`message.convId` 可用）。進行中（`compacting`）disabled。
- client 測試：`tests/client/chat-message-compaction.svelte.test.ts` 擴編（4 → 10 支）。

### P2.6 gauge 列 + 第三入口 + 快捷鍵（04-§2.3 / §3）
- `ContextGaugePopup.svelte` body：inspector 連結上方加列——
  `compacting` 時「Compacting context…」（spinner）；有生效 cmp 時
  「Compacted: N messages · ~X tokens saved」（X = `estimatedTokensBefore −`
  當前 payload 估計，同步估算、與 policy 同 estimator）。
- `ChatFormActions.svelte`：add 選單旁 icon 按鈕（Eye）→
  `chatStore.showContextInspector = true`；`chatStore.isLoading` 時 disabled
  （與 gauge 入口一致）；tooltip 帶快捷鍵。
- `use-keyboard-shortcuts.svelte.ts`：`Shift+Ctrl/Cmd+I` → 開 inspector
  （hook 內直接動 store，同 new-chat 模式；loading 中 / 無 active conv 不動作）；
  `KeyboardKey` enum 加 `I_UPPER`（字母序）。
- client 測試：gauge 列 + 入口（看既有 client 測試結構決定掛哪）。

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
- **`DatabaseMessage.type` / `role` 是 enum**（`ChatMessageType = MessageType`、
  `ChatRole = MessageRole`）：test fixture / story 一律用 `MessageType.X` / `MessageRole.X`
  enum 成員，**不要**用 string literal。`{ ... } as DatabaseMessage` 的 cast 會吃掉
  literal 檢查（舊 test 因此帶病生存），但 `Partial<DatabaseMessage>` 型別的參數會
  直接 contextual check 炸掉（5.6 第一輪 check 的 4 個錯就是這個）。
- **API 型別的 `input_audio.format` 是 enum 聯集**：`AudioInputFormat =
  FileTypeAudio.WAV | FileTypeAudio.MP3`，test fixture 要用 `FileTypeAudio.WAV`
  而非 `'wav'` 字面量；`input_video.format` 則是 `'mp4' | 'ogg' | 'auto'` 字面量聯集，
  字串可以。（5.7 第一輪 check 的錯之一）
- **自訂 `waitFor` helper 的 find 要回 `T | null`**：`Array.find()` 回 `undefined`，
  要 `?? null` 才過型別。（5.7 第一輪 check 的錯之一）
- **Dexie `.get()` 結果的 `children` 回調參數要顯式註解**：`database.service.ts`
  內 `parent.children.filter/flatMap((childId) => …)` 的 `childId` 會 implicit any
  ——一律寫 `(childId: string)`（既有 :534/:535/:769 皆如此；P2.3 第一輪 check
  的錯就是漏註解）。
- **`npm run check` 只有型別檢查**：`= svelte-kit sync && svelte-check`，**不含
  eslint**（lint 是獨立的 `npm run lint`，本工作流未跑過）。所以 class 成員順序
  （`perfectionist/sort-classes`，`useExperimentalDependencyDetection: true`）不會被
  check 抓到——`chat/index.svelte.ts` 的 public/private 方法不是嚴格字母序
  （如 `compactConversation` 在 `isStreaming` 之後；compaction 相關方法群聚在
  `compactConversation` 旁、群內字母序）。新增方法照此群聚慣例即可，不必重排既有順序。
  named import 成員順序 lint 也不檢查（`simple-import-sort` 只排 import 語句），
  但新成員照 ASCII 字母序插（uppercase 在前，如 `type CompactionPlan` 在
  `SUMMARY_CONTENT_PREFIX` 前）。
- **store 慣例**：`.svelte.ts` runes（$state/$derived）；`conversationsStore`
  的路徑邏輯（`filterByLeafNodeId`）對新 type 透明，**不要**改 `branching.ts`。
- **不要 import/export 改動**：`conversationsStore` 路徑邏輯、`branching.ts`、
  import/export service、`convertDbMessageToApiChatMessageData`（builder 複用它）。
- **編譯/測試由使用者執行**：每完成一個可獨立驗證的單位（Phase 1 建議
  5.1 / 5.2+5.3 / 5.4+5.5 / 5.6 / 5.7 各一段；Phase 2 每 P2.x 一段）就停下來
  請使用者跑 `npm run check` + 相關 `npm run test:unit -- --run <files>`，
  確認後再继续。
