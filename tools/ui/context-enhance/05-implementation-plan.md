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

### 雙 mode — recent-window(A,預設)+ threshold-target(B = v3 + N6)(規格定稿 2026-10-17;✅ 完成並確認 2026-10-17)

> 背景:自動壓縮從未觸發(262.14K/262.14K 案例)——根因是舊 budget 公式
> (summary max 70% × 1.5 = 105% n_ctx 的 reserve)把 keepBudget 壓死在 10% floor,
> planCompaction 回 null、auto 路徑完全靜默(分析見 06-status §3.20)。使用者另引入
> pi reference 的切點(下限:至少留最近 keepRecentTokens 原樣),決定**同時保留
> 兩種作法、user 選 mode、預設 = A**;A 超標沿用 B 的重試邏輯;**計數(v4)
> = 真實 per-message 優先 + 觸發 = 真實 `contextUsed` + 無資料例外 bytes/4**
> (取代 v3 的「無 API 值用 byte」;見 02-§3.4)。決策見 06-status §3.22/§3.24;設計:
> 02-§3.3/§3.4/§6(雙 mode)、03-§2/§3/§4.2/§4.4、04-§3/§4。
>
> **狀態(2026-10-17)**:✅ **完成並確認**——共用 / A / B 三塊來源碼(18 檔,
> 明細見 06-status §3.23)+ 測試(unit `compaction-policy` 重寫 / unit
> `summarize` 更新 / client `compaction-decision-card` 新 suite /
> `context-gauge-compaction` 回歸修正,見 06-status §3.23 執行記錄)全部完成;
> 使用者完整指令全綠(`npm run check` + unit 3 支 + client 5 支;第一輪 2 支
> client 失敗——卡片標記空白 + builder summary 段 char/4 遺漏——已修,見
> 06-status §4)。下列清單全部勾選。

#### 共用(兩 mode)

- [x] `chat.service.ts`:`ApiChatCompletionResponse` 補 `timings` 欄位;
      `handleNonStreamResponse` 解析 `data.timings` 傳給 `onComplete`
      (summary 呼叫實際 completion tokens 的來源)
- [x] `summarize.ts`:`summarizeMessages` 回傳 `string` → `{ content: string;
      tokens: number | null }`(tokens = 回應的實際 completion tokens;
      server 沒回 → null → 成功判定改 `byteLen(content)` 代入)
- [x] `compaction-policy.ts`:`estimateTokens` / `estimateApiMessageTokens`
      文字部分(content / toolCalls / reasoning / attachment text / PDF text)
      char/4 → **UTF-8 byte 數**;image 1000 / audio-video 3000 不變
- [x] 超標機制(共用):成功判定式(mode 特定,§02-6)→ 重發同一 request,
      總嘗試次數 = `contextSummaryMaxAttempts`(**新共用設定**,預設 3;
      1 = 總共一次;≤ 0 = 無限;registry validator 允許 0)→ 仍超 →
      gate 問 user(同 maxTurns/tool 確認機制)
- [x] `AgenticGates`:新增 compaction-decision gate
      (`requestCompactionDecision` / `resolveCompactionDecision` /
      `getPendingCompactionDecision`,同 requestContinue 的 Promise + pending
      state 模式;abort = skip)
- [x] `agenticStore` / `chatStore`:public wrapper(request/resolve/getPending)
      + `compactConversation` / `compactBetweenTurns` 接:觸發檢查(mode 特定)
      → plan(mode 特定)→ summarize → 成功判定/重試/gate(共用);
      手動路徑(Compact now / Re-summarize / 斷點後移)同走此流程
- [x] `ChatCompactionDecisionCard.svelte`:確認卡片(與 agentic continue 卡片
      同風格):顯示這次壓完的實際數 vs mode 目標 + [使用這次壓完] [重壓]
      [這次不壓];掛法:in-loop = agentic 訊息內(與 continue 卡片同位);
      flow 之間 = 訊息列尾端獨立 row
- [x] Settings:`contextCompactionMode`(SELECT:`recent-window`(A,**預設**)
      / `threshold-target`(B),dependsOn: auto)+ dependsOn 鏈(A 欄位 / B 欄位
      掛 mode;舊 threshold/keepTarget 的 dependsOn auto → mode)+
      settings-registry-invariants 同步更新
- [x] gauge:分母 / 觸發標記跟 active mode 走(04-§3)
- [x] unit tests:byte 計數(CJK / ASCII / 附件);成功判定邊界(≤ / >);
      重試次數(1 / 3 / ≤ 0);summaryTokens null → byteLen
- [x] client tests:卡片三選項 resolve gate;abort = skip

#### Mode A — recent-window(pi reference)

- [x] 新設定(mode=A 才顯示):`contextMaxContextOverride`(INPUT,0 = 關;
      有效視窗 = min(n_ctx, override);只用於裁切決策)、
      `contextKeepRecentTokens`(INPUT,預設 20000)
- [x] `compaction-policy.ts`:新增 `planCompactionRecentWindow(path, opts)`
      (pi walk:從最後往回加 byte 數、≥ keep 停;切在交叉點以右最近合法切點;
      沒有 → 最右合法切點(尾端 tool 保留其前 ass);未達 → null;
      **A 不產生空 kept**;I5 / minSummarize 檢查)
- [x] 觸發式(A):`lastPrompt > min(n_ctx, override) − keepRecentTokens`;
      `window − keep ≤ 0` → auto 永不觸發(手動不受影響)
- [x] 成功判定式(A):`headBytes + (summaryTokens ?? byteLen) + keptBytes ≤
      window − keepRecentTokens`
- [x] unit tests:下限停止;交叉點 = tool → 保留其前 ass 整輪;交叉點 =
      user/assistant;未達 → null;A 不產生空 kept;I5(minKeptMessages /
      minKeptUserTurns);minSummarize

