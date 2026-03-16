# 探索：避免重复回复 / 定位回复目标 / 外部程序 API 与文档

## 一、避免重复回复 & 如何知道/定位应回复哪封邮件（或 thread）

### 1.1 当前能力

- **稳定标识**：DESIGN.md 约定对外用 `accountId` + `folderPath` + `headerMessageId` 作为稳定引用。Thunderbird 内部 `messageId` 会随重启变化，**不要**作为长期主键。
- **回复目标**：reply_message 支持三种指定方式：
  - **messageId**：当前会话有效，不跨重启。
  - **headerMessageId**：邮件 Message-ID 头，**唯一、稳定**，推荐作为「要回复的那封」的标识。
  - **folderPath + subject**：按主题包含匹配，可能多封取第一封，适合主题唯一的流程。
- **幂等**：仅 send_email 支持 `idempotency_key`（存 storage.local）；**reply_message 目前无幂等**，同一请求发两次会回复两次。

### 1.2 避免重复回复（建议实现）

- **方案**：为 reply_message 增加与 send_email 类似的 **idempotency_key** 支持。
  - Envelope 已有 `idempotency_key`，router 会传给 handler。
  - 在 reply_message 中：若带 idempotency_key，先查 storage.local（如 key `reply_message_idempotency`），若该 key 已记录「已对该 headerMessageId（或 messageId）回复过」，则直接返回上次结果（success + result，带 idempotent: true）。
  - 存储内容建议：以 idempotency_key 为键，存 { headerMessageId, messageId, sentHeaderMessageId, 时间等 }，以便去重和审计。
- **调用方**：同一「逻辑操作」使用同一 idempotency_key（例如 `reply-to-<headerMessageId>` 或业务层唯一单号），重复请求时扩展直接返回缓存结果，不再真正发信。

### 1.3 如何知道「应该回复哪一封」

- **推荐**：用 **headerMessageId** 唯一确定一封邮件。
  - 流程上：先 **open_message**（用 subject/from/date 等查收件箱），响应里带 **result.stableIdentifiers.headerMessageId**；后续 **star_message**、**reply_message** 都传该 **headerMessageId**（及 accountId、folderPath 若需要），即可精确回复「刚打开的那封」。
  - 或：若邮件是「我方刚发的」，send_email 返回的 **result.headerMessageId** 是发出的那封；若对方回复后要「再回复那封回信」，则需对方邮件到达后通过 open_message 或 query 得到其 headerMessageId，再用于 reply。
- **不推荐**：仅用 folderPath + subject，因 subject 是「包含」匹配且可能多封，无法保证是同一封或最新一封。

### 1.4 Thread（会话/线程）

- **现状**：Thunderbird WebExtension messages API **没有** conversationId/threadId（见 Bug 1665676）。无法按「会话」维度查「该 thread 下所有邮件」。
- **实践**：
  - 「回复哪一封」：用 **headerMessageId** 指定唯一一封即可（即「该 thread 中的那一封」）。
  - 若业务需要「该会话最新一封」：只能用现有 query 条件（如 folderPath + subject + from + toDate/fromDate）查出一批，再按 date 排序取最新；当前 API 无 thread 聚合。

### 1.5 小结（已确认）

| 点 | 结论 |
|----|------|
| 防重复回复 | **需要**：reply_message 支持 idempotency_key，存 storage 按 key 返回缓存。 |
| 定位回复目标 | 流程由实现方确定；需**支持多次相互邮件沟通**（多轮往来）。 |
| Thread | **有需求**：需支持「按会话/thread 选一封再回复」；TB 无 threadId，用 query + headerMessageId 实现。 |

---

## 二、外部程序如何使用：功能列表、调用方式、封装与说明文档

### 2.1 前置条件

- **minimal-server** 已启动：`node minimal-server/server.js`（默认 127.0.0.1:3939）。
- **Thunderbird** 已安装并启用本扩展（Mail Automation Agent）。
- 外部程序与 minimal-server 同机（或能访问 127.0.0.1:3939）。

### 2.2 协议概要

- **唯一入口**：`POST http://127.0.0.1:3939/command`
- **请求体**（JSON）：
  - **request_id**（必填，字符串）：本次请求唯一标识，用于日志与响应关联。
  - **action**（必填，字符串）：见下表。
  - **payload**（必填，对象）：与 action 对应，见下。
  - **idempotency_key**（可选，字符串）：部分 action 支持，用于幂等（当前仅 send_email 已实现）。
