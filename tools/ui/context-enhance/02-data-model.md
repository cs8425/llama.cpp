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
  /** kept 區的第一則訊息 id(送出窗口的起點;user 或 assistant 訊息)。
   *  **缺欄位 = 空 kept**:所有訊息都被壓縮(payload = [system, summary]) */
  firstKeptMessageId?: string;
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

  id = c.compactionMeta.firstKeptMessageId
  if id 缺:                                       # 刻意的空 kept(I5 split 下限 0)
      i  = c 的 index + 1                          # kept = cmp 之後的訊息(通常為空)
  else:
      i  = id 在 path 的 index
      if i == -1:
          return convertAll(path)                 # fail-open:找不到斷點就全送,
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
| I3 | `firstKeptMessageId` **有 id 但找不到** → 忽略該 cmp,全量送出(fail-open);**id 缺**(刻意的空 kept)→ kept = cmp 之後的訊息 | 分支/刪除後 id 可能失效;安全方向是「變長」不是「變短」 |
| I4 | 斷點只允許切在 **user 或 assistant 訊息之前**,絕不切在 tool result | 切在 assistant 之前:kept 區以 `ass(tool_calls) → tool…` 開頭,配對完整;切在 tool 之前會產生孤兒 tool result(API 拒收) |
| I5 | user 邊界切:kept 區至少 N 則 user 訊息(可設,預設 4);split 切:kept 區**可為空**(`contextKeepMinMessages`,預設 0)——預算放不下時切點落在**最後一則訊息之後**,所有訊息都送進 summary(payload = `[system, summary]`);把值設回 ≥1 即恢復下限 | 避免把幾乎全部對話都 summarize 掉;split 切時該 span 的 user 訊息必然進 summary,由 summary 負責保留其內容(空 kept 時連最近的 tool 交換也進 summary,split prompt 變體已要求保留 tool results) |
| I6 | cmp 必須是路徑上的節點（由建立流程保證:parent = 當時的 leaf,currNode 指向它）——⚠️ **in-loop flow 實做違反**：flow 用 `lastCreatedInFlow` closure 變數建下一則訊息,不被 compaction 推進 → cmp 成 sibling（N10,06-§3.29;N10.1 修復後恢復） | 路徑外的節點不影響送出 |
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

- **空 kept**(split 下限 0,I5):若連最後一組 `ass + tool` 都放不进
  budget,切點落在**最後一則訊息之後**:summarize 區 = 1-8(整個 span),
  kept 為空,`firstKeptMessageId` 缺,payload = `[system, summary]`。

- 語義:span 的 user 訊息(使用者的實際請求)進 summary 而非 kept 區 —
  可接受,因為 summary prompt 明確要求保留「當前任務目標」;
  kept 區保留的是**最近的 tool 交換**,通常正是下一則訊息會引用的內容
  (預算更緊時最近的 tool 交換也進 summary——split prompt 變體已顯式
  要求保留 tool results 與 likely next step)。
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

### 3.3 選點演算法(雙 mode;A = recent-window / B = threshold-target)

兩種可選 mode(`contextCompactionMode`,2026-10-17 使用者定稿,**預設 = A**)。
共用:合法切點(I4)、安全下限(I5、minSummarizeTokens)、計數規則(§3.4);
差異:觸發公式(§6)、budget/停止規則、成功判定式(§6)。

> **planning 輸入 = effective path(N8,2026-10-18)**:以下演算法的 `path`
> 不是 raw DB path,而是 `buildLlmContext` 套用既有 cmp 後的 path(LLM 實際
> 看到的:`[system, 舊summary, kept…]`;無 cmp = raw path)。第二次(及之後)
> 壓縮時,舊 cmp 節點以一般 user 訊息身分在 summarize 區(rolling summary,
> 見 §4「第二次壓縮」);舊 cmp 已 drop 的原始訊息**不**重送。實做:新
> `effectiveCompactionPath()`(context-builder.ts,與 builder 共用窗口
> 解析)+ 兩個 planning 呼叫點餵它(06-status §3.27 / 05-N8)。

#### 3.3.1 Mode A — recent-window(pi reference;下限:「至少留最近 ~keepRecentTokens」)

