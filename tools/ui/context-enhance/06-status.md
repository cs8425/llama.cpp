# 06 · 實做狀態（continuity doc）

> 給「下一個繼續實做的 session」讀。規劃細節在 01–05，本檔只記錄
> **做到哪裡、做過的決策、接下來怎麼做**。

> **恢復點（最新）**：**N1–N5 全部完成並確認**（2026-07-22）——context
> enhance 的「下一輪增強」全數落地；剩：Phase 1 的 5.8 手動驗收（見 §4
> 清單）+ Phase 3 可選後續（兩段式 summary / token 校準 / per-conversation
> 覆蓋 / 合併重摘要提示 / summary 獨立 model，05-§1）。
>
> **N5 明細**（§3.19，✅ 已確認）：新設定 `contextSummaryMode`（SELECT：
> `prefix-stable` / `transcript`、預設 prefix-stable）——summary 的 prompt
> 模式開放給 user 選（使用者要求：該給選擇權 + 為後續 summary 選項（如
> 獨立 model / endpoint）預留 config 空間）；`toSummaryMode()` 純函式
> coerce（未知值回 default）；3 個呼叫點（compactConversation /
> summarizeRegion / in-loop compactBetweenTurns）各加 `mode:
> toSummaryMode(config.contextSummaryMode)`；unit `summarize` +2 支。
> 使用者跑 `npm run check` + unit `summarize`（16/16）+ client
> `settings-registry-invariants` 全綠。
>
> 此前（皆已確認）：N4 prefix-stable summary 模式（§3.18：第一輪 13/14 的
> test bug 已修、重跑全綠）；N3 Stop 鍵（§3.15）；N2 keep target 設定
> （§3.14）；N1 summary 上限改 n_ctx × %（§3.13）；§2t 版面輪手動驗證通過
> （PC 頂端區塊版面、長對話 Back to top 平滑回頂、mobile 第一視口 + 無水平
> 溢出）+ §2s 第 3 輪 mobile 寬度修復（`w-full`）一併通過。

## 1. 進度總覽

| 階段 | 狀態 |
| ---- | ---- |
| Phase 0 — 純核心 | ✅ 完成（使用者已確認 `npm run check` + unit 全綠） |
| Phase 1 — 送出路徑接 builder + 手動壓縮 | 🚧 5.1–5.7 ✅ 全部完成並確認（見 §4）；只剩 5.8 手動驗收 |
| Phase 2 — 自動觸發 + 人工介入 + flow 內再壓縮 | ✅ 完成：P2.1 ✅（見 §4）；P2.2 ✅（見 §2h/§4）；P2.3 ✅（見 §2i/§4）；P2.4 ✅（client 10/10 + check 全綠，見 §4/§2j/§2m/§2n）；P2.5 ✅（compaction 10/10 + inspector 10/10 回歸 + check 全綠，見 §4/§2o）；**P2.6 ✅ 完成並確認**（client 8/8 + check 全綠，見 §4/§2p/§2q/§2r） |
| Phase 3 — 可選後續 | ⬜ |
| 設計修正 — threshold 觸發語義解耦（§3.12） | ✅ 完成並確認（使用者 check + unit 26/26 全綠） |
| 下一輪 — 5 項增強（N1 summary 上限 / N2 keep target 設定 / N3 Stop 鍵 / N4 prefix-stable 模式 / N5 summary mode 設定，§5c） | ✅ **N1–N5 全部完成並確認**：N1（§3.13：改 n_ctx × %）；N2（§3.14：threshold 預設 80→70 + `contextKeepTargetPercent`）；N3（§3.15：手動壓縮 Stop 鍵）；N4（§3.18：prefix-stable default + 附件原樣送 + reasoning 跟隨主送出開關；第一輪 test bug 已修、重跑全綠）；N5（§3.19：`contextSummaryMode` SELECT 設定） |
| Context Inspector UI 修復（水平溢出 + header 重疊，§2s/§3.16） | ✅ 完成並確認（第 3 輪 `w-full` mobile 寬度修復已通過手動驗證） |
| Context Inspector 版面：Advanced 整塊上移 + Back to top（§2t/§3.17） | ✅ 完成並確認（自動驗證 check + client 14/14 全綠；手動驗證通過：PC 頂端區塊版面 / 長對話跳頂 / mobile 第一視口 + 無水平溢出） |

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

## 2p. Phase 2 已交付檔案（P2.6，完成並確認；規格見 §5b P2.6 / 04-§2.3 / 04-§3）

| 檔案 | 改動 |
| ---- | ---- |
| `src/lib/services/context/compaction-policy.ts` | 新純函式 `estimateCompactionSavings(path, entry)`：`estimatedTokensBefore −` 當前 payload 同步估算（整條 path 減掉 dropped 區 `path[head..boundary)`、in-effect entry 不計入 dropped 因為它就是送出的 summary；與 builder 同 estimator、同 I3 fail-open 條件）；meta 缺 / `estimatedTokensBefore` 缺 / boundary 失效 / 無淨節省皆回 0（防 NaN 洩到 UI） |
| `src/lib/services/context/index.ts` | barrel 加 `estimateCompactionSavings`（字母序） |
| `src/lib/components/app/chat/ChatForm/ChatFormContextGauge/ContextGaugePopup.svelte` | body 的 inspector 區塊改為「compaction 狀態 + 入口」容器（`flex flex-col gap-1`）：`contextStatsStore.compacting` 時 spinner 列「Compacting context…」（`role="status"`、`Loader2 animate-spin`）；否則生效 cmp（`findLastCompactionEntry` + meta + `estimateCompactionSavings > 0`）時「Compacted: N messages · ~X tokens saved」（N = `summarizedCount`、X = `formatNumber`，與 cmp 行同格式）；inspector 連結原樣（`chatStore.isLoading` disabled 不變）；舊 Phase 1 註解更新；import 加 `Loader2`、`findLastCompactionEntry` / `estimateCompactionSavings`、`contextStatsStore` / `conversationsStore`、`formatNumber` |
| `src/lib/components/app/chat/ChatForm/ChatFormActions/ChatFormActionInspectContext.svelte` | **新**：Eye icon 圓形 ghost 按鈕（照 `ChatFormActionAddButton` 外觀）→ `chatStore.showContextInspector = true`；`blocked = disabled \|\| chatStore.isLoading`（與 gauge 入口同一 gate）；tooltip 文字「Inspect what the LLM sees (Shift+Ctrl/⌘+I)」、disabled 時換「Unavailable while the model is responding」；sr-only label 同 tooltip |
| `src/lib/components/app/chat/ChatForm/ChatFormActions/ChatFormActions.svelte` | 左側 `mr-auto` 容器改為常駐（不再綁 `showAddButton`）：add 按鈕（`{#if showAddButton}`）+ `<ChatFormActionInspectContext {disabled} />` 並列（「add 選單旁」） |
| `src/lib/components/app/chat/index.ts` | export `ChatFormActionInspectContext`（JSDoc 同既有格式，插在 `ChatFormActionAddToolsSubmenu` 後） |
| `src/lib/enums/keyboard.enums.ts` | `I_LOWER = 'i'` / `I_UPPER = 'I'`（字母序插 `ESCAPE` 後、`K_LOWER` 前） |
| `src/lib/hooks/use-keyboard-shortcuts.svelte.ts` | `Shift+Ctrl/Cmd+I`（`I_LOWER \|\| I_UPPER`，照 new-chat 的 hook 內直接動 store 模式）→ `chatStore.showContextInspector = true`；`chatStore.isLoading` 或無 `activeConversation` 時靜默不動作（也不 preventDefault）；import 加 `chatStore` |
| `tests/unit/compaction-policy.test.ts` | +6 用例（`estimateCompactionSavings`：正常 path 的節省值（450−400=50）；I2 舊 cmp 落 dropped 區不計入 payload（500−400=100）；boundary 消失 → 0；boundary 指 system head → 0；無 meta → 0；before < payload clamp 0） |
| `tests/client/context-gauge-compaction.svelte.test.ts` | **新** client suite（8 支）：gauge 列 3 支（desktop viewport + `gaugePopup.open = true` 照 `context-panel-mobile` 模式：compacting spinner 列且無 compacted 列 / 生效 cmp 顯示「Compacted: 3 messages · ~1,794 tokens saved」+ inspector 入口仍在 / 無 cmp 無列）；form 入口 2 支（渲染 `ChatFormActions`、Eye 按鈕（sr-only name）click → `showContextInspector = true`；`isLoading` mock true 時 disabled——disabled 時 sr-only 文字切換，故用 disabled 文案查 role）；快捷鍵 3 支（直接呼叫 `useKeyboardShortcuts({})` 回傳的 `handleKeydown` + 合成 `KeyboardEvent`：active conv 時開 inspector + preventDefault；無 active conv 不動作；loading 中不動作） |

