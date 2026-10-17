# Context Enhance — 自動上下文管理(壓縮/裁切)設計分析

> 目標:llama-ui 目前把「root → currNode 的完整訊息路徑」原封不動送給 LLM,
> 沒有做任何裁切或壓縮。本目錄分析如何加入**自動上下文管理**(compaction),
> 並讓 user 能看到「壓縮後實際送出的資料」、允許進階 user 人工介入編輯。
>
> 本文件集是**設計分析與實施規劃**；實做進度與決策記錄見
> [06-status.md](./06-status.md)（Phase 0 完成；Phase 1 5.1–5.7 完成並確認、
> 剩 5.8 手動驗收；**Phase 2 P2.1–P2.6 全部完成並
> 確認**（client suite 全綠 + `npm run check` 全綠，見 06-status 恢復點 /
> §2p–§2r）。剩：5.8 手動驗收 + Phase 3 可選後續（**N1 ✅ 完成並確認**；
> **N2 ✅ 完成並確認**（threshold 預設 80→70 + `contextKeepTargetPercent`，
> 見 06-status §3.14）；**N3 ✅ 完成並確認**（手動壓縮 [Stop] 鍵，見
> 06-status §3.15）；**N4 ✅ 完成並確認**（prefix-stable summary 模式設為
> default，附件原樣送 + reasoning 跟隨主送出開關，見 06-status §3.18）；
> **N5 ✅ 完成並確認**（新設定 `contextSummaryMode`：summary 的 prompt
> 模式開放給 user 選，見 06-status §3.19））。
> **目前停點**：**雙 mode（共用 + A + B）✅ 完成並確認**
> （2026-10-17；完整指令全綠，第一輪 2 支 client 失敗已修：
> 卡片標記空白 + builder summary 段 char/4 遺漏，見 06-status
> §3.23/§4）——規格：同時保留兩種作法、user 選 mode、
> **default = A（recent-window / pi reference）**：A = 至少留最近
> `keepRecentTokens` 原樣 + 觸發 `window − keep`（window = min(n_ctx,
> `contextMaxContextOverride`）；B = v3 + N6（kept ≤（threshold−keepTarget）%、
> 成功判定 head+summary ≤ keepTarget%、允許空 kept）。**計數(v4,2026-10-17)=
> 真實 per-message 優先**(`deriveRealMessageTokens`:assistant=predicted_n、
> 段真實總和歸該段最後一則非-assistant)、**觸發 = 真實 `contextUsed`**
> (gauge 同源)、無資料例外(system / 尚未送出尾端)才 `bytes/4` 估算;
> 設定數字不變現為 token 尺度(見 02-§3.4)。超標 → 重試(`contextSummaryMaxAttempts`)→
> user gate（使用/重壓/跳過）。設計見 06-status §3.22、實做明細（18 檔）見
> §3.23、驗證修正明細見 06-status 恢復點；**剩**：Phase 1 5.8 手動驗收
> （見 06-status §4 清單；A/B mode 行為可一併驗）+ Phase 3 可選後續
> （兩段式 summary / per-conversation 覆蓋 / 合併重摘要提示 / summary
> 獨立 model / endpoint，見 05-§1；token 校準已被 v3 取代）。
> 此前：**N6 split 切允許空 kept ✅ 完成並確認**（2026-10-17：check + unit
> `compaction-policy` / `context-builder` + client 回歸 4 支全綠，見 06-status
> §3.21/§4；N6 = split 切下限 2→0、最後 ass+tool 放不下時切在最後一則之後
> 全壓、`firstKeptMessageId` 缺 = 空 kept）；v3 重設計已確認（「自動壓縮從未
> 觸發」根因見 06-status §3.20，現為雙 mode 規格的方法 B）；N1–N5 全部完成並
> 確認（N5 = `contextSummaryMode` SELECT 設定 +
> `toSummaryMode()` + 3 個呼叫點透傳，unit 16/16 + client registry 全綠）；剩 Phase 1 的 5.8 手動驗收 + Phase 3
> 可選後續（含 summary 獨立 model / endpoint；token 校準已被 v3 取代）。

## 目錄

| 文件 | 內容 |
| ---- | ---- |
| [01-current-state.md](./01-current-state.md) | 現況分析:context 目前如何組裝並送出(含檔案/行號)、為什麼沒有裁切、所有必須保持一致的消費點 |
| [02-data-model.md](./02-data-model.md) | 資料模型:compaction entry 格式、送出規則(演算法 + 不變式)、邊界情境、summary 產生方式 |
| [03-architecture.md](./03-architecture.md) | 架構:模組劃分、核心 API、整合點對照表、流程時序、替代方案比較、可維護性論點 |
| [04-ui.md](./04-ui.md) | UI 改動:compaction entry 渲染、「LLM 實際看到什麼」inspector、人工介入(編輯/移動斷點/手動壓縮)、context gauge、settings |
| [05-implementation-plan.md](./05-implementation-plan.md) | 分階段實施計畫、檔案清單(新增/修改)、測試計畫、風險與取捨、驗收標準 |
| [06-status.md](./06-status.md) | **實做狀態(continuity doc)**:Phase 0/1/2 交付明細、設計決策、驗證狀態、Phase 1 與 Phase 2 執行清單 |

## TL;DR — 核心決策

1. **Compaction 以「對話樹上的一個新節點」形式存在**(`type: 'compaction'`,新 `MessageType`),
   而不是 conversation 層級的欄位。樹是「送什麼給 LLM」的 single source of truth
   (路徑 = root → currNode),把 cmp 節點放進樹裡,branching / 刪除 / import-export
   **全部自動正確**,不需要任何額外同步邏輯。
2. **cmp 節點對 API 的 role 用 `user`**(content = summary 文字),`type: 'compaction'`
   只給 renderer 用。這跟現有的 `isSynthetic` cwd 訊息是同一個模式
   (「sent to the model as a user turn so chat templates accept it; the flag is only read by the renderer」)。
   不用 `system` role,因為各 chat template 對多個 system 訊息的行為不一致。
3. **建立唯一一個純函式 choke point:`buildLlmContext(path) → ApiChatMessageData[]`**。
   `sendMessage`、`preEncode`、agentic flow、以及 inspector UI 全部走它,
   保證「inspector 看到的 == 網路上實際送的」(WYSIWYG)。
   壓縮規則(找斷點)與套用規則(組裝 payload)分兩個純模組,各自可單元測試。
4. **斷點規則:只切在 user 或 assistant 訊息之前,絕不切在 tool result**
   (tool result 必須與它的 tool call 同存共毀)。若**單一 user-message span**
   (兩則 user 訊息之間,典型 = 一個 agentic turn)本身就超 keep 預算,
   允許 **split user-message span**:切點落在該 span 內的 assistant 訊息,
   span 前半段進 summary,後半段(最近 tool 交換)保留;連最近 tool 交換都
   放不下時,切點落在**最後一則訊息之後**(空 kept,全部壓縮;
   N6,2026-10-16,見 06-status §3.21)。
5. **自動觸發**:flow 之間(用 server `timings.prompt_n` 對照 mode 觸發點),
   以及 **agentic 迴圈 turn 之間**(「兩次 user 訊息之間」的 context 爆炸就
   發生在迴圈內,只在 flow 結束後檢查來不及;觸發點皆非 streaming 中)。
   **雙 mode(2026-10-17 定稿,預設 A)**:A = recent-window(pi reference):
   觸發 `window − keepRecentTokens`(window = min(n_ctx, maxContextOverride))、
   切點 = 從最後往回加真實 token 數(02-§3.4;無資料例外 bytes/4)到 ≥ keep(尾端 tool 跨越留其前 ass)、成功判定
   `head + summary + kept ≤ window − keep`;B = threshold-target(v3 + N6):
   觸發 `threshold% × n_ctx`、kept ≤ (threshold−keepTarget)%、成功判定
   `head + summary ≤ keepTarget%`、允許空 kept。超標(兩 mode 共用)→ 重試
   (`contextSummaryMaxAttempts`,預設 3 共計)→ user gate(使用/重壓/跳過,
   同 maxTurns 卡片機制)。設計與根因分析見 06-status §3.20/§3.22。
6. **Inspector 永遠可用**(不受自動壓縮開關影響):顯示精確的 payload、
   可編輯 summary、可移動保留斷點(含 mid-turn 斷點)、可手動 compact / expand(還原)。
   入口放在 context gauge popup 裡 + 聊天表單 action + 鍵盤快捷鍵。
7. **`preEncode` 必須走同一個 builder**:否則 KV cache 預熱的是「未壓縮」的 prompt,
   下一輪反而全量 re-prompt,比不預熱還糟。

## 與題述圖案的對應

```
path (activeMessages):  hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool
                        └──────── 被 summarize ────────┘ └──────── kept ────────┘
                                                     firstKeptMessageId ↑

新增 cmp 節點(parent = 路徑最後一筆,成為新 currNode):
  content = summary(usr/ass/tool 1..3 的摘要)
  compactionMeta.firstKeptMessageId = 第 4 筆(id)

LLM 實際收到:  system │ [summary, role=user] │ usr │ ass │ tool │ tool │ ass │ tool
```

> 若兩則 user 訊息之間的 span 本身超預算,切點會落在 span 內的 assistant 訊息
> (split user-message span),見 02-data-model.md §3。

## 範圍界定(第一版「簡單版」)

- ✅ 做:prefix 式 compaction(只 summarize 舊的前綴)、自動觸發(flow 之間 +
  agentic 迴圈 turn 之間)、inspector + 人工編輯、settings、preEncode 一致性、
  agentic flow 開始時套用、split user-message span(span 超預算時切在 span 內)。
- ❌ 不做(留給後續):兩段式 summary(兩次 LLM 呼叫再合併;v1 用單呼叫雙段
  prompt)、多 summary 合併策略(舊 cmp 直接落在 kept 區時按一般訊息送出即可)、
  server 端 compaction。（token 計數 v3 已定:API 實際值優先、否則 UTF-8
  byte 數,見 02-§3.4）
