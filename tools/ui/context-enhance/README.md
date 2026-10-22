# Context Enhance — 自動上下文管理(壓縮/裁切)設計分析

> 目標:llama-ui 目前把「root → currNode 的完整訊息路徑」原封不動送給 LLM,
> 沒有做任何裁切或壓縮。本目錄分析如何加入**自動上下文管理**(compaction),
> 並讓 user 能看到「壓縮後實際送出的資料」、允許進階 user 人工介入編輯。
>
> 本文件集是**設計分析與實施規劃**；實做進度與決策記錄見
> [06-status.md](./06-status.md)。
>
> **目前停點（2026-10-23）**：**N13 規格定稿 + label 格式使用者確認（compaction token 顯示對不上：toast / cmp 列 / `~0`；根因 RC1–RC5 + 規格 D1–D5；label = `Summarized N messages (~AAA → B tokens)`：N = drop 數 / AAA = 壓縮前真實 contextUsed / B = summaryTokens；未實做、進行中；06-status §3.34 / §5k）**；手動驗收通過 2026-10-23：N12.3 + N11/N11.4 + N10 + N8；下一步 = N13 實做（§5k）→ 剩餘手動驗收（N7 5 項 + 5.8）→ N9（規格定稿、未實做）
> （N12：打開 inspector 卡 `Building payload…` = 三個 display 消費端對
> tool-call-only assistant 的 `content === undefined`（刻意 wire shape、N11
> byte-identical 要求）未容忍；修 = total function（視為空 / 0 bytes）+ JSDoc，
> **wire shape 不動**；明細 + 執行清單：06-status §3.32 / §5i）
> （N11.4 已完成 2026-10-19：compact request session 欄位 `tools` / thinking
> kwargs + `preEncode` 同類修；source + 測試 + `npm run check` + unit 全綠，
> 明細見 06-status §3.31 / §5h；手動驗收通過並確認 2026-10-23（併入 N11））
> （N11 已完成 2026-10-18：N11.1 P0 tool result 附件（MCP screenshot base64）+
> N11.2 = A4 full-path summary（compact request =
> `buildLlmContext(effectivePath).messages` + instruction）+ N11.3 測試全綠，
> 明細見 06-status §3.30 / §5g）
> **待辦（依序）**：N13（規格定稿 + label 格式使用者確認、未實做、進行中；06-status §3.34 / §5k）→ 剩餘手動驗收（N7 5 項 + 5.8，
> 可一併；N12.3 + N11/N11.4 + N10 + N8 已通過 2026-10-23）→ N9（規格定稿、未實做）。
> 本目錄兩份抓包 `before-trigger.json` / `compact-requset.json` 只作根因文檔證據（修後 wire 形狀刻意
> 改變、不適用當 byte-prefix oracle；回歸測試用合成 fixture）。
>
> **已完成並確認（2026-10-18）**：**N10 in-loop cmp sibling 系統性 bug ✅**
> （N10.1 根因修：`onCompaction` callback + `lastCreatedInFlow` 推進；N10.2 已損樹修復：
> `findCompactionGraftFixes` 純函式 + `applyCompactionGraftFixes` IDB transaction +
> 啟動 migration + `loadConversation` 防禦層；N10.3 unit 5 向量；
> `npm run check` + unit + 5 支 client compaction suite 全綠；明細見 06-status §3.29 / 05-N10）。
>
> **新規格（2026-10-18 定稿）**：
>
> - **N9 F5 / refresh 韌性**：in-loop compaction 的 cmp + currNode 是兩次獨立 IDB 寫
>   （非原子）→ 兩寫之間 F5（或 `updateCurrentNode` 拋錯）→ cmp orphan（在 DB、
>   不在 path、不可見）→ reload 後全量送出 → overflow；非永久損毀（無資料遺失、
>   手動 compact 可恢復）。規格 = 原子 commit + 載入收編 orphan + 可選送出前
>   overflow guard，見 06-status §3.28 / 05-N9。
>
> **剩（依序）**：
> 1. **N13 compaction token 顯示對不上**（06-status §3.34 / §5k；規格定稿 +
>    label 格式使用者確認 2026-10-23、未實做、進行中：`Summarized N messages (~AAA → B
>    tokens)`，N = drop 數 / AAA = 壓縮前真實 contextUsed / B = summaryTokens）。
> 2. **剩餘手動驗收（可一併驗）**：✅ 已通過 2026-10-23：N12.3（agentic 對話開
>    inspector 不卡 `Building payload` + 展開 tool-call-only 列 / Copy JSON 不炸 +
>    普通對話無回歸；§5i）+ N11/N11.4（MCP screenshot → 連壓兩次 + F5 → `cache_n`
>    高命中；§5g/§5h）+ N10（連壓兩次後 F5 → summary 都在、匯出匯入同、既有已損
>    對話 migration 後恢復；§5f）+ N8（連壓兩次：第二次 summary 請求形狀正確、loop
>    正常續跑；§5d）。剩：N7 5 項（05-§3 #8–#12）+ Phase 1 5.8（06-status §4
>    清單；A/B mode 行為 + v4 真實 token 顯示可一併驗）。
> 3. **N9 F5 / refresh 韌性**（06-status §3.28 / 05-N9 / §5e；規格定稿、未實做）。
> 4. Phase 3 可選後續（兩段式 summary / per-conversation 覆蓋 / 合併重摘要
>    提示 / summary 獨立 model / endpoint / gauge savings 顯示，見 05-§1；
>    token 校準已被 v3/v4 取代）。
>
> **已完成並確認**（明細與決策見 06-status.md）：N12（Context Inspector 凍結修：
> 三 display 消費端對 `content === undefined` total function + JSDoc、wire shape
> 零改動；check + unit + client 全綠 2026-10-19；N12.3 手動驗收通過 2026-10-23）→ N11.4（compact request session
> 欄位一致性：`tools` / thinking kwargs thread 進壓縮路徑 + `preEncode` 同類修；
> check + unit 全綠 2026-10-19；手動驗收通過 2026-10-23、併入 N11）→ N11（compact request 前綴一致性：tool result
> 附件與 user input 同路徑 + full-path summary A4；messages 陣列層；手動驗收通過 2026-10-23）→ N10（in-loop cmp sibling 系統性
> bug：`onCompaction` 推進 flow 接掛點 + 已損樹 migration；手動驗收通過 2026-10-23）→ N8（第二次壓縮：plan 改在
> effective path；手動驗收通過 2026-10-23）→ N7（壓縮進行中：queue +
> in-chat 指標列 + Stop）→ v4 真實 token 計數 → 雙 mode（共用 + A + B，
> default B）→ N6（split 切允許空 kept）→ N1–N5（summary 上限 n_ctx × % /
> keep target 設定 / Stop 鍵 / prefix-stable default / `contextSummaryMode`）
> → Phase 2 P2.1–P2.6 → Phase 1 5.1–5.7 → Phase 0。