> 要點：
> - 「快捷鍵說明表登記」：本 app 無獨立快捷鍵說明 dialog（既有快捷鍵只在
>   tooltip / `KeyboardShortcutInfo` 顯示），故登記 = Eye 按鈕 tooltip 帶快捷鍵
>   + hook / barrel 的 JSDoc 註記。
> - gauge 列的 saved 數字是**同步估算**（04-§3 明定「純顯示用途」）：不跑
>   async `buildLlmContext`；估算式與 builder 的 payload 組成一緻
>   （head + summary + kept），I2 舊 cmp 落 dropped 區時也正確。
> - Eye 按鈕不受 `showAddButton` 控制（訊息編輯 form 隱藏 add 時 inspector 仍可開）；
>   但 `ChatFormActions` 本身只在 chat form 出現，無跨場景問題。
> - 快捷鍵 hook 在 3 處掛載（+layout / ChatScreen / SidebarNavigation）——同 new-chat
>   先例，`showContextInspector = true` 冪等，多掛載無副作用。
> - 無 store 改動（`showContextInspector` / `compacting` 皆既有）；UI 層走 client
>   測試、純函式走 unit（同 P2.4/P2.5 先例）。
> - Storybook：P2.6 無新 story（gauge 列狀態由 client 測試覆蓋；inspector story
>   三態仍留待後續，同 5.7 的偏差記錄）。

## 2q. P2.6 第一輪編譯/測試確認的修復（重跑待確認）

第一輪 `npm run check`（9 錯）+ client suite（5/8 掛）：

- **9 型別錯（全在 `context-gauge-compaction.svelte.test.ts` gauge 段）**：
  測試用了 testing-library 風格 API——`screen.queryByText(...)` /
  `screen.findByText(...)` / `row.parentElement` / `getByText((content) => ...)`。
  但 `vitest-browser-svelte` 的 `render()` 回傳 `RenderResult`（extends
  `vitest/browser` 的 `LocatorSelectors`），**只有** `getByRole` /
  `getByText` / `getByLabelText` / `getByPlaceholder` / `getByTitle` /
  `getByTestId`，且回 `Locator`、`getByText` 只收 `string | RegExp`
  （不收函式回呼）——`queryByText` / `findByText` / `Locator.parentElement`
  全都不存在。
- **5 支 runtime 掛**：
  - 3 支 gauge 列（`screen.queryByText is not a function` /
    `screen.findByText is not a function`）——同上述 API 缺失。
  - 2 支 form 入口（`Context "Tooltip.Provider" not found`）——
    `ChatFormActions` 獨立渲染時，`ChatFormActionAddDropdown` /
    `ChatFormActionInspectContext` 的 bits-ui `Tooltip.Root` 需要
    `Tooltip.Provider` 祖先（app 裡由 `+layout.svelte` 提供、獨立渲染沒有）。

全數已修（測試端 + 1 個新 wrapper，元件/store 零改動）：

| 檔案 | 問題 | 修復 |
| ---- | ---- | ---- |
| `tests/client/context-gauge-compaction.svelte.test.ts` | gauge 3 支用不存在的 `queryByText`/`findByText`/`Locator.parentElement` | 改走 `document.querySelector` + 新增 `waitFor` / `bodyText()` helper（同 `context-inspector` 慣例）：spinner 列找 `span` 的 `parentElement` 再 `querySelector('.animate-spin')`；compacted 列找「無子元素且含 `tokens saved`」的 `div`（`textContent.trim()` 對 `'Compacted: 3 messages · ~1,794 tokens saved'`）；「不存在」斷言改 `bodyText()` 不含該文字 |
| （同檔）form 2 支 | `ChatFormActions` 獨立渲染缺 `Tooltip.Provider` → `ChatFormActionAddDropdown` 的 `Tooltip.Root` 炸 | 改渲染新 `ChatFormActionsWrapper`（`Tooltip.Provider` 包 `ChatFormActions`，同 `ChatFormTestWrapper` 先例）；import 改本地 wrapper（字母序置最前） |
| （同檔）form 2 支 latent | `expect(eyeButton).toBeVisible()` / `.toBeDisabled()` 直接把 `Locator` 傳 `expect()`——`@vitest/browser` 只有 `expect.element()` 會解析 locator（`expect-element.js` 的 `expect.element = bn`），直接傳不會 resolve（原本被 render 炸掉蓋住、沒跑到） | 改 `await expect.element(eyeButton).toBeVisible()` / `.toBeDisabled()`（同該檔 gauge 段既有寫法） |
| `tests/client/components/ChatFormActionsWrapper.svelte` | **新**：form 入口測試缺 provider 的 wrapper | `Tooltip.Provider` 包 `ChatFormActions`、`disabled` prop 透傳（照 `ChatFormTestWrapper` 格式） |

> 要點：
> - 元件與 store **零改動**——全在測試端（API 用錯 + 缺 provider wrapper）。
> - `estimateCompactionSavings` 的 1,794 已對 `estimateTokens`（`ceil(len/4)`）
>   逐則核過：payload = system 4 + cmp 33 + kept 5 + final 4 = 46、
>   saved = 1840 − 46 = 1794（cmp content = `SUMMARY_CONTENT_PREFIX`(56 字) +
>   74 字 = 130 字 → `ceil(130/4)` = 33）。
> - `Tooltip.Provider` 是全 app 唯一的 bits-ui top-level provider
>   （`+layout.svelte` 只包它）；`ChatFormActions` 渲染樹內的
>   `DropdownMenu` / `Drawer` / `Collapsible` / `Checkbox` / `ModelsSelector`
>   皆不需其他 provider（已查 bits-ui 源：只有 `Tooltip` 有 `ProviderContext`）。
> - 快捷鍵 3 支（原本就綠）零改動。

### 重跑指令（~40s）

```bash
npm run check
npx vitest --project=client --run tests/client/context-gauge-compaction.svelte.test.ts
# 回歸
npx vitest --project=client --run tests/client/context-panel-mobile.svelte.test.ts
npx vitest --project=client --run tests/client/context-inspector.svelte.test.ts
npx vitest --project=unit --run tests/unit/compaction-policy.test.ts
```

## 2r. P2.6 第二輪重跑剩 2 支 strict mode violation 的修復（重跑已確認全綠、8/8）

第二輪重跑 8 支掛 2 支（6 綠：gauge 列 3 + 快捷鍵 3）。兩支都是
`getByRole('button', { name: … })` 的 strict mode violation——同一 accessible
name 命中 **2 個 button**：

1. 外層：bits-ui `Tooltip.Trigger` 自渲染的 `<button data-slot="tooltip-trigger">`
   （accessible name 由內容計算，等於內層 sr-only 文字）
2. 內層：真正的 shadcn `Button`（`<button data-slot="button">`，`onclick` 與
   `disabled` 都在这）

這是 **app 既有慣例**（`ChatFormActionAddButton` / `ChatFormActionRecord` 同樣是
`Tooltip.Trigger` 包 `Button` 的雙 button 結構），非 P2.6 引入——之前沒測試用
role 查這些按鈕所以沒浮出。

