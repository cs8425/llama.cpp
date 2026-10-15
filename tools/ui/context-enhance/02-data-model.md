# 02 · 資料模型與壓縮語義

## 1. 新訊息類型:compaction entry

### 1.1 Enum 與型別

```ts
// src/lib/enums/chat.enums.ts
export enum MessageType {
  ROOT = 'root',
  SYSTEM = 'system',
  TEXT = 'text',
  THINK = 'think',
  COMPACTION = 'compaction'   // ← 新增
}
```

```ts
// src/lib/types/database.d.ts — DatabaseMessage 新增選用欄位
export interface CompactionMeta {
  /** kept 區的第一則訊息 id(送出窗口的起點;user 或 assistant 訊息) */
  firstKeptMessageId: string;
  /** 被 summarize 掉的訊息數(不含 system prompt),供 UI 顯示 */
  summarizedCount: number;
  /** true = split user-message span(切點落在單一 span 內的 assistant 訊息) */
  isSplitTurn?: boolean;
  /** 產生 summary 用的模型(可選,供 UI 顯示) */
  model?: string;
  /** 產生 summary 時的 prompt 大小估計(token),供 UI 顯示「省了多少」 */
  estimatedTokensBefore?: number;
}
```

cmp 節點本身:

| 欄位 | 值 | 說明 |
| ---- | -- | ---- |
| `type` | `'compaction'` | renderer 唯一依據 |
| `role` | `'user'` | **API 層 role**。summary 以 user 訊息送出(理由見 §1.3) |
| `content` | summary 文字 | 可被 user 直接編輯(人工介入) |
| `compactionMeta` | 見上 | 純 metadata,不進 payload |
| `parent` | 壓縮前路徑的最後一則 | 成為新 leaf;`currNode` 指向它 |
| `timestamp` / `id` | 慣例 | — |

### 1.2 為什麼是「樹節點」而不是 conversation 欄位

| 考量 | 樹節點(採用) | conversation 欄位(不採用) |
| ---- | ------------ | -------------------------- |
| 與「送出 = 路徑」的定義一致 | ✅ 路徑上有 cmp 就套用 | ❌ 每次都要從欄位重推路徑 |
| Branching | ✅ 自動正確(見 §4) | ❌ 兩個分支共享前綴但 context 規則分岔,要額外同步 |
| 刪除還原 | ✅ 刪節點(子節點重掛) | ❌ 要另存「原始範圍」 |
| Import/export | ✅ JSONL 整則序列化,零改動 | ⚠️ 要動 schema + migration |
| 多分支各自壓縮 | ✅ 各分支可有自己的 cmp | ❌ 一欄位只能描述一個範圍 |
| 舊版 UI 向下相容 | ✅ 被當一般 user 訊息顯示(role=user) | ⚠️ 欄位被忽略,行為不明 |

### 1.3 為什麼 API role 用 `user` 而不是 `system`

- llama.cpp 各 chat template 對「多於一個 system 訊息」的行為不一致
  (有的合併、有的忽略、有的報錯)。summary 放 `user` role 兼容性最好。
- 本專案已有完全相同的先例:`isSynthetic` cwd 訊息 —
  「sent to the model as a *user* turn so chat templates accept it;
  the flag is only read by the renderer」(`types/database.d.ts:135`)。
- UI 上靠 `type === 'compaction'` 特判渲染,不會被當成一般 user 氣泡。
- 建議 summary 文字加固定前綴(可設定),例如:
  `[Conversation summary — earlier messages were compacted] ...`
  讓模型明確知道這是摘要。

## 2. 送出規則(buildLlmContext 的語義)

輸入:`path = activeMessages`(root 已排除,system 在最前)。
輸出:實際送給 LLM 的 `ApiChatMessageData[]`。

```
function buildLlmContext(path):
  c  = 路徑上「最後一則」type == 'compaction' 的節點
  if c is null:
      return convertAll(path)                    # 現行行為

  i  = index of c.compactionMeta.firstKeptMessageId in path
  if i == -1:
      return convertAll(path)                    # fail-open:找不到斷點就全送,
                                                 # 寧可變長也絕不誤刪「目前」訊息

  head  = path[0] if path[0].role == 'system'    # system prompt 永不進 summarize 區
  kept  = path[i .. end]
  return [convert(head),
          { role: 'user', content: c.content },  # summary(含前綴)
          ...convertAll(kept)]
```

### 不變式(invariants)