```
keep   = contextKeepRecentTokens(使用者設定)
window = min(model n_ctx, contextMaxContextOverride)   # override = 0 → n_ctx

valid(j) = path[j].role ∈ {user, assistant}

1. 從最後一則往回加算 per-message count(token 數,§3.4 真實值;無資料例外 bytes/4),
   加到 ≥ keep 停(交叉點 i)
2. 切在交叉點**以右最近**的 valid 切點;
   沒有(尾端 tool result 自己就跨過)→ **最右 valid 切點**
   (保留該 tool 之前的 ass(tool_calls) + 其 tool results)
3. 全程未達(整個 path < keep)→ null(不壓)
4. 對結果檢查:
   - summarize 區 count < minSummarizeTokens(2k)→ null
   - I5:kept.length ≥ M(`contextKeepMinMessages`,預設 0);
     切點落在 user 訊息上 → kept user 數 ≥ N(`contextKeepMinUserTurns`,預設 4)
```

- **A 不會產生空 kept**:kept 恆 ≥1 則、以 user/assistant 開頭
  (交叉點本身或所在 turn)。
- A 的 budget 是**下限**(target):kept ≥ keep(token 數,通常略超);
  上限由成功判定式(§6)保證(壓完總量 ≤ window − keep → 不重觸發)。
- 典型獲益場景:巨幅 tool result——往回加算在交叉點停、切點落在該 tool
  result **之後**的 assistant(或尾端 tool 自己跨過時保留整個 turn),
  最近 tool 交換**原樣保留**。

#### 3.3.2 Mode B — threshold-target(v3;上限:「kept ≤ budget」)

```
budget = keepBudgetTokens = (contextCompactionThreshold% − contextKeepTargetPercent%) × n_ctx
        # v3(2026-10-16,使用者確認 A 第二輪):budget = threshold 與 keep target 的差值:
        # 裁切後總量 = summary + kept ≤ keepTarget%(成功判定,v4:head 不計)+ budget(切點)
        # = threshold% × n_ctx → 不會立刻再觸發(避免連續壓縮)。
        # 移除舊的「- summaryReserve(× 1.5)、下限 n_ctx × 0.1」公式(過度設計,§3.20);
        # threshold ≤ keepTarget(設定異常)→ budget = 0 → 永不壓縮。

valid(j) = path[j].role ∈ {user, assistant}

1. 找最小 j 使 valid(j)、count(path[j..end]) ≤ budget 且 path[j].role == 'user'
   → 找到:一般壓縮(cut 在 span 邊界)
2. 否則找最小 j(j ∈ [起點, path.length])使 valid(j) 且 count(path[j..end]) ≤ budget
   (j = path.length = 切在最後一則訊息之後 → 空 kept;count = 0 恆成立)
   → 找到:split span 壓縮(isSplitTurn = true;j = path.length 時 firstKeptMessageId 缺)
3. 都沒有 → null(不壓)(空 kept 允許後階段 2 恆有解;實務上只剩空路徑/負 budget 等異常)
4. 對 1/2 的結果再檢查:
   - summarize 區(1..j)count < minSummarizeTokens(2k,token 數)→ null
   - I5:邊界切 → kept 區 user 訊息數 ≥ N(預設 4);split 切 → kept 區訊息數 ≥ M(`contextKeepMinMessages`,預設 0)
```

- 階段 1 優先的理由:邊界切讓 summary 涵蓋「完整回合」,語義最乾淨;
  split 切是預算逼出來的退路。
- **threshold 與 keep target 的分工(v3 最終版)**:`threshold` = 觸發點(ctx
  超過這個 % 才檢查,見 §6)且是**壓縮後總量的上限**;`keepTarget%` 約束
  **壓縮代表的大小**(summary,成功判定,§6;v4:system head 不計);budget = 兩者差值
  (kept 區上限,上方公式)。三者關係:summary ≤ keepTarget%、
  kept ≤ (threshold − keepTarget)%、**總量 ≤ threshold% → 不立刻再觸發**。
  v3 移除 summaryReserve(summary max × 1.5)與 10% floor;舊公式
  `n_ctx × (1 − threshold%)`(§3.12 已修)與 reserve/floor 公式
  (§3.13/§3.14 曾實做)皆作廢,記錄見 06-status §3.20。
- 巨幅單一 user 訊息(開頭就超 budget)會自然落到階段 2
  (user 訊息本身被 summarize);階段 2 允許空 kept,所以恆有切點
  (最壞 = 全部壓縮)。
- 巨幅 tool result(例:讀了 1MB 檔案)是 split 切的典型獲益場景:
  切點可以落在該 tool result **之後**的 assistant 上,把它整段 drop;
  連最後一組 `ass + tool` 都放不下時,切點落在最後一則之後(空 kept),
  該 tool result 整段進 summary。