### 修復（單檔，元件/store 零改動）

| 檔案 | 問題 | 修復 |
| ---- | ---- | ---- |
| `tests/client/context-gauge-compaction.svelte.test.ts` | form 入口 2 支的 `getByRole('button', { name: /Inspect what the LLM sees/ })` / `{ name: /Unavailable while the model is responding/ }` 各命中 2 個嵌套 button | 各加 `.last()` 取內層 `Button`（document order 上 descendant 恆在 ancestor 之後，page 上只有一個 Eye 按鈕）；補註解說明雙 button 來源 |

> 要點：
> - `.last()`（= `nth(-1)`）是 `Locator` 公開 API；不選 `.locator('[data-slot="button"]')`
>   因 `Locator.locator()` 是 `protected`（`npm run check` 會炸，已查
>   `@vitest/browser` 的 `locators.d.ts`）。
> - `toBeDisabled()` 斷的是內層——第二輪錯誤輸出已印出兩者 attribute 對照：
>   `disabled` 只在內層 `Button`，外層 trigger 不帶。
> - `userEvent.click` 也打內層（`onclick` 在內層）。
> - 不改元件：雙 button 是 Add/Mic 同款既有結構，只改一個會造成同列按鈕不一致；
>   若要根治 trigger 的 button 外殼屬獨立 a11y 工單，不在 P2.6 範圍。

### 重跑（已確認全綠）

上述 5 條指令由使用者全數跑過、**全綠**：`npm run check` + unit
`compaction-policy` + client `context-gauge-compaction`（**8/8**，含上述修復的
2 支 form 入口）+ 回歸 `context-panel-mobile` / `context-inspector`。
**P2.6 確認、Phase 2 完成**（剩 Phase 1 的 5.8 手動驗收 + Phase 3 可選後續）。

## 2s. Context Inspector UI 修復：水平溢出 + header 重疊（第 1–3 輪皆已確認）

### 症狀（使用者實測回報）
1. **水平溢出**：收合（未點擊）狀態下，長訊息（tool result 可達數萬字元）的
   單行預覽把**整個 dialog** 撐出超長水平 scrollbar；列文字硬切在 dialog
   右緣、無 ellipsis。
2. **header 重疊**：垂直捲動時 body 內容從 sticky 標題/描述背後透出
   （共用 `dialog-header.svelte` 是 `bg-background md:bg-transparent`）。

### 根因
- dialog content 是 `display: grid` + `overflow-y-auto`（CSS 規定此時
  `overflow-x` compute 成 `auto`）。收合列是 `white-space: nowrap` 單行；
  該行的 min-content 經 grid item / flex-column item 的 automatic minimum
  size（`min-width: auto`）一層層往上撐 → grid auto column 寬於 dialog →
  水平 scroll。
- `max-w-2xl`（42rem）壓在 `ul` 上 **PC 有效**（42rem < dialog 內寬 720px，
  且 `max-width` 同時夾住該元素的 min-content 貢獻）；**mobile 無效**：
  672px > 螢幕寬，且 `max-width: 100%` 這種百分比在 intrinsic sizing 階段
  解析不到（父層寬度正在被計算）→ 正解是 `min-w-0` 把 automatic minimum
  歸零。
- 重疊是獨立問題：sticky header 透明背景，與水平溢出無關。

### 變更（單檔 `DialogContextInspector.svelte`，邏輯零改動）
1. **C 資料層**：`PREVIEW_MAX_LENGTH = 150` + `clampPreview()`；
   `apiPreviewText()`（payload 列）/ `dbPreviewText()`（Compacted out 列）
   超 150 字元截斷 + `…`。全文不受影響（展開列 `fullText()`、Copy JSON）。
2. **A dialog 層**：`Dialog.Content` 加 `overflow-x-hidden`（與 base
   `overflow-y-auto` 不衝突）。
3. **header 結構（使用者指定，見 §3.16）**：`Dialog.Header` 只留 X
   （透明、sticky 恆駐右上角）；`Dialog.Title` + `Dialog.Description` 移到
   `Dialog.Content` 最前面（body 頂部、隨捲動）。a11y 不受影響（bits-ui
   走 id 接 `aria-labelledby` / `aria-describedby`）。
4. **列表寬度**：payload `ul` 與 Compacted out `ul` 皆 `max-w-2xl`
   （= `var(--container-2xl)` 42rem；PC 視覺上限、兩列表寬度一致）。
5. **第 2 輪 mobile 修復**：`min-w-0` 加在 grid item
   （`div.flex.min-w-0.flex-col.gap-4`）、兩支 `ul`、兩組 `li`——
   automatic minimum size 歸零，列表在任何 viewport 都不再把 dialog 撐寬；
   mobile 時 `ul` 拉滿 dialog 內寬（`max-w-2xl` 變 non-binding）。
6. **第 3 輪 mobile 寬度修復（本輪）**：`Dialog.Content` 加 `w-full`
   （md 以下生效；md+ 由 base 的 `md:w-auto` 勝出、PC 行為不變）。
   根因：dialog 是 `fixed + width: auto`（shrink-to-fit），而 fixed 元素的
   可用空間 = 視口寬 − left offset（50%）= **50vw**；第 2 輪 `min-w-0`
   把 min-content 歸零後，shrink-to-fit = min(max(min-content, 50vw),
   max-content) 塌到 50vw（375px 手機 → ~187px，與實測相符）。PC 此前
   「正常」也是 50vw（桌面 ≈ 720–768px，接近預期寬度）。`w-full` 給明確
   寬度（100vw，再被 `max-w-full` / `sm:max-w-2xl` 夾住）。

### 驗證狀態
- **第 1 輪（變更 1–4）✅ 使用者已確認**：`npm run check` + client
  `context-inspector`（**10/10**）全綠；實測 PC 正常、mobile 超寬。
- **第 2 輪（變更 5）✅ 使用者已確認**：`npm run check` + client 全綠；
  實測 mobile 不再超出，**但 dialog 變很窄（~50vw）難以閱讀**（根因見
  變更 6）。
- **第 3 輪（變更 6）✅ 使用者已確認**（2026-07-22，與 §2t 手動驗證一併驗）：
  1. `npm run check`
  2. `npx vitest --project=client --run tests/client/context-inspector.svelte.test.ts`
  3. 手動 mobile：dialog **滿寬**（375px 手機 = 全螢幕寬）、列表 100% 內寬、
     長列 ellipsis 正常、無水平 scroll、可讀。
  4. 手動 PC 回歸：不變（md+ 由 `md:w-auto` 勝出、~50vw 且被 48rem 夾住）。
  → 全部通過，§2s 完成。

### 若第 3 輪 mobile 仍 NG
檢查 devtools 的 dialog computed width（應為 100vw / 被 max-w 夾住）；若
shrink-to-fit 異常仍在，改明確寫 `w-[min(100vw,42rem)]`。

## 2t. Context Inspector 版面：Advanced 整塊上移 + 跳回頂端（使用者指定，已實做並確認）

### 使用者要求
- 手動壓縮等動作在 dialog 最底部，長 payload 列要捲到底才碰得到主要動作 →
  **Advanced 整塊上移**（不是只搬 Compact 按鈕），靠近「已使用 ctx」
  （Estimated send / % of n_ctx 區塊）。
- 最底下加**快速跳回頂端**按鈕。

### 變更（2 檔，邏輯零改動）

