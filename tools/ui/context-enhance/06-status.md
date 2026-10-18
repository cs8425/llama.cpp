# 06 · 實做狀態（continuity doc）

> 給「下一個繼續實做的 session」讀。規劃細節在 01–05，本檔只記錄
> **做到哪裡、做過的決策、接下來怎麼做**。

> **恢復點（最新，2026-10-18）**：**N11 compact request 前綴一致性——N11.1 + N11.2 source + N11.3 測試完成；`summarize.test.ts` 2 處測試檔 desync 已修（來源碼零改動）、待重跑確認**。
> N11.1（P0：tool result 附件在 DB→API 被丟）+ N11.2（A4 full-path summary）+
> D1（shared-builder 路徑、無 model 參數 / 無新 gating）source 完成；N11.3 測試完成
> （`summarize.test.ts` 依決定 B 修好 + 新 `tests/unit/chat-conversion.test.ts`
> 合成 fixture 回歸；明細見 §3.30 / §5g）。第一輪 `npm run check` + unit 回報
> 4 type + 6 runtime 失敗全在 `summarize.test.ts`（desync：`makePlanWithHead`
> spread 單則 `kept` / 3 處 options 傳到 `signal` 參位），已修、來源碼零改動。
> **待辦（依序）**：① 使用者重跑 `npm run check`（+ unit `summarize` /
> `chat-conversion` / `context-builder`）確認；② N11 手動驗收（MCP screenshot
> flow → 連壓兩次 + F5 → `cache_n` 高命中；可與 N10/N8/N7/5.8 一併驗）。
>
> **剩（依序）**：
> 1. **N11 — compact request 前綴一致性（§3.30 / §5g）**：⏸ 使用者
>    `npm run check` + unit 確認 → 手動驗收。
> 2. **N9 — F5 / refresh 韌性（規格定稿 2026-10-18、未實做；§3.28 / 05-N9 / §5e）**：
>    in-loop compaction 的 cmp + currNode 是兩次獨立 IDB 寫（非原子）→ 兩寫之間 F5
>    （或 `updateCurrentNode` 拋錯）→ cmp orphan（在 DB、不在 path、不可見）→
>    reload 後全量送出 → overflow；非永久損毀（無資料遺失、可恢復）。規格 =
>    原子 commit（N9.1）+ 載入收編 orphan（N9.2）+ 可選送出前 overflow guard
>    （N9.3）+ fail-open 語義入 02-§4（N9.4）。
> 3. **手動驗收（未做、可一併驗）**：N11（MCP screenshot → 連壓兩次 + F5 →
>    `cache_n` 高命中）
>    + N10（agentic loop 連壓兩次 → F5 → summary 都在、匯出匯入同、
>    既有已損對話 migration 後恢復）
>    + N8（agentic loop 連壓兩次：第二次 summary
>    請求 = `[system, 舊summary, 新訊息, instruction]`、loop 正常續跑）
>    + N7 5 項（05-§3 #8–#12）+ Phase 1 5.8
>    （§4 清單；A/B mode 行為 + v4 真實 token 顯示可一併驗）。
> 4. Phase 3 可選後續（05-§1）。
>
> **此前里程碑（皆完成並確認）**：N10（2026-10-18，§3.29/§4）→ N8（2026-10-18，§3.27/§4）→ N7（2026-10-04，§2u/§3.26）→ v4 真實
> token 計數（2026-10-17，
> §3.24/§3.25）→ 雙 mode 共用+A+B（2026-10-17，§3.22/§3.23）→
> N6 空 kept（2026-10-17，§3.21）→ N1–N5（2026-07-22，§3.13–§3.19）→
> Phase 2 P2.1–P2.6 → Phase 1 5.1–5.7 → Phase 0（逐項最終驗證狀態見 §4）。

## 1. 進度總覽

| 階段 | 狀態 |
| ---- | ---- |
| Phase 0 — 純核心 | ✅ 完成（使用者已確認 `npm run check` + unit 全綠） |
| Phase 1 — 送出路徑接 builder + 手動壓縮 | 🚧 5.1–5.7 ✅ 全部完成並確認（見 §4）；只剩 5.8 手動驗收 |
| Phase 2 — 自動觸發 + 人工介入 + flow 內再壓縮 | ✅ 完成：P2.1 ✅（見 §4）；P2.2 ✅（見 §2h/§4）；P2.3 ✅（見 §2i/§4）；P2.4 ✅（client 10/10 + check 全綠，見 §4/§2j/§2m/§2n）；P2.5 ✅（compaction 10/10 + inspector 10/10 回歸 + check 全綠，見 §4/§2o）；**P2.6 ✅ 完成並確認**（client 8/8 + check 全綠，見 §4/§2p/§2q/§2r） |
| Phase 3 — 可選後續 | ⬜ |
| v4 — 真實 token 計數（§3.24/§3.25） | ✅ **完成並確認**（2026-10-17：`npm run check` + unit `compaction-policy` 82/82 / `context-builder` / `summarize` + client `context-inspector` / `chat-message-compaction` / `context-gauge-compaction` / `compaction-decision-card` / `settings-registry-invariants` 全綠；第一輪 9 失敗已修、3 根因全在測試檔，見 §3.25 / 檔首恢復點；05-v4 清單已全勾） |
| N7 — 壓縮進行中：輸入 queue + in-chat 指標列（Stop）（§3.26/§2u） | ✅ **完成並確認**（2026-10-04：四輪跑測 8 支失敗全在測試檔已修、來源碼零改動；使用者重跑 `chat-message-compaction` 11/11 + check + 4 回歸檔全綠；queue 不 block + 指標列 + per-conv `compactingConvId` + sendMessage guard + finalizer 自動送 + client 11 支；手動驗收 #8–#12 未做） |
| N8 — 第二次壓縮：plan 改在 effective path（bug 修正；§3.27） | ✅ **完成並確認**（2026-10-18：N8.1–N8.3（3 來源檔 + 3 unit 檔）；第一輪 2 失敗全在測試檔已修（期望值筆誤、來源碼零改動）；使用者重跑 `npm run check` + unit 3 支 + client 5 支 compaction suite 全綠；手動驗收未做（§4 清單）；執行清單 05-N8 / §5d） |
| N9 — F5 / refresh 韌性：in-loop compaction 兩寫非原子（§3.28） | ⬜ **規格定稿、未實做**（2026-10-18：問題已對 code 驗證——`createCompactionMessage`（單一 IDB transaction）與 `updateCurrentNode`（獨立 IDB 寫）非原子 → 兩寫之間 F5 / `updateCurrentNode` 拋錯 → cmp orphan（在 DB、不在 path、不可見）→ reload 後全量送出 → overflow；非永久損毀（無資料遺失、手動 compact 可恢復）。規格 = 原子 commit（N9.1）+ 載入收編 orphan（N9.2）+ 可選送出前 overflow guard（N9.3）+ fail-open 語義入 02-§4（N9.4）；執行清單 05-N9 / §5e） |
| N10 — in-loop compaction 的 cmp 被接成 sibling（系統性 bug；§3.29） | ✅ **完成並確認**（2026-10-18：N10.1 根因修（`onCompaction` callback + `lastCreatedInFlow` 推進）+ N10.2 已損樹修復（`findCompactionGraftFixes` 純函式 + `applyCompactionGraftFixes` IDB transaction + 啟動 migration `compaction-graft-fix-v1` + `loadConversation` 防禦層）+ N10.3 unit 5 向量（`tests/unit/branching.test.ts`）；`npm run check` + unit + 既有 5 支 client compaction suite 全綠；剩手動驗收（§4 清單）；執行清單 05-N10 / §5f） |
| N11 — compact request 前綴一致性：tool result 附件被丟（N11.1）+ full-path summary（N11.2 = A4，§3.30） | 🚧 **N11.1 + N11.2 source + N11.3 測試完成、未確認**（2026-10-18：N11.1——轉換的 `extra → parts` 抽成 `ChatService.buildExtraContentParts`（固定序 / images 一律 cap / 無 gating）、tool+extra 不再 early-return 丟附件、in-flow 調同一 builder（順手修不 cap + 順序改 user input 路徑）、`toAgenticMessages` TOOL 分支直通、序列化對齊（assistant + tool_calls + 空 content → 省略 content 欄位）、清理 5 個 unused imports；`normalizeMessagesForApi` / `resolveOutgoingMessages` / `buildLlmContext` / `preEncode` / `sendMessage` / vision filter 全未動（D1：無 model 參數、無新 gating）；N11.2（A4）——`summarizeMessages` / `summarizeWithRetry` 收 `planPath`、prefix-stable payload = `buildLlmContext(planPath).messages` + instruction（刪自組裝）、transcript = `toSummarize + kept`、兩呼叫點傳 `planPath`（re-summarize = `effectiveCompactionPath(path)`）+ `summarizedCount = toSummarize + kept`（`chat:871` 不改）；N11.3——`tests/unit/summarize.test.ts` 依決定 B 修好（補 `planPath` + mock `convertDbMessageToApiChatMessageData` + payload assertions = `buildLlmContext(planPath).messages` + instruction）+ 新 `tests/unit/chat-conversion.test.ts`（真 ChatService、stores / cap mock：`buildExtraContentParts` 固定序 + cap / 轉換矩陣 / 空 content 三態 / in-flow ≡ DB rebuild byte-identity / 合成 fixture compact request = 最後 payload byte-prefix + instruction）。**待辦**：① 使用者 `npm run check` + unit 確認 ② 手動驗收（MCP screenshot → 連壓兩次 + F5 → `cache_n` 高命中）。執行清單 §5g） |
| 雙 mode 壓縮 — recent-window（A，預設）+ threshold-target（B = v3+N6）（§3.22/§3.23） | ✅ **完成並確認**（2026-10-17：`npm run check` + unit `compaction-policy` / `summarize` / `context-builder` + client `settings-registry-invariants` / `compaction-decision-card`（9/9）/ `context-inspector`（14/14）/ `chat-message-compaction` / `context-gauge-compaction` 全綠；第一輪 2 支 client 失敗已修，見 §4；05-雙 mode 清單已全勾） |
| N6 — split 切允許空 kept（§3.21） | ✅ 完成並確認（2026-10-17：check + unit `compaction-policy` / `context-builder` + client 回歸 4 支全綠；05-N6 清單已勾） |
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
| `context-builder.ts` | `buildLlmContext(path, opts?)` — 唯一 choke point；`findLastCompactionEntry(path)`。轉換**複用** `ChatService.convertDbMessageToApiChatMessageData`（不 fork；empty-system filter 鏡射 `normalizeMessagesForApi`）。`excludeReasoning` 時把 `reasoning_content` 設 undefined |
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

## 2k. P2.4 第一輪確認的修復（✅ 已確認；重跑 10/10 全綠見 §4）

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

## 2l. P2.4 診斷記錄（✅ 結案；根因與修復見 §2m）

第一輪 client 10/10 timeout 的五輪診斷（TEMP-DIAG 五層：setter patch /
mutation proxy / signal.v watch / DOM dump / instanceId）結案：**非 runtime
反應性問題**——selector 撞了 P2.4 新增的 bits-ui Select trigger（5 支
`aria-expanded` 按鈕）；「pathLen 0 重跑」是 afterEach 紅鵝（見 §2m）。
TEMP-DIAG 全數移除（兩檔搜 `TEMP-DIAG` 零結果）；唯一保留的測試改動是
`payloadRowButtons()` 的 selector 修正（非診斷代碼）。

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

## 2m. P2.4 根因與修復（client 測試 10/10 timeout；✅ 已確認）

**根因（一行）**：`payloadRowButtons()` 用 `[role="dialog"] button[aria-expanded]`
選 payload 列，但 P2.4 新增的 Advanced 區 bits-ui `Select.Trigger` 也是
`button[aria-expanded]` → 數到 **5** 支、`openInspector()` 的
`waitFor(length === 4)` 永不成立 → 10 支全掛在 `openInspector()`（DOM dump
的 `[diag] payload row buttons: 5` 就是答案）。

**「pathLen 0 重跑」是紅鵝**：測試在 `waitFor` 就 throw、`unmount()` 沒跑到，
`afterEach` 的 `activeMessages = []`（合法重置）打在還掛著的元件上 → effect
重跑 pathLen 0。五層 TEMP-DIAG 全在追一個不存在的 bug。

**修復（兩檔，零行為改動）**：selector 改 `[role="dialog"] li button[aria-expanded]`
（payload 列都在 `<li>` 內、Select trigger 不在）+ 移除全部 TEMP-DIAG。
bits-ui `DismissibleLayerState` responsible-layer 機制已確認：巢狀
AlertDialog / Select 互動不會誤關外層 inspector dialog。重跑 10/10 +
check 全綠（見 §4）。

## 2n. P2.4 boundary-select 用例根因與修復（9/10 → 10/10；✅ 已確認）

**根因（一行）**：用例要選的 `'help me fix the bug'` 是 **system head 之後
第一則（idx 1）**，而 boundary 候选集在兩端都排除 `index <= headLength`（元件
`boundaryOptions` + store `moveCompactionBoundary`；摘要涵蓋區 = 0 則、無意義）
→ 該 option 從未渲染 → `waitFor` timeout。非 portal / 反應性問題。

**修復（單檔，零元件/store 改動）**：`buildCompactedFixture()` 回傳加
`assistant`（tool_calls，idx 2）；用例改選「Within a turn (assistant)」邊界
（搜尋 `'read_file'`）、期望 `moveCompactionBoundary('insp-conv', cmp.id,
assistant.id)`。bits-ui 受控 Select：點 item → `onValueChange(v)`
（`select.svelte` 49–53 行），spy 必收到 `assistant.id`。重跑 10/10 +
check 全綠（見 §4）。

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

## 2q. P2.6 第一輪編譯/測試確認的修復（✅ 已確認；重跑見 §2r）

第一輪 `npm run check` 9 型別錯（全在 `context-gauge-compaction.svelte.test.ts`
gauge 段）+ client 5/8 掛。全數測試端修復、元件/store 零改動：

- gauge 3 支用了 testing-library 風格 API（`queryByText` / `findByText` /
  `Locator.parentElement`）——`vitest-browser-svelte` 的 `RenderResult` 只有
  `getByRole` / `getByText`（只收 `string | RegExp`、不收函式）/ `getByLabelText`
  / `getByPlaceholder` / `getByTitle` / `getByTestId`、回 `Locator` → 改
  `document.querySelector` + `waitFor` / `bodyText()` helper（同
  `context-inspector` 慣例）。
- form 2 支 `Tooltip "Provider" not found`（`ChatFormActions` 獨立渲染缺
  provider；app 裡由 `+layout.svelte` 提供）→ 新
  `tests/client/components/ChatFormActionsWrapper.svelte`（`Tooltip.Provider`
  包 `ChatFormActions`、`disabled` 透傳，照 `ChatFormTestWrapper` 先例）。
- latent：`expect(Locator)` 不會解析 → `await expect.element(...)`。

（以上測試環境 API / wrapper 慣例已併入 §6。）

## 2r. P2.6 第二輪剩 2 支 strict mode violation 的修復（✅ 重跑確認全綠 8/8）

form 入口 2 支 `getByRole('button', { name })` strict mode violation：同一
accessible name 命中 **2 個 button**——外層 bits-ui `Tooltip.Trigger` 自渲染的
`<button data-slot="tooltip-trigger">` + 內層 shadcn `Button`（`onclick` /
`disabled` 皆在內層）。這是 **app 既有雙 button 慣例**（`ChatFormActionAddButton`
/ `ChatFormActionRecord` 同款），非 P2.6 引入。

**修復（單檔，元件/store 零改動）**：兩支各加 `.last()` 取內層
（document order 上 descendant 恆在 ancestor 之後；不選
`.locator('[data-slot="button"]')` 因 `Locator.locator()` 是 protected）。
重跑 5 條指令全綠：`npm run check` + unit `compaction-policy` + client
`context-gauge-compaction`（**8/8**）+ 回歸 `context-panel-mobile` /
`context-inspector`。**P2.6 確認、Phase 2 完成**（見 §4）。

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

## 2u. N7 壓縮進行中：queue + in-chat 指標列（Stop）（✅ 完成並確認 2026-10-04）

> 設計：04-§4.2；實做清單：05-N7；決策與競態分析：§3.26（使用者 2026-10-04
> 確認 D1–D5）。

### 來源碼（9 檔，邏輯全在 store 層 + 1 新元件）