| # | 不變式 | 理由 |
| - | ------ | ---- |
| I1 | system prompt(path 開頭)永不被 summarize、永不被移除 | 行為定義 |
| I2 | 只有「最後一則」cmp 生效;更舊的 cmp 若落在 kept 區,按一般 `user` 訊息(其 content=舊 summary)送出 | 舊 summary 已被新 summary 涵蓋時自然被 drop;未被涵蓋時保留不丟資料 |
| I3 | `firstKeptMessageId` 找不到 → 忽略該 cmp,全量送出(fail-open) | 分支/刪除後 id 可能失效;安全方向是「變長」不是「變短」 |
| I4 | 斷點只允許切在 **user 或 assistant 訊息之前**,絕不切在 tool result | 切在 assistant 之前:kept 區以 `ass(tool_calls) → tool…` 開頭,配對完整;切在 tool 之前會產生孤兒 tool result(API 拒收) |
| I5 | user 邊界切:kept 區至少 N 則 user 訊息(可設,預設 4);split 切:kept 區至少 M 則訊息(預設 2,通常是一組 ass+tool 交換) | 避免把幾乎全部對話都 summarize 掉;split 切時該 span 的 user 訊息必然進 summary,由 summary 負責保留其內容 |
| I6 | cmp 必須是路徑上的節點(由建立流程保證:parent = 當時的 leaf,currNode 指向它) | 路徑外的節點不影響送出 |
| I7 | 壓縮只在「沒有 stream 在跑」時進行(flow 之間、agentic turn 之間) | 避免改動 in-flight 的 `sessionMessages` 底層 |

> 註:Pi 規範中「把 kept 邊界推進 context-invisible suffix(被 context_edit
> 省略的 assistant attempt 等)、replacement edit 阻擋推進」一整套規則,
> 前提是本專案**不存在**的機制(我們沒有 context-invisible 條目:
> 除 root 與被 compaction drop 者外,路徑上每則訊息都會送出)。
> 因此本設計不實現該推進規則,也無須處理相關 blocking 條件。

## 3. 斷點選擇(compaction policy)

### 3.1 user-message span 與 split span

- **user-message span**:從一則 user 訊息開始,到下一則 user 訊息之前的
  所有訊息(典型 = 一個 agentic turn:`usr, ass, tool, ass, tool, …`)。
- 正常情況:切點落在 span 邊界(某則 user 訊息之前),summary 涵蓋完整 span。
- **split user-message span**:單一 span 本身就超 keep budget 時,
  邊界切法保不住預算,切點退而落在該 span **內的 assistant 訊息**上:

```
Split user-message span (one span exceeds budget):

  entry:  0     1     2      3     4      5      6     7      8
        ┌─────┬─────┬─────┬──────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴──────┴──────┴─────┴──────┘
                ↑                                     ↑
         span 起點(turnStart)              firstKeptMessageId = 7
                │                                     │
                └──── 被 summarize(1-6)──────────────┘
                                                      └── kept(7-8)

  isSplitTurn = true
  summarize 區 = 更早的 history(若有)+ 該 span 的前半段(1-6)
```

- 語義:span 的 user 訊息(使用者的實際請求)進 summary 而非 kept 區 —
  可接受,因為 summary prompt 明確要求保留「當前任務目標」;
  kept 區保留的是**最近的 tool 交換**,通常正是下一則訊息會引用的內容。
- 對 `buildLlmContext` 而言 split 與一般壓縮**無差別**:`firstKeptMessageId`
  只是指到一則 assistant 訊息,§2 的送出規則完全一樣。
  差異只在 (a) policy 選點、(b) summary prompt、(c) UI 顯示。

### 3.2 合法切點

| 可切 | 不可切 |
| ---- | ------ |
| user 訊息(含 synthetic cwd) | tool result(必須與其 tool call 同存共毀) |
| assistant 訊息(有無 tool_calls 皆可) | system prompt(I1) |

> Pi 規範中的 BashExecution / custom_message / branch_summary 在我們
> 的型別系統中沒有對應物;上表即本專案的完整合法集合。

### 3.3 選點演算法(兩階段,優先邊界切)

```
budget = keepBudgetTokens
        # = n_ctx × contextKeepTargetPercent%(預設 50) - summaryReserve(≈ summary max_tokens × 1.5),下限 n_ctx × 0.1
        # summary max_tokens = n_ctx × contextSummaryMaxTokensPercent%(預設 70%;
        # 70% 時 reserve 壓過 50% target → keep 恆落 10% 下限,見 06-status §3.13)
        # (trigger threshold 只決定「何時檢查」,不參與 budget — 見下方解耦說明)

valid(j) = path[j].role ∈ {user, assistant}

1. 找最小 j 使 valid(j)、estimate(path[j..end]) ≤ budget 且 path[j].role == 'user'
   → 找到:一般壓縮(cut 在 span 邊界)
2. 否則找最小 j 使 valid(j) 且 estimate(path[j..end]) ≤ budget
   → 找到:split span 壓縮(isSplitTurn = true)
3. 都沒有 → null(不壓),gauge 顯示警告
4. 對 1/2 的結果再檢查:
   - summarize 區(1..j)estimate < minSummarizeTokens(例:2k)→ null
   - I5:邊界切 → kept 區 user 訊息數 ≥ N;split 切 → kept 區訊息數 ≥ M(預設 2)
```

