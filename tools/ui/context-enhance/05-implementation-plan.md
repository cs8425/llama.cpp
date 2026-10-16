# 05 · 實施計畫

## 1. 階段劃分(每階段可獨立合入、可獨立回退)

### Phase 0 — 純核心(零行為變更)

新增 `src/lib/services/context/` + 型別 + 全套 unit tests。
此階段**不改任何現有行為**(builder 還沒被接上),可先合入 review。

> ✅ 已完成——交付明細、設計決策與驗證狀態見 `06-status.md`。
> 額外交付:`tests/unit/summarize.test.ts`、export round-trip 測試、
> 修復既有的 `ChatRole`/`ChatMessageType` 缺失型別。

- [x] `MessageType.COMPACTION`(`enums/chat.enums.ts`)
- [x] `CompactionMeta`(`types/database.d.ts`,DatabaseMessage 加選用欄位)
- [x] `services/context/types.ts` / `context-builder.ts` / `compaction-policy.ts`(含 split span 兩階段選點)/ `summarize.ts`(含 split prompt 變體)/ `index.ts`
- [x] `tests/unit/context-builder.test.ts`、`tests/unit/compaction-policy.test.ts`

### Phase 1 — 送出路徑接上 builder + 手動壓縮

- [x] `ChatService.sendMessage` / `preEncode`:DB path 入參改走 `buildLlmContext`
      (簽名不變;`ApiChatMessageData[]` 入參維持原路徑)
- [x] `agenticStore.runAgenticFlow`:`:358` normalize 改 builder
- [x] `DatabaseService.createCompactionMessage()`(照 `createSystemMessage` 模式)
- [x] `chatStore.compactConversation(convId, { auto: boolean })`
      (plan → summarize → 建節點 → currNode → 選做 preEncode)
- [x] `ChatMessageCompaction.svelte` + `ChatMessage.svelte` 分派 +
      `ChatMessages.svelte` grouping 確認（已編譯確認）
- [x] Inspector 只讀版(`DialogContextInspector.svelte`)+ gauge popup 入口
      （已實做並確認全綠；交付明細見 06-status §2e/§2f/§4）
- [x] Settings 8 個 key(先全部加好,自動壓縮預設 off)

✅ 驗收:有 cmp 的對話,送出 payload = inspector 顯示 = 網路抓包;
手動「Compact now」可產生 cmp;無 cmp 對話行為與現行完全一致。

### Phase 2 — 自動觸發 + 人工介入 + flow 內再壓縮

- [x] `onFlowComplete` 自動壓縮檢查(02-§6 條件)
- [x] agentic `executeAgenticLoop` turn 之間再壓縮(03-§4.4):
      plan → summarize → 建 cmp → 重建 `sessionMessages` → 續跑;
      fail-open;signal 綁 flow abort;`contextAutoCompactionInLoop` 開關
- [x] Inspector 編輯:summary 文字 / 斷點選擇器(前移安全、後移強制重摘要)
      （P2.4 完成並確認:client 10/10 + check 全綠——
      見 06-status §2j/§2m）
- [x] Inspector 動作:Compact now / Expand(確認對話框)/ 重新摘要 / Copy JSON
      （同左）
- [x] cmp entry 的「編輯 / 重新摘要 / 還原」動作
      （P2.5 完成並確認:client 10/10 + inspector 10/10 回歸 + check 全綠
      ——見 06-status §2o）
- [x] gauge「Compacted: … saved」列 + 進行中狀態
      （P2.6 完成並確認——見 06-status §2p/§2q/§2r）
- [x] 快捷鍵 `Shift+Ctrl/Cmd+I` + 快捷鍵說明表登記
      （P2.6 完成並確認——見 06-status §2p/§2q/§2r；本 app 無獨立快捷鍵
      說明 dialog，登記 = Eye 按鈕 tooltip 帶快捷鍵）

✅ 驗收:長對話(或測試用低 threshold)自動壓縮發生一次且只發生一次;
編輯 summary 後下一輪 payload 即變;Expand 後 context 完整還原。

### v3 — 實際 token 計數 + compact 成功判定(設計確認 2026-10-16,未實做)

> 背景:自動壓縮從未觸發(262.14K/262.14K 案例)——根因是舊 budget 公式
> (summary max 70% × 1.5 = 105% n_ctx 的 reserve)把 keepBudget 壓死在 10% floor,
> planCompaction 回 null、auto 路徑完全靜默。根因分析與決策記錄見
> 06-status §3.20。設計:02-§3.3/§3.4/§6(v3)、03-§3/§4.2/§4.4(v3)。