#### Mode B — threshold-target(v3 + N6)

- [x] `compaction-policy.ts` `computeCompactionBudget`:`keepBudgetTokens =
      floor((contextCompactionThreshold − contextKeepTargetPercent) / 100 × nCtx)`
      (threshold ≤ keepTarget → 0)——移除 summaryReserve(× 1.5)與 10% floor;
      `computeSummaryMaxTokens` 不再進 budget(只留在 summary 呼叫的 max_tokens)
- [x] 觸發式(B):`lastPrompt > n_ctx × threshold%`
- [x] 成功判定式(B):`headBytes + (summaryTokens ?? byteLen) ≤
      keepTarget% × n_ctx`
- [x] unit tests:budget 簡化公式;既有 planCompaction 測試(上限 / 空 kept)
      維持

✅ 驗收:
- Mode A(預設):長對話(262K 級)自動壓縮真的會發生,最近 ~keepRecent
  (token 數)原樣保留(巨幅 tool result → 保留整個 turn),壓完總量低於觸發點;
  超標場景(小 window / 大 keep)走重試 → gate 三選項;無 cmp 對話行為不變。
- Mode B:同 v3 原驗收(長對話自動壓縮發生;小 keepTarget 超標走重試 →
  gate;無 cmp 不變)。
- 切 mode 不影響既有 cmp 節點;inspector / 手動操作兩 mode 皆可用。

### N6 — split 切允許空 kept（使用者要求 2026-10-16，✅ 完成並確認 2026-10-17）

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
> **狀態(2026-10-17)**:✅ **完成並確認**——使用者重跑 `npm run check` +
> unit `compaction-policy` / `context-builder` + client 回歸
> (`chat-message-compaction` / `context-inspector` / `context-gauge-compaction` /
> `settings-registry-invariants`)全綠(第一輪 check 的 `context-builder.ts`
> 語法錯已修,見 06-status §4 N6 第一輪/重跑)。下列清單全部勾選。

- [x] `types/database.d.ts`:`CompactionMeta.firstKeptMessageId: string` → `firstKeptMessageId?: string`
- [x] `services/context/types.ts`:`CompactionPlan.firstKeptMessageId` /
      `ContextCompactionInfo.firstKeptMessageId` → 選用 + doc
- [x] `compaction-policy.ts` `planCompaction`:階段 2 允許 `cutIndex = path.length`
      (切在最後一則訊息之後 → 空 kept、`firstKeptMessageId` 缺);
      I5 split 下限跟 `contextKeepMinMessages`(預設 0);
      `estimateCompactionSavings` 處理「無 boundary」(dropped = head 之後全部,排除 entry 本身)
- [x] `context-builder.ts` `buildLlmContext`:缺 `firstKeptMessageId` → kept = cmp 之後的訊息
      (通常為空)、`boundaryValid = true`;id 存在但找不到 → fail-open(I3 不變)
- [x] `stores/chat/index.svelte.ts`:`boundaryIndexOf` → `keptWindowStartOf`(缺 id = entry index + 1);
      `moveCompactionBoundary` / `recompactConversationEntry` / `summarizeRegion`
      處理空 kept(region 排除 cmp 節點本身)
- [x] `constants/settings.constants.ts`:`contextKeepMinMessages` defaultValue 2→0、
      min 2→0、help 文案
- [x] `ChatMessageCompaction.svelte`:空 kept 態(「Kept from: none」、dropped 統計 = 全部、
      expand 描述)
- [x] `DialogContextInspector.svelte`:空 kept → dropped 區 = 全部;選擇器顯示
      「無保留訊息(全部壓縮)」
- [x] unit:`compaction-policy.test.ts`(split 空 kept 切點 / I5=0 / 舊「連 split
      都放不下 → null」用例更新);`context-builder.test.ts`(空 kept payload、
      缺 meta = 空 kept、fail-open 不變)
- [x] client:chat-message-compaction / context-inspector 回歸(既有 fixture 用
      `firstKeptMessageId: ''` = 「有 id 但無效」= fail-open,行為不變,確認即可)

✅ 驗收:最後一組 ass+tool 超 budget 時,自動/手動壓縮產生空 kept cmp、
payload = `[system, summary]`、inspector 顯示「無保留訊息」、斷點可前移
恢復 kept;無 cmp 對話行為不變。

### v4 — 真實 token 計數（2026-10-17 使用者定稿；✅ 完成並確認 2026-10-17）

> 背景:Context Inspector 的「Estimated send」與每則「~N tok」用
> `estimateTokens`/`estimateApiMessageTokens` 的 **UTF-8 byte 數**當 token 顯示、
> 並除 n_ctx(token)→ 數字與 gauge(真實 `contextUsed`)永遠對不上(380,513 vs
> 153,939,≈2.5 bytes/token)。使用者決策:切點/觸發/成功判定/Inspector **全用真實
> token**,估算僅限無資料例外;設定數字不變(現為 token 尺度)。設計:02-§3.4(v4)、
> 04-§2/§3/§4;決策記錄見 06-status §3.24;實做明細見 06-status §3.25。
>
> **狀態（2026-10-17）**:✅ **完成並確認**——使用者完整指令全綠（`npm run
> check` + unit `compaction-policy` 82/82 / `context-builder` / `summarize` +
> client `context-inspector` / `chat-message-compaction` /
> `context-gauge-compaction` / `compaction-decision-card` /
> `settings-registry-invariants`;第一輪 9 失敗已修、3 根因全在測試檔,見
> 06-status 檔首恢復點 / §3.25）。下列清單全部勾選。

- [x] `compaction-policy.ts`:新增純函式 `deriveRealMessageTokens(path) →
      Map<dbId, number>`(assistant=`predicted_n`;每段非-assistant 真實總和歸該段
      最後一則非-assistant;system/尾端不在 map)