- 階段 1 優先的理由:邊界切讓 summary 涵蓋「完整回合」,語義最乾淨;
  split 切是預算逼出來的退路。
- **threshold 與 keep target 解耦(已修正)**:`threshold` 是純觸發點
  (ctx 到這個 % 才檢查,見 §6);keep target = **`contextKeepTargetPercent`%
  n_ctx**(預設 50、user 可自訂,INPUT 10–90,見 06-status §5c N2;扣 summary
  reserve,下限 10%)。舊公式 `n_ctx × (1 − threshold%)` 把兩者反相耦合
  (門檻越低 → 保留越多 → 可 summarize 區越小),1% 門檻 = 保留 99% →
  要 ctx > ~99% n_ctx 才可能產生 plan,自動壓縮等於停用,與 threshold 的
  慣例語義相反(修正記錄見 06-status §3.12)。
- 巨幅單一 user 訊息(開頭就超 budget)會自然落到階段 2
  (user 訊息本身被 summarize),或階段 3(連 split 都放不下)。
- 巨幅 tool result(例:讀了 1MB 檔案)是 split 切的典型獲益場景:
  切點可以落在該 tool result **之後**的 assistant 上,把它整段 drop。

### 3.4 估計值(第一版,故意簡單)

```
estimate(msg) = len(content)/4
              + Σ attachments:  image ≈ 1000 tokens/張(粗估)
                               text/pdf ≈ len/4
                               audio/video ≈ 固定 3000
              + toolCalls JSON len/4
```

> 校準升級路徑(Phase 3):每則 assistant 的 `timings.prompt_n` 是「該輪全量
> prompt 的真實值」,可用它反推每則訊息的平均成本,取代 char/4。第一版不需要。

## 4. 邊界情境行為表

| 情境 | 行為 | 依據 |
| ---- | ---- | ---- |
| 單一 span 超 budget(典型 agentic 長 turn) | split 切:切在 span 內 assistant,span 前半進 summary,後半(最近 tool 交換)保留;`isSplitTurn=true` | §3.1 |
| agentic flow 進行中(context 逼近上限) | turn 之間(非 streaming 中)觸發:建 cmp(parent=最後一則)→ 重建 in-memory `sessionMessages` → 續跑;flow 中斷時 cmp 已落 DB,狀態一致 | §6 |
| split 切後 flow 繼續追加 turns | 新訊息接在 cmp 之後;下次壓縮照「最後一筆 cmp 生效」(I2)涵蓋它 | I2 |
| 該 span 的 user 訊息被 summarize 後,user 又編輯了它 | 編輯落在 summarize 區:不影響送出(不在 kept 區);summary 文字不自動更新,可手動「重新摘要」 | — |
| 第二次壓縮(已有一筆 cmp) | 新 cmp 的 summarize 區包含舊 cmp 節點(它在路徑上、在斷點之前);舊 cmp 被 drop,新 summary 涵蓋它 | I2 |
| 第二次壓縮的斷點落在**舊 cmp 之後**(kept 區含舊 cmp) | 舊 cmp 按一般 user 訊息送出(content=舊 summary) | I2 |
| User 在 cmp **之前**的訊息 branch/regenerate | 新分支路徑不經過 cmp → 全量 context | 路徑定義 |
| User 在 cmp **之後** branch | 路徑仍含 cmp → 分支也壓縮 | I6 |
| 刪除 cmp 節點(「expand」) | 子訊息重掛到 cmp 的 parent(`reparentDirectChildren` 模式)→ 全量 context 還原;UI 需確認對話框(顯示估計 token 增量) | — |
| 刪除 summarize 區內某則訊息 | 路徑更新,`firstKeptMessageId` 通常仍存在 → 行為不變 | I3 |
| 刪除 kept 區內某則訊息,恰好刪到 `firstKeptMessageId` | `firstKeptMessageId` 失效 → fail-open 全量送出 + inspector 顯示「斷點失效」警告,提示重新壓縮 | I3 |
| 編輯 cmp 的 content(人工介入) | 直接 `updateMessage(cmpId, {content})`,下一輪生效;`compactionMeta` 不動 | — |
| 移動斷點(kept 變長/變短) | 變長(斷點前移):只更新 `firstKeptMessageId`(舊 summary 多涵蓋一點,無害)。變短(斷點後移):新 drop 的訊息未被 summary 涵蓋 → UI 必須提示「重新產生 summary」並執行,否則資料靜默遺失 | — |
| 對話 import(含 cmp) | JSONL 原樣進 DB;`type` 欄位被舊版解析器忽略時,按 role=user 顯示 | §1.2 |
| 新對話第一則訊息 | 不可能觸發(可 summarize 區不足 minSummarizeTokens) | policy |