- [ ] `compaction-policy.ts` `computeCompactionBudget`:`keepBudgetTokens =
      floor((contextCompactionThreshold − contextKeepTargetPercent) / 100 × nCtx)`
      (threshold ≤ keepTarget → 0)——移除 summaryReserve(× 1.5)與 10% floor;
      `computeSummaryMaxTokens` 不再進 budget(只留在 summary 呼叫的 max_tokens)
- [ ] `estimateTokens` / `estimateApiMessageTokens`:文字部分(content / toolCalls /
      reasoning / attachment text / PDF text)char/4 → **UTF-8 byte 數**
      (保守上限:切點 fit 偏向「多留」);image 1000 / audio-video 3000 不變
- [ ] `chat.service.ts`:`ApiChatCompletionResponse` 補 `timings` 欄位;
      `handleNonStreamResponse` 解析 `data.timings` 傳給 `onComplete`
      (summary 呼叫實際 completion tokens 的來源)
- [ ] `summarize.ts`:`summarizeMessages` 回傳 `string` → `{ content: string;
      tokens: number | null }`(tokens = 回應 timings 的 completion tokens;
      server 沒回 → null → 成功判定改 `byteLen(content)` 代入)
- [ ] 成功判定 + 重試迴圈(compactConversation / compactBetweenTurns / 手動
      re-summarize 共用):`headBytes + (summaryTokens ?? byteLen(summary)) ≤
      keepTarget% × n_ctx`;超標 → 重發同一 request,總嘗試次數 =
      `contextSummaryMaxAttempts`(新設定,預設 3;1 = 總共一次;≤ 0 = 無限;
      registry 需要允許 0 的 validator)
- [ ] `AgenticGates`:新增 compaction-decision gate
      (`requestCompactionDecision` / `resolveCompactionDecision` /
      `getPendingCompactionDecision`,同 requestContinue 的 Promise + pending
      state 模式;abort = skip)
- [ ] `agenticStore`:public wrapper(request/resolve/getPending)+
      `compactBetweenTurns` 接成功判定/重試/gate
- [ ] `chatStore.compactConversation`:接成功判定/重試/gate
- [ ] `ChatCompactionDecisionCard.svelte`:確認卡片(與 agentic continue 卡片
      同風格):顯示當前 compact 完的 token 數(head + summary,實際值/byte 數)
      vs keepTarget% 目標 + [使用這次壓完] [重壓] [這次不壓];
      掛法:in-loop = agentic 訊息內(與 continue 卡片同位);
      flow 之間 = 訊息列尾端獨立 row
- [ ] unit tests:byte 計數(CJK / ASCII / 附件);budget 簡化公式;
      成功判定邊界(≤ / >);重試次數(1 / 3 / ≤ 0);summaryTokens null → byteLen
- [ ] client tests:卡片三選項 resolve gate;abort = skip

✅ 驗收:長對話(262K 級)自動壓縮真的會發生;超標場景(小 keepTarget)走
重試 → gate 三選項;無 cmp 對話行為不變。

### N6 — split 切允許空 kept（使用者要求 2026-10-16，已實做、待編譯確認）

> 背景:split 切原本要求「最後 ≥2 則(含大 tool result)放得下 budget」
> (`contextKeepMinMessages` 預設 2);budget 極緊時(最後一組 ass+tool 本身就巨大)
> planCompaction 回 null、無法壓縮。使用者決策:split 下限改 0,允許
> **所有訊息都丟去 compact**(payload = `[system, summary]`);boundary 切不變
> (整個最後一個 turn 要放得下)。
> **D1(簡化版)**:`firstKeptMessageId` 改選用,**缺 id = 空 kept**(合法狀態,
> 不是 fail-open);id 存在但路徑上找不到 = fail-open(I3 不變)。
> **D2**:保留 `contextKeepMinMessages`,default 2→0、range 0–50(設回 ≥1 恢復舊行為)。
> 設計同步:02-§1.1/§2/I3/I5/§3.1/§3.3/§4、03-§2/§4.2、04-§2.2;
> 決策記錄見 06-status §3.21。
>
> **狀態(2026-10-16)**:程式碼 + tests 已實做、02/03/04/05 已同步;
> **待使用者編譯/測試確認**(指令清單見 06-status §4 最新條目)。
> 全綠後勾選下列清單。