- [x] `compaction-policy.ts`:新增 `messageSize(m, real, isTail) = 真實 ??
      (尾端 ? bytes/4 : 0)`;`estimateTokens` 改名 `messageBytes`(只供 inspector
      副欄 + bytes/4),不再當主大小
- [x] `planCompaction` / `planCompactionRecentWindow` / `evaluateCompactionResult`:
      所有 `estimateTokens` 加總改 `messageSize`(傳入 `realTokens` + 尾端判定);
      `minSummarizeTokens` / `keepRecentTokens` / keep budget 改 token 尺度
      (設定數字不變);mode B 原本 byte-vs-token 錯配順手修好
- [x] 觸發:`stores/chat/index.svelte.ts` / `stores/agentic/index.svelte.ts`
      `lastPrompt` 改 `contextStatsStore.contextUsed`(真實 KV),刪 byte fallback;
      `shouldTriggerCompaction` 參數 doc 改真實 contextUsed
- [x] `context-builder.ts` + `types.ts`:`ContextBuildResult.messages` 帶來源
      `sourceId`;移除 `estimatedTokens`(byte)字段
- [x] `DialogContextInspector.svelte`:標題/總和條綁 `contextUsed`/`contextTotal`
      (＝gauge);每則**主欄**＝`messageSize` 真實值(system=`-`、尾端=`est.`)、
      **副欄**＝`bytes`/`bytes÷4 est.`;整條 byte-當-token 拿掉
- [x] `ChatMessageCompaction.svelte` / `ContextGaugePopup.svelte`:「N→M」/
      「tokens saved」改真實 token(gauge 走 `estimateCompactionSavings` 純函式、零改動)
- [x] unit:`deriveRealMessageTokens`(assistant/段總和/首段/多非-assistant/尾端);
      `messageSize`(真實/尾端 bytes/4/非尾端 0);切點 A/B + 成功判定吃真實 token;
      觸發 `contextUsed`(=0 不觸發)——`compaction-policy.test.ts` 全數重寫完成
- [x] client:Inspector 標題＝gauge、主欄真實/`-`/`est.`、副欄 bytes+bytes/4;
      cmp「N→M」真實（4 client 測試全數更新,逐檔明細見 06-status §3.25；含修
      `DialogContextInspector` `row.tokens` 模板殘留 bug；使用者編譯驗證全綠）
- [x] 回歸:`compaction-policy` ✅ 已重寫 / `context-builder` 已改 token 尺度
      期望值 + `sourceId` 斷言（mock 改 `convertDbMessageToApiChatMessageData`）
      / `summarize` 3 處 `CompactionPlan` literal 補 `keptTokens` /
      `realMessageTokens`（mode A postSize 依 `keptTokens` 重算 = 10001）

✅ 驗收:Inspector 標題/總和條＝gauge 真實值(同單位同量級);每則主欄真實、
副欄 bytes+bytes/4;切點/觸發/成功判定全真實 token;無資料例外(system、尚未送出
尾端)才 bytes/4;設定數字不變(現 token 尺度)。

### N7 — 壓縮進行中:輸入 queue + in-chat 指標列(Stop)(設計定稿 2026-10-04;✅ 完成並確認 2026-10-04,使用者重跑全綠,見 06-status §2u/§3.26)

> 背景(分析已對 code 驗證,2026-10-04,見 06-status §3.26):post-flow 自動
> 壓縮兩個觸發點是 fire-and-forget;I7 guard 只在 `compactConversation` 開頭
> 檢查一次、`sendMessage` 不查 `compacting` → user 在 summary 期間立刻送下一句:
> (a) cmp 懸空(新 turn 的 `updateCurrentNode` 覆蓋 cmp 的)→ Summary 靜默丟失;
> (b) 該句以**未壓縮**全量 context 送出 → overflow 風險。手動 Compact /
> Re-summarize / 斷點後移同窗。in-loop 不受影響(loop block、輸入走
> steering)。進行中狀態也只在 gauge popup 可見、post-flow 聊天區無 Stop 入口。
>
> **使用者決策(2026-10-04)**:queue 不 block(輸入 → pending、壓縮完成後
> 自動送)+ in-chat 明確指標列(含 Stop)+ pending row 顯示於指標列下方
> (既有 `ChatMessageUserPending`)。設計:04-§4.2;實做明細:06-status §2u。

- [x] `context-stats.svelte.ts`:新增 `compactingConvId: string | null`;
      `setCompacting(convId | null)` helper(`compacting` + `compactingConvId`
      原子設定/清除)
- [x] `stores/chat/index.svelte.ts` `sendMessage`:新 guard 層(在 steering /
      streaming-pending 之後):`compacting && compactingConvId === convId` →
      `injectPendingMessage` + return
- [x] `stores/chat/index.svelte.ts` `compactConversation`:
      `setCompacting(convId)` 前移至 guard 檢查通過後立刻(path 解析 / plan
      之前);`finally` → 共用 finalizer `endCompactionState(convId)`
      (`setCompacting(null)` + consume pending → 自動送)
- [x] `stores/chat/index.svelte.ts` `moveCompactionBoundary`(後移) /
      `recompactConversationEntry`:同上(帶 convId 設定 + finalizer)
- [x] `stores/agentic/index.svelte.ts` `compactBetweenTurns`:
      `setCompacting(convId)`(無 finalizer 自動送 —— 該處輸入已在 guard 第 1
      層走 steering、由下一 loop iteration 消費)
- [x] `stores/chat/index.svelte.ts` `abortCurrentFlow`:補 `this.stopCompaction()`
      (pending row 的 Send-immediately 於壓縮期間 = 中斷 summary → finalizer
      自動送;無手動壓縮時 no-op)
