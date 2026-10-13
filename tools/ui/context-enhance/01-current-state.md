# 01 · 現況分析:context 目前如何組裝並送出

## 1. 資料模型:對話 = 一棵訊息樹

- `DatabaseConversation`(`src/lib/types/database.d.ts:14`):
  - `currNode: string | null` — 目前路徑的 leaf 節點 id。
- `DatabaseMessage`(`src/lib/types/database.d.ts:113`):樹節點。
  - `id` / `parent` / `children[]` — 樹結構(支援 branching)。
  - `type: MessageType` = `root | system | text | think`(`src/lib/enums/chat.enums.ts:44`)。
  - `role: MessageRole` = `system | user | assistant | tool`(同檔 :34)。
  - `content`、`extra`(attachments)、`toolCalls`(JSON string)、`toolCallId`、
    `timings`(含 `prompt_n` / `cache_n` / `predicted_n`)、`model`、`isSynthetic`。
- 新對話建立時:`createRootMessage()`(`src/lib/services/database.service.ts:205`,
  role=system、type=root、content='')→ 選填 `createSystemMessage()`
  (`:232`,role=system、type=system)= 題述圖案中的 `hdr`。

**「送給 LLM 的 context」= 從 root 到 `currNode` 的路徑**:

```ts
// src/lib/stores/conversations/index.svelte.ts:539 (loadConversation)
this.activeMessages = conversation.currNode
  ? (filterByLeafNodeId(allMessages, conversation.currNode, false) as DatabaseMessage[])
  : allMessages;
```

`filterByLeafNodeId`(`src/lib/utils/branching.ts:41`)沿 parent 回溯到 root,
排除 root 節點,system 訊息排序在最前。結果就是 `conversationsStore.activeMessages`。

## 2. 送出管線(目前「零裁切」的路徑)

```
chatStore.sendMessage()                       stores/chat/index.svelte.ts:608
  ├─ 建立 user 訊息 + assistant 訊息(寫入 DB 樹)
  └─ streamChatCompletion(activeMessages.slice(0, -1), assistantMessage)
        stores/chat/index.svelte.ts:799
        ├─ agenticStore.runAgenticFlow({ messages: allMessages, ... })   ← 有 tools 時
        │     stores/agentic/index.svelte.ts:304
        │     └─ ChatService.normalizeMessagesForApi(messages)          (:358)
        │        → toAgenticMessages() → executeAgenticLoop()
        │           之後每 turn 只往 in-memory sessionMessages 續加,
        │           不再重新組裝 → agentic 是 context 膨脹最快的路徑
        └─ ChatService.sendMessage(allMessages, ...)                    stores/chat/index.svelte.ts:1161
              services/chat.service.ts:1022
              └─ normalizeMessagesForApi() → POST /chat/completions (或 /stream)
```

轉換層(兩步):

1. `ChatService.normalizeMessagesForApi()`(`services/chat.service.ts:808`)
   — 把 `DatabaseMessage` 換成 `ApiChatMessageData`,只過濾「空的 system 訊息」。
2. `ChatService.convertDbMessageToApiChatMessageData()`(`:138`)
   — 單則轉換:attachments → content parts(text / image_url / input_audio /
     input_video)、`toolCalls` JSON 解析、`reasoning_content` 帶入。

**結論:從 `activeMessages[0]`(system)到最尾端,每一則都會被轉換並送出。**
整條管線沒有任何 token 預算、裁切或摘要邏輯 — 這就是「沒有做裁切 or 壓縮」的根因。

## 3. 所有「必須保持一致」的 context 消費點

任何 compaction 若只套在一個消費點,其它點送出的 payload 就會跟 inspector /
KV cache 不一致。完整清單:

| # | 消費點 | 位置 | 用途 |
| - | ------ | ---- | ---- |
| 1 | `ChatService.sendMessage()` | `services/chat.service.ts:1022` | 一般聊天主送出路徑 |
| 2 | `agenticStore.executeAgenticLoop()` | `stores/agentic/index.svelte.ts:432` | agentic 多 turn 迴圈(在 :358 一次性 normalize) |
| 3 | `ChatService.preEncode()` | `services/chat.service.ts:840`(由 `stores/chat/index.svelte.ts:1402 triggerPreEncode` 呼叫) | 下一輪前 KV cache 預熱,`n_predict: 0` |
| 4 | (新增)Context Inspector UI | — | 顯示「實際會送出什麼」,必須與 1/2/3 同源 |

> 輔助性 LLM 呼叫(如 `generateTitleWithLLM`,
> `stores/chat/index.svelte.ts:1292`)用的是自組的最小 context,
> **不需要**套用 compaction,保持現狀。

## 4. 與本功能相鄰的既有設施(可直接複用)

| 設施 | 位置 | 可複用點 |
| ---- | ---- | -------- |
| Context gauge(顯示用,不動作) | `stores/chat/context-stats.svelte.ts`、`hooks/use-context-gauge.svelte.ts`、`components/app/chat/ChatForm/ChatFormContextGauge/*` | `contextUsed` / `contextTotal` / `contextPercent` 已算好;popup(`ContextGaugePopup.svelte`)是 inspector 的天然入口;`prompt_n` 來自每則 assistant 的 `timings`,可當「實際 prompt 大小」的校準值 |
| 樹節點建立 | `DatabaseService.createSystemMessage()` / `createMessageBranch()`(`database.service.ts:157,232`) | `createCompactionMessage()` 照抄此模式 |
| 節點刪除 + 子節點重掛 | `DatabaseService.reparentDirectChildren()`(`database.service.ts:657`,目前 private) | 「expand(還原)」= 刪 cmp 節點、子訊息掛回其 parent |
| 合成訊息的渲染模式 | `isSynthetic` + `ChatMessageSynthetic.svelte`(`ChatMessage.svelte:62,412`) | cmp entry 的渲染走同一模式:API 層是 `user`,UI 層靠 `type` flag 特判 |
| 對話 import/export | `services/conversation-transfer.service.ts`(JSONL 整則序列化) | 新 `type` 欄位**自動**隨訊息進出,零改動(需補測試) |
| Settings 註冊表 | `constants/settings-keys.constants.ts` + `constants/settings.constants.ts`(`SETTINGS_REGISTRY`)+ `SettingsChatFields.svelte` | 新增 5~6 個 key,照表加 |
| 側邊 LLM 呼叫模式 | `generateTitleWithLLM` | summary 產生照此模式(非 streaming、獨立 prompt) |
| 測試慣例 | `tests/unit/`(vitest 純函式)、`tests/client/`(svelte 元件)、`tests/stories/`(storybook) | builder/policy 純函式 → unit;渲染/inspector → client + story |

## 5. 現況小結(痛點)

1. 長對話 / agentic 多 turn 後,`prompt_n` 持續逼近 `n_ctx`,
   目前只有 `contextStatsStore` 把數字畫在 gauge 上,**沒有任何自動動作**。
2. 超過 `n_ctx` 時直接 server error(`ErrorDialogState.contextInfo`
   有 `n_prompt_tokens / n_ctx`,見 `types/chat.d.ts:162`),user 只能手刪訊息。
3. user 完全無法看到「這一輪實際送了什麼」(例如 reasoning 被
   `excludeReasoningFromContext` 剔除、attachment 被 vision 過濾等
   都只發生在 `sendMessage` 內部,不可見)。
4. agentic 迴圈中 `sessionMessages` 只增不減,是 context 爆炸最快的場景。