- **响应**：长连接阻塞直到扩展 POST /done 或超时。
  - **200**：JSON `{ request_id, success, result? }` 或 `{ request_id, success: false, error: { code, message, details? } }`。
  - **504**：扩展在约定时间内未完成（默认 120s，可设 COMMAND_TIMEOUT_MS）。
- **超时**：服务端 COMMAND_TIMEOUT_MS（默认 120000），客户端建议设略大于该值的 fetch/timeout。

### 2.3 功能与 action / payload 一览

| action | 说明 | payload 要点 | 响应 result 要点 |
|--------|------|--------------|------------------|
| **switch_account_context** | 切换当前账号（上下文） | accountId / email / identityId 至少其一 | accountId, identityId, accountName, identityEmail, folders[] |
| **send_email** | 发信 | to（必）, subject, plainTextBody, isPlainText, cc, bcc, dry_run；可选 identityId/accountId（否则用上下文）, idempotency_key（envelope 层） | headerMessageId, stableIdentifiers；dry_run 时 details |
| **open_message** | 打开一封邮件（tab/窗口） | accountId（必）, folderPath 或 folderId；定位：headerMessageId 或 subject/from/to/fromDate/toDate | tabId, windowId, messageId, stableIdentifiers: { accountId, folderPath, headerMessageId } |
| **star_message** | 标星/取消标星 | accountId（必）；目标：messageId 或 headerMessageId 或 folderPath+subject；starred（可选，默认 true） | messageId, stableIdentifiers, previousState, newState, idempotent? |
| **add_contact** | 添加联系人 | email（必）, addressBookId 或 parentId（必）；可选 displayName, company, phone, note | contactId, parentId, duplicate?, stableIdentifiers |
| **forward_message** | 转发 | accountId（必）, messageId 或 headerMessageId；to/recipients（必）；可选 subject, body, forward_mode: inline/attachment, dry_run | messageId, headerMessageId, forwardResult, stableIdentifiers |
| **reply_message** | 回复 | accountId 可选（用上下文）；目标：messageId 或 headerMessageId 或 folderPath+subject；plainTextBody 或 body；可选 isPlainText, replyType | messageId, headerMessageId, replyResult, stableIdentifiers |

- **上下文**：switch_account_context 设置的 accountId/identityId 会被 send_email、open_message、star_message、forward_message、reply_message 在未显式传时使用。
- **错误**：统一为 `error: { code, message, details? }`；常见 code：VALIDATION、NOT_FOUND、CONTEXT_NOT_SET、API_ERROR、TIMEOUT。

### 2.4 封装建议（供外部程序调用）

- **最小封装**：一个函数 `command(action, payload, options?)`：
  - 内部 POST /command，body 含 request_id（可生成）、action、payload、可选 idempotency_key；
  - 设置 timeout（如 130000 ms）；
  - 返回解析后的 JSON；非 2xx 或 success: false 时抛错或返回 { success: false, error }。
- **可选**：在仓库内提供 **Node 客户端**（如 `clients/node/client.js` 或 `lib/mail-automation-client.js`），导出 `command(action, payload, options)` 及 `BASE_URL`/timeout 可配，便于脚本和外部程序直接 require/import。
- **封装层不替代**：不替代 minimal-server，只封装「如何调 /command、如何解析响应与错误」。

### 2.5 说明文档建议

- **位置**：如 **docs/EXTERNAL_API.md** 或项目根 **API.md**。
- **建议章节**：
  1. 前置条件与启动顺序（minimal-server、Thunderbird、扩展）。
  2. 协议：URL、请求方法、请求体字段、响应与错误格式、超时与 504。
  3. 上表：每个 action 的 payload 与 result 说明（可再展开必填/可选、示例）。
  4. 推荐流程：先 switch_account_context，再按需 send/open/star/forward/reply；用 open_message 返回的 headerMessageId 做后续 reply/star。
  5. 幂等：idempotency_key 的用法（当前 send_email；若实现 reply 幂等则一并写）。
  6. 示例：curl 一条、Node 一段（fetch 或封装后的 command()）。
  7. 故障排查：504、CONTEXT_NOT_SET、NOT_FOUND、扩展未加载等。

### 2.6 小结（已确认）

| 点 | 结论 |
|----|------|
| 文档 | **docs/EXTERNAL_API.md**，**仅中文**。 |
| 封装 | **只写文档**，以及**如何对接**（不提供仓库内客户端库）。 |
| 示例 | **仅 Node**，且使用 **TypeScript** 示例。 |

---

## 三、已确认结论汇总