| 檔案 | 改動 |
| ---- | ---- |
| `DialogContextInspector.svelte` | ① Advanced 整塊（heading + boundary `Select` + 動作列 [Compact now]/[Expand]/[Re-summarize]，compacting → [Stop]）**純平移**到紅警告 / compacting 狀態列**之後**、「Actual payload」**之前**（其餘區塊相對順序不變）；② 紅 boundary 失效警告條**移除**內含的 [Compact now] 按鈕（頂端區塊是唯一入口，警告文字保留、`flex flex-1` 包裝層簡化為 `span`）；③ 新增 `contentEl = $state<HTMLDivElement \| null>` + `Dialog.Content` `bind:ref`（shadcn 包裝元件的 `ref` 本來就是 `$bindable`，bits-ui ref 型別 = `HTMLAttributes<HTMLDivElement>['ref']`，型別安全）；④ 新增 `scrollToTop()`（`contentEl?.scrollTo({ top: 0, behavior: 'smooth' })`）+ 最底部置中 outline [Back to top] 按鈕（`ArrowUpToLine`，本機 lucide v1.46.0 有），只在 result 分支渲染；⑤ JSDoc 補新版面說明 |
| `tests/client/context-inspector.svelte.test.ts` | 新增 describe（3 支）：全 dialog 只有一個「Compact now」且位於「Actual payload」h3 **之前**（`compareDocumentPosition` DOM 順序）；boundary 失效警告條為純文字（無 button）且全 dialog 只有一個 Compact；Back to top 存在、點擊後 content `scrollTop` 回到 0（測試內把 content 限高 200px 製造 overflow，smooth scroll 用 `waitFor` 等 settle） |

### 行為不變項
- store 方法 / I7 guard / `actionsBlocked` / `refreshTick` 全數不動；
  compacting 仍是「動作列變 [Stop] + 狀態列」（現在位於頂端）。
- 既有 10 支 client 用例皆位置無關（文字搜尋按鈕）→ 預期照綠（含
  compacting 用例：Stop 存在、Compact/Expand/Re-summarize 為 null）。
- 無純邏輯變更 → 無新 unit。

### 驗證狀態
- 第一輪（使用者跑）：client `context-inspector` **13/14**——唯一掛
  「Back to top scrolls the dialog content back to the top」
  （`expect(content.scrollTop).toBeGreaterThan(0)` 實得 0）。根因：browser
  測試環境用 `vitest-browser-svelte` 獨派掛載元件，app 的 Tailwind CSS 未載入
  （只由 `src/routes/+layout.svelte` import `app.css`）→ `Dialog.Content` 的
  `overflow-y-auto` class 無效、元素非 scroll container、`scrollTop` 永遠 0
  （非元件 bug；production 有 class）。**測試端修復**：明確設
  `content.style.overflowY = 'auto'`（mirror production class）+ 限高
  200px → 80px（不依賴內容高度估算）；元件零改動。
- 第二輪（使用者跑）：`npm run check` +
  `npx vitest --project=client --run tests/client/context-inspector.svelte.test.ts`
  （**14/14**）**全綠** → 自動驗證完成。
- ✅ 使用者手動驗證已通過（2026-07-22）：
  1. PC：inspector 開框即見 Advanced 區塊（ctx 條正下方）：boundary select +
     Compact/Expand/Re-summarize；payload 列在下方；最底部 Back to top。
  2. 長對話捲到底 → Back to top → 平滑回頂。
  3. Mobile：頂端區較高（title + ctx + Advanced ≈ 300px）、payload 在
     第一視口之下、跳頂可用；**無水平溢出**（§2s 第 3 輪 `w-full` 修復回歸確認，可一併驗）。
  → 全部通過，§2t 完成。

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

### 3.12 threshold 語義修正：觸發點與 keep target 解耦
**背景**：使用者實測——auto 設 1%、ctx 到 3%（5,229 / 262,144 tokens）無任何反應；
手動 Compact now → `No range to compact`。對照代碼：實做與 02-§3.3 舊公式
`keepBudget = floor(n_ctx × (1 − threshold%) − summaryReserve)` 完全一致
（**非實做 bug**），但公式本身把觸發點與保留目標**反相耦合**：threshold 越低
→ keep budget 越大 → 可 summarize 區越小。1% 門檻 = 保留 99% n_ctx → 要
ctx > ~99.2% n_ctx（keep budget + minSummarizeTokens）才可能產生 plan，
自動壓縮（含 in-loop）等於停用——與 threshold 的慣例語義（「ctx 到這個點
觸發壓縮」）完全相反。使用者確認要改成慣例語義。

**修正**（`computeCompactionBudget`，`services/context/compaction-policy.ts`）：
- keep target 固定 **50% n_ctx**（新常數 `KEEP_TARGET_FRACTION = 0.5`）−
  summary reserve（1.5 × summaryMaxTokens），下限 **10% n_ctx**
  （`KEEP_BUDGET_FLOOR_FRACTION = 0.1`，防小模型負 budget）。
- `CompactionSettings` 移除 `contextCompactionThreshold`（budget 不再讀它；
  兩處 store 呼叫端傳整包 `config` 變數，structural typing 不受影響）。
- threshold gate（`stores/chat/index.svelte.ts` auto 門檻檢查、
  `stores/agentic/index.svelte.ts` `compactBetweenTurns`）**本就是純觸發，零改動**——
  現在 threshold 的語義就是「ctx 到這個 % 才檢查」。
- unit：`compaction-policy.test.ts` budget 段 2→4 支（50% 公式 / 與 threshold
  無關 / 10% floor / min 透傳）。
- 文件：02-§3.3 公式 + 解耦說明、02-§6 語義註、04-§4 設定表描述。

**行為變更**：
- 低 threshold（1%）：「1% 開始檢查」+ ctx 長過 ~50% n_ctx 後才有非空
  summarize 區 → 真正開始壓縮（舊公式：~99.2% 才動）。
- 預設 80%：觸發點不變；keep 從 20% n_ctx − reserve 變 50% n_ctx − reserve
  → 同一次壓縮保留得更多（壓得較溫和），但觸發後行為可預期。
- 任何 threshold：壓縮後 payload ≈ ≤ 50% n_ctx + summary（+ system head），
  與 threshold 數值無關。

### 3.13 N1 設計變更：summary 上限 = n_ctx × %（使用者要求，完成並確認）

**背景**：原 N1 規劃是把固定上限 `contextSummaryMaxTokens` 4096 → 65536。
使用者指出固定數字不對：上限應**跟著 LLM 的 ctx 大小走**——例如 256k 的
70% ≈ 180k、128k 的 70% ≈ 90k，不該固定死。

**實做**：
- 設定：`contextSummaryMaxTokens`（INPUT 128–4096、預設 1024）**移除**，改
  新 key `contextSummaryMaxTokensPercent`（INPUT **10–90**、預設 **70**）
  （`settings-keys.constants.ts` + `settings.constants.ts` registry；舊 key 不
  migration、舊值丟棄、回預設 70）。
- `compaction-policy.ts`：新純函式 `computeSummaryMaxTokens(nCtx, percent) =
  max(1, floor(nCtx × percent / 100))`；`CompactionSettings` 欄位改名為
  `contextSummaryMaxTokensPercent`；`computeCompactionBudget` 的
  `summaryReserve` 改 `computeSummaryMaxTokens(nCtx, …) × 1.5`（公式結構不變）。
- 3 個 summary 呼叫點改傳 derived 值（三處 nCtx 皆已在 scope）：
  `chatStore.compactConversation`、`chatStore.summarizeRegion`（recompact /
  斷點後移共用；簽名加 `convId`，nCtx 未知 → `undefined` →
  `summarizeMessages` 內建 1024 fallback）、`agenticStore.compactBetweenTurns`。
- `summarize.ts` 零改動（`maxTokens` 本來就透傳）。
- unit：新 `computeSummaryMaxTokens` 2 支（128k/256k @70% = 91750/183500、
  floor 且永不 0）+ budget 4→6 支（50% 公式 / 與 threshold 無關 / reserve
  壓過 floor / **大模型 @70% 落 10% floor** = 13107）。
- 文件：02-§3.3/§4.2、04-§4、05-§1、本檔 §5c。