| 檔案 | 改動 |
| ---- | ---- |
| `src/lib/stores/chat/context-stats.svelte.ts` | 新 `compactingConvId` + 原子 `setCompacting(convId \| null)`；全 codebase 的 `compacting` 寫入改走它（四條路徑） |
| `src/lib/stores/chat/index.svelte.ts` | `compactConversation`：`setCompacting(convId)` 前移至 I7 guard 通過後立刻（收 guard→path/plan/summary 的 async 競態窗口）；全函式 try/finally → 新共用 finalizer `endCompactionState(convId)`（`setCompacting(null)` + consume pending → 自動送；conv 已切走時 pending 留 queue 不送）；`moveCompactionBoundary`（後移）/ `recompactConversationEntry` 同款；`sendMessage` 新第三層 guard（steering / streaming-pending 之後：同 conv `compacting` → `injectPendingMessage` + return）；`abortCurrentFlow` 補 `stopCompaction()` |
| `src/lib/stores/agentic/index.svelte.ts` | `compactBetweenTurns`：`setCompacting(conversationId)`；finally 只清狀態、**不** consume pending（in-loop 輸入走 steering，既有行為） |
| `src/lib/components/app/chat/ChatMessages/ChatMessageCompacting.svelte` | 新元件（spinner + 「Compacting context…」+ [Stop]，`role="status"`）：顯示條件 = per-conv（`compactingConvId === activeConv.id`）+ 尾端非 cmp；Stop 分派 `isRunning(convId)` ? `stopGeneration()` : `stopCompaction()` |
| `src/lib/components/app/chat/ChatMessages/ChatMessages.svelte` | 超標卡片的 else 分支插入指標列（DOM 序：訊息列 → 指標列 → 超標卡片 → pending/steering row） |
| gauge popup / cmp row / inspector | 既有三個 `compacting` 消費者改 per-conv（「conv A 背景壓縮不在 conv B 顯示/阻擋」的必然推論） |
| barrel（`$lib/components/app`） | 同 `ChatCompactionDecisionCard` 補 export |
| `tests/client/chat-message-compacting.svelte.test.ts` | 新 suite（11 支）：指標列顯示/隱藏（同 conv / 他 conv / idle / 尾端 cmp / 超標卡片顯示中）、Stop 分派（running / 非 running）、`sendMessage` guard（同 conv → pending 無 API 呼叫；他 conv → 正常送）、finalizer 自動送（early exit / abort 兩路徑）、DOM 序 |

### 設計補充（§3.26 未列、實做時定案）
- finalizer 的 conv 已切走例外：pending 留 queue 不送、不回傳到別的 conv。
- 三個既有 `compacting` 消費者改 per-conv（gauge 行 / cmp row Stop 與
  actionsBlocked / inspector actionsBlocked）。

### 跑測記錄（四輪、2026-10-04；8 支失敗全在測試檔、來源碼零改動；使用者重跑全綠確認）

- **第一輪 `chat-message-compacting` 10/12（2）**：① cmp row 由
  `LazyChatMessage` 經 IntersectionObserver **異步** mount、單一 `tick()` 不足
  → `await waitFor(cmpRow)` 輪詢；② `auto-sends the queued message when the
  summary call is aborted`（`runCompactionSummary` 0 次呼叫）：測試只設
  `activeConversation` 未入 `conversations` list（`resolveConversationPath`
  回 null 提前 return）+ n_ctx 鏈（`contextTotal` → `activeModelId` →
  `getModelContextSize`）未 mock 全 → `setActiveConversation` 連 list 一起寫
  + 補 model mock（當輪假設「derived 首次求值在 spy 之後」錯誤，見第二輪）。
- **第二輪 `chat-message-compacting` 11/12（1）**：同一支測試，真根因 =
  Svelte 5 `$derived` cache 過期——上游 `activeModelId` derived 已被同檔較早
  測試求值成 null，spy 上游 getter **不會 invalidate** 它 → 改直接 pin 被測
  路徑讀的葉值 `vi.spyOn(contextStatsStore, 'contextTotal', 'get')
  .mockReturnValue(256000)`（教訓已併入 §6）。
- **第三輪回歸 `context-gauge-compaction` 7/8 + `context-inspector` 12/14
  （3）**：舊測試只設 `compacting = true`、未帶 N7 per-conv 的
  `compactingConvId` → gauge 行 / inspector Stop 列 derived 恆 false → 改
  `setCompacting(convId)` + `afterEach` 改 `setCompacting(null)` + gauge 測試補
  active conversation。
- **第四輪 `chat-message-compaction` 9/11（2）**：2 支 Stop 測試與第三輪同根因
  （cmp row 的 `compacting` derived 恆 false → Stop 列不渲染）→
  `setCompacting('cmp-conv')` + `afterEach` 改 `setCompacting(null)`；全
  codebase grep 確認無其他直接寫 `compacting` 之處。

### 驗證狀態（✅ 使用者 2026-10-04 重跑全綠、N7 確認）

- `npx vitest --project=client --run
  tests/client/chat-message-compaction.svelte.test.ts` **11/11**
- `npm run check` 0 錯
- 回歸 `chat-message-compacting` / `context-gauge-compaction` /
  `context-inspector` / `compaction-decision-card` 全綠
- 05-N7 清單已勾（手動驗收 #8–#12 未做，見檔首「剩」）

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

### 3.20 v3 重設計：實際 token 計數 + compact 成功判定 + 超標重試/user gate（✅ 已實做为雙 mode 方法 B；token 計數部分後被 v4 取代，見 §3.24/§3.25）

**背景（2026-10-16 使用者報告）**：Context 面板 262.14K / 262.14K（100%），
Inspector 顯示 Estimated send 175,490（66.9%），但自動壓縮**從未觸發**。
設定：keep min user turns 1 / min messages 2 / keep target 40% / summary max 70% /
auto on / in-loop on / threshold 50%。

**根因分析（代碼核實 + 數值模擬驗證）**：
1. 三個觸發點都在（非 agentic onComplete 末 / agentic flow 結束 / in-loop
   turn 之間），I7 guard 不會擋（`isRunning` 在 finally 已清）。
2. threshold gate 應通過（gauge ~100%，prompt_n 實際值 ≥ 50% × 262,144）。
3. **`computeCompactionBudget` 把 keepBudget 壓死在 10% floor（26,214）**：
   summaryReserve = 183,500（70% n_ctx）× 1.5 = 275,250 = **105% n_ctx**，
   大於任何 keep target（40% = 104,857 → 104,857 − 275,250 < 0 → floor）。
   keep target 設 40~90% 全部無效。
4. `planCompaction` 需要「kept suffix ≤ 26,214 est.」的切點：agentic 尾端
   （最後一個 turn 的 tool results）遠超 26K est. → 邊界切與 split 切都被擋
   → **回 null**。
5. auto 模式 plan = null 時**完全靜默**（無 toast / log / gauge 指示）→
   「從未觸發」且無任何回饋。
   旁證：gauge 的 `contextUsed = prompt_n + cache_n + predicted_n` 重複計算
   cache（llama.cpp 的 prompt_n 已含 cached tokens）；char/4 對 CJK 低估 ~1.5×
   （262K 實際 vs 175K 估計）。

**使用者決策（2026-10-16，A–E）**：
- **A**（第二輪修正）：觸發 = 當前 context 超過 `contextCompactionThreshold × n_ctx`
  就執行裁切；**移除所有 keepBudget 的過度設計**（×1.5 reserve、10% floor）。
  planCompaction 算法本體不變（兩階段 / I4 / I5 / minSummarizeTokens），
  **budget = (threshold − keepTarget)% × n_ctx**——語義：threshold 觸發、
  成功判定約束 head + summary ≤ keepTarget%、切點約束 kept ≤ 差值
  → 裁切後總量 ≤ threshold% × n_ctx，**避免繼續觸發裁切**。
- **B**：超標 gate 三選項：**使用這次壓完（use it）/ 重壓（retry）/ 這次不壓
  （skip）**。
- **C**：新設定重試次數：**預設 3，3 = 共 3 次；1 = 總共一次；≤ 0 = 無限重試**。
- **D**：flow 之間的超標確認卡片 = **與 agentic 卡片同風格**（in-loop 掛
  agentic 訊息內；flow 之間掛訊息列尾端獨立 row）。
- **E**：**沒有 API 回傳準確 token 數時，直接用 byte 數**（UTF-8），
  不做 char/4 自己估算。

**v3 設計摘要**（詳見 02-§3.3/§3.4/§6、03-§3/§4.2/§4.4、05-雙 mode 清單的 Mode B 部分；v3 現為雙 mode 的方法 B，見 §3.22）：
- token 計數：API 有實際值用實際值（觸發 = prompt_n；成功判定 = summary 回應
  的 completion tokens）；沒有 → UTF-8 byte 數（保守上限）。
- 裁切：budget = keepTarget% × n_ctx（裸值）；算法不變。
- 成功判定（新）：`system head（byte 數）+ summary（API 實際 tokens）≤
  keepTarget% × n_ctx`；kept 區不進判定（已由切點約束）。
- 超標：重發同一 request（`contextSummaryMaxAttempts`，預設 3 共計；≤ 0 =
  無限）→ 仍超 → gate 問 user（同 maxTurns/tool 確認機制，abort = skip）。
  手動路徑（Compact now / Re-summarize / 斷點後移）同走此流程。
- 必要前置：非 streaming 回應補解析 `timings`（現況 `handleNonStreamResponse`
  不解析、`ApiChatCompletionResponse` 無 `timings` 欄位）。
- `summarizeMessages` 回傳改 `{ content, tokens }`（tokens = null 時成功判定
  改 byteLen(content) 代入）。
- 作廢：原 Phase 3「token 估計校準（prompt_n 反推每則成本）」——v3 在兩個
  需要精確的決策點直接用 API 實際值，切點用 byte 數，不再需要。

**未決（等使用者決定）→ 已決（2026-10-17，使用者 Q2）**：切點 / per-message 的
計數單位。決定：**API 有實際 token 數就用**（觸發 = `prompt_n`、成功判定 =
summary 的 completion tokens）；**msg 不是 API 來的 / API 缺失 token
數資料改用 byte**（per-message 沒有 API 實際值 → byte 數）；**不做派生比例**
（不用 `prompt_n / totalBytes` 反推）。後果（接受並記錄）：mode A 的
`keepRecentTokens` 對照 byte 加算（CJK 下實際保留 tokens ≈ 設定 / 3–8，
該設定實際是 byte budget）；觸發式 `window − keepRecentTokens` 混 token 尺度
（window）與 byte 尺度（keep）（CJK 下觸發點實際偏高，即較晚才壓）。

**狀態**：✅ 已實做並確認（2026-10-17，作為雙 mode 的**方法 B**，見
§3.22/§3.23）；v3 的 token 計數部分（API 值 / byte 數）已被 **v4 真實
per-message token** 取代（§3.24/§3.25，見 02-§3.4）。

### 3.21 N6：split 切允許空 kept（使用者要求 2026-10-16；✅ 已實做並確認 2026-10-17）

**背景**：split 切原本要求「最後 ≥2 則（含大 tool result）放得下 budget」
（`contextKeepMinMessages` 預設 2）。budget 極緊時（典型：agentic 最後一組
ass+tool 含巨大 tool result）planCompaction 回 null、無法壓縮——與 §3.20
同源的「壓不下去」死區。使用者決策：split 下限改為允許 0，即允許
**所有 message 都丟去 compact**（payload = `[system, summary]`）；
boundary 切維持原規則（整個最後一個 turn 要放得下 budget）。

**使用者決策（2026-10-16）**：
- **D1（簡化版）**：`CompactionMeta.firstKeptMessageId` 改選用
  （`firstKeptMessageId?: string`）。**缺 id = 空 kept**（合法狀態：kept =
  cmp 節點之後的訊息，通常為空）——系統未投入實際使用、無 legacy 資料，
  「meta 整組缺」與「欄位缺」不區分；**id 存在但路徑上找不到 = fail-open
  全量送出**（I3 不變；真實場景 = 刪了 boundary 訊息 / branch 後路徑變動）。
- **D2**：保留 `contextKeepMinMessages` 設定，**default 2 → 0、range 0–50**
  （設回 ≥1 即恢復舊的下限行為）。

**設計要點**（詳見 02-§1.1/§2/I3/I5/§3.1/§3.3/§4、03-§2/§4.2、04-§2.2、
05-N6 清單）：
- `planCompaction` 階段 2 的 j 範圍扩到 `path.length`：`cutIndex = path.length`
  = 切在最後一則訊息之後 → 空 kept、`firstKeptMessageId` 缺。階段 2 因此
  恆有解（最壞 = 全壓）；「無有效斷點 → null」實務上只剩 minSummarizeTokens
  未達（2k）等情形。
- `buildLlmContext`：缺 `firstKeptMessageId` → kept = cmp 之後的訊息、
  `boundaryValid = true`（**不是** fail-open）；有 id 找不到 → fail-open（I3）。
- v3 的 `threshold ≤ keepTarget → budget = 0 → auto 永不觸發` guard 維持
  （在觸發層；手動 Compact now 不受影響、可全壓）。
- `minSummarizeTokens`（2k）檢查不變。
- Inspector：空 kept 時斷點選擇器顯示「無保留訊息（全部壓縮）」、只能前移；
  cmp row 的 Kept from 顯示「none」；Re-summarize 的 region = cmp 之前的所有
  訊息（**排除 cmp 節點本身**——實作上 summarizeRegion 的 region 以 entry id
  過濾，避免把被重寫的 summary 自己餵進 summary payload）。
- 空 kept 時沿用 split-turn prompt 變體（已要求保留 task goal / steps /
  tool results / likely next step）；不加新 prompt。
- 既有 client fixture 的 `firstKeptMessageId: ''` 維持「有 id 但無效」=
  fail-open 語義（空字串 ≠ 缺欄位），行為不變。

**狀態**：✅ **完成並確認**（2026-10-17：使用者重跑 `npm run check` + unit
`compaction-policy` / `context-builder` + client 回歸 4 支全綠，見 §4 N6
重跑；05-N6 清單全部勾選）。歷史：使用者已確認（D1 簡化版 + D2）；
02/03/04/05 文件已同步；程式碼 + tests 已實做（2026-10-16）；第一輪 check
抓到 `context-builder.ts` 語法錯（`keptIndex` 三元漏 `?`）、已修（2026-10-17，
見 §4 N6 第一輪）。

### 3.22 雙 mode 壓縮：recent-window（A，預設）+ threshold-target（B = v3+N6）（規格定稿 2026-10-17，✅ 完成並確認 2026-10-17）

**背景**：§3.20 的 v3 設計（budget 公式修正 + 實際 token 計數 + 成功判定/
重試/gate）已確認未實做；使用者另引入 pi reference 的切點（下限：從最後
往回加到 ≥ keepRecentTokens 停，保留最近窗口原樣），並要求**同時保留兩種
作法、user 選 mode**。

**使用者決策（2026-10-17，Q1–Q3）**：
- **Q1**：預設 mode = **A（recent-window）**。
- **Q2**：計數 = **能從 API 拿到 token 數就用**（觸發 = `prompt_n`；成功判定
  = summary 回應的 completion tokens）；**msg 不是 API 來的 / API 缺失 token
  數資料改用 byte**（per-message 沒有 API 實際值 → byte）；**不做派生比例**
  （不用 `prompt_n / totalBytes` 反推）。後果（接受、記錄）：A 的
  `keepRecentTokens` 對照 byte 加算（CJK 下實際保留 tokens ≈ 設定 / 3–8，
  該設定實際是 byte budget）；觸發式混 token 尺度（window）與 byte 尺度（keep）
  （CJK 下觸發點實際偏高，即較晚才壓）。
- **Q3**：A 壓完成功 = `contextTokens（壓完後 context） ≤ window −
  keepRecentTokens`（即低於觸發點 → 不重觸發）；**失敗用 B 的重試邏輯**（同一
  `contextSummaryMaxAttempts` + gate 卡片）→ 超標機制**兩 mode 共用**，只有
  成功判定式不同；`contextSummaryMaxAttempts` 從「B 專用」變**共用**。

**規格摘要**（詳見 02-§3.3/§3.4/§6、03-§2/§3/§4.2/§4.4、04-§3/§4、
05-雙 mode 清單）：
- 新設定 `contextCompactionMode`（SELECT：`recent-window`（A，**預設**）/
  `threshold-target`（B），dependsOn: `contextAutoCompaction`）；切 mode 不影響
  既有 cmp 節點（mode 只決定往後的裁切決策；inspector / 手動操作 mode-agnostic）。
- **Mode A**：設定 `contextMaxContextOverride`（0 = 關；有效視窗 =
  `min(n_ctx, override)`；只用於裁切決策、不硬限送出）+ `contextKeepRecentTokens`
  （預設 20000）。觸發 `lastPrompt > window − keep`（`window − keep ≤ 0` →
  auto 永不觸發、手動不受影響）。切點（pi walk）：從最後往回加 byte 數、
  ≥ keep 停；切在交叉點**以右最近**合法切點；沒有（尾端 tool 自己跨過）→
  最右合法切點（保留其前 ass(tool_calls) + tool results）；未達 → 不壓；
  **A 不產生空 kept**（kept 恆 ≥1 則、以 user/assistant 開頭）。成功判定
  `headBytes + (summaryTokens ?? byteLen) + keptBytes ≤ window − keep`。