1. **重复回复**：**需要** — 扩展内为 reply_message 实现 idempotency_key（与 send_email 类似）。
2. **定位回复 / 多次相互邮件**：流程由实现方确定；需**支持多次相互邮件沟通**（多轮往来）。
3. **Thread**：**有需求** — 支持「按会话/thread 选一封再回复」；TB 无 threadId，用 query 条件 + headerMessageId 实现。
4. **外部 API 文档**：**docs/EXTERNAL_API.md**，**仅中文**。
5. **客户端**：**只写文档与对接说明**，不提供仓库内封装库。
6. **示例语言**：**仅 Node + TypeScript**。

---

## 四、实现计划（探索完成后执行）

### 4.1 reply_message 幂等

- 在 **reply_message** handler 中读取 envelope.idempotency_key；若存在，先查 storage.local（如 key `reply_message_idempotency`），若该 idempotency_key 已有记录则直接返回上次 result（并带 idempotent: true），不再次发信。
- 成功发送后，以 idempotency_key 为键写入 { headerMessageId, messageId, sentHeaderMessageId 等 } 便于审计。
- schema：reply_message 的 payload 无需新增必填字段；idempotency_key 在 envelope 层已有。

### 4.2 多次相互邮件 + 按 thread 选一封

- **推荐流程**（文档中写明）：
  - 每一轮「谁要回复」：先 **switch_account_context** 到该账号；再**定位要回复的那封**：
    - 若有**已知 headerMessageId**（例如上一轮 open_message 或 resolve 返回的），直接 **reply_message** 传 headerMessageId（及 accountId、folderPath 若需）。
    - 若需「会话中最新一封」：用 **open_message** 的 query（folderPath + subject + from + toDate/fromDate）定位一封，返回的 **stableIdentifiers.headerMessageId** 作为后续 **reply_message** 的 headerMessageId；或增加轻量 action **resolve_message**（只做 messages.query，返回 { messageId, headerMessageId } 不打开窗口），便于多轮中「只取引用不打开」。
- **按 thread 选一封**：因 TB 无 threadId，用 **folderPath + subject**（+ 可选 from、toDate/fromDate）查出一批，取**第一条**（或按 date 取最新，若 query 结果顺序稳定）；得到该条的 headerMessageId 后用于 reply。若实现 **resolve_message**，可接受与 open_message 相同的 query 参数，返回 stableIdentifiers，避免重复打开邮件。
- **demo**：demo_flow_mark_to_oh.js 可改为「open_message 后取 result.stableIdentifiers.headerMessageId，star 与 reply 均传该 headerMessageId」，作为推荐流程示例；若有 resolve_message，可加一段「仅解析不打开再回复」的示例。

### 4.3 resolve_message action（已纳入本轮实现）

- **用途**：仅根据 query（folderPath、subject、from、headerMessageId、toDate/fromDate）解析出唯一一封邮件的 messageId 与 headerMessageId，**不**打开窗口。便于多轮沟通中「只取要回复的那封的引用」。
- **payload**：与 open_message 的定位部分一致（accountId 必填；folderPath；定位用 headerMessageId 或 subject/from/to/fromDate/toDate）。
- **result**：{ messageId, headerMessageId, accountId, folderPath }（即 stableIdentifiers + messageId）。
- **实现**：新增 action **resolve_message**；复用 messagesAdapter 的 findFolderId、queryMessages、resolveMessageId 逻辑，不调用 messageDisplay.open；schema 新增 validateResolveMessagePayload（与 open_message 的定位条件一致），router 与 ACTIONS 注册。

### 4.4 docs/EXTERNAL_API.md（仅中文）

- **章节**：前置条件与启动顺序；协议（URL、方法、请求体、响应与错误、超时）；各 action 的 payload/result 说明（含 **resolve_message**、idempotency_key 对 send_email/reply_message）；推荐流程（多次相互邮件、用 headerMessageId、按 thread 用 query 取一封，可用 resolve_message 只取引用不打开）；**如何对接**（Node/TS：fetch 示例、request_id 生成、timeout、错误处理）；故障排查。
- **示例**：curl 一条；**Node + TypeScript** 一段（fetch 或 axios，含类型注释或接口定义更佳），展示 command 调用方式与超时、错误处理。
- **不提供**：仓库内独立客户端包或 npm 库；仅文档内示例代码与对接说明。

### 4.5 待定项（实现时可再定）

- **idempotency_key 存储格式**：与 send_email 对齐（如 `reply_message_idempotency` 下以 key 为键存对象），具体字段可随审计需求微调。