**Budget 連動（行為變更）**：預設 70% cap 時 `summaryReserve = 105% n_ctx`
> 50% target → `keepBudgetTokens` **恆落 10% n_ctx floor**（小 cap 例如 10%
時 50% target 公式仍有效：keep = 50% − 15% = 35%）。最壞情況安全：10%
kept + 70% summary cap + 20% system headroom < n_ctx ✓。意義：壓縮後只留
~10% n_ctx 的近期上下文——比舊 1024 cap（keep ≈ 50% − 1536）更激進。使用者
想留更多可調低 percent（20% → keep 20%）；N2 的 keep target 在 percent ≥ 33%
時會被 floor 蓋過（target 要生效需 percent < target/1.5）。

### 3.14 threshold 預設 80→70 + N2 `contextKeepTargetPercent`（使用者要求，完成並確認）

**背景**：① 使用者要求 `contextCompactionThreshold` 預設值改 **70**（原 80）；
② 依 §5c N2 把固定 50% 的 keep target（`KEEP_TARGET_FRACTION`）提出來給
user 自訂。

**實做**：
- `settings.constants.ts`：threshold 條目 `defaultValue: 80` → `70`；同條目
  help 順手修正（舊句「The remainder is the keep budget」是 §3.12 解耦前的
  舊語義，現改「Only decides when the check runs; … set by the keep target
  and the summary cap」）；新條目 `contextKeepTargetPercent`（INPUT 10–90、
  `isPositiveInteger`、預設 `50`、label「Keep target (% of n_ctx)」，General
  section 放在 `contextKeepMinMessages` 後）。
- `settings-keys.constants.ts`：新 key `CONTEXT_KEEP_TARGET_PERCENT`
  （字母序在 `CONTEXT_KEEP_MIN_USER_TURNS` 後）。
- `compaction-policy.ts`：`CompactionSettings` 加 `contextKeepTargetPercent`
  （字母序）；`KEEP_TARGET_FRACTION` 常數移除；`computeCompactionBudget`
  改 `Math.floor((nCtx × settings.contextKeepTargetPercent) / 100) −
  summaryReserve`（預設 50 時與舊 `nCtx × 0.5` 逐位元一致）；
  `KEEP_BUDGET_FLOOR_FRACTION`（10% floor）不動。
- 兩處 store 呼叫端（`chatStore.compactConversation`、
  `agenticStore.compactBetweenTurns`）傳整包 `config` → **零改動**
  （`SettingsConfigType` 由 registry 派生，自動含新 key）。
- unit（`tests/unit/compaction-policy.test.ts`）：base fixture 加
  `contextKeepTargetPercent: 50`；新增「uses the configured keep target
  percent」一支（30% target：20000 × 0.3 = 6000 − 2100 reserve）。原
  budget 4 支（50% 公式 / 與 threshold 無關 / reserve 壓過 floor / 大模型
  @70% 落 floor）不変。

**行為變更**：
- threshold 預設 70：自動壓縮檢查提早 10 個點觸發（keep budget 不受影響，
  觸發與 keep 早已解耦，§3.12）。
- keep target 預設 50：與舊固定 50% 常數行為**完全一致**（逐位元）；
  user 調高（例如 70）可保留更多近期上下文——但受 §3.13 的 floor 交互
  限制（summary percent ≥ 33% 時 keep 恆落 10% floor，target 只在小 cap
  時生效）。
- 既有 user 的 localStorage 值不受影響（只改 registry 預設；舊值保留，
  新 key 首次落預設 50）。

**確認**：使用者跑 `npm run check` + unit `compaction-policy`
（**30/30**：原 29 + 新 1）+ client `settings-registry-invariants`，全綠。

### 3.15 N3 手動壓縮 [Stop] 鍵（完成並確認）

**背景**：`compacting` 期間（summary 呼叫在跑）UI 全部 disabled、只能等
（04-§2.2 舊行為）。本項讓 user 可中斷手動壓縮的 summary 呼叫。

**實做**：
- `summarize.ts`：`summarizeMessages` 在 `signal?.aborted` 時丟真正的
  `AbortError`（DOMException）。動機：`ChatService.sendMessage` 會吞掉
  fetch 的 AbortError（return `undefined`），不補這層會降級成
  「empty response」，store 無法區分「已停止」vs「失敗」。
- `chat/index.svelte.ts`：新 private 欄位 `compactionAbortController:
  AbortController | null`（非 reactive；UI 只看 `contextStatsStore.compacting`）。
  三處手動摘要路徑（`compactConversation` / `recompactConversationEntry` /
  `moveCompactionBoundary` 後移分支）都在 `compacting = true` 後建
  controller、signal 傳 `summarizeMessages`（後兩者經 `summarizeRegion` 新增
  的 `signal?` 參數轉傳）；catch 用 `isAbortError` 分流（abort →
  `toast.info('Compaction stopped')`，否則維持原 error toast）；finally 清
  controller + `compacting = false`。fail-open 語義不變：不建 cmp、
  context 完整保留。
- 新 public `stopCompaction()`：abort 該 controller（無 in-flight 時 no-op）。
- UI：`compacting === true` 時，inspector 的 Advanced 動作列
  （[Compact now]/[Expand]/[Re-summarize]）與 fail-open 警告列的 [Compact now]
  換成單一 [Stop]（destructive、lucide `Square` icon）；cmp row 展開區動作列
  （Edit / Re-summarize / Restore all context）同換 [Stop]；皆呼叫
  `stopCompaction()`。`compacting` 在 store finally 重置後 UI 自動翻回原
  按鈕；Stop 不觸發 payload refresh（fail-open 什麼都沒改）。
- **未動**（照 §5c 範圍）：in-loop `compactBetweenTurns` 沿用 flow abort
  signal；gauge 的「Compacting context…」列；`triggerPreEncode`（自管
  preEncodeAbortController；summary 完成後才跑，Stop 對它是 no-op）。
- 測試：unit `summarize.test.ts` +2（aborted signal → reject `AbortError`；
  無 signal 的 empty response 維持原 throw）；client `context-inspector`：
  原「compacting 時全 disabled」用例改「Stop 取代動作列、Edit summary /
  boundary select 仍 disabled」+ 新點 Stop → spy `stopCompaction`；
  client `chat-message-compaction` 同模式 2 支。

**確認**：使用者跑 4 條指令全綠：`npm run check` +
`npx vitest --project=unit --run tests/unit/summarize.test.ts` +
`npx vitest --project=client --run tests/client/context-inspector.svelte.test.ts`
+ `npx vitest --project=client --run tests/client/chat-message-compaction.svelte.test.ts`。

### 3.16 Inspector header 結構變更（使用者指定，§2s）
04-§2.2 原設計標題/描述在 sticky header 內。實做改為：**header 只留 X**
（透明背景、sticky），`Dialog.Title` + `Dialog.Description` 移到 body 最前面
（隨捲動）。動因：inspector 是會垂直捲動的高 dialog，共用 header 的
`md:bg-transparent` 讓捲動內容從標題背後透出重疊；不透明背景（E1）可解但
使用者偏好只留 X。a11y 無影響（bits-ui 的 Title/Description 走 id 接
`aria-labelledby` / `aria-describedby`，與 DOM 位置無關）。

### 3.17 Advanced 整塊上移 + Back to top（使用者指定，§2t）
04-§2.2 原設計把動作列放在 dialog 最底部（Advanced 區）。使用者回饋：長
payload 列時主要動作（手動壓縮）離第一視口太遠 → Advanced **整塊**（boundary
select + Compact/Expand/Re-summarize）上移到「Estimated send / % of n_ctx」
附近，最底部加 Back to top。實做為純平移（其餘區塊相對順序不變）+ 警告條
重複 Compact 按鈕移除 + `Dialog.Content` `bind:ref`（元件本來就支援
`$bindable` ref）+ `scrollTo({ top: 0, behavior: 'smooth' })`。**不採用**
sticky 方案（控制區恆駐頂端）：§2s 第 1–3 輪皆在處理 sticky 重疊 / 寬度
回歸，且 mobile 上 ~300px 的 sticky 區塊會吃掉大半視口。

