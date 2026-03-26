# 探索：Executor 日志分析及解决方案

## 1. 日志摘要

| 序号 | taskId | action | outcome | reason |
|------|--------|--------|---------|--------|
| 1 | warmup:beril@fc→oh.duang@gm:send:20260318:5 | Send | ok | null |
| 2 | warmup:oh.duang@gm→beril@fc:open:20260318:1 | Open | failed | missing_reply_to_message_id_or_subject |
| 3 | warmup:mark@fc→oh.duang@gm:send:20260318:2 | Send | failed | api_error |
| 4 | warmup:oh.duang@gm→mark@fc:open:20260318:1 | Open | failed | missing_reply_to_message_id_or_subject |

---

## 2. 根因分析

### 2.1 Open 失败：`missing_reply_to_message_id_or_subject`

**触发位置**：`minimal-server/executor.js` → `validateRequired()`  
当前逻辑：Open/Star 要求「至少具备其一」：
- `reply_to_message_id`（Notion 列：reply_to_message_id / replyToMessageId）
- `subject`（Notion 列：subject / Subject）

你的两条 Open 任务在解析后这两个字段都为空，因此被判定为必填缺失。

**可能原因**（需你对照 Notion 确认其一或多种）：

1. **列名不一致**  
   Notion 里「主题」或「邮件 Message-ID」用的不是我们解析的 key：  
   - 主题：当前只认 `subject`、`Subject`；若你用的是「标题」「主题」「Queue Item」（页面 title）等，解析不到。  
   - 回信定位：只认 `reply_to_message_id`、`replyToMessageId`。

2. **Open 行确实未填**  
   工作流若是「先 Send，对方再 Open 刚收到的那封」，Open 行可能设计上就没有 subject/reply_to_message_id，而是依赖「发件人」或「标题在别列」。

3. **类型/格式**  
   若 subject 或 reply_to_message_id 在 Notion 里是 formula、rollup、或非 rich_text/title，当前解析只会得到空字符串。

### 2.2 Send 失败：`api_error`

**含义**：扩展执行 `send_email` 时返回了 `success: false`（或抛错），executor 统一记成 `api_error` 并回写 Failed。

**可能原因**（需看 Notion 该行的 execution_result_detail）：

- 身份/账号：identity 或 account 不可用、未找到。  
- 收件人：to 无效、被拒、或触发了 TB 的某种限制。  
- 网络/服务器：超时、SMTP 错误等。  
- 其他：如 compose 被用户取消、权限等。

**如何确认**：在 Notion 里打开失败的那条 Send 任务，看 `execution_result_detail` 中的 `extension.error`（code、message、details），即可对应到扩展/Thunderbird 的具体错误。

---

## 3. 解决方案建议

### 3.1 Open 的 `missing_reply_to_message_id_or_subject`（代码侧）

**方案 A：放宽 Open 的「定位条件」**

- 扩展的 `open_message` 支持用 **folderPath + from** 定位（见 `extension/shared/schemas.js`：`hasQuery = headerMessageId || subject || from || ...`）。  
- 当前 executor 的校验是「reply_to_message_id 或 subject 至少一个」，没有把「仅有 from」视为合法。  
- **建议**：  
  - 在 `validateRequired()` 里，对 **Open** 改为：`reply_to_message_id || subject || fromEmail` 至少一个即通过。  
  - 在 `mapActionToEnvelope()` 的 Open 分支里，当没有 headerMessageId 且没有 subject 时，用 `from: row.fromEmail || row.counterpartyEmail` 作为查询条件（已有 folderPath: INBOX），这样「只填发件人」的 Open 行也能执行。

**方案 B：扩展 subject 的解析来源（避免漏掉你 Notion 的列名）**

- 在 `queueParser.js` 里给 subject 增加更多 key 别名，例如：  
  - 把 **Queue Item**（或你用来当「任务标题/主题」的 title 属性）也当作 subject 来源：  
    - 例如 `readPropertyText(props, ["subject", "Subject", "Queue Item", "queue_item", "标题", "主题"])`，若你 DB 里是 title 类型，需要同样用 `readRichText`/title 方式读。  
- 这样只要 Notion 行在「标题」或「主题」列有内容，就能通过「至少一个 subject」的校验，并用于 Open/Star。

**方案 C：Star 的说明**

- 扩展的 `star_message` 只支持：messageId、headerMessageId、或 **folderPath+subject**，不支持「仅 from」。  
- 因此 **Star** 的校验保持「reply_to_message_id 或 subject 至少一个」是合理的；若未来要支持「仅按发件人标星」，需要扩展侧先支持按 from 查询再标星。

### 3.2 Send 的 `api_error`（排查与数据侧）

- **必做**：在 Notion 中查看失败任务 `warmup:mark@fc→oh.duang@gm:send:20260318:2` 的 **execution_result_detail**，根据其中的 `extension.error`（code、message、details）确定是账号、收件人、网络还是其他问题。  
- **可选**：若希望控制台也直接看到扩展错误，可在 executor 打 `[executor]` 日志时，对 `outcome === 'failed'` 且 `reason === 'api_error'` 时多打一行 `extensionError: out?.error`（注意不要打满屏），便于不打开 Notion 也能快速看原因。

### 3.3 Notion 数据/列名（你侧确认）

- 打开两条失败的 **Open** 行，确认：  
  - 主题/标题存在哪一列？列名（API 里的 property name）是什么？  
  - 若有「原邮件 Message-ID」列，列名是什么？  
- 若列名不是 `subject`/`Subject` 或 `reply_to_message_id`/`replyToMessageId`，要么：  
  - 在 **方案 B** 里为 subject / reply_to_message_id 增加你实际使用的 key（或 title 映射），或  
  - 在 config 的 notion_property_names 同级增加「队列列名映射」（若你希望做成配置化，可再单独做一小块配置）。