## 5. Summary 產生(簡單版)

- **呼叫方式**:非 streaming `ChatService.sendMessage()`(與
  `generateTitleWithLLM` 同模式),`summarizeMessages` 的 `mode` 參數決定
  payload 形狀(**default = `prefix-stable`**;`transcript` = v1 fallback):
  - **prefix-stable**(default):前綴與主對話 payload 的 prefix 完全一致
    (同一套 `normalizeMessagesForApi` 轉換、附件原樣送、
    `reasoning_content` 跟隨 `excludeReasoningFromContext` 開關),
    同一 summarize 區的重複摘要(Re-summarize、同區再壓)可重用 KV cache
    前綴;模型看到原始訊息結構,摘要忠度更高:
    ```
    [ { role: 'system',      content: 對話的 system head(原樣) },
      …被 summarize 的 1..i-1 則(逐則轉換,保留原 role/結構:
        user/assistant/tool、tool_calls、attachments),
      { role: 'user',        content: 壓縮指令 } ]
    ```
    只有最後一則壓縮指令會變(default / 自訂 `contextSummaryPrompt`、
    正常 / split-turn 變體),前綴恆定。
  - **transcript**(v1 fallback):
    ```
    [ { role: 'system', content: 壓縮指令 },
      { role: 'user',   content: transcript(被 summarize 的 1..i-1 則) } ]
    ```
- **transcript 格式**(僅 transcript 模式):`[role] content`,attachments 以佔位符表示
  (`[image: name.jpg]`、`[file: x.ts, 12KB]`),避免把 base64 餵進 summary 呼叫。
- **參數**:`max_tokens = n_ctx × contextSummaryMaxTokensPercent%`(預設 70%;
  128k → 91750、256k → 183500;n_ctx 未知時 fallback 1024)、`temperature 0.2`、
  model = 該對話的模型(`getConversationModel`),ROUTER 模式下明確帶 model。
- **預設 prompt(可設定)**:
  ```
  Summarize the conversation so far for future context. Preserve, concretely:
  1) decisions and their reasons, 2) facts, names, paths, URLs,
  3) code changes / file operations performed, 4) tool results that matter,
  5) open tasks and constraints. Be dense; drop small talk.
  ```
- **split-turn 變體**(`isSplitTurn=true` 時使用,同一單次呼叫、雙段結構):
  ```
  Summarize for future context, in two parts:
  (a) Earlier conversation: decisions, facts, paths, completed work.
  (b) In-progress turn (prefix only): the current task goal (the user's
      request, verbatim if short), steps already taken, files touched,
      tool results that matter, and the likely next step.
  Be dense; drop small talk.
  ```
  理由:span 前半段的價值不在「歷史」而在「**進行中狀態**」
  (agent 正在做什麼、做到哪裡),prompt 要顯式要求保留。
  (Pi 對 split span 用兩次呼叫再合併;v1 用單呼叫雙段 prompt,
  兩次呼叫的品質選項留給 Phase 3。)
- **失敗處理**:summary 呼叫失敗 → **不建立** cmp 節點,toast 提示,
  維持全量 context(安全方向)。
- **UI 回饋**:進行中在 gauge / 訊息列顯示「Compacting context…」。

## 6. 自動觸發條件

```
onFlowComplete / onComplete(且無 stream 在跑):
  lastPrompt = 最後一則 assistant 的 timings.prompt_n
             ?? estimate(path)        # 沒 timings 時用估計
  if autoCompactionEnabled
     && n_ctx 已知
     && lastPrompt ≥ n_ctx × threshold%(預設 80%)   # threshold = 純觸發點
     && planCompaction(path) 有有效斷點:
       → 執行壓縮(§5)
```

- **語義**:`threshold` = 純觸發點(「ctx 到這個 % 才檢查」);「壓到多小」
  由 §3.3 的固定 keep target(50% n_ctx)決定,與 threshold 無關。

- agentic flow:兩個觸發點(都非 streaming 中):
  1. **turn 之間**(迴圈內):每 turn 的 tool results 落 DB 後、
     下一 turn 送出前檢查。這是 split span 的主要動機 —
     「兩次 user 訊息之間」的爆炸就發生在這裡。
     流程:plan(用該 conv 的 DB 路徑)→ summarize → 建 cmp
     (parent = 最後一則)→ 用 builder 重建 `sessionMessages` → 續跑。
     summary 呼叫失敗/超時 → 跳過,續跑(fail-open)。
  2. `onFlowComplete` 時:同 flow 之間規則。
- 同一觸發點最多觸發一次(避免連續壓縮迴圈;新 cmp 建立後
  下一輪/下一 turn 的 `prompt_n` 會自然下降,不會立刻再超標;
  一個 flow 內跨 turn 多次再壓縮是合法的)。