- **Mode B**（= v3 + N6）：觸發 `lastPrompt > n_ctx × threshold%`；budget =
  `（threshold − keepTarget）% × n_ctx`（threshold ≤ keepTarget → 0 → auto
  永不觸發）；切點 = 現行 `planCompaction()`（兩階段上限 + N6 空 kept +
  I4/I5）；成功判定 `headBytes + (summaryTokens ?? byteLen) ≤
  keepTarget% × n_ctx`（kept 不進判定）。
- **共用**：三個觸發點 / contextTokens 來源（prompt_n 優先、否則 byte 數）/
  per-message byte 計數（image 1000、audio-video 3000 不變）/ cmp 節點 /
  builder / I1–I7 / inspector / 手動操作 / minKept×2 / minSummarizeTokens /
  summary maxTokens% / summaryMode / prompt / fail-open / 超標機制
  （成功判定 → 重試 × maxAttempts → gate 卡片三選項，abort = skip；手動路徑
  同走此流程）。
- **Settings dependsOn 鏈**：auto → mode → {A: override/keep} / {B:
  threshold/keepTarget}；舊 threshold/keepTarget 的 dependsOn auto → mode
  （registry invariants 測試需同步）。
- **Gauge**：分母跟 mode 走（A = 有效視窗、觸發標記 = window − keep；
  B = n_ctx、觸發標記 = threshold%）。
- **複雜度評估**：中等——mode = 兩個呼叫點上的策略選擇（觸發公式 + planner +
  壓後處理），共用同一套純核心；無資料模型改動、無 UI 重複（除 settings
  欄位）；風險 = dependsOn 三層鏈（registry 測試抓）、A 的單位一致性
  （Q2 已解：byte 加算 + 記錄後果）、兩個 planner 的長期維護（皆小純函式、
  回同一 CompactionPlan 型別）。

**狀態**：✅ **完成並確認（2026-10-17）**——規格定稿（Q1–Q3）；02/03/04/05
已同步；來源碼（§3.23，18 檔）+ 測試（unit 重寫/更新 + client 新 suite +
1 項回歸修正，見 §3.23 執行記錄）全部完成；使用者完整指令全綠（check +
unit 3 支 + client 5 支；第一輪 2 支 client 失敗已修，見 §4）。實做順序已照
規劃執行：共用基礎（timings 解析 / `{content, tokens}` / byte 計數 / 重試+
gate / settings 鏈 / 卡片）→ A（planner + 觸發/判定 + gauge）→ B（budget
公式 + 觸發/判定）→ 測試（unit 重寫/更新 + client 新 suite + 1 項回歸修正）。
05-雙 mode 清單已全勾。

## 3.23 雙 mode 實做（共用 + A + B）（2026-10-17；✅ 完成並確認）

> 實做順序照 §3.22：共用基礎 → A → B。本輪一次完成三個層（同一個可編譯
> 單位，末尾以使用者 check + 測試收口）。

**決策（規劃未明定、實做時決定，已記錄）**：

1. **settings 需要 `dependsOnValue` 新機制**：既有 `dependsOn` 是單層 truthy
   檢查（`Boolean(localConfig[field.dependsOn])`），對 SELECT 型 mode 恆為
   truthy → 無法表達「mode = A 才顯示」。新增 `SettingsFieldConfig.dependsOnValue?:
   string`：有值時改為等值比較。`SettingsChatFields.svelte` 的檢查改為
   `!field.dependsOn || (field.dependsOnValue != null ? localConfig[field.dependsOn] === field.dependsOnValue : Boolean(localConfig[field.dependsOn]))`；`toSettingsSection` 透傳。
2. **共用超標機制放純核心（可單測）**：`summarizeWithRetry()` 在
   `services/context/summarize.ts`，gate 以介面注入（`CompactionSummaryGate.
   requestDecision`）→ 重試次數 / gate 互動可 unit 測；store 只負責把 gate
   接到 `agenticStore.requestCompactionDecision`。
3. **`SummarizeWithRetryOptions.compactionMode`**（非 `mode`）：`SummarizeOptions` 已有
   `mode?: SummaryMode`（summary prompt 模式），同名會衝突。
4. **卡片掛法兩處**：in-loop = `ChatMessageAgenticContent`（continue 卡片同位、
   `isStreaming && isLastAssistantMessage` 守衛）；flow 之間 / 手動 =
   `ChatMessages` 訊息列尾端獨立 row（`!agenticStore.isRunning(convId)` 守衛
   防雙掛）。gate pending state 在 `AgenticGates`（agenticStore 擁有）——
   chatStore 經 `agenticStore.requestCompactionDecision` 走同一個 gate。
5. **gauge 只在 `contextAutoCompaction` 開時跟 mode 走**（關 = n_ctx、無觸發
   標記）；觸發標記 = 進度條上的垂直刻度（`title="Auto-compaction trigger"`）。
6. **`estimateTokens` / `estimateApiMessageTokens` 名稱保留**（05 清單如此），
   文字部分 char/4 → UTF-8 byte（`TextEncoder`，新導出 `byteLength`）；image
   1000 / audio-video 3000 不變；`MIN_SUMMARIZE_TOKENS = 2000` 現為 byte 語義。
   `context-builder.test.ts` 的期望值用同一函式計算 → 自適應、零改動。
7. **`CompactionSettings` 改收 `contextCompactionThreshold`**（B 的 budget =
   差值公式需要）、移除 `contextSummaryMaxTokensPercent`（不再進 budget；
   `computeSummaryMaxTokens` 只用於 summary 呼叫的 max_tokens）。

**變更明細（18 檔）**：

| 檔案 | 改動 |
| ---- | ---- |
| `src/lib/types/api.d.ts` | `ApiChatCompletionResponse` + `timings`（同 stream chunk 形狀；`predicted_n` = 實際 completion tokens） |
| `src/lib/services/chat.service.ts` | `handleNonStreamResponse` 解析 `data.timings` 傳給 `onComplete`（原傳 `undefined`） |
| `src/lib/services/context/types.ts` | + `CompactionMode`（'recent-window' \| 'threshold-target'）、`CompactionDecision`（'use' \| 'retry' \| 'skip'） |
| `src/lib/services/context/compaction-policy.ts` | **重寫**：byte 計數（`byteLength` 導出）；`computeCompactionBudget` 新公式 `floor((threshold − keepTarget)/100 × nCtx)`（threshold ≤ keepTarget → 0；移除 summaryReserve × 1.5 與 10% floor）；`CompactionSettings` +threshold / −summaryMaxTokensPercent；`planCompaction` 邏輯不變（byte 化）；新 `toCompactionMode` / `computeEffectiveWindow` / `shouldTriggerCompaction`（A: `lastPrompt > window − keep`、`window − keep ≤ 0` 永不觸發；B: `> nCtx × threshold%`）/ `planCompactionRecentWindow`（pi walk：從尾端加 byte ≥ keep 停、交叉點以右最近合法切點、尾端全 tool → 最右合法切點、未達 → null、A 不產生空 kept、I5/minSummarize）/ `evaluateCompactionResult`（A: `head + summary + kept ≤ window − keep`；B: `head + summary ≤ keepTarget% × nCtx`）/ `resolveSummarySize`（tokens ?? byteLen）/ `nextCompactionStep`（≤0 = 無限） |
| `src/lib/services/context/summarize.ts` | `summarizeMessages` 回傳 `string` → `SummaryResult { content, tokens }`（tokens 經 `onComplete` 抓 `timings.predicted_n`，server 沒回 → null）；新 `CompactionSummaryGate` / `SummarizeWithRetryOptions` / `summarizeWithRetry`（summarize → 判定 → retry × maxAttempts → gate；nCtx ≤ 0 → 不判定；無 gate → fail-open 接受） |
| `src/lib/services/context/index.ts` | barrel 補全部新 export |
| `src/lib/constants/settings-keys.constants.ts` | +4 key（字母序）：`CONTEXT_COMPACTION_MODE` / `CONTEXT_KEEP_RECENT_TOKENS` / `CONTEXT_MAX_CONTEXT_OVERRIDE` / `CONTEXT_SUMMARY_MAX_ATTEMPTS` |
| `src/lib/constants/settings.constants.ts` | registry：mode SELECT（`recent-window` 預設、Clock/Gauge icons、dependsOn auto）+ A 兩欄（override 0 = 關 / keep 20000、dependsOn mode + dependsOnValue A）+ B 兩欄（threshold/keepTarget 的 dependsOn auto → mode + dependsOnValue B，help 更新）+ `contextSummaryMaxAttempts`（0–10、預設 3、dependsOn auto）；lucide +`Clock`/`Gauge`；`toSettingsSection` 透傳 `dependsOnValue` |
| `src/lib/types/settings.d.ts` | `SettingsFieldConfig` + `dependsOnValue?: string` |
| `src/lib/components/app/settings/SettingsChat/SettingsChatFields.svelte` | dependsOn 檢查支援 `dependsOnValue` 等值 |
| `src/lib/stores/agentic/gates.svelte.ts` | + `CompactionDecisionRequest`（convId/mode/postSize/target/attempts）+ `requestCompactionDecision`（Promise + pending state；abort = 'skip'）/ `resolveCompactionDecision` / `getPendingCompactionDecision`；`clear()` 清 compaction state |
| `src/lib/stores/agentic/index.svelte.ts` | +3 public wrapper（getPending/resolve/request）；`compactBetweenTurns` 雙 mode：`shouldTriggerCompaction` 取代舊 threshold 比較、plan 按 mode（A: `planCompactionRecentWindow` / B: `planCompaction`）、`summarizeWithRetry`（gate → `this.gates.requestCompactionDecision`）、null → return（skip）、`summary.content`、toast 用 `byteLength` |
| `src/lib/stores/chat/index.svelte.ts` | `compactConversation` 雙 mode（同上 + null → toast 'Compaction skipped'）；新 private `runCompactionSummary`（接 `summarizeWithRetry`，gate → `agenticStore.requestCompactionDecision`）；`summarizeRegion` 拆 `buildRegionPlan` + `summarizeRegion`（回 `SummaryResult \| null`）；`recompactConversationEntry` / `moveCompactionBoundary`（後移）處理 null + `summary.content` |
| `src/lib/components/app/chat/ChatMessages/ChatMessageActions/ChatMessageActionCard/ChatCompactionDecisionCard.svelte` | **新**：Scale icon；「~postSize of ~target allowed (after N attempts). Keep it?」+ [Use this summary] [Re-compact] [Skip]（continue 卡片同風格） |
| `src/lib/components/app/chat/index.ts` | export `ChatCompactionDecisionCard` |
| `src/lib/components/app/chat/ChatMessages/ChatMessageAgenticContent.svelte` | in-loop 掛卡片（`pendingCompaction` derived + identity 型 dismissal、同 continue 卡片模式） |
| `src/lib/components/app/chat/ChatMessages/ChatMessages.svelte` | flow 之間 / 手動：訊息列尾端獨立 row（`!isRunning` 守衛） |
| `src/lib/components/app/chat/ChatForm/ChatFormContextGauge/ContextGaugePopup.svelte` | mode-aware：`gaugeTotal`（auto 開 + A → `computeEffectiveWindow`；B/關 → n_ctx）、`gaugePercent` / `gaugeColorLevel`、`triggerBarPercent` 刻度（A: window−keep；B: threshold%）；usage() / 進度條 / remaining 全改 mode 值 |

**已知風險（第一輪 check 重點盯）**：

- Svelte strict mode：4 個新/改元件（card / agentic content / chat messages /
  gauge popup）——歷輪 strict violation 都在測試端，但 `visibleCompaction` /
  `pendingCompaction` 的 `$state(null)` 推斷類型需留意。
- `SettingsChatFields` 的 `localConfig[field.dependsOn] === field.dependsOnValue`
  比較（union 型別 vs string）應無問題，但 check 會驗。
- `compactBetweenTurns` 的 gate 掛在 `this.gates`（非 public wrapper）——
  同檔直接存取、無問題。
- `ContextGaugePopup` 的 `gaugeTotal` derived 讀 `gauge.contextTotal`（getter）
  + `settingsStore.config`——反應性應正常。

**測試（2026-10-17 第二輪，已完成並使用者確認，見 §4）**：`compaction-policy.test.ts`
重寫（byte 語義 + 8 新 suite）/ `summarize.test.ts`（`SummaryResult` +
`summarizeWithRetry` 8 支）/ `compaction-decision-card.svelte.test.ts` 新建（卡片 6 支 +
store gate 層 3 支）；回歸 `context-gauge-compaction` 硬編碼 estimate 值修正
（`~1,794` → `~1,658`，byte 語義）、`context-inspector` / `chat-message-compaction` /
`settings-registry-invariants` / `context-builder` 零改動。

## 3.24 v4 真實 token 計數（使用者定稿 2026-10-17；✅ 已實做，見 §3.25）

> 觸發:Context Inspector 的「Estimated send」/每則「~N tok」用
> `estimateTokens`/`estimateApiMessageTokens` 的 **UTF-8 byte 數**當 token 顯示、
> 並除 n_ctx(token)→ 數字與 gauge(真實 `contextUsed`)永遠對不上(380,513 vs
> 153,939,≈2.5 bytes/token)。

**決策(使用者 2026-10-17)**:
1. **觸發裁切 = 真實 `contextUsed`**(`contextStatsStore.contextUsed` =
   prompt_n+cache_n+predicted_n,gauge 同源),不再是 `prompt_n ?? byte 加算`。
2. **Inspector 每則用真實 token**(原 UI 的 `timings` 資料),不用 byte 估算:
   - 主欄 = 真實值:assistant=`predicted_n`、每段非-assistant 真實總和歸該段
     最後一則非-assistant(「首則 user 用總和」)、system=`-`(無獨立值)、
     尚未送出尾端=`est.`
   - 副欄 = `bytes` + `bytes÷4 est.`(參考)
   - 總和條 = 真實 `contextUsed`(＝gauge)
3. **切點選擇也用精確數字**(`deriveRealMessageTokens` + `messageSize`),
   估算僅限無資料例外(system、尚未送出尾端)。
4. **設定數字不變**:`contextKeepRecentTokens`(20000)/`MIN_SUMMARIZE_TOKENS`(2000)
   現含義由 byte 改 **token**;mode B 原本 byte-vs-token 錯配順手修好。

**核心函式(純)**:
- `deriveRealMessageTokens(path) → Map<dbId, number>`:assistant=`predicted_n[i]`;
  段總和 `=(prompt_n[i+1]+cache_n[i+1])−(prompt_n[i]+cache_n[i])−predicted_n[i]`
  歸該段最後一則非-assistant;首段=`prompt_n[0]+cache_n[0]`;system/尾端不在 map。
- `messageSize(m, real, isTail) = 真實 ?? (尾端 ? bytes/4 : 0)`。
- `estimateTokens` 改名 `messageBytes`(只供 inspector 副欄 + bytes/4)。

**影響面**:`compaction-policy.ts`(planner/成功判定/trigger 全改 `messageSize`)、
`context-builder.ts`+`types.ts`(messages 帶 `sourceId`、移除 `estimatedTokens` byte)、
`stores/chat`+`stores/agentic`(trigger 用 `contextUsed`)、`DialogContextInspector`/
`ChatMessageCompaction`/`ContextGaugePopup`(顯示真實 + 副欄)。

**取代**:v3 的「無 API 值 → UTF-8 byte 數」(02-§3.4 舊版)與「不做派生比例」;
v1 的 char/4。設計同步:02-§3.4(v4)/§3.3/§6、03-§2/§4、04-§2/§3/§4、
05-v4 區塊、README TL;DR。實做清單:05-v4 區塊。

## 3.25 v4 真實 token 計數實做（2026-10-17；✅ 完成並確認）

> 規格:05-v4 區塊 / 02-§3.4(v4) / 04-§2/§3 / §3.24(決策)。以下為實做明細 +
> 規格未明訂的決策(2026-10-17 v4 結案全數確認,見檔首恢復點)。

