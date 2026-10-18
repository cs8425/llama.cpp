# Context Enhance — 自動上下文管理(壓縮/裁切)設計分析

> 目標:llama-ui 目前把「root → currNode 的完整訊息路徑」原封不動送給 LLM,
> 沒有做任何裁切或壓縮。本目錄分析如何加入**自動上下文管理**(compaction),
> 並讓 user 能看到「壓縮後實際送出的資料」、允許進階 user 人工介入編輯。
>
> 本文件集是**設計分析與實施規劃**；實做進度與決策記錄見
> [06-status.md](./06-status.md)。
>
> **目前停點（2026-10-18）**：**N11 compact request 前綴一致性——N11.1 + N11.2 source + N11.3 測試完成、未確認**
> （N11.1 P0：tool result 附件（MCP screenshot base64）在 DB→API 轉換被丟 →
> compact request 前綴在第一張 screenshot 分岔 → KV cache 失效；N11.2 = A4：
> summary 用**整個 effective path**產生（compact request =
> `buildLlmContext(effectivePath).messages` + instruction）；D1：tool result DB
> 重建與 in-flow 走 user input 同路徑（無 model 參數 / 無新 gating）；N11.3 測試：
> `summarize.test.ts` 依決定 B 修好 + 新 `tests/unit/chat-conversion.test.ts`
> （轉換矩陣 / byte-identity / 空 content 三態 / compact request = 最後 payload
> byte-prefix + instruction 合成 fixture）。明細見 06-status §3.30 / §5g。）
> **待辦（依序）**：使用者 `npm run check` + unit 確認 → 手動驗收（MCP
> screenshot → 連壓兩次 + F5 → `cache_n` 高命中）。
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
> 1. **N11 compact request 前綴一致性**（06-status §3.30 / §5g）：N11.1
>    前綴一致性修（P0；D1 shared-builder 路徑）✅ source 完成 → N11.2 full-path
>    summary（A4）✅ source 完成 → N11.3 測試 ✅ 已寫（`summarize.test.ts` 依決定 B
>    修好 + `chat-conversion.test.ts` 合成 fixture 回歸）→ ⏸ 使用者 `npm run check`
>    + unit 確認 → 手動驗收。
> 2. **N9 F5 / refresh 韌性**（06-status §3.28 / 05-N9 / §5e）。
> 3. **手動驗收（未做、可一併驗）**：N10（agentic loop 連壓兩次後 F5 → summary 都在、
>    匯出匯入同、既有已損對話 migration 後恢復）
>    + N8（agentic loop 連壓兩次：第二次 summary
>    請求 = `[system, 舊summary, 新訊息, instruction]`、loop 正常續跑）+ N7 5 項
>    （05-§3 #8–#12）+ Phase 1 5.8（06-status §4 清單；A/B mode 行為 + v4 真實
>    token 顯示可一併驗）。
> 4. Phase 3 可選後續（兩段式 summary / per-conversation 覆蓋 / 合併重摘要
>    提示 / summary 獨立 model / endpoint / gauge savings 顯示，見 05-§1；
>    token 校準已被 v3/v4 取代）。
>
> **已完成並確認**（明細與決策見 06-status.md）：N10（in-loop cmp sibling 系統性
> bug：`onCompaction` 推進 flow 接掛點 + 已損樹 migration）→ N8（第二次壓縮：plan 改在
> effective path）→ N7（壓縮進行中：queue +
> in-chat 指標列 + Stop）→ v4 真實 token 計數 → 雙 mode（共用 + A + B，
> default A）→ N6（split 切允許空 kept）→ N1–N5（summary 上限 n_ctx × % /
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
   **雙 mode(2026-10-17 定稿,預設 A)**:A = recent-window(pi reference):
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
  server 端 compaction。（token 計數 v4 已定:真實 per-message token
  （`deriveRealMessageTokens`）,無資料例外（system / 尚未送出尾端）才
  `bytes/4` 估算,見 02-§3.4）
