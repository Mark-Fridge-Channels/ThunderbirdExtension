# 探索：回复功能（reply_message）分析与问题排查

## 1. 当前实现概览

- **入口**：`reply_message` action → `handleReplyMessage`（handlers/replyMessage.js）→ `replyToMessage`（adapters/composeAdapter.js）。
- **流程**：解析 messageId（支持 messageId / headerMessageId / folderPath+subject）→ 取 identityId（payload 或 context）→ `compose.beginReply` → 若有正文则 `setComposeDetails` → `compose.sendMessage`。

## 2. 官方 API 对照（Thunderbird MV3）

### 2.1 compose.beginReply(messageId, [replyType], [details])

- **文档**：https://webextension-api.thunderbird.net/en/mv3/compose.html
- **参数**：messageId（必填）、replyType（可选：replyToSender / replyToList / replyToAll）、details（可选，ComposeDetails）。
- **说明**：若不传 identityId，使用默认 identity（不一定是被回复邮件所在账号）。
- **返回**：Promise\<Tab\>（TB 89+），用 tab.id 做后续 setComposeDetails / sendMessage。

### 2.2 ComposeDetails（beginReply 的 details）

- 可用字段：identityId、plainTextBody、body、isPlainText 等。
- **注意**：文档要求「通过 details.isPlainText 或只指定 details.body / details.plainTextBody 之一」设定格式，不要同时混用 body 与 plainTextBody 造成歧义。
- 当前实现只传 identityId、plainTextBody、isPlainText，符合「只指定 plainTextBody」的用法。

### 2.3 setComposeDetails(tabId, details)

- 文档注明：**已有撰写窗口的 compose 格式不能改**（不能从纯文本改成 HTML 或反过来）。
- 当前在 beginReply 之后再次 setComposeDetails(plainTextBody, isPlainText)，未改格式，仅改正文，符合文档。

### 2.4 compose.sendMessage(tabId, options)

- 返回：`{ messages, mode, headerMessageId? }`（TB 102+）。
- headerMessageId 在「实际发出」时才有；若仅放入发件箱可能没有。
- 当前用 `sendResult?.headerMessageId ?? messages[0]?.headerMessageId`，与文档一致。

### 2.5 messages.query / MessageList

- **reference.md**：messages.query 返回 **MessageList**，必须用 `.messages` 取数组，不能直接当数组解构。
- **messagesAdapter.queryMessages** 已正确使用 `list?.messages ?? []` 并返回数组，符合规范。

### 2.6 messages.query 的 subject / author

- **subject**：文档为 "Returns only messages whose **subject contains** the provided string"（包含匹配，非精确）。
- **author**：文档为 "The **address** part must match **completely**", "**name** part must match **partially**"。
- 用 subject 查「尽快处理问题」时，可能匹配到多封；当前取 `list[0]`，即第一封匹配，在主题唯一时可行，多封时可能需更严格条件（如再加 from/date）。

## 3. 可能问题与建议

| # | 问题 | 严重性 | 建议 |
|---|------|--------|------|
| 1 | **beginReply 未传 identityId 时用默认 identity** | 中 | 已通过 payload/context 传 identityId；若未传会回 CONTEXT_NOT_SET，逻辑正确。需确认调用方（如 demo_flow）在切换账号后确实用同一账号回复。 |
| 2 | **setComposeDetails 与 beginReply 的 body 重复** | 低 | 当前先 beginReply(details 里带 plainTextBody)，再 setComposeDetails(plainTextBody)。若 beginReply 已支持预填正文，可能重复；若仅预填引用块，则第二次设置是必须的。保留二次设置更稳妥，无功能错误。 |
| 3 | **subject 为「包含」匹配** | 中 | 多封主题都含「尽快处理问题」时会取第一封。若需精确匹配，需在应用层过滤 subject 或加 from/date 等条件；或文档中说明「主题应尽量唯一」。 |
| 4 | **sendMessage 抛错** | 高 | 用户取消发送、onBeforeSend 取消、网络/服务器错误等会 throw。当前 handler 已 try/catch 并返回 API_ERROR，行为合理。 |
| 5 | **ComposeDetails 只传一种 body** | 已满足 | 仅传 plainTextBody + isPlainText，未混用 body，符合文档「只指定一种」的要求。 |

## 4. 与 reference.md 的符合性

- **不用 try-catch 猜 API**：未用 try-catch 试探参数，参数均按文档使用。
- **MessageList 访问方式**：通过 messagesAdapter 使用 `.messages`，未直接解构 MessageList。
- **background type: module**：扩展已用 type: "module"。
- **strict_min_version**：manifest 为 128.0，beginReply/sendMessage 等均在 TB 67–102 引入，满足。

## 5. 若「回复不成功」时的排查顺序

1. **扩展控制台**：看是否有 throw 或 makeError(API_ERROR, ...)，确认是 beginReply、setComposeDetails 还是 sendMessage 报错。
2. **identityId**：确认 switch_account_context 后 context 的 identityId 与要回复的账号一致（oh.duang@gmail.com 的 identity）。
3. **messageId**：确认解析出的 messageId 正确（用 folderPath+subject 时，是否有多封匹配或主题未同步）。
4. **权限**：manifest 需 compose、compose.send、messagesRead、accountsRead；当前已具备。
5. **Thunderbird 版本**：确保 ≥ 128.0（或你声明的 strict_min_version）。

## 6. 结论与后续

- 当前回复链路与 Thunderbird 官方 compose/messages API 用法一致，未发现明显违反文档或 reference 的写法。
- 若实际出现「回复没发出、发错账号、或报错」，请提供：**具体报错信息**（扩展控制台或 POST /done 的 error）、**步骤**（是否先 switch 再 open/star 再 reply）、以及**是否用 folderPath+subject 解析 messageId**。可根据这些信息进一步定位是 identity、message 解析还是 sendMessage 环节问题，并做针对性修改（不改变现有探索结论）。