**來源碼改動(9 檔)**:
1. `src/lib/services/context/compaction-policy.ts`(重寫):
   - 新 `deriveRealMessageTokens(path) → Map<dbId, number>`:「measured」assistant =
     `timings.prompt_n != null && predicted_n != null`(cache_n 缺 → 0);assistant =
     `predicted_n`;首段 = `prompt_n[0] + cache_n[0]`;段 =
     `(p2+c2) − (p1+c1) − predicted1`,**clamp ≥ 0**(in-loop compaction 後 prompt 縮水);
     段總和歸該段**最後一則非-assistant、非-system**(`lastNonAssistantId`;段內只剩
     system head 時總和丟棄——system 永不當 owner,02-§3.4「system = 0」);system/尾端
     不入 map。無 measured assistant → 空 map。
   - 新 `tailStartOf(path)`:最後一則 assistant 之後的 index;**無 assistant → 0**
     (整條 path 皆尾端 = 尚未送出)。
   - 新 `messageSize(m, real, isTail) = real ?? (isTail ? round(messageBytes/4) : 0)`。
   - `estimateTokens` → `messageBytes`、`estimateApiMessageTokens` →
     `apiMessageBytes`(byte 只供 inspector 副欄 + 尾端估算。**決策**:API 版一併改名
     保持一致——規格只提 estimateTokens)。
   - `planCompaction(path, budget, realTokens?)` / `planCompactionRecentWindow(path,
     opts, realTokens?)`:所有 size 走 `messageSize`(realTokens 缺省時內部 derive);
     **head = 0**(system 併入首段);plan 新欄位 `keptTokens`(kept 區真實)+
     `realMessageTokens`(plan 時的 map,供成功判定)。
   - `evaluateCompactionResult`:**不再加 system head**(**決策**,02-§3.4「walk 記 0」
     的延伸):A = `summary + plan.keptTokens ≤ window − keep`;B = `summary ≤
     keepTarget% × n_ctx`。
   - `estimateCompactionSavings`:真實 size(結構不變:path − dropped)。
   - `shouldTriggerCompaction` 邏輯不變;doc 改 `lastPrompt` = 真實 contextUsed。
   - `resolveSummarySize` 不變(`tokens ?? byteLen(content)`,02-§4 E)。
2. `types.ts`:`CompactionPlan` + `keptTokens` / `realMessageTokens`;新
   `ContextPayloadMessage extends ApiChatMessageData { sourceId?: string }`;
   `ContextBuildResult.messages: ContextPayloadMessage[]`、`estimatedTokens` 移除。
3. `context-builder.ts`:新 `convertWithSourceIds` = 逐則
   `ChatService.convertDbMessageToApiChatMessageData` + mirror `normalizeMessagesForApi`
   的 empty-system filter(不 fork;payload 與舊路徑 bit-identical);每行 `sourceId =
   db id`;summary row `sourceId = entry.id`。
4. `index.ts`:exports 同步(去 estimate*,加 messageBytes / apiMessageBytes /
   deriveRealMessageTokens / messageSize / tailStartOf / ContextPayloadMessage)。
5. `stores/chat/index.svelte.ts`:trigger = `contextStatsStore.contextUsed`(byte
   fallback scan 移除);toast `after = plan.estimatedTokensAfter +
   resolveSummarySize(summary.tokens, cmp.content)`(**決策**:與成功判定同源);新
   `pathRealTokens(path)`;`buildRegionPlan` / recompact / boundary-move 的
   `estimatedTokensBefore` 皆真實。
6. `stores/agentic/index.svelte.ts`:trigger = `isActive ? contextStatsStore.contextUsed
   : lastPrompt`(**決策**:contextUsed 是 active 對話的數,非 active flow 用它是 bug;
   非 active = 該 turn 真實 prompt_n;null → 不觸發,無 byte fallback);toast 同 chat
   store。
7. `DialogContextInspector.svelte`:標題/總和條 = `contextUsed` / `contextTotal`(= gauge,
   「Real context: N tokens (P% of n_ctx)」);每則**主欄** = real(system `-`、尾端
   `est. N` = bytes/4、path 中間未歸屬 = 0)、**副欄** = `bytes / ~bytes÷4 est.`;
   `fullPathTokens` = 真實總和;expand 描述「from」= payload 各列 real 加總
   (`payloadRealTokens`)。⚠️ 本輪補修:payload row 模板殘留 `row.tokens`（`PayloadRow`
   無此欄位 → svelte-check 必掛 + runtime NaN）,依 04-§2.2 改渲染
   `{row.main} <span class="opacity-60">({row.sub})</span>`。
8. `ChatMessageCompaction.svelte`:N→M = `meta.estimatedTokensBefore`(現為真實)→
   `real ?? bytes/4`;`droppedTokens` / `fullPathTokens` 真實。
9. `settings.constants.ts`:`contextKeepRecentTokens` label (bytes)→(tokens) + help;
   `contextCompactionThreshold` help「last prompt」→「real context usage (the gauge)」。

**測試**（全數更新完成；2026-10-17 使用者完整指令全綠）:
- ✅ `tests/unit/compaction-policy.test.ts` 全數重寫（2026-10-17 本輪已核實）：
  fixture `assistantTimed(id, content, prompt, predicted, cache)`；新 suite
  `deriveRealMessageTokens`(6) / `tailStartOf`(3) / `messageSize`(4)；
  `planCompaction`(11) / `planCompactionRecentWindow`(10) /
  `evaluateCompactionResult`(6) / `estimateCompactionSavings`(7) 改 token-scale
  期望值；byte suite 改名 `messageBytes` / `apiMessageBytes`（斷言不變）。
- ✅ `tests/unit/context-builder.test.ts`：import 除 `estimateTokens`；mock 改
  `ChatService.convertDbMessageToApiChatMessageData`（per-message
  `{content, role, reasoning_content?}`；empty-system filter 在 builder 端）；
  刪 `result.estimatedTokens` 斷言；所有 `result.messages` `toEqual` 補
  `sourceId`（`message()` 依建立順序 m1..mN；summary row = `cmp.id`）。
- ✅ `tests/unit/summarize.test.ts`：3 處 `CompactionPlan` literal 補
  `keptTokens` + `realMessageTokens: new Map()`（`makePlan` / `makePlanWithHead`
  keptTokens 10；`makeBigKeptPlan` keptTokens 10000）；`normalizeMessagesForApi`
  mock 保留（summarize.ts 仍在用）；mode A postSize 期望 10401 → **10001**
  （= summary 1 + `plan.keptTokens`；v4 成功判定不讀 head bytes）。
- ✅ `tests/client/context-inspector.svelte.test.ts`：finalAssistant fixture 加
  `timings: { prompt_n: 1500, predicted_n: 100 }` → contextUsed 1600、n_ctx
  32768 → 4.9%；`Estimated send:` → `Real context:`；舊「row 加總 = header」
  不變式改**逐列主/副欄斷言**（新 `tokenCell` helper 抓 `span.font-mono`）：
  system `- (16 Bytes / ~4 est.)`、summary `- (132 Bytes / ~33 est.)`、kept
  `1,500 (19 Bytes / ~5 est.)`（首段真實總和歸該段最後一則非-assistant）、
  final `100 (15 Bytes / ~4 est.)`（predicted_n）。
- ✅ `tests/client/context-gauge-compaction.svelte.test.ts`：`~1,658`（v3 byte
  語義）→ `~1,840`（v4 `estimateCompactionSavings` = 1840 − real payload；
  fixture 無 timings → payload 計 0）；fixture 註解同步。
- 回歸（跑確認；本輪靜態掃描皆無 token 相關斷言、零改動）：
  `tests/client/chat-message-compaction.svelte.test.ts`（L159 `~1,840` N 側 =
  `meta.estimatedTokensBefore` 不變；M 側 = real ?? bytes/4 → fixture 無
  timings → cmp 132B/4 = `~33`；expand 描述斷言為通用文案）/
  `compaction-decision-card`（props 自含 postSize/target）/
  `settings-registry-invariants`（純 load/sync/reset 不變式）。
 - 🐛 **第一輪修復（2026-10-17；`compaction-policy.test.ts` 9 失敗、3 根因全在
   測試檔、來源碼零改動）**:① 漏 import `evaluateCompactionResult`（6 失敗 +
   check 10 錯）→ 補上；② planCompaction fixture `prompt_n` 與段公式
   `seg = prompt[i+1] − prompt[i] − predicted[i]` 算術不一致（每輪 prompt =
   前輪 prompt + 前輪 predicted + 本輪 user 400）→ a4 4800→5200、a5
   5200→6000；③ `estimateCompactionSavings` 期望 1900→1700 ×2 + 註解重算
   （entry 在尾端無真實值 → bytes/4 = 200 計入 payload，02-§3.4(v4)；
   使用者確認「暫時 bytes/4、僅提示用途、差距太大可移除」，見檔首恢復點）。

**Wire 安全**:`sendMessage` / `preEncode` 逐則 map 成
`{content, role, tool_call_id, tool_calls, reasoning_content}` → `sourceId` 不會進
request body(已確認 chat.service.ts:1142-1162 / 883-897)。

## 3.26 N7 — 壓縮進行中：輸入 queue + in-chat 指標列（Stop）（分析 + 決策 2026-10-04；✅ 完成並確認 2026-10-04）

> 觸發：使用者要求「自動壓縮同時 user 輸入的部份，UI 要有明確提示（類似
> Summarized message 列）+ 可中止 + 阻止輸入」。檢視現有 code 後改採
> **queue**（與既有 streaming-pending / steering 一致；硬阻止有逃生問題），
> 使用者 2026-10-04 確認。設計：04-§4.2；實做清單：05-N7。

### 問題（已對 code 驗證，2026-10-04）

1. **fire-and-forget**：`streamChatCompletion` 兩個 post-flow 觸發點
   （`chat/index.svelte.ts:1862` agentic / `:1926` 非 agentic）=
   `void this.compactConversation(convId, { auto: true })`；completion
   handler 立刻返回、UI 解鎖。
2. **guard 一次性**：`compactConversation` 的 I7 檢查（`:565-567`，
   `isChatLoading` / `isRunning` / `compacting`）只在開頭；summary 進行中不重查、
   不中斷。`sendMessage`（`:1309`）**完全不查 `compacting`**；form 也未 disable
   （`ChatScreen.svelte:357` disabled = propsError || editing）。
3. **競態結果**（active conversation；`resolveConversationPath` `:1102` 回傳
   **live** `activeMessages`，cmp parent 在 summary await **後**才求值 `:661`）：
   - 新 turn 的 stream 在 summary 完成**後**結束 → `updateCurrentNode(新 assistant)`
     覆蓋 `updateCurrentNode(cmp)` → **cmp 懸空**（DB 裡是子節點、不在
     active path）→ Summary **靜默丟失**（任何 path 重 derive 都排除它；
     in-memory 陣列尾含 cmp 與 DB currNode 分岔）；下次檢查再觸發第二次壓縮。
   - 新 turn 先結束 → cmp 掛新 assistant 之後 → 一致（不丟）。
   - 兩 case 共同：新訊息以**未壓縮完整 context** 送出 → context 已近
     window（觸發原因）→ **overflow 風險**。
4. **手動路徑同窗**：Compact now / Re-summarize / 斷點後移（皆設 `compacting`、
   數秒級 summary 呼叫）有完全相同的 race。
5. **in-loop 不受影響**：loop 被 `await compactBetweenTurns` block；輸入 →
   steering（`isRunning` true）。
6. 進行中狀態僅 gauge popup 可見；post-flow 在聊天區無 Stop 入口
   （N3 Stop 在 inspector / cmp row）。

### 決策（使用者 2026-10-04 確認）

- **D1 queue，不 block**：輸入 → `pendingMessages`（既有 single-slot；後送覆蓋
  前送，與 streaming 期間同語義）→ 壓縮結束（成功 / gate skip / 失敗 / abort，
  皆 fail-open）由 finalizer 自動送。不 disable 輸入框。
- **D2 in-chat 指標列**：訊息列尾端獨立 row（與超標卡片同錨點、位於其上方）：
  spinner + 「Compacting context…」+ [Stop]；per-conv（新增 `compactingConvId`）；
  尾端已是 cmp 時讓位給真 cmp row；post-flow gate 顯示超標卡片時讓位
  （in-loop 卡片在 agentic 訊息內、不讓位）。
- **D3 Stop 分派**：in-loop（`isRunning`）→ `stopGeneration()`（flow signal →
  summary 中斷 fail-open → flow 結束）；post-flow / 手動 → `stopCompaction()`
  （既有）。pending row 的 Send-immediately = `abortCurrentFlow` 補
  `stopCompaction()` → finalizer 自動送。
- **D4 store 層是主修**：guard 在 `sendMessage`（steering / streaming-pending
  之後第三層）；`compacting = true` 前移至 guard 通過後立刻（收 async 窗口）；
  四條路徑（chatStore 3 + agentic 1）皆帶 convId 設定/清除
  （`setCompacting` helper）。
- **D5 範圍**：四條 compaction 路徑全部覆蓋（auto + 手動 3 條）；in-loop 的
  輸入仍走 steering（不變）。

### 狀態

- ✅ **已實做（2026-10-04）**——明細見 §2u（store 層五處 + 新元件 +
  `ChatMessages` 插入 + 三個消費者 per-conv + client 11 支）。
- ✅ **跑測（2026-10-04，使用者確認全綠）**：四輪 8 支失敗全在測試檔
  （LazyChatMessage 異步 mount 未等 / conversation 未入 list / Svelte 5
  `$derived` cache 過期 → `contextTotal` stale null / 舊測試未帶 per-conv
  `compactingConvId`（第三 + 第四輪）），全數已修、來源碼零改動（根因明細見
  §2u「跑測記錄」）；最終重跑 `chat-message-compaction` 11/11 + `npm run
  check` + 回歸 `chat-message-compacting` / `context-gauge-compaction` /
  `context-inspector` / `compaction-decision-card` 全綠。
- 實做順序（依建議完成）：context-stats flag → chatStore guard + finalizer →
  agentic flag → `abortCurrentFlow` → 指標列元件 + `ChatMessages` 插入 →
  client 測試 → （待）手動驗收（05-§3 新增 5 項，#8–#12）。
- 設計補充兩點（§2u「設計補充」）：finalizer 的 conv 已切走例外（pending 留
  queue 不送）+ 三個既有 `compacting` 消費者改 per-conv。

### 3.27 N8：第二次壓縮 plan 在 raw path（bug）— 根因 + 修正（分析 + 規劃 2026-10-18；N8.1–N8.3 已實做、N8.4 第一輪測試修正後待重跑確認）

> 觸發：使用者實測 agentic loop——第一次自動壓縮 OK；loop 續跑、第二次觸發時
> summary 呼叫實際送出 `[system, user_prompt, 001..199（全量原始歷史）,
> summary_prompt]`，context 超過 LLM 能處理的大小、無法產生 summary，loop 卡死。
> inspector 顯示 `[system, summary, 101..199]`，兩者分岔。分析已對 code 驗證
> （2026-10-18）。

#### 問題（確認）

- **症狀**：第一次壓縮 OK（raw path = 全量歷史、送得出）；第二次觸發時 summary
  呼叫 context overflow → throw → fail-open 不建 cmp → 下一輪主 LLM 呼叫也超標
  → agentic loop 卡在超標 context（用戶輸入不受阻、但 flow 無法推進）。
- **根因（單一）**：兩個 planning 呼叫點把 **raw DB path**（root→currNode，含全部
  原始訊息 + 舊 cmp 節點）餵給 policy；policy 在 raw path 上切
  `toSummarize = path[systemStart..cutIndex)`（`compaction-policy.ts:440/621`）→
  `toSummarize` 含**已被舊 cmp drop 的原始訊息**；prefix-stable（default）
  `summarizeMessages`（`summarize.ts:213-223`）把 `toSummarize` 整段轉成
  `[systemHead, …toSummarize, instruction]` 送出 → 重送整段原始歷史：
  - `stores/agentic/index.svelte.ts:552-560`（`compactBetweenTurns`，in-loop auto，
    使用者場景）
  - `stores/chat/index.svelte.ts:617-625`（`compactConversation`，post-flow auto +
    手動 Compact now，同病）
- **inspector 為什麼對**：它走 `buildLlmContext`（builder 套用 cmp）→ 顯示
  effective context `[system, summary, 101..199]`。送出路徑與壓縮路徑用了兩種
  path 觀點 → 違反 WYSIWYG 不變式（03-§2、README TL;DR #3）。
- **附帶危害**：`deriveRealMessageTokens` / `estimatedTokensBefore/After` /
  `keptTokens` 在 raw path 上算 → 多算已 drop 訊息 → 成功判定與 toast 數字偏離
  gauge（`contextUsed` = effective payload 真實用量）；transcript 模式（fallback）
  同病（`buildSummaryTranscript(plan.toSummarize)` 也是全量 raw 歷史）。
- **測試盲區**：`tests/unit/compaction-policy.test.ts` plan 段**從未**把含舊 cmp 的
  path 餵 `planCompaction*`（cmp fixture 只給 `estimateCompactionSavings` 用，該
  函式有正確處理 entry）。

#### 設計意圖（不是設計缺口、是實做偏離）

- 02-§4 邊界表「第二次壓縮（已有一筆 cmp）」：新 cmp 的 summarize 區包含
  **舊 cmp 節點**、舊 cmp 被 drop、新 summary 涵蓋它（rolling summary；I2「零
  特殊處理」，另見本檔 §3.10）。
- 意圖 = 在 **effective path**（LLM 實際看到的 path = builder 觀點）上 plan；
  實做漏了「planning 前先 collapse path」這一步。

#### 修正計畫（已確認；執行清單 05-N8 / §5d）

**核心：planning 改在 effective path（builder 觀點）上做。**