- [ ] `types/database.d.ts`:`CompactionMeta.firstKeptMessageId: string` → `firstKeptMessageId?: string`
- [ ] `services/context/types.ts`:`CompactionPlan.firstKeptMessageId` /
      `ContextCompactionInfo.firstKeptMessageId` → 選用 + doc
- [ ] `compaction-policy.ts` `planCompaction`:階段 2 允許 `cutIndex = path.length`
      (切在最後一則訊息之後 → 空 kept、`firstKeptMessageId` 缺);
      I5 split 下限跟 `contextKeepMinMessages`(預設 0);
      `estimateCompactionSavings` 處理「無 boundary」(dropped = head 之後全部,排除 entry 本身)
- [ ] `context-builder.ts` `buildLlmContext`:缺 `firstKeptMessageId` → kept = cmp 之後的訊息
      (通常為空)、`boundaryValid = true`;id 存在但找不到 → fail-open(I3 不變)
- [ ] `stores/chat/index.svelte.ts`:`boundaryIndexOf` → `keptWindowStartOf`(缺 id = entry index + 1);
      `moveCompactionBoundary` / `recompactConversationEntry` / `summarizeRegion`
      處理空 kept(region 排除 cmp 節點本身)
- [ ] `constants/settings.constants.ts`:`contextKeepMinMessages` defaultValue 2→0、
      min 2→0、help 文案
- [ ] `ChatMessageCompaction.svelte`:空 kept 態(「Kept from: none」、dropped 統計 = 全部、
      expand 描述)
- [ ] `DialogContextInspector.svelte`:空 kept → dropped 區 = 全部;選擇器顯示
      「無保留訊息(全部壓縮)」
- [ ] unit:`compaction-policy.test.ts`(split 空 kept 切點 / I5=0 / 舊「連 split
      都放不下 → null」用例更新);`context-builder.test.ts`(空 kept payload、
      缺 meta = 空 kept、fail-open 不變)
- [ ] client:chat-message-compaction / context-inspector 回歸(既有 fixture 用
      `firstKeptMessageId: ''` = 「有 id 但無效」= fail-open,行為不變,確認即可)

✅ 驗收:最後一組 ass+tool 超 budget 時,自動/手動壓縮產生空 kept cmp、
payload = `[system, summary]`、inspector 顯示「無保留訊息」、斷點可前移
恢復 kept;無 cmp 對話行為不變。

### Phase 3 —(可選,後續)

> **下一輪(規劃已定;N1–N5 ✅ 全部完成並確認,明細見 06-status §3.13–§3.19,依序 N1→N5)**:
> 1. **N1** ✅ summary 上限 = n_ctx × %（新設定 `contextSummaryMaxTokensPercent`
>    預設 70：128k → ~91k、256k → ~183k；舊固定 key 移除——完成並確認，
>    見 06-status §3.13）。
> 2. **N2** ✅ 新設定 `contextKeepTargetPercent`(INPUT 10–90,預設 50)——
>    compact target 從固定 50% 常數(`KEEP_TARGET_FRACTION`)提出来給
>    user 自訂(完成並確認,見 06-status §3.14/§5c)。
> 3. **N3** ✅ 手動壓縮 [Stop] 按鈕——`compacting` 期間可中斷 summary 呼叫
>    (`chatStore.stopCompaction()` abort → `summarizeMessages` 丟真
>    `AbortError` → 既有 fail-open:不建 cmp、toast「Compaction stopped」);
>    inspector 與 cmp row 動作列換 [Stop];in-loop 沿用 flow abort
>    (完成並確認,見 06-status §3.15/§5c)。
> 4. **N4** ✅ prefix-stable summary 模式(新增、**設為 default**):
>    `[system, 被壓縮訊息原文, 要求壓縮的 prompt]`,前綴完全一致、
>    只有最後的壓縮 prompt 不同(KV 前綴重用);transcript 模式保留為
>    fallback(設計見 03-§2.1;附件原樣送 + reasoning 跟隨主送出開關,
>    完成並確認,見 06-status §3.18)。
> 5. **N5** ✅ 新設定 `contextSummaryMode`(SELECT:`prefix-stable` /
>    `transcript`,預設 prefix-stable):summary 的 prompt 模式開放給 user 選
>    (逃生門:server 拒絕 prefix-stable payload 時可切回 transcript);
>    3 個呼叫點經 `toSummaryMode()` 透傳(完成並確認,見 06-status §3.19)。

