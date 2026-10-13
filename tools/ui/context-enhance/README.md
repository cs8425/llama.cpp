# Context Enhance — 自動上下文管理(壓縮/裁切)設計分析

> 目標:llama-ui 目前把「root → currNode 的完整訊息路徑」原封不動送給 LLM,
> 沒有做任何裁切或壓縮。本目錄分析如何加入**自動上下文管理**(compaction),
> 並讓 user 能看到「壓縮後實際送出的資料」、允許進階 user 人工介入編輯。
>
> 本文件集是**設計分析與實施規劃**；實做進度與決策記錄見
> [06-status.md](./06-status.md)（Phase 0 已完成，Phase 1 待開始）。

## 目錄

| 文件 | 內容 |
| ---- | ---- |
| [01-current-state.md](./01-current-state.md) | 現況分析:context 目前如何組裝並送出(含檔案/行號)、為什麼沒有裁切、所有必須保持一致的消費點 |
| [02-data-model.md](./02-data-model.md) | 資料模型:compaction entry 格式、送出規則(演算法 + 不變式)、邊界情境、summary 產生方式 |
| [03-architecture.md](./03-architecture.md) | 架構:模組劃分、核心 API、整合點對照表、流程時序、替代方案比較、可維護性論點 |
| [04-ui.md](./04-ui.md) | UI 改動:compaction entry 渲染、「LLM 實際看到什麼」inspector、人工介入(編輯/移動斷點/手動壓縮)、context gauge、settings |
| [05-implementation-plan.md](./05-implementation-plan.md) | 分階段實施計畫、檔案清單(新增/修改)、測試計畫、風險與取捨、驗收標準 |
| [06-status.md](./06-status.md) | **實做狀態(continuity doc)**:Phase 0 交付明細、設計決策、驗證狀態、Phase 1 執行清單 |

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
   span 前半段進 summary,後半段(最近 tool 交換)保留。
5. **自動觸發**:flow 之間(用 server `timings.prompt_n` 對照
   `n_ctx × threshold%`),以及 **agentic 迴圈 turn 之間**(「兩次 user 訊息
   之間」的 context 爆炸就發生在迴圈內,只在 flow 結束後檢查來不及;
   觸發點皆非 streaming 中)。
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
- ❌ 不做(留給後續):token 精算(先用 char/4 + 附件估計)、
  兩段式 summary(兩次 LLM 呼叫再合併;v1 用單呼叫雙段 prompt)、
  多 summary 合併策略(舊 cmp 直接落在 kept 區時按一般訊息送出即可)、server 端 compaction。