- **full-path summary（N11.2 = A4，使用者定案 2026-10-18；source + 測試完成並確認 2026-10-18；06-§3.30）**:
  所有 compaction 的 summary 皆用**整個 effective path**產生(compact request =
  `buildLlmContext(effectivePath).messages` + instruction、复用原 chat UI code
  path、不自組裝)→ compact request 前綴 = 完整最後送出 payload(KV cache 重用
  最大);切點 / kept 視窗照現行計算(kept ≤ budget),kept 尾段 append 到 summary
  後繼續執行——尾段同時在 summary(濃縮)與 kept(原樣),刻意重複換精確度。
  原「empty kept 選項」提案(A1)不採用:`planCompaction` 不改。

### 3.4 token 計數(v4:真實 per-message 優先,無資料例外才 bytes/4 估算)

> **v4(2026-10-17 使用者定稿)取代 v3 的「無 API 值 → UTF-8 byte 數」規則。**
> 切點 / 成功判定 / 觸發 / inspector 顯示**全部改用真實 token**;只有
> 「沒有真實資料」的少數例外才用 `bytes/4` 估算。設定數字
> (`contextKeepRecentTokens`、`MIN_SUMMARIZE_TOKENS`)**不變**,現含義由 byte 改 token。

**真實 per-message token(`deriveRealMessageTokens(path) → Map<dbId, number>`)**:
server 只回「每 request／assistant turn 層級」的 token 數(存於 assistant
`timings`:`prompt_n` / `cache_n` / `predicted_n`),故 per-message 真實值由相鄰
`prompt_n` 推得(純真實、非估算):

- assistant `i` → `predicted_n[i]`(該 turn 輸出)
- 每段非 assistant 訊息(ass_i 與 ass_{i+1} 之間,或 ass_0 之前)→
  **段真實總和歸到「該段最後一則非 assistant」**(=觸發下一輪的那則;
  「首則 user 用總和」即此規則的前段特例):
  `segTotal = (prompt_n[i+1]+cache_n[i+1]) − (prompt_n[i]+cache_n[i]) − predicted_n[i]`
  (首段 = `prompt_n[0]+cache_n[0]`)
- system → 無獨立真實值(已併進首段總和)→ 顯示 `-`、walk 記 0
- 最後一則 assistant 之後的**尾端**(新 user 等,尚未被 token 化)→ 無真實值

**統一大小 `messageSize(m) = 真實值 ?? (尾端 ? bytes/4 : 0)`**:
- 切點 walk、成功判定、`minSummarizeTokens`、keep budget 全用 `messageSize`(真實 token)
- `bytes/4` 估算**僅**用於無真實值的例外(尚未送出的尾端);system 無獨立值→0(併入首段)
- byte 數(`messageBytes`)**只**供 inspector 副欄顯示與 `bytes/4` 估算,不再當主大小

**觸發** = 真實 `contextStatsStore.contextUsed`(= `prompt_n + cache_n + predicted_n`,
即 gauge 的真實 KV 用量),不再是 `prompt_n ?? byte 加算`。

**後果(已確認)**:`contextKeepRecentTokens`(預設 20000)與
`MIN_SUMMARIZE_TOKENS`(預設 2000)現為 **token 尺度**(原本 byte);
mode B 切點原本「byte 對 token budget」的錯配順手修好。

## 4. 邊界情境行為表

