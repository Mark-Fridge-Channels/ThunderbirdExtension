# 未来需 Experiment API 的边界清单

以下能力在当前**仅用官方 MailExtension API** 时存在限制；若需完整实现，可考虑 Experiment API（建议目标 ESR，并评估维护成本）。

## 1. forward_message

- **现状**：使用 `compose.beginForward(messageId, forwardType, details)` + `setComposeDetails` + `sendMessage`，可完成“打开转发窗口、填收件人、发送”。
- **可能缺口**：
  - 若需在**无 UI、完全后台**下完成转发（不打开 compose 窗口），官方 API 无“无头转发”接口，需 Experiment 提供“直接发送转发邮件”的能力。
  - 若需对转发内容做**深度改写**（如替换 MIME 部分、修改引用关系），官方仅暴露 compose 窗口内容，可能需 Experiment 访问底层消息结构。

## 2. 账号/身份切换与“默认发件身份”

- **现状**：通过内存中的执行上下文（accountId/identityId）和 `compose` 的 `identityId` 指定发件身份，不依赖 UI 焦点。
- **可能缺口**：若外部希望“把某账号设为 Thunderbird 全局默认账号/默认身份”，官方 API 无直接设置入口，可能需 Experiment 修改默认身份。

## 3. 批量任务与速率限制

- **现状**：每次命令单次执行；批量由外部程序多次下发。
- **可能缺口**：若需在扩展内做队列、重试、速率限制，或需监听发送结果（如 `compose.onAfterSend`）并回写到外部，当前架构已支持；若需**进程内批量发送且保证顺序与去重**，可继续在 handler 层用 idempotency 与队列扩展，无需 Experiment。

## 4. 事件推送（如 onNewMailReceived）

- **现状**：官方有 `messages.onNewMailReceived`，可在 background 中监听并通过 Native Messaging 的 port 主动推送到 host（host 需支持接收“非请求-响应”类消息）。
- **可能缺口**：若 host 与扩展之间是“请求-响应”单次模型，需在 host 侧增加长连或轮询以获取事件；无需 Experiment。

## 5. 联系人/通讯录高级能力

- **现状**：使用 `addressBooks.contacts.create(parentId, vCard)` 与 `query`，可查重、创建。
- **可能缺口**：若需按自定义字段批量导入、或与远程通讯录同步，官方 API 可能不足以表达所有字段或策略，可能需 Experiment 或服务端配合。

## 6. 稳定 messageId 与跨会话引用

- **现状**：已明确不以内部 `messageId` 为长期主键，使用 `accountId + folderPath + headerMessageId` 作为稳定引用。
- **可能缺口**：若未来需“仅用 headerMessageId 在任意账号/文件夹中定位”，需在多个账号/文件夹中 query，官方 `messages.query` 已支持，无需 Experiment。

---

**建议**：优先保持“官方 API + 当前四层架构”；仅在上述明确缺口且产品确需时，再引入最小范围的 Experiment（优先 ESR，并记录在 VENDOR.md / 文档中）。