## 目錄

| 文件 | 內容 |
| ---- | ---- |
| [01-current-state.md](./01-current-state.md) | 現況分析:context 目前如何組裝並送出(含檔案/行號)、為什麼沒有裁切、所有必須保持一致的消費點 |
| [02-data-model.md](./02-data-model.md) | 資料模型:compaction entry 格式、送出規則(演算法 + 不變式)、邊界情境、summary 產生方式 |
| [03-architecture.md](./03-architecture.md) | 架構:模組劃分、核心 API、整合點對照表、流程時序、替代方案比較、可維護性論點 |
| [04-ui.md](./04-ui.md) | UI 改動:compaction entry 渲染、「LLM 實際看到什麼」inspector、人工介入(編輯/移動斷點/手動壓縮)、context gauge、settings |
| [05-implementation-plan.md](./05-implementation-plan.md) | 分階段實施計畫、檔案清單(新增/修改)、測試計畫、風險與取捨、驗收標準 |
| [06-status.md](./06-status.md) | **實做狀態(continuity doc)**:Phase 0/1/2 交付明細、設計決策、驗證狀態、Phase 1 與 Phase 2 執行清單 |
| [07-agentic-limits.md](./07-agentic-limits.md) | **相鄰功能(非 compaction 工作流)**:agentic loop guard — `agenticMaxTurns` 0/負數 = 無限制 + wall-time soft/hard limit(soft = turn 邊界 continue 卡片;hard = 直接中斷 in-flight LLM call、等同手動 Stop)+ in-chat 常駐通知列(Resume = 從路徑尾端續跑 loop)。規格定稿 2026-10-19;**Phase A–D + 手動驗收完成並確認**(06-status §3.33/§5j) |

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
   DB→API 轉換同樣單一:tool result 與 user input 走同一個 `extra → parts`
   shared builder(N11 D1,2026-10-18),所有重建路徑與 in-flow 送出路徑
   byte-identical。