### 3.18 N4 prefix-stable summary 模式（✅ 完成並確認；第一輪 test bug 已修、重跑全綠）

**背景**：v1 transcript 模式把被壓訊息拍平成一段文字、指令當 system——
同一 summarize 區的重複摘要（Re-summarize、同區再壓）前綴完全不同，
KV cache 無法重用；且模型看不到原始訊息結構。N4 改送
「[system head, 被壓訊息原結構, 指令（末尾 user)]」：前綴恆定、只有最後
一則指令變（03-§2.1）。

**決策（使用者 2026-07-22 定，D1/D2 皆 A）**：
- **D1 附件原樣送**（不佔位符）：前綴與主對話 payload byte 一致 → summary
  呼叫可直接重用上一個主 turn / preEncode 的熱 KV cache；摘要忠度最高。
  非 vision 模型由 `sendMessage` 既有的 vision filter 自動剝除 image parts
  （與主送出路徑同行為，無新失效模式）。toSummarize 區剛在主對話全量送出
  過（auto 觸發在 threshold），大小安全已證明。
- **D2 `reasoning_content` 跟隨 `excludeReasoningFromContext` 開關**：summary
  呼叫把同一開關傳進 `sendMessage`，兩種設定下前綴都與主 payload 一致；
  開關關時 summarizer 還能看到 assistant 推理。

**實做**：
- `types.ts`：`CompactionPlan` 加 `systemHead: DatabaseMessage | null`
  （path 的 system head；null = 無 system prompt）。`summarizeMessages`
  簽名不變，head 由 plan 帶。
- `compaction-policy.ts`：`planCompaction` 回傳值加
  `systemHead: systemStart === 1 ? path[0] : null`。
- `summarize.ts`：新 `SummaryMode = 'prefix-stable' | 'transcript'`；
  `SummarizeOptions` 加 `mode?`（**default = `'prefix-stable'`**）與
  `excludeReasoning?`。prefix-stable 的 payload =
  `[…normalizeMessagesForApi([head]), …normalizeMessagesForApi(toSummarize),
  { content: 指令, role: user }]`——與 builder 同一套轉換（WYSIWYG 同源）；
  指令內容不變（`DEFAULT_SUMMARY_PROMPT` / `SPLIT_TURN_SUMMARY_PROMPT` /
  自訂），位置從 system 位移到末尾 user 訊息。transcript 模式維持 v1 形狀
  （`[system(指令), user(transcript)]`）作 fallback。`excludeReasoning`
  轉傳 `sendMessage` 的 `excludeReasoningFromContext`（request body 映射
  剝除 `reasoning_content`，與主送出路徑同一機制）。abort / empty
  response 行為不變。
- 呼叫端 3 處各加 `excludeReasoning:
  config.excludeReasoningFromContext === true`（`compactConversation` /
  `summarizeRegion`（手動 plan 補 `systemHead`）/ in-loop
  `compactBetweenTurns`）；mode 靠 default，呼叫端零其他改動。
- barrel：export `SummaryMode`。
- 測試：unit `summarize.test.ts` mock 的 `normalizeMessagesForApi` 改
  pass-through（原 `vi.fn()` 回 undefined 會在 spread 時炸）；`makePlan`
  補 `systemHead: null`；新 `makePlanWithHead`（system head +
  user/assistant(tool_calls)/tool 三則 region）。新增 6 支：default
  prefix-stable 結構（head 第一、region 順序與 role 保留、指令最後 user、
  `normalizeMessagesForApi` 收 `[head]` 與 `[toSummarize]`）、split 變體只換
  指令（prefix 逐則相等）、自訂 prompt（trim）、無 system head、
  `excludeReasoning` 透傳、transcript fallback 維持 v1 形狀（不碰
  `normalizeMessagesForApi`）。unit `compaction-policy.test.ts` +2 斷言
  （`systemHead` = `path[0]` / 無 system 時 null）。
- 文件：02-§5（兩模式 payload 形狀 + D1/D2）、03-§2.1（標記已實做 + 兩決策）
  、05-Phase 3 清單、README。
- **已知邊界**（fail-open 覆蓋）：region 以 tool 訊息結尾時（典型 = flow
  被中斷後直接發新訊息），prefix-stable payload 會出現 `[…, tool, user(指令)]`
  的 role 轉折；個別嚴格的 chat template 若拒絕，summary 呼叫失敗 → 不建
  cmp、context 完整保留（與既有 fail-open 同路徑）。

**第一輪修復**（使用者第一輪 2026-07-22：`npm run check` + unit
`compaction-policy`（30/30）全綠；unit `summarize` **13/14**）：唯一失敗是
`split-turn variant only swaps the trailing instruction (prefix identical)`——
**test bug、實做無誤**：測試對兩支呼叫各叫一次 `makePlanWithHead()`，而
`message()` fixture 用 `m${Math.random()}` 隨機 id；mock 的
`normalizeMessagesForApi` 是 pass-through，DB 訊息（含 `id`）原樣進 payload →
兩次呼叫的 prefix id 不同，deep-equal 必然失敗。修復（只動測試）：該用例改
build 一個 `plan` 共用，split 呼叫用 `{ ...plan, isSplitTurn: true }`，prefix
引用同一批訊息物件。實做（`summarize.ts`）零改動。

**✅ 已確認**：使用者重跑 `npm run check` + unit `summarize`（14/14）+
`compaction-policy`（30/30）全綠。

### 3.19 N5 summary mode 設定 `contextSummaryMode`（✅ 完成並確認）

**背景（使用者 2026-07-22 要求）**：N4 把 `SummaryMode` 做成 internal
default（無 UI），但使用者認為該給選擇權——尤其 summary 後續可能增加選項
（如用另一個 model / api endpoint 做 compact 而非當前任務的模型），所以
mode 應進 config、預留空間。

**決策**：
- 新增 `contextSummaryMode`（SELECT：`prefix-stable` / `transcript`、預設
  `prefix-stable`）——逃生門語義：server 拒絕 prefix-stable payload 時（§3.18
  已知邊界：region 以 tool 結尾的 `[…, tool, user(指令)]` role 轉折）可切回
  transcript；不是「推薦選項」，default 仍是 prefix-stable。
- coerce 收斂在純函式 `toSummaryMode(value: unknown)`（`summarize.ts`）：
  只有 `'transcript'` 字串回 transcript，其餘（undefined / 空 / 損壞的
  localStorage 值）一律回 `prefix-stable`——呼叫點零判斷、default 單一來源。
- 未做（刻意）：summary 獨立 model / endpoint 設定（N5 的動機之一，但屬於
  新機制，留 Phase 3；config 空間已預留——新 key 照 `CONTEXT_*` 慣例加）。

**實做**：
- `summarize.ts`：`toSummaryMode()` 純函式；`SummarizeOptions.mode` JSDoc 補
  「user-selectable via `contextSummaryMode`」。
- `index.ts`（barrel）：export `toSummaryMode`。
- `settings-keys.constants.ts`：`CONTEXT_SUMMARY_MODE: 'contextSummaryMode'`
  （字母序插在 `CONTEXT_SUMMARY_MAX_TOKENS_PERCENT` 後）。
- `settings.constants.ts`：registry +1 條目（General section，插在
  `contextShowCompactionEntries` 與 `contextSummaryPrompt` 之間；SELECT、
  無 dependsOn——手動/自動/in-loop 三個呼叫點都適用）；options 各帶 icon
  （registry 型別 `SettingsEntry.options.icon` 必填：`Layers` =
  prefix-stable、`FileText` = transcript）；lucide import 加 `FileText`、
  `Layers`。`SETTING_CONFIG_DEFAULT` / `SettingsConfigType` 由 registry 派生，
  零改動。