- [ ] 兩段式 summary(兩次 LLM 呼叫再合併)取代單呼叫雙段 prompt
- [x] ~~token 估計校準:用 `timings.prompt_n` 反推每則成本~~ → 被 v3 取代
      (2026-10-16):需要精確的兩個決策點(觸發、成功判定)直接用 API 實際值,
      切點用 byte 數,不再需要逐則成本校準
- [ ] per-conversation 覆蓋(「此對話停用自動壓縮」,
      放 `ConversationPreferences`)
- [ ] 舊 cmp 落在 kept 區時的「合併重摘要」提示

## 2. 檔案清單

### 新增

| 檔案 | 說明 |
| ---- | ---- |
| `src/lib/services/context/types.ts` | `CompactionPlan` / `ContextBuildResult` |
| `src/lib/services/context/context-builder.ts` | `buildLlmContext`(唯一 choke point) |
| `src/lib/services/context/compaction-policy.ts` | `planCompaction` / `estimateTokens` |
| `src/lib/services/context/summarize.ts` | transcript 組裝 + summary 呼叫 |
| `src/lib/services/context/index.ts` | barrel |
| `src/lib/components/app/chat/ChatMessages/ChatMessage/ChatMessageCompaction/ChatMessageCompaction.svelte` | cmp 渲染 |
| `src/lib/components/app/dialogs/DialogContextInspector.svelte` | inspector(可再拆 2~3 個子元件:訊息列、已裁切區、進階區) |
| `tests/unit/context-builder.test.ts` | |
| `tests/unit/compaction-policy.test.ts` | |
| `tests/stories/ChatMessageCompaction.stories.svelte` | |

### 修改(每筆一句話理由)

| 檔案 | 改動 |
| ---- | ---- |
| `src/lib/enums/chat.enums.ts` | `MessageType.COMPACTION` |
| `src/lib/types/database.d.ts` | `CompactionMeta` + `DatabaseMessage.compactionMeta?` |
| `src/lib/services/database.service.ts` | `createCompactionMessage()`;(必要時)`reparentDirectChildren` 開放給 expand 流程 |
| `src/lib/services/chat.service.ts` | `sendMessage` / `preEncode` 改走 builder(簽名不變) |
| `src/lib/stores/agentic/index.svelte.ts` | flow 開始前改走 builder |
| `src/lib/stores/chat/index.svelte.ts` | `compactConversation()`、自動觸發掛 `onFlowComplete`、inspector 快照 |
| `src/lib/stores/chat/context-stats.svelte.ts` | (Phase 2)compacted 指標 |
| `src/lib/constants/settings-keys.constants.ts` | 6 個新 key |
| `src/lib/constants/settings.constants.ts` | `SETTINGS_REGISTRY` 條目 |
| `src/lib/components/app/chat/ChatMessages/ChatMessage/ChatMessage.svelte` | 分派新 branch |
| `src/lib/components/app/chat/ChatMessages/ChatMessages.svelte` | grouping 確認(大概率零改動)+ 測試 |
| `src/lib/components/app/chat/ChatForm/ChatFormContextGauge/ContextGaugePopup.svelte` | inspector 入口 + compacted 列 |
| `src/lib/hooks/use-keyboard-shortcuts.svelte.ts` | 快捷鍵(Phase 2) |
| `src/lib/components/app/chat/index.ts` / `dialogs/index.ts` | export |

**刻意不改的**:`conversationsStore` 的路徑邏輯(`filterByLeafNodeId` 對新 type
透明)、`branching.ts`、import/export 服務、`ChatService.convertDbMessageToApiChatMessageData`
(builder 複用它,不 fork 一份)。

## 3. 測試計畫

### Unit(vitest,`tests/unit/`)

`context-builder.test.ts`:
- 無 cmp → 輸出 == 現行 normalize 結果(回歸保護)
- 單 cmp → `[system, summary, kept...]`,drop 區正確
- 雙 cmp → 最後一筆生效;舊 cmp 在 kept 區時按 user 訊息出現
- `firstKeptMessageId` 失效 → fail-open 全量
- kept 區開頭不可能是 `tool`(用含 tool_calls 的 fixture 驗證 I4)
- system prompt 恆在第一位

`compaction-policy.test.ts`:
- 不超 budget → null
- 超 budget → 切在 user 邊界、kept ≤ budget、minKeptUserTurns 滿足
- 單一 span 超 budget(無 user 邊界可切)→ split 切在 assistant、
  kept 以 `ass(tool_calls)+tool` 開頭、`isSplitTurn=true`、minKeptMessages 滿足