| 情境 | 行為 | 依據 |
| ---- | ---- | ---- |
| 單一 span 超 budget(典型 agentic 長 turn) | split 切:切在 span 內 assistant,span 前半進 summary,後半(最近 tool 交換)保留;`isSplitTurn=true`;連最近 tool 交換都放不下 → 空 kept(全壓,`firstKeptMessageId` 缺) | §3.1 |
| split 切空 kept(全部壓縮) | payload = `[system, summary]`;cmp 之後追加的新訊息成為 kept;inspector 斷點選擇器顯示「無保留訊息」、只能前移(選一則訊息);Re-summarize 的 region = cmp 之前的所有訊息(排除 cmp 節點本身) | I5/§3.3 |
| agentic flow 進行中(context 逼近上限) | turn 之間(非 streaming 中)觸發:建 cmp(parent=最後一則)→ 重建 in-memory `sessionMessages` → 續跑;flow 中斷時 cmp 已落 DB,狀態一致 | §6 |
| F5 / 頁面重刷(in-loop compaction 期間) | 三個時機:(a) summary 呼叫中 / gate 等待中 → 不建 cmp(fail-open),reload 後全量 context、下個 flow-complete 自動再觸發(≤n_ctx 自愈);(b) **`createCompactionMessage` 與 `updateCurrentNode` 之間**(兩寫非原子)→ cmp orphan(在 DB、不在 path、不可見)→ reload 後全量送出 → overflow;(c) currNode commit 後 → cmp 在 path、狀態一致。修復規格(原子 commit + 載入收編 orphan + 可選送出前 guard)= N9,見 06-§3.28 | N9(06-§3.28) |
| in-loop compaction 後 flow 繼續追加 turns(**N10 系統性 bug**) | 未修前:cmp 與下一則 flow 訊息成 sibling(`lastCreatedInFlow` 不被推進)→ cmp 不在 root→currNode 路徑 → F5 / 匯出匯入後所有 summary 消失、inspector 全量、session 無法繼續;in-memory 平陣列遮住分岔。修復 = compaction 後推進 flow 接掛點(N10.1)+ 已損樹 migration(N10.2),見 06-§3.29 | N10(06-§3.29) |
| split 切後 flow 繼續追加 turns | 新訊息接在 cmp 之後;下次壓縮照「最後一筆 cmp 生效」(I2)涵蓋它 | I2 |
| 該 span 的 user 訊息被 summarize 後,user 又編輯了它 | 編輯落在 summarize 區:不影響送出(不在 kept 區);summary 文字不自動更新,可手動「重新摘要」 | — |
| 第二次壓縮(已有一筆 cmp) | plan 在 **effective path**(builder 觀點,N8/06-§3.27)上:新 cmp 的 summarize 區 = **整個 effective path**(含舊 cmp 節點,rolling summary;A4,N11.2);舊 cmp 已 drop 的原始訊息不重送;舊 cmp 被 drop,新 summary 涵蓋它 | I2 |
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
| compact 結果超標（summary > keepTarget% × n_ctx;v4:head 不計） | 重發同一 request（`contextSummaryMaxAttempts`，預設 3 次總計；1 = 一次；≤0 = 無限）→ 仍超 → gate 問 user：[使用這次壓完 / 重壓 / 這次不壓]；use it = 建 cmp（接受超標 summary）；retry = 嘗試次數重新計算後重跑；skip = 不建 cmp、維持全量 context | §6（v3） |
| gate 等待期間 abort（flow stop / Stop 鍵） | 等同 skip（fail-open），不建 cmp | §6（v3） |
| server 沒回 summary 的 token 數 | 成功判定改用 `byteLen(summary content)` 代入（E：無 API 數 → byte 數） | §3.4/§6（v3） |

## 5. Summary 產生(簡單版)