1. `services/context/context-builder.ts` 新增純函式
   `effectiveCompactionPath(path): DatabaseMessage[]`：
   - 無 cmp entry → 原樣回傳 `path`；
   - 窗口解析與 `buildLlmContext` **完全共用**（I1 system head / I2 最後一筆生效 /
     I3 fail-open）：把 `buildLlmContext` 現行窗口解析抽成共用內部 helper
     （`resolveCompactionWindow`）、兩處都用 → 結構上保證「planning 輸入 ==
     builder 輸入」；
   - boundary 失效（id 不存在 / 指到 system head）→ 回傳 `path`（mirror builder
     的 fail-open 全量送出）；
   - 否則 → `[...head, entry, ...path.slice(keptIndex).filter(m => m.id !==
     entry.id)]`（entry 留在陣列當一般節點；role=user 本來就合法）。
2. 兩個 planning 呼叫點改餵 effective path（**唯二**的新壓縮 planner）：
   - `stores/agentic/index.svelte.ts` `compactBetweenTurns`：
     `planCompaction*(effectiveCompactionPath(path), …)`
   - `stores/chat/index.svelte.ts` `compactConversation`：同上。
   - **下游全部不動**（已驗證正確）：`parentId`（raw path 末筆）/
     `preCompactionPath` snapshot / `triggerPreEncode`（builder 拿新 cmp 套 raw
     path → 正確新前綴）/ agentic `sessionMessages` 重建（`buildLlmContext(
     [...preCompactionPath, cmp])`）/ cmp meta（`summarizedCount =
     plan.toSummarize.length`，現含舊 cmp 一筆、屬預期）。
3. **順手修正（自動）**：token 會計改在 effective path 上 →
   `estimatedTokensBefore/After` / `keptTokens` / 成功判定與 gauge 一致；
   `isSplitTurn` / `minSummarizeTokens` / `minKeptUserTurns` 安全檢查作用在正確
   規模；兩種 summary mode（prefix-stable / transcript）都修好。
4. **明確不改**：
   - `recompactConversationEntry` / `moveCompactionBoundary`（後移）：手動
     「重新摘要同一區」**刻意**用 raw 原始區重算（`buildRegionPlan`，
     `chat/index.svelte.ts:1199-1224`）——從原始資料重產 summary 是設計功能。
     （已知獨立限制：對超大原始區 re-summarize 也可能 overflow；本次不處理。）
   - `estimateCompactionSavings`（raw path 上已正確處理 entry）。
   - **policy 函式本身不改契約**（「plan what you're given」）、collapse 放呼叫端。
     理由：03-§1 分層（builder 擁有「套用既有 cmp」語義、policy 只決定切點）+ inspector
     的 recompact 路徑手動組 plan、不受影響。（替代案：collapse 塞進
     `planCompaction*` 內部可防未來新呼叫點；預設採呼叫端版本——diff 最小、
     可審性最好。）

#### 修正後行為（使用者場景）

```
第二次壓縮: effective path = [system, cmp_1, 101..199]
plan → toSummarize = [cmp_1, 101..cut], kept = [cut..199]
summary 呼叫 = [system, cmp_1 (user), 101..cut, instruction]   ← 放得下 context
新 summary 涵蓋「舊 summary + 新訊息」(rolling)；
新 cmp.firstKeptMessageId 指向 kept 區真實 DB 訊息；
下一輪 payload = [system, cmp_2, kept]
```

#### 邊界情境（測試要覆蓋）

1. 舊 cmp 在 `toSummarize` 內 → `convertDbMessageToApiChatMessageData` 轉成 plain
   user 訊息（已驗證 code 路徑 OK；加測試鎖定）。
2. 切點恰好落在舊 cmp 上（role=user 是合法切點）→ 新 boundary = 舊 cmp id → 舊
   summary 在 kept 區原樣再送一次（I2 接受的 duplication；罕見；文件註記）。
3. effective path 上空 kept（cutIndex = length）→ `firstKeptMessageId` 缺 →
   builder 行為不變。
4. I3 fail-open（boundary 失效）→ effective = raw → 行為等同今天、不回歸。
5. 多筆舊 cmp：只有最後一筆生效；更早的 cmp 留在 kept 區當一般 user 節點。
6. `summarizedCount` 含舊 cmp 一筆（cosmetic：cmp row / gauge 的「Summarized N
   messages」；可選：顯示時扣除或加註）。

#### 測試計畫

- `tests/unit/context-builder.test.ts`：新 `effectiveCompactionPath` suite（無
  entry / 單 cmp / 空 kept / I3 ×2 / entry 後追加訊息 / 舊 cmp 落 kept 區）。
- `tests/unit/compaction-policy.test.ts`：新「第二次壓縮」向量（
  `effectiveCompactionPath` → `planCompactionRecentWindow` / `planCompaction`
  ）：summarize 區不含已 drop 原始訊息、`firstKeptMessageId` 來自 cmp 後區域、
  `summarizeTokens` ≈ effective 規模。
- `tests/unit/summarize.test.ts`：prefix-stable payload 形狀加「path 已含舊 cmp」
  向量（鎖定送出 = `[system, 舊summary, 新訊息, instruction]`）。
- client 既有 5 支 compaction suite（`chat-message-compaction` /
  `context-inspector` / `context-gauge-compaction` / `compaction-decision-card` /
  `chat-message-compacting`）零改動過關。
- **手動驗收（使用者原始場景）**：agentic loop 連壓兩次；devtools / inspector
  確認第二次 summary 請求 = `[system, 舊summary, 101..199, instruction]`、loop
  正常續跑。

#### 狀態

- ✅ **N8 完成（代碼 + 回歸，2026-10-18）**：N8.1 `resolveCompactionWindow`
  + `CompactionWindow` + `effectiveCompactionPath` export + barrel；N8.2 兩呼叫點
  餵 `planPath`、下游零改動；N8.3 三 unit 檔新增 10 用例（context-builder 7 /
  compaction-policy 2 / summarize 1）；N8.4 回歸全綠（`npm run check` + 3 unit
  檔 + 5 client compaction suite）。剩手動驗收（使用者原始場景：agentic loop
  連壓兩次）。
- **第一輪 2 失敗全在測試檔已修、來源碼零改動（根因索引）**：
  `compaction-policy.test.ts` N8「第二次壓縮」向量兩筆期望值
  `toSummarize = ['cmp1', 'a1']` 筆誤——測試自己的 fixture（`cmp1.
  firstKeptMessageId = 'u1'`）把 u1 放在 effective path 內、自己又斷言切點
  在 u2 → plan 的連續分割契約下 `toSummarize` 必然是 `[cmp1, u1, a1]`、原期望
  不可達。修正 = 兩筆期望陣列補 `'u1'` + 兩筆註解（含「cmp1 = first
  segment」誤標——v4 規則第一段總和歸段內最後非-assistant = u1、cmp1 計 0）。

## 3.28 N9: F5 / refresh 韌性 — in-loop compaction 兩寫非原子（問題驗證 + 規格 2026-10-18；未實做）

### 問題（已對 code 驗證，2026-10-18）

使用者問題：agentic loop 內觸發自動壓縮、summary node 產生後繼續執行，F5 後
summary node 不見、context 超過 LLM 能處理的大小、造成整個狀態損毀——會不會發生？

**結論：會，在兩個視窗（其中一個正是題述鏈）；不是「永久狀態損毀」（無資料
遺失、可恢復），而是暫時性 hard failure + 不可見孤兒節點。**

**已驗證的持久化鏈：**

1. Agentic loop：assistant / tool 訊息建立時即逐則落 DB
   （`createMessageBranch`，`chat/index.svelte.ts:1651–1714`），`currNode` 同步推進
   （active → `conversationsStore.updateCurrentNode` → DB；non-active →
   `DatabaseService.updateCurrentNode` 直寫）。
2. In-loop compaction `compactBetweenTurns`
   （`agentic/index.svelte.ts:481–660`，call site `:1226`——本 turn tool results
   落 DB 後、下一 turn 送出前）：
   - `DatabaseService.createCompactionMessage`
     （`database.service.ts:282–319`）：**單一 IDB transaction**（add cmp + 附到
     parent `children`），原子。
   - `updateCurrentNode(cmp.id)`（`agentic:624/626`、`chat:686/688` →
     `database.service.ts:725–729`）：**另一次 IDB 寫入**（conversations 表），
     **與上者非原子**。
3. F5 → `loadConversation`（`conversations/index.svelte.ts:521–549`）→
   `activeMessages = filterByLeafNodeId(allMessages, currNode)`（沿 DB currNode
   的 parent 鏈回溯）。
4. `buildLlmContext`（`context-builder.ts:157`）只認 **path 上** 的 cmp
   （`findLastCompactionEntry`）；path 上無 cmp → 全量送出。
5. **載入路徑沒有任何 orphan cmp 修復邏輯**（conversations store 無 orphan /
   COMPACTION 處理）。
6. （補充）F5 後 `discoverActiveStream`（`+page.svelte:88/108/127`）可能把
   server 端 in-flight stream 接回、完成目前 assistant turn，但 in-memory agentic
   loop（tool 執行、turn k+1）不會復原——既有行為、N9 範圍外。

**F5 三個時機：**

| F5 時機 | cmp 在 DB？ | currNode | reload 後 path | 結果 |
| --- | --- | --- | --- | --- |
| A. summary LLM 呼叫中 / gate 卡片等待中（`createCompactionMessage` 前） | 無（abort → fail-open、不建 cmp） | 最後一則 | 全量 | 設計中的 fail-open。≤n_ctx：下一則送出成功、下個 flow-complete 自動再觸發（自愈；`contextUsed` 從持久化的 timings 重算）；>n_ctx：下一則送出 overflow → hard failure、需手動 compact |
| B. **`createCompactionMessage` 與 `updateCurrentNode` 之間**（ms 級視窗；`updateCurrentNode` 拋錯同路徑） | **有（orphan）** | 指向 cmp 的 parent | 全量（cmp 不在 path） | **題述鏈**：cmp「不見」（在 DB 但不可見——leaf 的 child、不在 active path）→ 全量送出 → overflow + 留不可見孤兒節點 |
| C. `updateCurrentNode` commit 後 | 有 | cmp（或更後節點） | 含 cmp | **節點不消失**、狀態一致 |

- **A 是最可能按 F5 的時刻**（「Compacting context…」顯示中、呼叫數秒到數分鐘、
  「畫面卡住就重刷」是最可能的使用者行為）；後果較輕（無 orphan）。
- **B 的視窗 ms 級**（兩個 awaited IDB operation 之間），低機率但真實；
  `updateCurrentNode` 拋錯（IDB quota / locked 等）會放大。

**「狀態損毀」評估：**

- **無資料遺失**：compaction 從不刪除任何原始訊息（只加節點 + 移 currNode），
  完整歷史恆在 DB。
- **暫時性 hard failure**：A（>n_ctx）/ B 時，下一則 LLM 送出以 context overflow
  失敗（server error dialog）；user 需手動 Compact now（inspector 入口恆可用、
  手動跳過 threshold gate）或刪訊息才能恢復。
- B 另留 **不可見 orphan cmp**（leaf 的 child；UI 只顯示 active path，永遠看不到）。

### 規格（N9，未實做）

- **N9.1（根因修、建議）— cmp + currNode 原子 commit**：新
  `DatabaseService.commitCompactionMessage({ convId, parentId, content,
  compactionMeta })`：**單一** IDB transaction 跨 `[messages, conversations]`——add
  cmp + 附 parent children + `currNode = cmp.id`，all-or-nothing（與既有
  `expandCompactionMessage` 同一 transaction 模式，`database.service.ts:335–339`）。
  兩個呼叫點（`agentic compactBetweenTurns`、`chat compactConversation`）改走原子
  commit、移除獨立 `updateCurrentNode`。效果：視窗 B 完全消失；transaction commit
  後任何時刻 F5 → 狀態一致。視窗 A 是固有的（summary 在 LLM 呼叫回傳前不存在），
  由 N9.4 語義 +（可選）N9.3 涵蓋。
- **N9.2（防禦層）— 載入時收編 orphan cmp**：`loadConversation`（或 app 啟動、
  每 conversation 一次）偵測「cmp 是 currNode 的 child」簽名（`type === COMPACTION`
  且 `parent === conversation.currNode`）→ **收編**：`currNode = cmp.id`（持久化 +
  in-memory）。此簽名只能來自中斷的兩寫序列：完整 commit 後 currNode 不會回到 leaf
  且其 child cmp 仍存（唯一把 currNode 移回 parent 的路徑 expand 會刪掉 cmp）；
  完整 commit 後 user 若從 leaf branch，currNode 會是 cmp 的 descendant 而非 leaf。
  效果：修復 DB 中已發生的視窗 B 狀態（含 N9.1 上線前產生的 orphan）。偵測抽純函式
  （如 `findOrphanedCompaction(allMessages, currNode) → cmpId | null`）供 unit 測試。
- **N9.3（UX 安全網、可選）— 送出前 overflow guard**：送出 choke point 若 built
  payload 估計 > n_ctx → 擋下送出 + dialog [Compact now / 刪訊息 / 強制送出]，
  不讓 request 出包失敗。把殘餘失敗態（A 的 >n_ctx、任何既有超標狀態）變成引導式
  恢復；與 F5 正交。
- **N9.4（文件）— fail-open 語義定案**：「F5 / abort 在 summary 呼叫中 = 壓縮取消：
  不建 cmp、對話維持全量 context；auto-compaction 在下個 flow-complete / turn
  boundary 再觸發。」加入 02-§4。

**明確不做**：agentic loop 跨 F5 可復原（in-memory loop 不復原；server-side stream
可能經 `discoverActiveStream` 接回完成目前 turn、但 tool 執行不復原——既有）；N7
in-memory queue（pending messages）F5 即失（既有、輕微）。

### 測試計畫

- unit：`findOrphanedCompaction` 純函式（若 N9.2 採此形式）：(a) cmp 是 leaf 的
  child → 收編；(b) cmp 是 leaf 的 descendant（正常 commit 後）→ 無；(c) 無 cmp →
  無；(d) cmp 在其它分支（parent 不在 path）→ 無。
- Dexie 層（`commitCompactionMessage` transaction 語義）依既有慣例不在 unit 範圍
  （見 §4 Phase 1 5.4/5.5 註記），以手動驗收覆蓋。
- 手動驗收：
  1. In-loop compaction：在 `updateCurrentNode` 設 breakpoint（模擬視窗內 F5）→
     F5 → 對話顯示 cmp row、payload = `[system, summary, kept]`、不 overflow（N9.1）；
  2. F5 在 summary 呼叫中（「Compacting…」）→ reload 後無 cmp、全量 context；
     ≤n_ctx：下一則送出成功且 flow 完成後自動再壓縮；>n_ctx：overflow dialog
     （N9.3 若實做則為 guard）；
  3. 預植 orphan 狀態（devtools：手動把 currNode 改回 cmp 的 parent）→ 開啟對話 →
     自動收編（cmp row 出現、payload 壓縮）（N9.2）。
- 回歸：`npm run check` + 既有 5 支 client compaction suite + conversations-store
  相關 suite。

### 狀態

- ⬜ **未實做**（規格定稿 2026-10-18；執行清單 §5e / 05-N9）。

## 3.29 N10: in-loop compaction 的 cmp 被接成 sibling（系統性 bug；根因 + 修正 2026-10-18；✅ 完成並確認）

### 問題（使用者回報 + 已對 code 驗證，2026-10-18）

使用者場景：agentic loop 正常完成後，UI 顯示
`[system, 001…099, summary, 101…196, summary, 201…999]`（summary 看得到）；
但只要 (1) 匯出後再匯入 或 (2) F5 重新整理，**所有 summary node 消失**、
inspector 顯示全量訊息、session 無法繼續（context overflow）。

**結論：不是 §3.28 的競態視窗（那是 ms 級、低機率）；這是系統性 bug——
in-loop compaction 把 cmp 節點接成「下一則 flow 訊息的 sibling」而不是它的
parent。in-memory 平陣列遮住分岔、DB 樹暴露分岔。**

### 根因（已對 code 驗證）

1. `compactBetweenTurns`（`agentic/index.svelte.ts:481–660`）建 cmp：
   `parentId = path[path.length - 1].id`（= 最後一則 tool result，例 099）。
   這一步本身正確（cmp 成為當下 leaf）。
2. 但 flow 的下一則 assistant 訊息走 `createAssistantMessage` 回調
   （`chat/index.svelte.ts:1651–1678`）→ `createMessageBranch(…, lastCreatedInFlow)`。
   `lastCreatedInFlow` 是 `streamChatCompletion` 的 closure 變數（`:1596` 初始化，
   只在 `:1675` assistant 建立 / `:1711` tool result 建立時更新）——
   **compaction 從不更新它**。
3. ⇒ `101.parent = 099 = cmp1.parent`：**cmp1 與 101 是 sibling**。第二次
   compaction 同構（cmp2 與 201 sibling）。