- 呼叫端 3 處各加 `mode: toSummaryMode(config.contextSummaryMode)`
  （`compactConversation` / `summarizeRegion` / in-loop
  `compactBetweenTurns`；物件 key 字母序插在 `maxTokens` 與 `prompt` 間）；
  兩 store 的 `$lib/services/context` import 各加 `toSummaryMode`。
- 測試：unit `summarize.test.ts` +2 支（`toSummaryMode`：已知兩值原樣回、
  未知/空/undefined 回 prefix-stable）。registry 全 key 迴歸靠既有 client
  `settings-registry-invariants`（generic、自動涵蓋新 key）。
- 文件：04-§4 設定表 +1 行；05-Phase 3 清單 +N5；README 停點。

**✅ 已確認**：使用者跑 `npm run check` +
`npx vitest --project=unit --run tests/unit/summarize.test.ts`（16/16）+
`npx vitest --project=client --run tests/client/settings-registry-invariants.svelte.test.ts`
全綠。

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
  > ✅ **5.8 項目 1–2 現在可驗**（P2.4 的 inspector「Compact now」§2j + P2.6 的表單
  > Eye 按鈕 / 快捷鍵 / gauge 列皆已落地並確認）。項目 3 已由 unit 回歸覆蓋。
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
- **Phase 2 P2.6 已實做、待編譯確認**（變更見 §2p）：gauge 列
  （compacting spinner / Compacted 節省列，`estimateCompactionSavings` 純函式
  + 6 支 unit）+ `ChatFormActions` 第三入口（`ChatFormActionInspectContext`
  Eye icon 按鈕）+ `Shift+Ctrl/Cmd+I` 快捷鍵（`KeyboardKey.I_LOWER/I_UPPER`）
  + 新 client suite `context-gauge-compaction.svelte.test.ts`（8 支）。
  待使用者跑：`npm run check` +
  `npx vitest --project=unit --run tests/unit/compaction-policy.test.ts`（24 支預期）+
  `npx vitest --project=client --run tests/client/context-gauge-compaction.svelte.test.ts`（8 支）+
  回歸 `context-panel-mobile`（2 支）+ `context-inspector`（10 支）。
  全綠 → P2.6 確認、Phase 2 完成（剩 5.8 手動驗收 + Phase 3 可選後續）。
- **Phase 2 P2.6 第一輪**（修復見 §2q）：`npm run check` 9 型別錯（gauge 3 支用了
  `RenderResult` 不存在的 testing-library API）+ client 5/8 掛（gauge 3 支 API
  缺失 + form 2 支獨立渲染缺 `Tooltip.Provider`）。全數測試端修復（新
  `ChatFormActionsWrapper`、`document.querySelector` + `waitFor`/`bodyText()`
  helper）。
- **Phase 2 P2.6 第二輪**（修復見 §2r）：client 6/8 綠，2 支 form 入口 strict
  mode violation——`getByRole('button', { name })` 同時命中 bits-ui
  `Tooltip.Trigger` 外層 button 與內層 `Button`（Add/Mic 同款既有雙 button
  結構）。2 支各加 `.last()` 取內層（`onclick`/`disabled` 都在內層）。
- **Phase 2 P2.6 第二輪重跑 ✅ 確認**：使用者跑了 5 條指令全綠——
  `npm run check` + unit `compaction-policy` + client
  `context-gauge-compaction`（**8/8**）+ 回歸 `context-panel-mobile` /
  `context-inspector`。**P2.6 完成、Phase 2 完成**（變更見 §2p；第一輪修復
  §2q；第二輪修復 §2r）。
- **§3.12 threshold 語義修正 ✅ 確認**：使用者跑 `npm run check` +
  unit `compaction-policy`（26/26），全綠。
- **N1 ✅ 完成並確認**（變更見 §3.13）：summary 上限改 n_ctx ×
  `contextSummaryMaxTokensPercent`（預設 70，舊固定 key 移除）。使用者跑
  `npm run check` + unit `compaction-policy`（**29/29**），全綠。
- **N2 ✅ 完成並確認**（變更見 §3.14）：threshold 預設 80→70 +
  新設定 `contextKeepTargetPercent`（預設 50）。使用者跑 3 條指令全綠：
  `npm run check` +
  `npx vitest --project=unit --run tests/unit/compaction-policy.test.ts`
  （**30/30**：原 29 + 新 1）+
  `npx vitest --project=client --run tests/client/settings-registry-invariants.svelte.test.ts`。
- **N3 ✅ 完成並確認**（變更見 §3.15）：手動壓縮 Stop 鍵
  （`chatStore.stopCompaction()` + inspector/cmp row [Stop] 按鈕 +
  `summarizeMessages` abort 時丟真 `AbortError`）。使用者跑 4 條指令全綠：
  `npm run check` + unit `summarize`（8/8：原 6 + 新 2）+ client
  `context-inspector` + client `chat-message-compaction`。
- **Context Inspector UI 修復第 1 輪（§2s）✅ PC 確認 / mobile NG**：使用者
  跑 `npm run check` + client `context-inspector`（**10/10**）全綠；實測
  PC 正常、mobile 超寬（dialog `max-w-full`、`ul` `max-w-2xl` 672px >
  螢幕寬）→ 第 2 輪已改（`min-w-0`：grid item + 兩 `ul` + 兩組 `li`）。
- **Context Inspector UI 修復第 2 輪（mobile 溢出）✅ 確認 / 新症狀**：使用者
  跑 `npm run check` + client 全綠；實測 mobile 不再超出，**但 dialog 變很窄
  （~50vw）難以閱讀** → 第 3 輪已改（`Dialog.Content` 加 `w-full`，md 以下；
  根因：fixed 元素 shrink-to-fit 可用空間 = 視口 − 50% left offset = 50vw，
  min-content 歸零後寬度塌到 50vw）。
- **Context Inspector UI 修復第 3 輪（mobile 寬度）✅ 使用者已確認**（2026-07-22）：
  重跑
  `npm run check` +
  `npx vitest --project=client --run tests/client/context-inspector.svelte.test.ts`
  + mobile 手動（滿寬、可讀、無水平 scroll）+ PC 回歸（不變，清單見 §2s）
  全部通過。
- **Context Inspector 版面輪（§2t）第一輪**：使用者跑 client `context-inspector`
  （**13/14**）——唯一掛「Back to top scrolls the dialog content back to the
  top」（`expect(content.scrollTop).toBeGreaterThan(0)` 實得 0）。根因（§2t 驗證
  狀態）：browser 測試環境獨立掛載元件、app Tailwind CSS 未載入 →
  `Dialog.Content` 非 scroll container、`scrollTop` 不可設；非元件 bug。
  已測試端修復（`style.overflowY = 'auto'` + 限高 80px；元件零改動）。
- **Context Inspector 版面輪（§2t）第二輪 ✅ 自動驗證確認**：使用者跑
  `npm run check` + client `context-inspector`（**14/14**）全綠。剩手動驗證
  （PC 頂端區塊 / 跳頂 / mobile，清單見 §2t）。
- **Context Inspector 版面輪（§2t）手動驗證 ✅ 通過**（使用者 2026-07-22）：
  PC 頂端區塊版面、長對話 Back to top 平滑回頂、mobile 第一視口 + 無水平
  溢出（含 §2s 第 3 輪 `w-full` 一併通過）。§2t / §2s 完成。
- **N4 第一輪**：使用者跑 `npm run check`（全綠）+ unit `compaction-policy`
  （**30/30**）+ unit `summarize`（**13/14**）。唯一失敗 = split-turn prefix
  比對（test bug：兩支 `makePlanWithHead()` → 隨機 id，mock pass-through 把 id
  送進 payload；見 §3.18 第一輪修復）。實做零改動、只修測試（共用同一 plan）。
- **N4 ✅ 完成並確認**：使用者重跑 `npm run check` + unit `summarize`（**14/14**）
  + unit `compaction-policy`（**30/30**）全綠。