- [x] `ChatMessages/ChatMessageCompacting.svelte`(新):指標列(spinner +
      「Compacting context…」+ [Stop]);Stop 分派:`isRunning(convId)` ?
      `stopGeneration()` : `stopCompaction()`;顯示條件 = 04-§4.2(per conv /
      尾端非 cmp / 超標卡片顯示中不顯)
- [x] `ChatMessages.svelte`:訊息列尾端、超標卡片**上方**插入指標列 block
      (DOM 序:訊息列 → N7 指標列 → 超標卡片 → pending/steering row);export
      與 `ChatCompactionDecisionCard` 同 barrel
- [x] client 測試:指標列顯示/隱藏(同 conv / 他 conv / 尾端 cmp / 超標卡片
      顯示中);Stop 分派(running / 非 running);`sendMessage` 於 compacting
      (同 conv → pending、無 API 呼叫;他 conv → 正常);finalizer 自動送
      (成功 / abort 兩路徑);DOM 序(指標列在 pending row 上方)
- [ ] 手動驗收:見 §3 新增 5 項(#8–#12,未做)

✅ 驗收:自動壓縮窗口內送下一句 → 訊息出現為 pending row、壓縮完成後自動送、
payload = `[system, summary, kept…] + 新 turn`;Stop → 不建 cmp、queue 訊息
照常送出(全量 context);他 conversation 輸入不受影響;in-loop 行為不變
(steering)。

### N8 — 第二次壓縮：plan 改在 effective path（bug 修正；規劃 2026-10-18；✅ 完成 + 回歸確認（2026-10-18）、手動驗收未做；明細見 06-status §3.27）

> 背景（分析已對 code 驗證，2026-10-18）：第二次（及之後）壓縮的
> `planCompaction*` 收到的是 **raw DB path**（含舊 cmp 已 drop 的原始訊息 +
> 舊 cmp 節點）→ `toSummarize` 在 raw path 上切 → prefix-stable summary
> 呼叫把整段原始歷史重送 → context overflow → summary 失敗（fail-open、不建
> cmp）→ agentic loop 卡在超標 context。inspector（走 builder）顯示
> effective context `[system, summary, 101..199]`，兩者分岔（違反
> WYSIWYG）。設計意圖是 rolling summary（02-§4「第二次壓縮」：新 summarize
> 區含舊 cmp 節點）；實做漏了「planning 前先 collapse path」這一步。修正：
> 新 `effectiveCompactionPath()`（context-builder.ts、與 `buildLlmContext`
> 共用窗口解析）+ 兩個 planning 呼叫點餵它。根因 / 邊界情境 / 測試計畫：
> 06-status §3.27。

- [x] `services/context/context-builder.ts`：抽 `buildLlmContext` 現行窗口
      解析為共用內部 helper（I1 head / I2 最後一筆生效 / I3 fail-open）；新
      export 純函式 `effectiveCompactionPath(path)`：無 cmp → 原樣；boundary
      失效 → raw（fail-open）；否則 → `[...head, entry, ...kept]`（entry 留
      陣列當一般節點）
- [x] `stores/agentic/index.svelte.ts` `compactBetweenTurns`：
      `planCompaction*(effectiveCompactionPath(path), …)`
- [x] `stores/chat/index.svelte.ts` `compactConversation`：同上（涵蓋
      post-flow auto + 手動 Compact now）
- [x] unit `context-builder.test.ts`：`effectiveCompactionPath` suite（無
      entry / 單 cmp / 空 kept / I3 ×2 / entry 後追加訊息 / 舊 cmp 落 kept
      區）
- [x] unit `compaction-policy.test.ts`：「第二次壓縮」向量（effective path →
      plan：summarize 區排除已 drop 原始訊息 / `firstKeptMessageId` 來自 cmp
      後區域 / `summarizeTokens` ≈ effective 規模）
- [x] unit `summarize.test.ts`：prefix-stable payload「path 已含舊 cmp」向量
      （= `[system, 舊summary, 新訊息, instruction]`）
- [x] 回歸：`npm run check` + 既有 5 支 client compaction suite 零改動全綠
- [ ] 手動驗收（使用者原始場景）：agentic loop 連壓兩次 → 第二次 summary
      請求 = `[system, 舊summary, 新訊息, instruction]`、loop 正常續跑；
      toast / gauge token 數字與 effective context 一致

✅ 驗收：第二次（及 N 次）壓縮的 summary 輸入 == inspector 的 payload +
壓縮指令（WYSIWYG）；新 cmp 的 `firstKeptMessageId` 指向 kept 區真實 DB
訊息；下一輪 payload = `[system, cmp_new, kept]`；手動 re-summarize / 斷點
後移不變（仍是 raw region 語義）。

**明確不改**（06-§3.27）：`recompactConversationEntry` /
`moveCompactionBoundary`（後移）（`buildRegionPlan` 的 raw-region 語義）/
`estimateCompactionSavings` / policy 函式契約（collapse 在呼叫端）。

### N9 — F5 / refresh 韌性：in-loop compaction 原子 commit + orphan 收編（規格定稿 2026-10-18；未實做；明細見 06-status §3.28）

> 背景（已對 code 驗證，2026-10-18）：in-loop compaction 的
> `createCompactionMessage`（單一 IDB transaction）與 `updateCurrentNode`（獨立 IDB
> 寫入）**非原子** → 兩寫之間 F5（或 `updateCurrentNode` 拋錯）→ cmp orphan（在
> DB、leaf 的 child、不在 active path、UI 不可見）→ `buildLlmContext` reload 後看不到
> cmp → 全量送出 → context overflow + 不可見孤兒節點。F5 在 summary 呼叫中（最可能
> 的刷新時刻）= 設計中的 fail-open（不建 cmp、≤n_ctx 自愈；>n_ctx 需手動 compact）。
> 非「永久狀態損毀」：無資料遺失（compaction 從不刪訊息）、手動 Compact now 可恢復。
> 修復規格與完整分析：06-status §3.28。

- [ ] `database.service.ts`：新 `commitCompactionMessage({ convId, parentId, content,
      compactionMeta })`——單一 IDB transaction 跨 `[messages, conversations]`（add cmp
      + 附 parent children + `currNode = cmp.id`，all-or-nothing；同
      `expandCompactionMessage` 模式）
- [ ] `agentic compactBetweenTurns` + `chat compactConversation`：改走原子 commit、
      移除獨立 `updateCurrentNode`
- [ ] 純函式 `findOrphanedCompaction(allMessages, currNodeId) → cmpId | null` + unit
      4 向量（leaf child / leaf descendant / 無 cmp / 其它分支）
- [ ] `loadConversation`：偵測 orphan cmp（currNode 的 child）→ 收編（`currNode =
      cmp.id`，持久化 + in-memory）
- [ ] （可選）送出前 overflow guard：built payload 估計 > n_ctx → 擋下 +
      [Compact now / 刪訊息 / 強制送出]
- [ ] 02-§4 邊界情境表：F5 列（已同步）
- [ ] 回歸：`npm run check` + 既有 5 支 client compaction suite 零改動全綠
- [ ] 手動驗收：兩寫視窗 breakpoint 模擬 → F5 → cmp 在 path、不 overflow；summary
      呼叫中 F5 → 全量 context、自動再觸發；預植 orphan → 載入收編

✅ 驗收：in-loop compaction 的 transaction commit 後任何時刻 F5 → reload path 含 cmp、
payload = `[system, summary, kept]`、不 overflow；DB 無 orphan cmp（或有則載入時自動
收編）；summary 呼叫中 F5 = 設計中的 fail-open（不建 cmp、≤n_ctx 自愈）。

**明確不做**（06-§3.28）：agentic loop 跨 F5 可復原（in-memory loop 不復原；
server-side stream 可能經 `discoverActiveStream` 接回完成目前 turn、但 tool 執行不
復原——既有）；N7 in-memory queue（pending messages）F5 即失（既有、輕微）。

### N10 — in-loop compaction 的 cmp 被接成 sibling（系統性 bug；✅ 完成並確認 2026-10-18；明細見 06-status §3.29）

> 背景（使用者回報 + 已對 code 驗證，2026-10-18）：agentic loop 連壓兩次正常停下
> 後，UI 看得到 summary；但 F5 或匯出→匯入後**所有 summary 消失**、inspector 顯示
> 全量、session 無法繼續（overflow）。根因：flow 的下一則訊息用 closure 變數
> `lastCreatedInFlow`（`chat/index.svelte.ts:1596/1675/1711`）當 parent，compaction
> 從不推進它 → `101.parent = 099 = cmp1.parent`（sibling）→ cmp 不在 root→currNode
> 路徑上；in-memory 平陣列（`addMessageToActive`）遮住分岔，任何從樹重建的路徑
> （load / export / import）都丟 cmp。post-flow 壓縮無此問題（下一則 user 訊息走
> `addMessage('-1')` → live 陣列尾端 = cmp）。

- [x] agentic flow callback 型別新增 `onCompaction?(cmp: DatabaseMessage)`
- [x] `streamChatCompletion` 接線：`onCompaction: (cmp) => { lastCreatedInFlow =
      cmp.id; }`
- [x] `compactBetweenTurns`：callbacks 傳入；cmp 建立 + currNode 更新成功後呼叫
      `callbacks.onCompaction?.(cmp)`
- [x] 純函式 `findCompactionGraftFixes(allMessages, currNodeId) →
      { cmpId, reattachId }[]` + unit 5 向量
- [x] 已損樹修復（單一 IDB transaction：`c2.parent = c.id`、`p.children` 移除
      `c2.id`、`c.children` 加入 `c2.id`）+ app 啟動一次性 migration +
      `loadConversation` 防禦層
- [x] 回歸：`npm run check` + unit `branching`（`findCompactionGraftFixes` 5 向量）
      + 既有 5 支 client compaction suite 零改動全綠（2026-10-18 確認）
- [ ] 核心回歸（手動）：in-loop compaction 後下一則 assistant 訊息
      `parent === cmp.id`
- [ ] 手動驗收（使用者原始場景）：agentic loop 連壓兩次正常停下 → F5 → summary
      都在、inspector = 壓縮後 context；匯出 → 匯入 → 同；session 可繼續
- [ ] 既有已損對話：啟動 migration 後開啟 → summary 回到路徑上、可繼續

✅ 驗收：in-loop compaction 後 DB 樹 == in-memory 陣列（cmp 在 root→currNode 路徑
上）；F5 / 匯出匯入後 summary 節點保留、inspector 顯示壓縮後 context、session 可
繼續；既有已損對話經 migration 恢復。

**與 N9 的關係**（06-§3.29）：N9.1（原子 commit）/ N9.2（收編 currNode 的 child）
仍需要、與 N10 互補；N10.2 偵測簽名不同（sibling of path node vs child of leaf）。

### N11 — compact request 前綴一致性：tool result 附件被丟（N11.1，P0）+ full-path summary（N11.2 = A4，使用者定案 2026-10-18）（分析 + 規劃 + 決策 + 實做 2026-10-18；source + 測試完成、待確認；明細見 06-status §3.30 / §5g）

> 背景（使用者抓包 + 已對 code 驗證，2026-10-18）：使用者 agentic loop
> （mode B threshold-target、threshold 40% / keepTarget 35% / n_ctx 262144、
> in-loop + auto compaction 皆 on）`[system, 舊summary, 101..186（無其它 user
> 訊息）]` 觸發壓縮。抓包（本目錄 `before-trigger.json` = 觸發前實際送出 payload，
> 187 則；`compact-requset.json` = compact request，164 則）確認兩問題：
>
> ① **P0 bug（N11.1）**：`convertDbMessageToApiChatMessageData`
> （`chat.service.ts:142–149`）對 `role=tool + toolCallId` early-return
> `{content: string, role, tool_call_id}`、**完全忽略 `message.extra`** → MCP
> screenshot 的 image base64 在**所有從 DB 重建 payload 的路徑**被丟（compact
> request / post-compaction 下一 turn / F5 後第一 turn / preEncode / inspector）→
> compact request 前綴在**第一張 screenshot（約第 125 則 loop 訊息）**即與實際
> 送出 payload 分岔 → KV cache 失效（抓包主因）。主送出路徑是另一條路：agentic
> loop 在 tool 執行後自己組 parts（`agentic/index.svelte.ts:1168–1206`，vision /
> audio 由 model 決定）→ D1「附件原樣送、前綴 byte-identical」承諾（06-§3.18）
> **對 tool result 從未成立**（06-§2h 曾記「窄邊界情境」，抓包證明是常態）。
> 附帶發現（同屬前綴一致性）：`"content": ""` vs 欄位遺漏（in-flow
> `agentic:947` `turnContent || undefined` 省略、轉換送 `''`）；image cap 不一致
> （轉換有 `capImageDataURLSize`、in-flow 不 cap）。
>
> ② **設計決策（N11.2，A4 使用者定案 2026-10-18）**：summary 用**整個 effective
> path**產生（compact request = `buildLlmContext(effectivePath).messages` +
> instruction、复用原 chat UI code path 不自組裝 → 前綴 = 完整最後送出 payload、
> 最大 cache 亲和性）；切點 / cmp 嫁接 / post-compaction 形狀**不變**（抓包例：
> kept = 165..186 append 到 summary 後，與 summary 刻意重複確保精確度）。scope =
> 所有 compaction；prompt / max_tokens 不變；無新 meta / 無新設定 / 無 fallback。

> **D1 定案（使用者 2026-10-18）取代原規劃的「model 參數 / 參數 thread / vision
> filter 共用 gating」三項（已整段刪除）**：tool result DB 重建與 in-flow 走 user input
> 同路徑（shared builder、無 model 參數、無新 gating）。

- [x] N11.1（P0）：`chat.service.ts` 把 `extra → parts` 區塊原樣抽出為
      `ChatService.buildExtraContentParts({ content, extra })`（固定序、images 一律
      `capImageDataURLSize`、無 model gating）
- [x] N11.1：`convertDbMessageToApiChatMessageData`：`role=tool + toolCallId + 有 extra`
      不再 early-return：`{ content: await buildExtraContentParts(message), role: TOOL,
      tool_call_id }`；`tool + 無 extra` 現行 plain early-return 不變；非 tool 有 extra
      改調 shared builder（行為不變）
- [x] N11.1：序列化對齊：assistant + tool_calls 且 content 空 → 轉換**省略
      content 欄位**（向 in-flow 對齊——cache 是 in-flow 建的，重建端要跟它一致）
- [x] N11.1：in-flow tool result parts 建構（`agentic/index.svelte.ts:1168–1206`）
      整段改調 `buildExtraContentParts` + `parts.length <= 1 ? cleanedResult : parts`
      （cap 統一、順手修掉 in-flow 不 cap；順序改 user input 路徑；`<= 1` 讓空 content
      + 無附件邊界情境 wire 不變）
- [x] N11.1：`toAgenticMessages` TOOL 分支保留 parts content
      （`AgenticMessage.content: string | ApiChatMessageContentPart[]`、
      `agentic:150–156` 不再 `→ ''`）
- [x] N11.1：清理不再使用的 import（`ContentPartType` / `ApiChatMessageContentPart` /
      `getAudioInputFormat` / `DatabaseMessageExtraAudioFile` /
      `DatabaseMessageExtraImageFile`）
- [x] **一律不動**：`normalizeMessagesForApi` / `resolveOutgoingMessages` /
      `buildLlmContext` / `ContextBuildOptions` / `preEncode` / `sendMessage` /
      vision filter（D1：無 model 參數、無新 gating）
- [x] N11.2（A4）：`summarizeMessages` / `summarizeWithRetry` 加 `planPath` 參數
      （effective path，呼叫點已有：`agentic:559` / `chat:623` / re-summarize =
      `effectiveCompactionPath(path)`）
- [x] N11.2（A4）：prefix-stable payload =
      `buildLlmContext(planPath, { excludeReasoning }).messages` + instruction；
      **刪除**現行 `normalizeMessagesForApi([systemHead]) + normalize(toSummarize)`
      自組裝（`summarize.ts:213–223`）
- [x] N11.2（A4）：transcript 模式 `buildSummaryTranscript` 區段同步改 full path
      （`toSummarize + kept`）
- [x] N11.2（A4）：兩呼叫點 `summarizedCount` = `plan.toSummarize.length +
      plan.kept.length`（`agentic:616` / `chat:677`；`chat:871` 邊界移動不改）
- [x] unit：`buildExtraContentParts` / 轉換矩陣（tool result × image / audio / 兩者 /
      無 extra → 固定序、cap 被呼叫、無 extra 回 string + `tool_call_id`）；in-flow 與
      DB rebuild 的 **byte-identity**（同函式同輸入）；空 content 序列化三態
      （assistant + tool_calls + 空 → 欄位省略；tool_calls 非空 → 保留；無 tool_calls
      空 → `content: ''` 不變）（N11.3 → `tests/unit/chat-conversion.test.ts`）
- [x] regression（N11.3，合成 fixture：screenshot tool result data URL 圖 + audio）：
      in-flow ≡ DB rebuild byte-identical；compact request = 最後一筆 payload 的
      **byte-prefix** + instruction（本目錄兩份抓包只作根因文檔證據、不適用當 oracle）
      （→ `tests/unit/chat-conversion.test.ts`）
- [x] `tests/unit/summarize.test.ts` 過期修正（決定 B，使用者 2026-10-18：併入
      N11.3）：呼叫補 `planPath` + mock `convertDbMessageToApiChatMessageData`
      （faithful stand-in）+ payload assertions = `buildLlmContext(planPath).messages`
      + instruction（無 cmp / 有 cmp、prompt 選擇、excludeReasoning、transcript =
      `toSummarize + kept`）
- [ ] 回歸：`npm run check` + 既有 5 支 client compaction suite 零改動全綠
      （⏸ 2026-10-18 待使用者編譯確認）
- [ ] 手動驗收：MCP screenshot flow → 連壓兩次 + F5 → server `cache_n`（gauge）
      在 compact request 與後續 turns 皆高命中

✅ 驗收：所有 DB 重建路徑（compact request / post-compaction 下一 turn / F5 後
第一 turn / preEncode / inspector）與 in-flow 送出的前綴 **byte-identical** →
KV cache 不因任何重建失效；inspector == 實際送出（WYSIWYG 恢復）。N11.2（A4）：
compact request = `[system, 舊summary, 101..186]` + instruction、前綴 =
完整最後送出 payload（到 184）；post-compaction = `[system, 新summary, 165..186]`
繼續執行。

**與 N9 的關係**（06-§3.30）：獨立（N9 = cmp/currNode 兩寫原子性；N11 = payload
前綴一致性）。N11.1 修掉「reload 後第一 turn 斷前綴」的症狀，但 N9 的 orphan
cmp 韌性仍需要。

**明確不改**（06-§3.30）：`planCompaction` / 切點 / budget / 雙 mode 語義（A4
只改 summary 輸入區段、切點照現行計算——mode A/B 皆適用）；cmp 節點格式 /
`compactionMeta` 欄位（不新增）；prompt 文字；`max_tokens`
（`computeSummaryMaxTokens`）；over-target check / retry / gate；無新設定、無
fallback / overhead 邏輯。

### Phase 3 —(可選,後續)

> **下一輪(N1–N5)✅ 全部完成並確認**——明細見 06-status §3.13–§3.19 / §5c
> (N1 summary 上限 n_ctx × % / N2 keep target 設定 / N3 手動壓縮 Stop 鍵 /
> N4 prefix-stable default / N5 `contextSummaryMode`)。

- [ ] 兩段式 summary(兩次 LLM 呼叫再合併)取代單呼叫雙段 prompt
- [x] ~~token 估計校準:用 `timings.prompt_n` 反推每則成本~~ → v3 一度以 byte 數取代;
      **v4 改回真實 per-message**(`deriveRealMessageTokens`,相鄰 `prompt_n` 推得),
      估算僅限無資料例外(system/尚未送出尾端),見 02-§3.4 / 上方 v4 區塊
- [ ] per-conversation 覆蓋(「此對話停用自動壓縮」,
      放 `ConversationPreferences`)
- [ ] 舊 cmp 落在 kept 區時的「合併重摘要」提示
- [ ] gauge「tokens saved」顯示（`estimateCompactionSavings`）：in-effect entry
      現按 bytes/4 計入 payload（v4 tail 語義,2026-10-17 使用者決策）——僅
      提示用途、無實質影響；若差距太大,考慮移除該顯示

## 2. 檔案清單

### 新增

| 檔案 | 說明 |
| ---- | ---- |
| `src/lib/services/context/types.ts` | `CompactionPlan` / `ContextBuildResult`（N11 不改：無 model 參數） |
| `src/lib/services/context/context-builder.ts` | `buildLlmContext`(唯一 choke point) + `effectiveCompactionPath`(N8:套用 cmp 後的 path = planning 輸入)；(N11 不改) |
| `src/lib/services/context/compaction-policy.ts` | `planCompaction` / `deriveRealMessageTokens` / `messageSize` / `messageBytes`（N11.2 A4 不改：切點照現行計算） |
| `src/lib/services/context/summarize.ts` | transcript 組裝 + summary 呼叫；(N11.2 A4)收 `planPath` 參數、prefix-stable payload = `buildLlmContext(planPath).messages` + instruction（刪自組裝）、transcript 區段 = full path |
| `src/lib/services/context/index.ts` | barrel |
| `src/lib/components/app/chat/ChatMessages/ChatMessage/ChatMessageCompaction/ChatMessageCompaction.svelte` | cmp 渲染 |
| `src/lib/components/app/dialogs/DialogContextInspector.svelte` | inspector(可再拆 2~3 個子元件:訊息列、已裁切區、進階區) |
| `src/lib/components/app/chat/ChatMessages/ChatMessageCompacting.svelte` | (N7)壓縮進行中指標列(spinner + Stop) |
| `tests/unit/branching.test.ts` | (N10)`findCompactionGraftFixes` 5 向量 |
| `tests/unit/context-builder.test.ts` | |
| `tests/unit/compaction-policy.test.ts` | |
| `tests/stories/ChatMessageCompaction.stories.svelte` | |

### 修改(每筆一句話理由)

| 檔案 | 改動 |
| ---- | ---- |
| `src/lib/enums/chat.enums.ts` | `MessageType.COMPACTION` |
| `src/lib/types/database.d.ts` | `CompactionMeta` + `DatabaseMessage.compactionMeta?` |
| `src/lib/services/database.service.ts` | `createCompactionMessage()`;(必要時)`reparentDirectChildren` 開放給 expand 流程;(N10)`applyCompactionGraftFixes`(單一 IDB transaction) |
| `src/lib/utils/branching.ts` | (N10)`findCompactionGraftFixes` 純函式(路徑邏輯零改動) |
| `src/lib/services/migration.service.ts` | (N10)`compaction-graft-fix-v1` 啟動 migration |
| `src/lib/stores/conversations/index.svelte.ts` | (N10)`loadConversation` 防禦層(graft fix 檢查 + 套用) |
| `src/lib/types/agentic.d.ts` / `types/chat.d.ts` | (N10)`onCompaction` callback 型別 |
| `src/lib/services/chat.service.ts` | `sendMessage` / `preEncode` 改走 builder(簽名不變)；(N11)`buildExtraContentParts` shared builder（`extra → parts` 原樣抽出、images 一律 cap、無 gating）+ `convertDbMessageToApiChatMessageData` tool+extra 走它 + 空 content 序列化對齊（無 model 參數、無新 gating） |
| `src/lib/stores/agentic/index.svelte.ts` | flow 開始前改走 builder;(N7)`compactBetweenTurns` 改 `setCompacting(convId)`;(N8)`compactBetweenTurns` plan 改餵 effective path;(N10)callbacks 傳入、cmp 建後呼叫 `onCompaction`；(N11)tool result parts 抽 shared helper + `toAgenticMessages` 保留 parts；(N11.2 A4)傳 `planPath` 進 `summarizeWithRetry` + `summarizedCount` = full path 覆蓋 |
| `src/lib/stores/chat/index.svelte.ts` | `compactConversation()`、自動觸發掛 `onFlowComplete`、inspector 快照;(N7)`sendMessage` guard + `endCompactionState` finalizer + `compacting` 前移 + `abortCurrentFlow` 補 `stopCompaction()`;(N8)`compactConversation` plan 改餵 effective path;(N10)`streamChatCompletion` 接 `onCompaction` → 推進 `lastCreatedInFlow`；(N11.2 A4)同 agentic：傳 `planPath` + `summarizedCount` = full path 覆蓋 |
| `src/lib/stores/chat/context-stats.svelte.ts` | (Phase 2)compacted 指標;(N7)`compactingConvId` + `setCompacting` helper |
| `src/lib/constants/settings-keys.constants.ts` | 6 個新 key |
| `src/lib/constants/settings.constants.ts` | `SETTINGS_REGISTRY` 條目 |
| `src/lib/components/app/chat/ChatMessages/ChatMessage/ChatMessage.svelte` | 分派新 branch |
| `src/lib/components/app/chat/ChatMessages/ChatMessages.svelte` | grouping 確認(大概率零改動)+ 測試;(N7)尾端插入指標列 block |
| `src/lib/components/app/chat/ChatForm/ChatFormContextGauge/ContextGaugePopup.svelte` | inspector 入口 + compacted 列 |
| `src/lib/hooks/use-keyboard-shortcuts.svelte.ts` | 快捷鍵(Phase 2) |
| `src/lib/components/app/chat/index.ts` / `dialogs/index.ts` | export |

**刻意不改的**:`conversationsStore` 的路徑邏輯(`filterByLeafNodeId` 對新 type
透明)、import/export 服務。（`convertDbMessageToApiChatMessageData` 原本列此處;
**N11.1 改它**——tool+extra 走 shared builder + 空 content 序列化對齊——但仍維持
單一副本不 fork：builder 與 in-flow 都調同一個 `buildExtraContentParts`。）
(`branching.ts` 原列此處;N10 新增純函式
`findCompactionGraftFixes`,路徑邏輯本身仍零改動。）

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
- (N7)指標列顯示/隱藏(同 conv / 他 conv / 尾端 cmp / 超標卡片顯示中);
  Stop 分派(running → `stopGeneration`、非 running → `stopCompaction`);
  `sendMessage` 於 compacting(同 conv → `injectPendingMessage`、無 API
  呼叫;他 conv → 正常送出);finalizer 自動送(成功 / abort 兩路徑);
  DOM 序(指標列在 pending row 上方)

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
8. (N7)低 threshold 觸發自動壓縮 → 聊天區出現指標列(含 Stop);
   壓縮期間送下一句 → pending row 出現於指標列下方 → 壓縮完成 →
   自動送、payload 含 summary + 新 turn(inspector 可驗)。
9. (N7)指標列 Stop → 不建 cmp、queue 訊息照常送出(全量 context)。
10. (N7)pending row 的 Send-immediately(壓縮期間)→ summary 中斷、訊息送出。
11. (N7)conv A 背景壓縮中 → conv B 的輸入/送出完全不受影響;
    切回 A 時指標列/ pending row 仍在(若壓縮未完成)。
12. (N7)in-loop 壓縮期間輸入 → 仍走 steering(行為不變);指標列 Stop =
    停 flow。

## 4. 風險與緩解

| 風險 | 影響 | 緩解 |
| ---- | ---- | ---- |
| KV cache 前綴改變 → compaction 後首次全量 re-prompt | 該輪變慢(一次性) | compaction 完成立即 preEncode(新 context);自動壓縮只發生在 flow 間 |
| 個別 chat template 對 user 開頭/連續 user 訊息敏感 | 極少數模型報錯 | summary 用 user role 是業界常規做法;出錯時 fail 在送出前可偵測(inspector 可先驗證);需要時可在 builder 加「summary 併入 system」的 fallback 開關(預設關) |
| token 估計不準(char/4) | 斷點位置偏差 | 估計只決定「切哪」,不決定「送不送得下」;真正超標會 server 報錯,inspector 有真實 `prompt_n` 校準可看;Phase 3 升級 |
| 自動壓縮與 send 競態(N7) | 壓縮進行中(fire-and-forget)user 送新訊息 → cmp 懸空 / Summary 靜默丟失 + 未壓縮 context 送出 overflow | N7(設計 2026-10-04,06-§3.26):`sendMessage` guard(同 conv `compacting` → pending queue,任何結束皆自動送)+ per-conv `compactingConvId` + `compacting=true` 前移 + 四路徑 finalizer;UI 指標列(Stop)為第二層。I7 維持(觸發點 + 雙重檢查) |
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