4. DB 樹實際形態：
   ```
   099
   ├── cmp1          (leaf、死胡同，不在 root→currNode 路徑上)
   └── 101 → … → 196
                    ├── cmp2      (leaf、死胡同)
                    └── 201 → … → 999  (currNode)
   ```
5. in-memory `activeMessages` 是平陣列：`addMessageToActive(cmp)` 附在 099 後、
   flow 再附 101 → 陣列順序 `[…099, cmp1, 101…]` 看起來正確 → UI 顯示 summary、
   `buildLlmContext(陣列)` 套用 cmp → loop 正常跑、flow 期間 payload 正確。
6. **任何從樹重建的路徑都丟 cmp**：F5（`loadConversation` →
   `filterByLeafNodeId` 沿 parent 鏈）；匯出（`getConversationsForExport` →
   `getConversationsWithMessages` 從 DB 取）→ JSONL 保留 parent 指針 → 匯入
   （`importConversations` → `db.messages.put(msg)`）→ load。cmp 不在
   root→currNode 路徑 → `buildLlmContext` 看不到 → 全量送出 → overflow。

**為什麼 post-flow 壓縮（`compactConversation`）沒這個問題**：下一則 user 訊息走
`addMessage(…, '-1', …)`（`chat/index.svelte.ts:165–174`）→ parent = live 陣列最後一則
= cmp。只有 in-loop flow 的 `lastCreatedInFlow` closure 變數繞過 cmp。

**與既有規格的關係**：02-§2 I6（「cmp 必須是路徑上的節點」）與 03-§4.4
（「新訊息接在 cmp 之後」）的假設被實做系統性違反；03-§4.4 的設計決策「flow 建
訊息用 `lastCreatedInFlow` 當 parent（不用 currNode），mid-flow 移動 currNode 不影響
flow 的 parent 鏈」正是繞過 cmp 的機制。§3.28 的 N9.2 偵測簽名（cmp 是 currNode 的
child）**抓不到**此案例（這裡 cmp 是路徑中間節點的 sibling），N10 是獨立修正。

### 修正規格（N10，✅ 已實做）

- **N10.1（根因修）— compaction 後推進 flow 的接掛點**：
  - agentic flow 的 callback 集新增 `onCompaction?(cmp: DatabaseMessage)`。
  - `streamChatCompletion`（chat store）接線：`onCompaction: (cmp) =>
    { lastCreatedInFlow = cmp.id; }`。
  - `compactBetweenTurns` 在 `createCompactionMessage` + currNode 更新成功後呼叫
    `callbacks.onCompaction?.(cmp)`（需把 callbacks 傳入）。
  - 效果：下一則 assistant / tool 訊息接在 cmp 之下 → DB 樹 == in-memory 陣列 →
    F5 / 匯出匯入都保留 cmp 在路徑上。`firstKeptMessageId` 指向的訊息（kept 區
    起點）仍在路徑上、不變。
  - 與 N9.1 的順序：若 N9.1 先做（原子 commit），`onCompaction` 在原子 commit
    之後呼叫；兩者獨立、可並行實做。
- **N10.2（資料修復）— 修復已損樹（既有對話）**：
  - 純函式 `findCompactionGraftFixes(allMessages, currNodeId) →
    { cmpId, reattachId }[]`：對每則 cmp `c`（`type === COMPACTION`），令
    `p = c.parent`；若 `p` 有 child `c2 ≠ c` 且 `c2` 是 `currNodeId` 的祖先（active
    路徑經 c2 不經 c）→ 輸出 fix `{ cmpId: c.id, reattachId: c2.id }`。
  - 套用（單一 IDB transaction）：`c2.parent = c.id`、`p.children` 移除 `c2.id`、
    `c.children` 加入 `c2.id`。cmp 建立時是 leaf，`c.children` 原為空。
  - 觸發：app 啟動時一次性 migration（掃所有 conversations）+ `loadConversation`
    時檢查（防禦層，成本低）。冪等：修完後 c 在路徑上、偵測不再命中；多筆 cmp
    依路徑由上而下修（每筆 fix 只動一條邊、互不影響，單 pass 即可，保險可
    loop-until-stable）。
  - 邊界：currNode 在 c 的 subtree 內（正常 post-flow 態）→ 不命中；cmp 在非
    active 分支 → 不命中（`c2` 不是 currNode 祖先）。
  - 效果：已損對話恢復（路徑含 cmp、inspector 顯示壓縮後 context、session 可繼
    續）；只動拓撲、不動 content / compactionMeta。
- **N10.3（測試）**：
  - unit `findCompactionGraftFixes` 向量：(a) 錯接 sibling → fix；(b) 正常
    post-flow cmp（currNode 是 cmp descendant）→ 無；(c) 無 cmp → 無；(d) cmp 在
    其它分支 → 無；(e) 兩筆錯接 cmp → 兩筆 fix。
  - 回歸（核心）：in-loop compaction 後，下一則 assistant 訊息的 `parent ===
    cmp.id`（DB 樹必須 == 平陣列）。
  - 手動驗收（使用者原始場景）：agentic loop 連壓兩次後正常停下 → F5 → summary
    都在、inspector = 壓縮後 context；匯出 → 匯入 → 同；session 可繼續（下一則
    訊息送出正常）。
- **與 N9 的關係**：N9.1（原子 commit，修 currNode 指針競態）與 N9.2（收編
  currNode 的 child）仍需要、與 N10 互補；N10.2 的偵測簽名不同（sibling of path
  node vs child of leaf）。

### 狀態

- ✅ **完成並確認（2026-10-18）**：N10.1 根因修（`onCompaction` callback + `lastCreatedInFlow` 推進）+ N10.2 已損樹修復（`findCompactionGraftFixes` 純函式 + `applyCompactionGraftFixes` IDB transaction + 啟動 migration `compaction-graft-fix-v1` + `loadConversation` 防禦層）+ N10.3 unit 5 向量（`tests/unit/branching.test.ts`）；`npm run check` + unit + 既有 5 支 client compaction suite（`chat-message-compaction` / `context-inspector` / `context-gauge-compaction` / `compaction-decision-card` / `chat-message-compacting`）全綠。剩手動驗收（使用者原始場景：agentic loop 連壓兩次 → F5 / 匯出匯入 summary 都在 + 既有已損對話 migration 後恢復；§4 清單）。

## 3.30 N11: compact request 前綴一致性 — tool result 附件被丟 + mode B 切點 cache 亲和性（問題驗證 + 規劃 + 實做 2026-10-18；source + 測試完成、待確認）

### 問題（使用者回報 + 抓包驗證，2026-10-18）

使用者場景：agentic loop（設定：mode B threshold-target、threshold 40%、keepTarget 35%、
keepMinMessages 0、keepMinUserTurns 1（UI `min: 1` 無法設 0，`settings.constants.ts:266`）、
in-loop + auto compaction 皆 on）`[system, 舊summary, 101..186（無其它 user 訊息）]`
觸發壓縮。兩觀察：

1. compact request 只送 `[system, 舊summary, 101..164, instruction]`（不到 186）→ 使用者
   認為理應 `[system, 舊summary, 101..186, instruction]`。
2. tool call 回傳的 image base64 沒帶進 compact request → KV cache 失效。

**證據（本目錄 `before-trigger.json` = 觸發前實際送出的 payload，1.23MB / 187 則；
`compact-requset.json` = compact request，241KB / 164 則）：**

| 項 | before-trigger.json | compact-requset.json |
| --- | --- | --- |
| 結構 | [舊summary] + 186 則 loop | [舊summary] + 162 則 loop + [instruction] |
| content parts 陣列 | 5 則（1237/1445/1495/1742/1869 行，全為 screenshot tool result） | **0 則** |
| `chrome_cdp_screenshot` 結果（`tool_call_id: 3DoEKZC0…`） | `content: [text, image_url(data:image/png;base64,…)]`（1236–1251 行） | `content: "screenshot — …"` 純字串（1254–1258 行） |
| instruction | — | `SPLIT_TURN_SUMMARY_PROMPT` 變體（1640 行）→ `isSplitTurn = true` |
| max_tokens | — | 183500 = floor(nCtx × 0.7) → **nCtx = 262144** |

→ toSummarize = 101..164（使用者編號）、kept = 165..186（24 則）；compact request 前綴在
**第一張 screenshot（約第 125 則 loop 訊息，before-trigger 1237 行）** 處即與實際送出
payload 分岔——不是使用者觀察的 164。另：第一張圖之前兩檔已有 17 行行號偏移（多則
空 content assistant 的序列化差異，見下「附帶發現」）。

### 問題 1（N11.1，P0 bug）：DB→API 轉換丟掉 tool result 附件

**根因**（`chat.service.ts:142–149`）：`convertDbMessageToApiChatMessageData` 對
`role=tool + toolCallId` early-return `{content: string, role, tool_call_id}`，
**完全忽略 `message.extra`**（MCP screenshot / audio 附件）。主送出路徑是另一條路：
agentic loop 在 tool 執行後自己組 parts（`agentic/index.svelte.ts:1168–1206`；
`extractBase64Attachments` `:1140` 把 base64 存進 `extra`、文字替成
`[Attachment saved: …]`；送出時組 `[text, image_url(base64)]`，model 支持 vision 才帶
image、支持 audio 才帶 input_audio）。兩路徑不相等 → prefix-stable 的 D1 承諾
（「附件原樣送、前綴 byte-identical」，06-§3.18）**對 tool result 從未成立**。

**波及範圍（所有從 DB 重建 payload 的路徑）：**

| # | 消費點 | 路徑 | 後果 |
| --- | --- | --- | --- |
| 1 | compact request | `summarize.ts:213–223` → `normalizeMessagesForApi` → 轉換 | 前綴在第一張 screenshot 分岔 → **抓包 cache 失效的主因** |
| 2 | post-compaction 下一 turn | `agentic:641–645` `buildLlmContext → toAgenticMessages` | kept 區（165..186）的 image 被丟 → 下一 turn 在 kept 區第一張圖分岔（即使 compact request 本身完美也失效） |
| 3 | `toAgenticMessages` 地雷 | `agentic:150–156` | TOOL 分支把 parts → `''`：上游一旦開始產 parts，內容被靜默清空 |
| 4 | F5 / reload 後第一 turn | `agentic:405–408` `resolveOutgoingMessages` | 歷史 tool result 的 image 全丟 → reload 後第一 turn 斷前綴（既有問題、非 compaction 特有） |
| 5 | `preEncode` | `chat.service.ts:873–904` | 用無圖 payload 預熱 KV cache → 下一輪全量 re-prompt（README TL;DR #7 警告的正是這類） |
| 6 | Inspector WYSIWYG | `DialogContextInspector` | 顯示的 payload ≠ in-flow 實際送出的 |

> 06-§2h（202–205 行）當時已記錄「兩邊都丟 tool image parts…live push 的 parts 在
> compaction 後會回到 mapper 語義——**窄邊界情境**」。抓包證明**不是**窄邊界：任何用
> vision tool（MCP screenshot）的 agentic flow 每次都踩到。

**附帶發現（同屬前綴一致性）：**

- **`"content": ""` vs 欄位遺漏**：in-flow 推 assistant 用 `content: turnContent ||
  undefined`（`agentic:947`）→ 空 content 不送；轉換一律送 `content: ''`
  （`chat.service.ts:145/:164`）。抓包裡第一張圖之前已有 17 行行號偏移（多則這種
  空 content assistant，每則多 1 行）。token 影響視 chat template（通常 neutral），
  但違反 byte-identical 保證。
- **image cap 不一致**：轉換有 `capImageDataURLSize`（`chat.service.ts:218`，
  MAX_IMAGE_RESOLUTION），in-flow 直接送原始 `base64Url`（`agentic:1190`，不 cap）→
  就算兩邊都帶圖，base64 也可能不同 → 仍斷前綴。

### 問題 2（N11.2，已決策 = A4）：mode B 切點 vs cache 亲和性

**已驗證行為（by design、非 coding bug）**：`planCompaction`
（`compaction-policy.ts:386–469`）stage 1 找不到 user 邊界（loop 內無 user 訊息）→
stage 2 找 suffix ≤ budget 的**最早**合法切點；budget = (40−35)% × 262144 =
**13107 tokens** → 切在 165、kept = 165..186（24 則、≤ 5%）。

**Cache 分析**（KV cache = 最後一筆實際送出 `[system, 舊summary, 101..184]`；
185/186 尚未被送出過）：

| compact request 形態 | 與 cache 的共同前綴 | 成本 |
| --- | --- | --- |
| 現行（kept = 165..186）：`[…, 101..164, instr]` | 到 164 | 165..184 重算（≤5% n_ctx、一次性） |
| 使用者提案（empty kept）：`[…, 101..186, instr]` | **到 184（完整最後 payload）** | 185/186 + instr 為新 token |

→ mode B 切點（N11.2）單獨**不會**「失效」cache、只是把命中點限制在切點；真正讓命中點縮到 ~125
的是 tool result 附件 bug（N11.1）。使用者的「理應 101..186」= **用最近 24 則 tool 交換不再原樣
保留，換最大 cache 亲和性**（現有設計刻意保留最近 tool 交換原樣，02-§3.1；split
prompt 變體已要求 summary 保留 in-progress state）。

**決策（A4，使用者拍板 2026-10-18）**：非純 A1（empty kept）也非 A2（現狀）——
**summary 輸入 = 整個 effective path + kept 視窗照現行計算**（A1 的 summary 區
+ A2 的 kept 視窗）：

| 環節 | 行為 |
| --- | --- |
| compact request | `[system, 舊summary, 101..186, instr]` = `buildLlmContext(effectivePath).messages` + instruction——**复用原 chat UI code path、不自組裝**；前綴 = 完整最後送出 payload（到 184）、cache 亲和性最大 |
| 切點 / cmp 嫁接 | 不變（切在 165、parent=164、`firstKeptMessageId=165`）——`planCompaction` / budget / 雙 mode 全不改 |
| post-compaction | `[system, 新summary, 165..186]`——kept 尾段 append 到 summary 後繼續執行；165..186 同時在 summary（濃縮）與 kept（原樣）＝**刻意重複、換精確度**（使用者取捨） |

**使用者約束（2026-10-18）**：① 前綴 byte-identical 走原 chat UI code path
（`buildLlmContext` choke point）、不重新組裝；② scope = 所有 compaction
（manual + in-loop + re-summarize、mode A/B）；③ 不加 `fullPathSummary` 等新
meta 欄位（功能未正式推出、既有資料皆內部測試）；④ prompt 文字維持現狀；
⑤ 不做 INSTRUCTION_OVERHEAD / 動態 max_tokens / overflow fallback——summary
呼叫參數 N11 前怎樣就維持怎樣。

### 修正方案（N11，2026-10-18 定案；N11.1 + N11.2 source 改動完成 2026-10-18、未確認）

> **決策記錄（D1，使用者 2026-10-18）**：原規劃 N11.1 #1/#2（轉換加 `model` 參數 +
> 參數 thread）**撤回**——使用者追問「原本 chat UI flow 的 tool call result / user input
> 是怎送的」後確認 **user input 路徑為準**：轉換無條件組 parts
> （固定順序、image 一律 cap、**無 gating**），model gating 由下游既有 `sendMessage`
> vision filter 處理（`chat.service.ts:1114–1140`，遍歷所有 role、`options.model`
> 有值且非 vision 才剔 image、單 text part 塌回 string）。tool result 走**同一條路**：
> ① 轉換的 `extra → parts` 區塊抽成 shared builder，tool+extra 落到它；
> ② in-flow 也調同一個 builder（順手修掉不 cap）；
> ③ parts 順序以 user input 路徑為準 `[...images, ...audio, text]`（使用者確認 in-flow
>    由 `[text, …attachments]` 改為該順序）；
> ④ **不新增 model 參數、不新增 gating、所有簽名不變**（`normalizeMessagesForApi` /
>    `resolveOutgoingMessages` / `buildLlmContext` / `ContextBuildOptions` / `preEncode` /
>    inspector / vision filter 全維持現狀）——原規劃「參數 thread」整段刪除。
> （注意：此 D1 ≠ 06-§3.18 的「D1 承諾」（附件原樣送、前綴 byte-identical）；後者
> 是本修要恢復的設計承諾。）

**一致性驗證（修後四象限）**：ROUTER+vision：兩路 `[image(cap), text]`；
ROUTER+非vision：兩路都組 `[image, text]` → 下游 filter 剔圖塌回 `text`（同）；
single+vision：`effectiveModel` 只在 ROUTER 設（`chat:1570–1576`）→ 無 filter、兩路都送圖；
single+非vision：兩路都送圖（= 現行 user 附圖行為；現行 in-flow 會丟，
行為變化 ④）。compact request（`summarizeMessages` 內 `sendMessage(model: …)` 走同一 filter）
與主送出路徑同 model → 同 filter 結果 → 前綴 byte-identical 結構性成立。

**N11.1（P0）— tool result 與 user input 同路徑**