---

## 4. 小结

| 现象 | 根因方向 | 建议 |
|------|-----------|------|
| Open 报 missing_reply_to_message_id_or_subject | 解析后 subject 与 reply_to_message_id 均为空 | 方案 A（Open 允许仅 from）+ 方案 B（subject 多 key/Queue Item 标题）；并确认 Notion 列名与填值 |
| Send 报 api_error | 扩展/Thunderbird 返回错误 | 查 Notion 该行 execution_result_detail；可选在 executor 日志中打印 extensionError |

需要的话我可以按「方案 A + B」给出具体补丁（executor 校验与 Open 映射 + queueParser subject 别名）。

---

## 5. 方案 A 集成说明（仅放宽 Open）

### 5.1 改动范围

| 文件 | 改动点 | 说明 |
|------|--------|------|
| `minimal-server/executor.js` | `validateRequired()` | **仅对 Open** 放宽：允许 `reply_to_message_id || subject || fromEmail` 至少一个即通过；**Star 保持不变**（仍要求 reply_to_message_id 或 subject，因扩展 star_message 不支持仅按 from 定位）。 |

### 5.2 具体逻辑

- **当前**（94–95 行）：Open 与 Star 共用同一条件  
  `if (!row.replyToHeaderMessageId && !row.subject) return { ok: false, reason: "missing_reply_to_message_id_or_subject" };`
- **方案 A**：  
  - **Open**：改为 `replyToHeaderMessageId || subject || row.fromEmail` 至少一个即通过（`row.fromEmail` 在 queueParser 中已为 `from || counterpartyEmail`，可表示「要打开的那封邮件的发件人」）。  
  - **Star**：保持原样，仍要求 `replyToHeaderMessageId || subject`（扩展只支持 messageId / headerMessageId / folderPath+subject）。

### 5.3 mapActionToEnvelope（Open）无需改

- 当前已对 Open 在无 headerMessageId 时传 `from: row.fromEmail || row.counterpartyEmail`，扩展 `open_message` 支持 folderPath + from，故**无需修改** mapActionToEnvelope。
- 方案 A 仅需放宽校验，通过后现有 payload 即可用「仅 from」在 INBOX 中定位并打开。

### 5.4 依赖与边界

- **依赖**：`queueParser.js` 已提供 `fromEmail`（及 counterpartyEmail 回退），无新增解析。
- **边界**：若某行 Open 既无 reply_to_message_id、subject，也无 from/From/counterparty（即 fromEmail 为空），仍会报错；此时无足够信息定位邮件，行为合理。
- **Star**：不随方案 A 放宽，避免扩展侧不支持「仅 from」导致 star_message 报错。

---

## 6. 日志分析：Add Contact / Open / Send 均失败（20260319）

### 6.1 日志摘要

| taskId | action | outcome | reason |
|--------|--------|---------|--------|
| warmup:Mark-BAI@outlook→mark@fc:add_contact:20260319:1 | Add Contact | failed | missing_address_book_id |
| warmup:Mark-BAI@outlook→mark@fc:open:20260319:1 | Open | failed | api_error |
| warmup:mark@fc→Mark-BAI@outlook:send:20260319:1 | Send | failed | api_error |

### 6.2 原因分析

**① Add Contact — `missing_address_book_id`**

- **触发位置**：`minimal-server/executor.js` 的 `validateRequired()` 与 `mapActionToEnvelope()`，当 `cfg.executor.addressBookId` 为空时直接报此 reason。
- **配置来源**：`minimal-server/config.json` 中 `executor.address_book_id` 当前为 `""`，加载后 `addressBookId` 为空。
- **结论**：未配置 Thunderbird 通讯录 ID，Add Contact 按设计会失败并回写该 reason。

**② Open — `api_error`**

- **含义**：扩展执行 `open_message` 时返回了 `success: false`（或抛错），executor 统一记为 api_error。
- **可能原因**（需看 Notion 该行的 **execution_result_detail** 里 `extension.error`）：  
  - 账号/身份未找到（如 actor 邮箱在 TB 中不存在或未配置）；  
  - INBOX 中无匹配「发件人/主题」的邮件；  
  - folderPath/权限或扩展内部错误。
- **建议**：在 Notion 中打开该 Open 任务，查看 `execution_result_detail` 的 `extension.error`（code、message、details）以确定具体错误。

**③ Send — `api_error`**

- **含义**：扩展执行 `send_email` 时返回了 `success: false`（或抛错）。
- **可能原因**（同样需看 Notion 该行 **execution_result_detail**）：  
  - 发件身份/账号不可用或未找到；  
  - 收件人地址无效或被拒；  
  - 网络/SMTP 超时或错误；  
  - 用户取消发送或扩展/Thunderbird 限制。
- **建议**：在 Notion 中打开该 Send 任务，查看 `execution_result_detail` 的 `extension.error` 以定位具体原因。

### 6.3 对应措施

| 失败项 | 原因 | 你可做的 |
|--------|------|----------|
| Add Contact | 未配置 `address_book_id` | 在 `minimal-server/config.json` 的 `executor.address_book_id` 中填入 Thunderbird 通讯录 ID（通过扩展或 TB 获取 addressBooks 中目标通讯录的 id），保存后重启 minimal-server。 |
| Open | 扩展返回错误 | 在 Notion 该行看 execution_result_detail → extension.error，根据 code/message 排查账号、邮箱、INBOX 是否有匹配邮件等。 |
| Send | 扩展返回错误 | 同上，看 execution_result_detail → extension.error，排查发件身份、收件人、网络等。 |