- **呼叫方式**:非 streaming `ChatService.sendMessage()`(與
  `generateTitleWithLLM` 同模式),`summarizeMessages` 的 `mode` 參數決定
  payload 形狀(**default = `prefix-stable`**;`transcript` = v1 fallback):
  - **prefix-stable**(default):前綴與主對話 payload 的 prefix 完全一致
    (**A4,N11.2:payload = `buildLlmContext(effectivePath).messages` +
    instruction**——與 chat UI 送出路徑同一 choke point、不自組裝:有舊 cmp =
    `[system head, 舊summary(user role), kept…]`、無 = 整路徑;
    `reasoning_content` 跟隨 `excludeReasoningFromContext` 開關)→ compact
    request 前綴 = 完整最後送出 payload(KV cache 重用最大);模型看到原始訊息
    結構,摘要忠度更高:
    ```
    [ …buildLlmContext(effectivePath) 輸出(= 最後一筆 live payload:
        system head、舊summary(user role)、1..n 則逐則轉換,保留原
        role/結構:user/assistant/tool、tool_calls、attachments),
      { role: 'user',        content: 壓縮指令 } ]
    ```
    只有最後一則壓縮指令會變(default / 自訂 `contextSummaryPrompt`、
    正常 / split-turn 變體),前綴恆定。
    > **D1 也涵蓋 tool result 附件（N11.1，source 修完並確認 2026-10-18；06-§3.30）**：「附件原樣送」
    > 對 MCP screenshot 等 tool result 的 base64 附件必須成立——原實做
    > `convertDbMessageToApiChatMessageData` 對 `role=tool` early-return、忽略
    > `extra` → 所有 DB 重建路徑（compact request / post-compaction 重建 /
    > F5 後 / preEncode / inspector）前綴在第一張圖分岔 → KV cache 失效。修正（已實做）=
    > 轉換與 in-flow 送出路徑共用 `ChatService.buildExtraContentParts`
    > （同序 / 無 gating（下游 `sendMessage` vision filter 處理）/ 同 cap）→ byte-identical。
    > **session 欄位層（N11.4，06-§3.31；方案定案 + 實做 2026-10-19、✅ check + unit 全綠）**：上述「前綴 =
    > 完整最後送出 payload」只在 **messages 陣列層**成立（N11）。body 的 session 層
    > wire 欄位——具體是 `tools`（tool definitions，chat template 把它們渲染進 prompt
    > 開頭）與有設定時的 `enableThinking` / `reasoningEffort`
    > （`chat_template_kwargs`）——compact request 未帶 → 渲染 prompt 從 token 0
    > 分岔 → KV cache 完全失效。修正 = 把與最後一筆 live payload 相同的 session
    > 欄位 thread 進壓縮路徑（in-loop 直接用 loop 的 `tools`；chat store 決定性重算）
    > + `preEncode` 同類修（`chat:697` / `chat:1834` 預熱點）。
  - **transcript**(v1 fallback):
    ```
    [ { role: 'system', content: 壓縮指令 },
      { role: 'user',   content: transcript(整個 effective path,A4) } ]
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

## 6. 自動觸發與 compact 成功判定(v3)

```
onFlowComplete / onComplete(且無 stream 在跑)/ agentic turn 之間:
  contextUsed = contextStatsStore.contextUsed   # 真實 KV = prompt_n+cache_n+predicted_n(gauge 同源)
  if autoCompactionEnabled
     && n_ctx 已知
     && contextUsed > n_ctx × threshold%            # threshold = 純觸發點(「超過」);mode A 改 window − keep
     && planCompaction(path, budget) 有有效斷點:   # budget = (threshold − keepTarget)% × n_ctx(§3.3)
        → 執行壓縮:
            1. summarize(max_tokens = summaryMax% × n_ctx,不變)
            2. 成功判定(新;v4:system head 不計——併進首段總和):
               summaryTokens = summary 回應的實際 completion tokens(API)
                               # server 沒回時 → byteLen(summary content)
               summaryTokens ≤ keepTarget% × n_ctx ?
                 是 → 建 cmp,完成
                 否 → 重發同一個 compact request
                      (總嘗試次數 = contextSummaryMaxAttempts,預設 3;
                       1 = 總共一次;≤ 0 = 無限)
                      仍超 → 停下,gate 問 user(同 maxTurns/tool 確認機制):
                        顯示:當前 compact 完的 token 數(summary,
                              實際值/byte 數)vs keepTarget% 目標
                        [使用這次壓完 (use it)] → 建 cmp(接受超標 summary)
                        [重壓 (retry)]          → 重跑 summary 迴圈
                                                  (嘗試次數重新計算)
                        [這次不壓 (skip)]       → 不建 cmp,維持全量 context
```

- **觸發**:`threshold` = 純觸發點(「超過這個 % 才檢查」),用真實 `contextUsed`(gauge 同源)。
- **成功判定**:「壓到多小」用**事後實際數字**判定——mode B:
  `summary ≤ keepTarget% × n_ctx`(v4:system head 不計,併進首段總和);
  mode A:`summary + kept ≤ window − keep`。summary 的 token 數是 API 回應的實際值
  (需要非 streaming 路徑解析 `timings`,見 03-§3)。**kept 區不進成功判定**(mode B)——
  它已由切點(§3.3)約束在 (threshold − keepTarget)% 內;總量 = summary + kept
  ≤ threshold% × n_ctx,不會立刻再觸發。
- **超標處理**:server 有強制 `max_tokens`,summary 本身不會超過它;超標只可能
  來自 summary 真的太長(模型寫太多)→ 重發同一個 request 幾次(stochastic)
  通常可解;仍超則交給 user 決(三選項)。in-loop 時 flow 暫停等 user
  (同 maxTurns);abort(flow stop / Stop 鍵)= skip(fail-open)。
- **手動路徑**(Compact now / Re-summarize / 斷點後移重摘要)走同一條
  「summarize → 成功判定 → 重試 → gate」流程。

- agentic flow:兩個觸發點(都非 streaming 中):
  1. **turn 之間**(迴圈內):每 turn 的 tool results 落 DB 後、
     下一 turn 送出前檢查。這是 split span 的主要動機 —
     「兩次 user 訊息之間」的爆炸就發生在這裡。
     流程:plan(用該 conv 的 DB 路徑)→ summarize → 成功判定/重試/gate → 建 cmp
     (parent = 最後一則)→ 用 builder 重建 `sessionMessages` → 續跑。
     summary 呼叫失敗/超時 → 跳過,續跑(fail-open)。
  2. `onFlowComplete` 時:同 flow 之間規則。
- 同一觸發點最多觸發一次(避免連續壓縮迴圈;新 cmp 建立後
  下一輪/下一 turn 的 `prompt_n` 會自然下降,不會立刻再超標;
  一個 flow 內跨 turn 多次再壓縮是合法的)。