1. `chat.service.ts`：把現有 `extra → parts` 區塊（`:179–320`，textFiles / legacy /
   images 過 `capImageDataURLSize` / audio / content text / video / pdf / mcp）**原樣抽出**為
   `public static async buildExtraContentParts(message: { content: string; extra?: DatabaseMessageExtra[] }): Promise<ApiChatMessageContentPart[]>`。
2. `convertDbMessageToApiChatMessageData` 重構：
   - `tool + toolCallId + 無 extra` → 現行 plain early-return（含 `tool_call_id`，不變）；
   - `tool + toolCallId + 有 extra` → `{ content: await buildExtraContentParts(message), role: TOOL, tool_call_id }`
     （不再 early-return 丟 extra）；
   - 非 tool 有 extra → 改調 `buildExtraContentParts`（取代 inline 區塊，行為不變）；
   - 非 tool 無 extra（plain 分支）→ **序列化對齊**：`assistant + tool_calls + content === ''`
     → 省略 `content` 欄位（向 in-flow `content: turnContent || undefined`、`agentic:947` 對齊）；其餘不變。
3. `agentic/index.svelte.ts` in-flow `:1168–1206` 整段取代為
   `buildExtraContentParts({ content: cleanedResult, extra: attachments })` + `parts.length === 1 ? cleanedResult : parts`
   （單一 text part 仍塌回 string、no-attachment 情形 wire 不變；開始 cap）。
4. `toAgenticMessages` TOOL 分支（`agentic:150–156`）：`content: message.content` 直通（型別已
   支援 `string | ApiChatMessageContentPart[]`、去掉 `→ ''` 強轉）。
5. 清理不再使用的 import（實做時逐個確認：`ContentPartType` /
   `getAudioInputFormat` / `DatabaseMessageExtraAudioFile` / `DatabaseMessageExtraImageFile`）。
6. `normalizeMessagesForApi` / `resolveOutgoingMessages` / `preEncode` / `sendMessage` / vision filter：**一律不動**
   （preEncode 無 filter = 現行 chat UI flow、user 附圖同存在、不修，行為變化 ⑤）。

N11.1 完成後，波及範圍表 #2–#6（post-compaction 下一 turn、F5 後第一 turn、preEncode、
inspector）自動恢復（同一根因）。N11.1 + N11.2 A4 合成後：compact request =
`[system, 舊summary, 101..186]` + instruction、前綴 byte-identical 到 184。

**行為變化表（相對現行，使用者 2026-10-18 確認）**

| # | 變化 | 一次性成本 |
| --- | --- | --- |
| ① | tool result parts 順序 → `[images, audio, text]` | 既有 agentic 對話自第一則 tool result 起重算 |
| ② | in-flow image 開始 cap（`MAX_IMAGE_RESOLUTION`） | 超標 screenshot 的 base64 一次變化 |
| ③ | tool result audio 不再 gating（照 chat UI：filter 只剔 image） | 無 |
| ④ | single+非vision：tool result 圖會送（現行 in-flow 會丟） | 無（= 現行 user 附圖行為） |
| ⑤ | preEncode 無 filter（ROUTER+非vision 的 warm/next-turn 分岔） | 既有、user 附圖同存在、不修 |

**N11.2（A4，已定案）— full-path summary；改動收在 `summarize.ts` + 2 呼叫點**

1. `summarizeMessages` / `summarizeWithRetry` 收 **`planPath`**（effective path）——
   兩呼叫點已有（`agentic:559` / `chat:623`；re-summarize = `effectiveCompactionPath(path)`），
   **不從 plan 重組**；**不需傳 model**（D1 定案刪除參數 thread）。
2. prefix-stable payload 改 `(await buildLlmContext(planPath, { excludeReasoning }))
   .messages` + `{ content: instruction, role: USER }`——`buildLlmContext(effectivePath)`
   的輸出**就是**最後一筆 live payload（有舊 cmp = `[system, 舊summary, kept…]`、
   無 = 整路徑），與 UI 送出路徑同一 choke point（`resolveOutgoingMessages:860`
   走它）→ byte-identical 是結構性的。**刪除**現行
   `normalizeMessagesForApi([systemHead]) + normalize(toSummarize)` 自組裝
   （`summarize.ts:213–223`）。（已驗證：`sourceId` tag 不上 wire——`sendMessage` /
   `preEncode` body mapping 新建 `mapped` object；非 vision model 過濾由既有通用
   vision filter 涵蓋，不需另寫。）
3. transcript 模式（fallback）：`buildSummaryTranscript` 區段同步改 full path
   （`toSummarize + kept`、system head 排除規則照舊）。
4. 兩呼叫點 `summarizedCount` 改 `plan.toSummarize.length + plan.kept.length`
   （= 實際被 summary 覆蓋的數，與 `estimatedTokensBefore`（整路徑）顯示一致；
   `agentic:616` / `chat:677`；`chat:871` 邊界移動 meta 更新**不改**）。
5. **明確不改**：plan / 切點 / budget / 雙 mode、cmp 嫁接、post-compaction 形狀、
   `max_tokens`（`computeSummaryMaxTokens` 照舊）、temperature、prompt 文字、
   over-target check / retry / gate、無新 meta 欄位、無新設定、無 fallback /
   overhead 邏輯；所有既有簽名（含 `buildLlmContext` / `ContextBuildOptions`）。

**N11.3 — 測試（fixture 方案 2026-10-18 調整）**

- unit：`buildExtraContentParts` / 轉換矩陣——tool result × {image / audio / 兩者 / 無 extra} →
  順序 `[images, audio, text]`、cap 被呼叫、無 extra 回 string + `tool_call_id`；**byte-identity**：同一 DB message →
  轉換輸出 === in-flow 輸出（同函式同輸入）；空 content 序列化三態
  （有 tool_calls 空 → 欄位省略；有 tool_calls 非空 → 保留；無 tool_calls 空 → `content: ''` 不變）。
  image 用例 `vi.mock('$lib/utils/cap-img-size')`（unit 是 node 環境、無 canvas）。
- unit：`summarize` mock `sendMessage` 抓 payload——無 cmp / 有 cmp 兩路徑 =
  `buildLlmContext(planPath).messages` + instruction；prompt 選擇（default / split /
  custom）不變；transcript = `toSummarize + kept`。
- regression fixture **調整**：本目錄兩份抓包（`before-trigger.json` /
  `compact-requset.json`）**不再**可當 byte-prefix oracle——修後 wire 形狀（順序 + cap）
  刻意改變、舊抓包代表的是舊分岔；只保留為根因文檔證據。改用**合成 fixture**（含 screenshot tool result 的
  data URL 圖 + audio 的幾則訊息）assert：① in-flow ≡ DB rebuild byte-identical；
  ② compact request = 最後一筆 payload 的 byte-prefix + instruction。
- `npm run check` + 既有 5 支 client compaction suite 全綠（停、使用者編譯確認）。
- 手動驗收（使用者做）：MCP screenshot flow → 連壓兩次 + F5 → server `cache_n`（gauge）在 compact
  request 與後續 turns 皆高命中。

**與 N9 的關係**：獨立（N9 = cmp/currNode 兩寫原子性；N11 = payload 前綴一致性）。
N11.1 修掉「reload 後第一 turn 斷前綴」的症狀，但 N9 的 orphan cmp 韌性仍需要。

### 狀態

- 🚧 **N11.1 + N11.2 source + N11.3 測試完成（2026-10-18，未確認）**：
  - N11.1：`ChatService.buildExtraContentParts`（轉換的 `extra → parts` 區塊原樣抽出：
    固定序 text files / legacy / images（cap）/ audio / content text / video / PDF /
    MCP prompt / MCP resource、無 model gating）+ `convertDbMessageToApiChatMessageData`
    （tool+extra 走 shared builder、不再 early-return 丟附件；tool+無 extra 現行 plain
    early-return 不變；非 tool 有 extra 改調 shared builder、行為不變；plain 分支序列化
    對齊：assistant + tool_calls + 空 content → 省略 content 欄位）+ in-flow
    `agentic:1168–1206` 改調同一 builder（順手修不 cap、順序改 user input 路徑、
    `parts.length <= 1 ? cleanedResult : parts`——`<= 1` 為空 content + 無附件邊界
    情境保持 wire 不變）+ `toAgenticMessages` TOOL 分支 content 直通 + 清理 5 個
    unused imports（`ContentPartType` / `ApiChatMessageContentPart` /
    `DatabaseMessageExtraAudioFile` / `DatabaseMessageExtraImageFile` /
    `getAudioInputFormat`）。
  - N11.2（A4）：`summarizeMessages` / `summarizeWithRetry` 收 `planPath`（effective
    path）；prefix-stable payload = `buildLlmContext(planPath, { excludeReasoning })
    .messages` + instruction（刪自組裝 `normalizeMessagesForApi([systemHead]) +
    normalize(toSummarize)`）；transcript = `buildSummaryTranscript(toSummarize + kept)`；
    兩呼叫點傳 `planPath`（agentic `planPath = effectiveCompactionPath(path)` 既有 /
    chat `compactConversation` 既有 / `summarizeRegion` = `effectiveCompactionPath(path)`
    覆蓋 re-summarize + 邊界後移）+ `summarizedCount = plan.toSummarize.length +
    plan.kept.length`（`agentic:616` / `chat:677`；`chat:871` 邊界移動 meta 不改）。
  - N11.3：`tests/unit/summarize.test.ts` 依決定 **B**（使用者 2026-10-18：併入
    N11.3）修好——所有呼叫補 `planPath` 參數、mock 改 `convertDbMessageToApiChatMessageData`
    faithful stand-in（context-builder.test.ts 模式）、payload assertions = 真
    `buildLlmContext(planPath).messages` + instruction（無 cmp / 有 cmp 兩路徑、prompt
    選擇 default / split / custom、excludeReasoning strip、transcript =
    `toSummarize + kept`）；新 `tests/unit/chat-conversion.test.ts`（真 ChatService，
    `settingsStore` / `modelsStore` / `capImageDataURLSize` mock——node 無 canvas）：
    `buildExtraContentParts` 固定 part 序 + cap（含 PDF pages 不 cap）/ tool result
    轉換矩陣（image / audio / 兩者 / 無 extra）/ 空 content 序列化三態（assistant +
    tool_calls + 空 → 欄位省略）/ in-flow ≡ DB rebuild byte-identity（screenshot +
    audio / audio only / 無附件）/ 合成 fixture 回歸（screenshot tool result data URL
    圖 + audio：第一次壓縮 prefix = 完整 pre-compaction payload、第二次壓縮 prefix =
    `[sys, 舊 summary, kept]` payload、皆 byte-identical + instruction；本目錄兩份
    抓包只作根因文檔證據、不適用當 oracle）。
  - **未動**（依規劃）：`planCompaction` / 切點 / budget / 雙 mode、cmp 嫁接、
    post-compaction 形狀、`max_tokens` / temperature / prompt 文字 / over-target 機制、
    無新 meta / 無新設定 / 無 fallback；所有既有簽名（`buildLlmContext` /
    `ContextBuildOptions` / `normalizeMessagesForApi` / `resolveOutgoingMessages` /
    `preEncode` / `sendMessage` / vision filter——無 model 參數、無新 gating）。
- ⏸ **待辦（依序）**：① 使用者跑 `npm run check` + unit（`summarize` /
  `chat-conversion` / `context-builder`）確認；② 手動驗收（MCP screenshot flow →
  連壓兩次 + F5 → server `cache_n` 高命中）。

## 4. 驗證狀態

> 逐輪過程記錄已精簡（里程碑結案後只留最終狀態 + 根因索引）。

- **Phase 0 ✅**：`npm run check` + 4 支 unit 全綠。
- **Phase 1 5.1–5.3 ✅**：check + 4 支 unit + client
  `settings-registry-invariants` 全綠。
- **Phase 1 5.4/5.5 ✅**：check + 4 支 unit 全綠（無新增 unit：Dexie 層 /
  store 協調層不在 unit 範圍；diff 控制在 `compactConversation` + 2 private
  helper + `compacting`）。
- **Phase 1 5.6 ✅**：check + client `chat-message-compaction` 4/4 全綠
  （第一輪 4 型別錯 = fixture string literal → 改 enum 成員，見 §6）。
- **Phase 1 5.7 ✅**：check 0 錯 0 警告 + unit `compaction-policy` /
  `context-builder` + client `context-inspector` 4/4 全綠（第一輪 3/4：
  dropped 區把 in-effect entry 算進「Compacted out」→ 已修，§2f）。
- **Phase 2 P2.1 ✅**：check + unit `compaction-policy` 18/18 全綠
  （第一輪 2 型別錯：`CompactionSettings` import 來源，已修）。
- **Phase 2 P2.2 ✅**：check 全綠（無新純邏輯、無新增 unit）。
- **Phase 2 P2.3 ✅**：check 全綠（第一輪 1 型別錯：Dexie children 回調
  implicit any → 顯式 `(childId: string)`，見 §6）。
- **Phase 2 P2.4 ✅**：client 10/10 + check 全綠（兩層測試端根因：
  §2m selector 撞 Select trigger、§2n boundary 候选集排除 head 後首則；
  五輪診斷 + TEMP-DIAG 全數移除，見 §2l–§2n）。
- **Phase 2 P2.5 ✅**：check + client `chat-message-compaction` 10/10 +
  `context-inspector` 10/10 回歸全綠。
- **Phase 2 P2.6 ✅**：check + unit `compaction-policy` + client
  `context-gauge-compaction` 8/8 + 回歸 `context-panel-mobile` /
  `context-inspector` 全綠（兩輪測試端修復：§2q / §2r）。
- **§3.12 / N1 / N2 ✅**：check + unit `compaction-policy`（N2 後 30/30）+
  client `settings-registry-invariants` 全綠。
- **N3 ✅**：check + unit `summarize` 8/8 + client `context-inspector` /
  `chat-message-compaction` 全綠。
- **§2s / §2t Inspector UI 修復 + 版面 ✅**：check + client
  `context-inspector` 14/14 全綠 + 手動驗證通過（PC 頂端區塊 / 長對話
  Back to top / mobile 滿寬無水平溢出）。
- **N4 ✅**：check + unit `summarize` 14/14 + unit `compaction-policy` 30/30
  全綠（第一輪 13/14 的 test bug 已修，§3.18）。
- **N5 ✅**：check + unit `summarize` 16/16 + client
  `settings-registry-invariants` 全綠。
- **N6 ✅**：check + unit `compaction-policy` / `context-builder` + client 回歸
  4 支全綠（第一輪 5 錯 = `context-builder.ts` `keptIndex` 三元漏 `?`，已修）。
- **雙 mode（共用 + A + B）✅**：check + unit `compaction-policy` /
  `summarize` / `context-builder` + client `settings-registry-invariants` /
  `compaction-decision-card` 9/9 / `context-inspector` 14/14 /
  `chat-message-compaction` / `context-gauge-compaction` 全綠
  （第一輪 2 支 client 失敗已修：卡片標記空白 + builder summary 段
  char/4 遺漏，見 §3.23）。
- **v4 ✅**：check 0 錯 0 警告 + unit `compaction-policy` 82/82 /
  `context-builder` / `summarize` + client `context-inspector` /
  `chat-message-compaction` / `context-gauge-compaction` /
  `compaction-decision-card` / `settings-registry-invariants` 全綠
  （第一輪 9 失敗已修、3 根因全在測試檔，見 §3.25；entry=bytes/4
  使用者確認）。
- **N7 ✅（完成並確認，2026-10-04）**：四輪跑測 8 支失敗全在測試檔（根因
  索引見 §2u「跑測記錄」；derived-cache 教訓見 §6），已修、來源碼零改動；
  使用者重跑 `chat-message-compaction` 11/11 + `npm run check` + 回歸
  `chat-message-compacting` / `context-gauge-compaction` / `context-inspector` /
  `compaction-decision-card` 全綠；05-N7 清單已勾（手動驗收 #8–#12 未做）。
- **N8 ✅（完成並確認，2026-10-18）**：N8.1–N8.3（3 來源檔 + 3 unit 檔）；
  第一輪 2 失敗全在測試檔（N8 向量期望值筆誤，見 §3.27 狀態）、已修、來源碼
  零改動；使用者重跑 `npm run check` + unit `compaction-policy` /
  `context-builder` / `summarize` + client 5 支 compaction suite
  （`chat-message-compaction` / `context-inspector` /
  `context-gauge-compaction` / `compaction-decision-card` /
  `chat-message-compacting`）全綠；05-N8 清單已勾（手動驗收未做）。
- **N10 ✅（完成並確認，2026-10-18）**：`npm run check` + unit `branching`
  （`findCompactionGraftFixes` 5 向量）+ 既有 5 支 client compaction suite
  （`chat-message-compaction` / `context-inspector` /
  `context-gauge-compaction` / `compaction-decision-card` /
  `chat-message-compacting`）零改動全綠；05-N10 / §5f 清單已勾（手動驗收未做：
  agentic loop 連壓兩次 → F5 / 匯出匯入 summary 都在 + 既有已損對話 migration
  後恢復）。