4. **斷點規則:只切在 user 或 assistant 訊息之前,絕不切在 tool result**
   (tool result 必須與它的 tool call 同存共毀)。若**單一 user-message span**
   (兩則 user 訊息之間,典型 = 一個 agentic turn)本身就超 keep 預算,
   允許 **split user-message span**:切點落在該 span 內的 assistant 訊息,
   span 前半段進 summary,後半段(最近 tool 交換)保留;連最近 tool 交換都
   放不下時,切點落在**最後一則訊息之後**(空 kept,全部壓縮;
   N6,2026-10-16,見 06-status §3.21)。
5. **自動觸發**:flow 之間與 **agentic 迴圈 turn 之間**（「兩次 user 訊息之間」的 context 爆炸
   發生在迴圈內,只在 flow 結束後檢查來不及;觸發點皆非 streaming 中）。觸發值 = 真實
   `contextUsed`（gauge 同源,v4）。
   **雙 mode(2026-10-17 定稿,預設 B)**:A = recent-window(pi reference):
   觸發 `window − keepRecentTokens`(window = min(n_ctx, maxContextOverride))、
   切點 = 從最後往回加真實 token 數(02-§3.4;無資料例外 bytes/4)到 ≥ keep(尾端 tool 跨越留其前 ass)、成功判定
   `summary + kept ≤ window − keep`(v4:system head 不計);B = threshold-target(v3 + N6):
   觸發 `threshold% × n_ctx`、kept ≤ (threshold−keepTarget)%、成功判定
   `summary ≤ keepTarget%`(v4:system head 不計)、允許空 kept。超標(兩 mode 共用)→ 重試
   (`contextSummaryMaxAttempts`,預設 3 共計)→ user gate(使用/重壓/跳過,
   同 maxTurns 卡片機制)。設計與根因分析見 06-status §3.20/§3.22。
6. **Inspector 永遠可用**(不受自動壓縮開關影響):顯示精確的 payload、
   可編輯 summary、可移動保留斷點(含 mid-turn 斷點)、可手動 compact / expand(還原)。
   入口放在 context gauge popup 裡 + 聊天表單 action + 鍵盤快捷鍵。
7. **`preEncode` 必須走同一個 builder**:否則 KV cache 預熱的是「未壓縮」的 prompt,
   下一輪反而全量 re-prompt,比不預熱還糟。（N11.4：`preEncode` 也必須帶上
   session 的 `tools` / thinking kwargs，06-§3.31。）

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
  server 端 compaction。（token 計數 v4 已定:真實 per-message token
  （`deriveRealMessageTokens`）,無資料例外（system / 尚未送出尾端）才
  `bytes/4` 估算,見 02-§3.4）