- 切點絕不落在 tool result(用 ass→tool→ass→tool 交替 fixture 驗證)
- 巨幅單一 user 訊息 → split 切(user 訊息進 summary)或 null
- summarize 區 < minSummarizeTokens → null
- `estimateTokens` 各 attachment 型別

`conversation-export.test.ts`(擴充):
- 含 cmp 的對話 export → import round-trip,欄位完整。

### Client(`tests/client/`)

- cmp entry 渲染(收合/展開、動作呼叫 store 的 spy)
- `contextShowCompactionEntries=false` 不渲染
- inspector:mock `buildLlmContext` 輸出 → 斷言列出的訊息、token 條、
  Copy JSON;summary 編輯後呼叫 `updateMessage`

### Storybook

- `ChatMessageCompaction.stories.svelte`(收合/展開/警告態)
- inspector 的三個狀態(正常 / 斷點失效 / 進行中)

### 手動驗收清單(E2E)

1. 長對話跑到 >80% n_ctx → 自動壓縮一次 → gauge 數字回落。
2. 長 agentic flow(低 threshold)→ turn 之間再壓縮、flow 不中斷、
   重載後路徑含 cmp(split 切時 kept 區以 assistant 開頭)。
3. Inspector Copy JSON 與 devtools 網路面板的 request body 一致
   (附件佔位符除外的逐欄位 diff)。
4. 編輯 summary → 下一輪 request 含新文字。
5. Expand → 下一輪 request 回到全量。
6. 在 cmp 之前的訊息 regenerate → 新分支無 cmp、全量 context。
7. 關閉 server 時 summary 呼叫失敗 → 不產生 cmp、toast(flow 內失敗則續跑)。

## 4. 風險與緩解

| 風險 | 影響 | 緩解 |
| ---- | ---- | ---- |
| KV cache 前綴改變 → compaction 後首次全量 re-prompt | 該輪變慢(一次性) | compaction 完成立即 preEncode(新 context);自動壓縮只發生在 flow 間 |
| 個別 chat template 對 user 開頭/連續 user 訊息敏感 | 極少數模型報錯 | summary 用 user role 是業界常規做法;出錯時 fail 在送出前可偵測(inspector 可先驗證);需要時可在 builder 加「summary 併入 system」的 fallback 開關(預設關) |
| token 估計不準(char/4) | 斷點位置偏差 | 估計只決定「切哪」,不決定「送不送得下」;真正超標會 server 報錯,inspector 有真實 `prompt_n` 校準可看;Phase 3 升級 |
| 自動壓縮與 stream 競態 | 送出中改路徑 | I7:觸發點只在 flow 完成後 + turn 之間(皆非 streaming 中)+ `isChatLoading` / `isRunning` 雙重檢查 |
| mid-flow 再壓縮延遲(summary 呼叫在迴圈內) | agentic 該 turn 間隔變長 | 只在超 threshold 時發生;summary 可中斷(signal 綁 flow abort);fail-open 續跑;可用獨立開關(`contextAutoCompactionInLoop`)關閉 |
| flow 在 cmp 建立後中斷 | 狀態不一致? | cmp 已落 DB + currNode 已移,中斷只是「少幾則訊息」,路徑仍合法;重載後重建即用 |
| 斷點後移造成靜默資料遺失 | 品質 | 02-§4 規定:後移必須重新 summary,UI 強制流程 |
| 舊版 UI 匯入含 cmp 的檔 | 顯示異常 | role=user 降级為一般訊息,功能不損;round-trip 測試 |
| summary 品質差(本地小模型) | 上下文失真 | 預設 prompt 強調「保留具體事實/路徑/決定」;summary 永遠可見可編輯可還原(這是把 cmp 做成**樹節點 + 可視化**的最大價值) |
| agentic 迴圈內 context 爆掉(第一版不壓) | 長 agentic 任務仍可能超限 | 第一版明確範圍外;maxTurns 機制已存在;Phase 3 處理 |

## 5. 驗收標準(整體)

1. 任何一輪送出的 payload,都等於 inspector 在送出前顯示的內容(WYSIWYG)。
2. 自動壓縮開啟後,長對話不會再因 `prompt_n > n_ctx` 報錯(在模型能力範圍內)。
3. 所有 compaction 操作(建立/編輯/移動/還原)都有可視痕跡(聊天列 + inspector),
   且都可還原。
4. 未啟用、無 cmp 的對話,行為與現行版本**逐位元一致**(unit 回歸測試保證)。
5. 新增/修改的純邏輯 100% 有 unit test 覆蓋;store 層 diff 控制在
   `compactConversation` 與觸發掛鉤兩處。