- **Phase 1 5.8 手動驗收（未做；可與 v4 一併驗）**：
  1. 有 cmp 的對話：送出 payload = inspector 顯示 = devtools 抓包（附件佔位符除外逐欄位一致）。
  2. 手動「Compact now」可產生 cmp（聊天列出現 entry；下一輪 payload 含 summary）。
  3. 無 cmp 對話行為與現行完全一致（context-builder.test.ts 的回归測試保證）。
  > ✅ 5.8 項目 1–2 現可驗（P2.4 inspector「Compact now」+ P2.6 表單
  > Eye 按鈕 / 快捷鍵 / gauge 列皆已落地）；A/B mode 行為 + v4 真實
  > token 顯示可一併驗。

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

## 5d. N8 執行清單（依序做；每完成一項可請使用者編譯確認）

> 第二次壓縮：plan 改在 effective path（bug 修正；分析 + 規劃 2026-10-18、
> 明細見 §3.27）。根因：兩個 planning 呼叫點把 raw DB path（含舊 cmp 已 drop
> 的原始訊息）餵 `planCompaction*` → summary 呼叫重送整段原始歷史 →
> overflow。修正：新 `effectiveCompactionPath()` + 兩呼叫點餵它。

### N8.1 `effectiveCompactionPath`（`services/context/context-builder.ts`）
- [x] 抽 `buildLlmContext` 現行窗口解析為共用內部 helper（I1 head / I2 最後一筆
      生效 / I3 fail-open）→ `resolveCompactionWindow` + `CompactionWindow`
- [x] 新 export 純函式 `effectiveCompactionPath(path)`：無 cmp → 原樣；boundary
      失效 → raw（fail-open）；否則 → `[...head, entry, ...kept]`（entry 留陣列
      當一般節點）；barrel `index.ts` 同步 export

### N8.2 兩個 planning 呼叫點改餵 effective path
- [x] `stores/agentic/index.svelte.ts` `compactBetweenTurns`：
      `planCompaction*(effectiveCompactionPath(path), …)`（`planPath` 變數）
- [x] `stores/chat/index.svelte.ts` `compactConversation`：同上（涵蓋 post-flow
      auto + 手動 Compact now）
- [x] 確認下游零改動（`parentId` / `preCompactionPath` / `triggerPreEncode` /
      `sessionMessages` 重建 / cmp meta）

### N8.3 unit
- [x] `context-builder.test.ts`：`effectiveCompactionPath` suite（無 entry / 單
      cmp / 空 kept / I3 ×2 / entry 後追加訊息 / 舊 cmp 落 kept 區）
- [x] `compaction-policy.test.ts`：「第二次壓縮」向量（effective path → plan：
      summarize 區排除已 drop 原始訊息 / `firstKeptMessageId` 來自 cmp 後區域 /
      `summarizeTokens` ≈ effective 規模；mode A + B 各一組；新增 chat.service
      mock + `effectiveCompactionPath` import）
- [x] `summarize.test.ts`：prefix-stable payload「path 已含舊 cmp」向量（=
      `[system, 舊summary, 新訊息, instruction]`）

### N8.4 回歸 + 驗收
- [x] `npm run check` + 既有 5 支 client compaction suite 零改動全綠
      （`chat-message-compaction` / `context-inspector` /
      `context-gauge-compaction` / `compaction-decision-card` /
      `chat-message-compacting`）
- [ ] 手動驗收（使用者原始場景）：agentic loop 連壓兩次 → 第二次 summary 請求
      = `[system, 舊summary, 新訊息, instruction]`、loop 正常續跑；toast / gauge
      token 數字與 effective context 一致

## 5e. N9 執行清單（依序做；每完成一項可請使用者編譯確認）

> F5 / refresh 韌性：in-loop compaction 兩寫非原子（規格 §3.28）。根因修 = 原子
> commit（N9.1）；防禦層 = 載入時收編 orphan（N9.2）；可選 = 送出前 overflow
> guard（N9.3）；N9.4 純文件。

### N9.1 原子 commit `commitCompactionMessage`（`database.service.ts`）
- [ ] 新 `static commitCompactionMessage({ convId, parentId, content, compactionMeta })`：
      單一 IDB transaction 跨 `[messages, conversations]`——add cmp +
      `addChildToParent` + `currNode = cmp.id`（同 `expandCompactionMessage` 的
      transaction 模式）；任一失敗全回滾
- [ ] `stores/agentic/index.svelte.ts compactBetweenTurns`：改走原子 commit、移除獨立
      `updateCurrentNode`（active / non-active 分支統一；non-active 保留 in-memory
      `applyConversationUpdate` mirror）
- [ ] `stores/chat/index.svelte.ts compactConversation`：同上（涵蓋 post-flow auto +
      手動 Compact now）
- [ ] 確認下游零改動（`preCompactionPath` / `triggerPreEncode` / `sessionMessages`
      重建 / cmp meta / toast）

### N9.2 載入時收編 orphan cmp
- [ ] 純函式 `findOrphanedCompaction(allMessages, currNodeId) → cmpId | null`（放
      `utils/branching.ts` 或 `services/context/`，實做時定）+ unit 4 向量（leaf child /
      leaf descendant / 無 cmp / 其它分支）
- [ ] `loadConversation`：偵測到 orphan → `updateCurrentNode(cmpId)`（持久化）+ in-memory
      `currNode` 更新（active + conversations array）
- [ ] （可選）app 啟動時對非 active conversations 掃一次（或只做 load 時——實做時定）

### N9.3 送出前 overflow guard（可選）
- [ ] 送出 choke point：built payload 估計 > n_ctx → 擋下 + dialog
      [Compact now / 刪訊息 / 強制送出]

### N9.4 文件
- [x] 02-§4 邊界情境表：F5 列（已同步）
- [ ] README / 05-N9 狀態更新（N9 完成後）

### N9.5 回歸 + 驗收
- [ ] `npm run check` + 既有 5 支 client compaction suite 零改動全綠
- [ ] 手動驗收 3 項（§3.28 測試計畫）：兩寫視窗 breakpoint 模擬 / summary 呼叫中 F5 /
      預植 orphan 收編

## 5f. N10 執行清單（最高優先；依序做；每完成一項可請使用者編譯確認）

> in-loop compaction 的 cmp 被接成 sibling（系統性 bug；規格 §3.29）。根因修 =
> compaction 後推進 flow 接掛點（N10.1）；資料修復 = 已損樹重接（N10.2）；
> 測試鎖定（N10.3）。

### N10.1 compaction 後推進 flow 的接掛點
- [x] agentic flow callback 型別新增 `onCompaction?(cmp: DatabaseMessage)`
      （`types/agentic.d.ts` `AgenticFlowCallbacks` + `types/chat.d.ts` `ChatStreamCallbacks`）
- [x] `stores/chat/index.svelte.ts streamChatCompletion`：接線
      `onCompaction: (cmp) => { lastCreatedInFlow = cmp.id; }`
- [x] `stores/agentic/index.svelte.ts compactBetweenTurns`：把 callbacks 傳入；
      `createCompactionMessage` + currNode 更新成功後呼叫
      `callbacks.onCompaction?.(cmp)`；`executeAgenticLoop` 傳入 `callbacks`
- [x] 確認 `createAssistantMessage` / `createToolResultMessage` 下游零改動（parent
      來源不變、只是 `lastCreatedInFlow` 的值推進了）

### N10.2 已損樹修復
- [x] 純函式 `findCompactionGraftFixes(allMessages, currNodeId) →
      { cmpId, reattachId }[]`（`utils/branching.ts`）+ unit 5 向量（§3.29 N10.3）
- [x] 修復套用（單一 IDB transaction）：`c2.parent = c.id`、`p.children` 移除
      `c2.id`、`c.children` 加入 `c2.id`；冪等（`database.service.ts` `applyCompactionGraftFixes`）
- [x] app 啟動時一次性 migration（`migration.service.ts` `compaction-graft-fix-v1`）
      + `loadConversation` 防禦層檢查（`conversations/index.svelte.ts`）

### N10.3 回歸 + 驗收
- [x] `npm run check` + unit `branching`（`findCompactionGraftFixes` 5 向量）+ 既有
      5 支 client compaction suite 零改動全綠（2026-10-18 確認）
- [ ] 核心回歸（手動）：in-loop compaction 後下一則 assistant 訊息
      `parent === cmp.id`（DB 樹 == 平陣列）
- [ ] 手動驗收（使用者原始場景）：agentic loop 連壓兩次正常停下 → F5 → summary
      都在、inspector = 壓縮後 context；匯出 → 匯入 → 同；session 可繼續
- [ ] 既有已損對話：啟動 migration 後開啟 → summary 回到路徑上、可繼續

## 5g. N11 執行清單（依序做；每完成一項可請使用者編譯確認）

> compact request 前綴一致性（規格 §3.30）：N11.1 = tool result 附件被丟（P0 bug）；
> N11.2 = full-path summary A4（使用者定案 2026-10-18）；N11.3 = 測試。決策 D1
> （shared-builder 路徑、無 model 參數）使用者定案 2026-10-18。本目錄兩份抓包只作
> 根因文檔證據（修後 wire 形狀改變、不適用當 byte-prefix oracle）。

### N11.1 前綴一致性（P0，shared-builder 路徑）
- [x] `chat.service.ts`：把 `extra → parts` 區塊（`:179–320`）原樣抽出為
      `public static buildExtraContentParts({ content, extra }): Promise<ApiChatMessageContentPart[]>`
- [x] `convertDbMessageToApiChatMessageData`：`tool + toolCallId + 有 extra` →
      `{ content: await buildExtraContentParts(message), role: TOOL, tool_call_id }`
      （不再 early-return 丟 extra）；`tool + 無 extra` → 現行 plain early-return 不變；
      非 tool 有 extra → 改調 shared builder（行為不變）
- [x] 序列化對齊：`assistant + tool_calls + content === ''` → 省略 `content` 欄位
      （向 in-flow `content: turnContent || undefined`、`agentic:947` 對齊）
- [x] `agentic:1168–1206` in-flow 整段取代為 `buildExtraContentParts` +
      `parts.length <= 1 ? cleanedResult : parts`（順手修不 cap；parts 順序改為 user
      input 路徑；`<= 1` 讓空 content + 無附件邊界情境 wire 不變）
- [x] `toAgenticMessages` TOOL 分支：`content` 直通（去掉 `→ ''` 強轉，`agentic:150–156`）
- [x] 清理不再使用的 import（`ContentPartType` / `ApiChatMessageContentPart` /
      `getAudioInputFormat` / `DatabaseMessageExtraAudioFile` / `DatabaseMessageExtraImageFile`，逐個確認）
- [x] **一律不動**：`normalizeMessagesForApi` / `resolveOutgoingMessages` /
      `buildLlmContext` / `ContextBuildOptions` / `preEncode` / `sendMessage` /
      vision filter（無 model 參數、無新 gating）

### N11.2 full-path summary（A4，已定案 2026-10-18）
- [x] `summarizeMessages` / `summarizeWithRetry` 加 `planPath` 參數（effective path，
      呼叫點已有：`agentic:559` / `chat:623` / re-summarize = `effectiveCompactionPath(path)`）
- [x] prefix-stable payload = `buildLlmContext(planPath, { excludeReasoning }).messages`
      + instruction；**刪除** `normalizeMessagesForApi([systemHead]) +
      normalize(toSummarize)` 自組裝（`summarize.ts:213–223`）
- [x] transcript 模式：`buildSummaryTranscript` 區段改 full path（`toSummarize + kept`）
- [x] 兩呼叫點 `summarizedCount` = `plan.toSummarize.length + plan.kept.length`
      （`agentic:616` / `chat:677`；`chat:871` 不改）
- [x] 明確不改：plan / 切點 / cmp / post-compaction 形狀、`max_tokens`、prompt、
      over-target 機制、無新 meta / 無新設定 / 無 fallback、所有既有簽名

### N11.3 測試 + 驗收
- [x] 前置：`tests/unit/summarize.test.ts` 過期修正（決定 = **B**，使用者 2026-10-18：
      併入 N11.3）——所有呼叫補 `planPath`、mock = `convertDbMessageToApiChatMessageData`
      faithful stand-in、payload assertions = `buildLlmContext(planPath).messages`
      + instruction（無 cmp / 有 cmp、prompt default / split / custom、excludeReasoning、
      transcript = `toSummarize + kept`）
- [x] unit：`buildExtraContentParts` / 轉換矩陣（tool result × image / audio / 兩者 /
      無 extra → `[images, audio, text]`、cap 被呼叫、無 extra 回 string + `tool_call_id`）；
      byte-identity（同一 DB message → 轉換 === in-flow）；空 content 序列化三態
      （image 用例 `vi.mock('$lib/utils/cap-img-size')`，node 環境無 canvas）
      → 新 `tests/unit/chat-conversion.test.ts`
- [x] unit：`summarize` mock `sendMessage` 抓 payload——無 cmp / 有 cmp 兩路徑 =
      `buildLlmContext(planPath).messages` + instruction；prompt 選擇（default / split /
      custom）不變；transcript = `toSummarize + kept` → `tests/unit/summarize.test.ts`
- [x] regression 合成 fixture（screenshot tool result data URL 圖 + audio）：in-flow ≡
      DB rebuild byte-identical；compact request = 最後一筆 payload 的 byte-prefix +
      instruction（本目錄兩份抓包只作文檔證據、不適用當 oracle）
      → `tests/unit/chat-conversion.test.ts`
- [ ] `npm run check` + 既有 5 支 client compaction suite 全綠（停、使用者編譯確認）
- [ ] 手動驗收：MCP screenshot flow → 連壓兩次 + F5 → `cache_n` 高命中（gauge）

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
- **client 測試環境 API（vitest-browser-svelte）**：`render()` 回傳的
  `RenderResult` 只有 `getByRole` / `getByText`（只收 `string | RegExp`、
  不收函式）/ `getByLabelText` / `getByPlaceholder` / `getByTitle` /
  `getByTestId`、回 `Locator`——沒有 testing-library 的 `queryByText` /
  `findByText` / `Locator.parentElement`；要 DOM 直查走
  `document.querySelector` + `waitFor` / `bodyText()` helper（慣例見
  `context-inspector.svelte.test.ts`）。`expect(Locator)` 不會解析——
  要 `await expect.element(locator).toBeVisible()`。
- **client 測試獨立渲染缺 provider**：含 bits-ui `Tooltip.Root` 的元件
  （如 `ChatFormActions`）獨立渲染要包 `Tooltip.Provider`（app 裡
  `+layout.svelte` 提供）→ 用 `ChatFormActionsWrapper.svelte` /
  `ChatFormTestWrapper.svelte` 先例。
- **bits-ui `Tooltip.Trigger` 包 `Button` 是雙 button 結構**（Add/Mic 同款
  既有慣例）：`getByRole('button', { name })` 會 strict mode violation——
  加 `.last()` 取內層（`onclick` / `disabled` 皆在內層；`Locator.locator()`
  是 protected、不可用）。
- **client 測試 selector 要夠窄**：dialog 內 bits-ui `Select.Trigger` 也帶
  `aria-expanded`——payload 列用 `[role="dialog"] li button[aria-expanded]`
  才不會數到 trigger（P2.4 五輪診斷的根因，§2m）。
- **mock module-singleton store 的 `$derived` 鏈：spy 上游 plain getter
  不會讓下游 derived 重新求值**：Svelte 5 `$derived` lazy + cached，
  module-singleton store 的 derived cache 跨測試不清除——同檔第一支測試已
  求值過的鏈（如 `contextStatsStore.contextTotal` → null），後續測試
  `vi.spyOn(上游, 'get')` 只換 getter、不 invalidate 被追蹤的依賴 →
  下游一直讀 stale 值（N7 第二輪：`contextTotal` stale null →
  `compactConversation` 提前 return、`runCompactionSummary` 0 次，§2u）。
  修法：直接 pin 被測路徑讀的葉值（`vi.spyOn(store, 'leaf', 'get')
  .mockReturnValue(…)`），或改寫 `$state` 來源讓依賴正常 invalidate。
- **測試在 `waitFor` throw 時 `unmount()` 沒跑到**：`afterEach` 的 store
  重置（如 `activeMessages = []`）會打在還掛著的元件上、effect 重跑——
  看到的「pathLen 0 / state 變 0」通常是 teardown 紅鵝、非 runtime bug
  （§2m）。
- **編譯/測試由使用者執行**：每完成一個可獨立驗證的單位（Phase 1 建議
  5.1 / 5.2+5.3 / 5.4+5.5 / 5.6 / 5.7 各一段；Phase 2 每 P2.x 一段）就停下來
  請使用者跑 `npm run check` + 相關 `npm run test:unit -- --run <files>`，
  確認後再继续。