- **N5 ✅ 完成並確認**（變更見 §3.19）：使用者跑 `npm run check` + unit
  `summarize`（**16/16**：原 14 + 新 2）+ client
  `settings-registry-invariants`（全 key 迴綠、含新 `contextSummaryMode`）全綠。
- **下一步**：① Phase 1 的 5.8 手動驗收（見上方清單）；② Phase 3 可選後續（規劃見 05-§1，含 summary 獨立 model / endpoint）。

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

### P2.6 gauge 列 + 第三入口 + 快捷鍵（04-§2.3 / §3）✅ 完成並確認（client 8/8 + check 全綠；變更見 §2p、修復見 §2q/§2r）
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

## 5c. 下一輪執行清單（N1–N5 ✅ 全部完成並確認，§3.13–§3.19）

> 來源：使用者 2026-07-21 要求（§3.12 修正後）。每項獨立可編譯、
> 獨立可確認；順序建議 N1→N4（N1/N2 同動 settings 檔、可合併一次確認）。

### N1 summary 上限 = n_ctx × %（✅ 完成並確認；設計變更見 §3.13）
- ~~registry `max: 4096` → `65536`~~ → 使用者指出固定數字不對：上限應跟著
  LLM ctx 大小走（256k 的 70% ≈ 180k、128k 的 70% ≈ 90k）。
- 改新設定 `contextSummaryMaxTokensPercent`（INPUT 10–90、預設 70）+ 純函式
  `computeSummaryMaxTokens(nCtx, percent)`；3 個 summary 呼叫點（compact / 
  summarizeRegion / in-loop）取 nCtx 現算；budget reserve 用同一 derived 值 × 1.5
  （70% 時 keep budget 落 10% floor，明細 §3.13）。
- ✅ 確認：`npm run check` + unit `compaction-policy`（29/29 全綠）。

### N2 新設定 `contextKeepTargetPercent`（✅ 完成並確認；明細見 §3.14）
- 新 key `CONTEXT_KEEP_TARGET_PERCENT`（`contextKeepTargetPercent`）+
  registry：INPUT(10–90)、預設 `50`（General section，字母序在
  `contextKeepMinMessages` 後）。✅
- `compaction-policy.ts`：`CompactionSettings` 加 `contextKeepTargetPercent`；
  `computeCompactionBudget` 把 `KEEP_TARGET_FRACTION`（固定 0.5）改成
  `settings.contextKeepTargetPercent / 100`（常數已移除）；
  `KEEP_BUDGET_FLOOR_FRACTION`（10% n_ctx floor）保留不動。✅
- 兩處 store 呼叫端已傳整包 `config` → 零改動。✅
- unit：budget 用例參數化 target（base fixture 加 `contextKeepTargetPercent: 50`；
  新增自訂 target 30% 一支；50% 公式 / 與 threshold 無關 / floor 三支不變）。✅
- 文件：04-§4 設定表已更新；02-§3.3 公式 `n_ctx × 0.5` →
  `n_ctx × contextKeepTargetPercent%`。✅
- 另：`contextCompactionThreshold` 預設 80 → 70（使用者要求，同批）。✅

### N3 手動壓縮 [Stop] 按鈕（✅ 完成並確認；明細見 §3.15）
- ~~`chatStore`：`compactConversation` 建 `AbortController`…~~ → 照計畫落地：
  private `compactionAbortController`（非 $state，UI 只看 `compacting`）、
  signal 傳 `summarizeMessages`、新 public `stopCompaction()`；catch 用
  `isAbortError` 分流 → `toast.info('Compaction stopped')`；fail-open 不變。
- ~~同樣的 signal 套用到 `recompactConversationEntry` 與 `moveCompactionBoundary`~~
  → 已做（經 `summarizeRegion` 新增 `signal?` 參數）；`compactBetweenTurns`
  未動（沿用 flow abort）。✅
- ~~UI：`compacting === true` 時 inspector 的 [Compact now] / [重新摘要] 與
  cmp row 動作列變 [Stop]~~ → 已做：inspector 的 Advanced 動作列與
  fail-open 警告列、cmp row 展開區動作列，`compacting` 時皆換成單一
  [Stop]（destructive + `Square` icon，呼叫 `stopCompaction()`）；
  gauge 列未動。✅
- ~~client 測試：inspector + cmp row 各加 stop 用例~~ → 已做：兩套各改
  1 支（compacting 時 Stop 取代動作列）+ 各新增 1 支（點 Stop → spy
  `stopCompaction`）。✅
- 額外（計畫外但必要）：`summarizeMessages` 在 `signal?.aborted` 時丟真
  `AbortError`——`ChatService.sendMessage` 會吞掉 fetch AbortError（回
  `undefined`），不補這層 store 無法區分「已停止」vs「empty response」。
  unit +2 支（§3.15）。✅

### N4 prefix-stable summary 模式（✅ 完成並確認；明細見 §3.18）
- 設計：03-§2.1。payload = `[system（path 的 system head 原樣）, 被壓縮
  訊息逐則轉換（保留原 role/結構：user/assistant/tool、tool_calls、
  attachments）, user（要求壓縮的 prompt）]`。✅
- 關鍵約束：前綴（system + 被壓縮訊息）完全一致、只有最後的壓縮 prompt
  不同（default / 自訂 `contextSummaryPrompt`、正常 / split-turn 變體只換
  最後一則）→ 同一 summarize 區的重複摘要（Re-summarize 等）可重用
  KV cache 前綴。✅
- `summarize.ts`：`summarizeMessages` 加 mode 參數
  （`'prefix-stable' | 'transcript'`，**default = prefix-stable**）；v1
  transcript 模式（`buildSummaryTranscript` 扁平文字）保留為 fallback。✅
- 指令內容不變（`DEFAULT_SUMMARY_PROMPT` / `SPLIT_TURN_SUMMARY_PROMPT` /
  自訂），位置從「system 位」移到「末尾 user 訊息」。✅
- 原未決兩點已定（使用者 2026-07-22，D1/D2 皆 A，見 §3.18）：
  附件**原樣送**（前綴與主 payload byte 一致；非 vision 模型由 `sendMessage`
  既有 vision filter 自動剝除）；`reasoning_content` **跟隨**
  `excludeReasoningFromContext` 開關（summary 呼叫轉傳同一開關）。✅
- `CompactionPlan` 加 `systemHead`（`planCompaction` / `summarizeRegion`
  手動 plan 各填一筆）；呼叫端 3 處各加 `excludeReasoning`（mode 靠
  default 零改動）。✅
- unit：prefix-stable payload 結構（system 第一、訊息順序與 role 保留、
  指令最後、split 變體只換指令）；transcript fallback 回歸；+ 無 head /
  自訂 prompt / excludeReasoning 透傳。第一輪 13/14（1 支 test bug 已修，
  §3.18 第一輪修復），重跑 14/14 全綠。✅

### N5 summary mode 設定 `contextSummaryMode`（✅ 完成並確認；明細見 §3.19）
- 動機（使用者 2026-07-22）：summary 的 prompt 模式該給 user 選擇權；
  summary 後續可能增加選項（如獨立 model / api endpoint 做 compact），
  mode 應進 config 預留空間。✅
- 新設定 `contextSummaryMode`（SELECT：`prefix-stable` / `transcript`、預設
  `prefix-stable`，General section）；逃生門語義（server 拒絕 prefix-stable
  payload 時切回），default 不變。✅
- `toSummaryMode(value)` 純函式 coerce（未知/損壞值 → `prefix-stable`）；
  3 個呼叫點（compact / summarizeRegion / in-loop）各加
  `mode: toSummaryMode(config.contextSummaryMode)`。✅
- unit +2 支（`toSummaryMode`）；registry 全 key 迴歸靠既有 client
  `settings-registry-invariants`。✅ 確認：`npm run check` + unit `summarize`
  （16/16）+ client `settings-registry-invariants` 全綠。

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
