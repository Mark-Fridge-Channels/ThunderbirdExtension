# 外部程序对接说明（Mail Automation Agent）

本文档说明如何从外部程序（Node/TS 等）调用本扩展提供的邮件自动化能力。扩展通过本地 HTTP 服务（minimal-server）接收命令并执行。

---

## 1. 前置条件与启动顺序

1. **启动 minimal-server**（与扩展通信的本地服务）：
   ```bash
   node minimal-server/server.js
   ```
   默认监听 `http://127.0.0.1:3939`，可通过环境变量 `PORT` 修改端口。

2. **Thunderbird** 已安装，并已加载/安装本扩展（Mail Automation Agent）。  
   开发时：附加组件 → 从文件安装 → 选择项目中的 `extension` 目录；或安装打包后的 `extension.xpi`。

3. 外部程序与 minimal-server **同一台机器**（或能访问 127.0.0.1:3939）。

---

## 2. 协议概要

### 2.1 唯一入口

- **方法**：`POST`
- **URL**：`http://127.0.0.1:3939/command`
- **请求头**：`Content-Type: application/json`

### 2.2 请求体（JSON）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| request_id | string | 是 | 本次请求唯一标识，用于日志与响应关联。 |
| action | string | 是 | 动作名，见下文「动作列表」。 |
| payload | object | 是 | 与 action 对应的参数对象。 |
| idempotency_key | string | 否 | 幂等键；仅部分 action 支持（send_email、reply_message）。 |

### 2.3 响应

- 连接会**阻塞**直到扩展执行完毕并回写结果，或服务端超时。
- **HTTP 200**：JSON  body 为下列之一：
  - 成功：`{ request_id, success: true, result }`
  - 失败：`{ request_id, success: false, error: { code, message, details? } }`
- **HTTP 504**：扩展在约定时间内未完成（默认 120 秒）。可设环境变量 `COMMAND_TIMEOUT_MS`（如 180000）延长服务端超时；客户端请求建议设置略大于该值的超时（如 130 秒）。

### 2.4 错误码（error.code）

| code | 说明 |
|------|------|
| VALIDATION | 参数校验失败（如缺少必填、格式错误）。 |
| NOT_FOUND | 账号/文件夹/邮件未找到。 |
| CONTEXT_NOT_SET | 需要 accountId/identityId 但未传且上下文未设置（需先 switch_account_context）。 |
| API_ERROR | 调用 Thunderbird API 抛错。 |
| TIMEOUT | 扩展未在时间内完成（服务端 504 时 body 中可能带此码）。 |

---

## 3. 动作列表（action / payload / result）

### switch_account_context

切换当前执行上下文（账号/身份），后续 send_email、open_message、star_message、reply_message 等可省略 accountId/identityId 时将使用该上下文。

| 项目 | 说明 |
|------|------|
| **payload** | accountId / email / identityId **至少填一个**（字符串）。 |
| **result** | accountId, identityId, accountName, identityEmail, folders（数组，含 id/path/name）。 |

### send_email

发一封新邮件。可使用上下文的 identityId/accountId。

| 项目 | 说明 |
|------|------|
| **payload** | to（必填，字符串或字符串数组）, subject, plainTextBody, isPlainText（默认 true）, cc, bcc, dry_run（布尔）；可选 identityId/accountId。 |
| **envelope.idempotency_key** | 可选。相同 key 重复请求时返回上次发送结果，不再真正发信（result 带 idempotent: true）。 |
| **result** | headerMessageId, stableIdentifiers；dry_run 时为 details。 |

### open_message

在浏览器中打开一封邮件（新 tab 或窗口）。返回的 **stableIdentifiers.headerMessageId** 可用于后续 star_message、reply_message 精确定位该封邮件。

| 项目 | 说明 |
|------|------|
| **payload** | accountId（必填）, folderPath 或 folderId（默认 INBOX）；**定位条件**：headerMessageId **或** subject/from/to/fromDate/toDate 至少一种。可选 open_mode（"tab"\|"window"）。 |
| **result** | tabId, windowId, messageId, stableIdentifiers: { accountId, folderPath, headerMessageId }。 |

### resolve_message

仅解析出一封邮件的 messageId 与 headerMessageId，**不打开**窗口。适用于多轮沟通中「只取要回复的那封的引用」再调用 reply_message。

| 项目 | 说明 |
|------|------|
| **payload** | 与 open_message 的定位部分一致：accountId（必填）, folderPath（默认 INBOX）；定位：headerMessageId 或 subject/from/to/fromDate/toDate。 |
| **result** | messageId, headerMessageId, accountId, folderPath, stableIdentifiers。 |

### star_message

对一封邮件标星或取消标星。

| 项目 | 说明 |
|------|------|
| **payload** | accountId（必填）；**目标**：messageId 或 headerMessageId 或 folderPath+subject。可选 starred（布尔，默认 true）。 |
| **result** | messageId, stableIdentifiers, previousState, newState；若状态未变则 idempotent: true。 |

### add_contact

在指定通讯录中创建联系人（若已存在同邮箱则返回 duplicate: true）。

| 项目 | 说明 |
|------|------|
| **payload** | email（必填）, addressBookId 或 parentId（必填）；可选 displayName, company, phone, note。 |
| **result** | contactId, parentId, duplicate?, stableIdentifiers。 |

### forward_message

转发一封邮件。

| 项目 | 说明 |
|------|------|
| **payload** | accountId（必填）, messageId 或 headerMessageId（需配合 folderPath 若用 headerMessageId）；to 或 recipients（必填）；可选 subject, body, forward_mode（"inline"\|"attachment"）, dry_run。 |
| **result** | messageId, headerMessageId, forwardResult, stableIdentifiers。 |

### reply_message

回复一封邮件。可使用上下文的 accountId/identityId。

| 项目 | 说明 |
|------|------|
| **payload** | **目标**：messageId 或 headerMessageId（可选 folderPath）或 folderPath+subject。plainTextBody 或 body；可选 isPlainText（默认 true）, replyType（"replyToSender"\|"replyToList"\|"replyToAll"）。accountId 可选（用上下文）。 |
| **envelope.idempotency_key** | 可选。相同 key 重复请求时返回上次回复结果，不再真正发送（result 带 idempotent: true）。 |
| **result** | messageId, headerMessageId, replyResult, stableIdentifiers（含 sourceMessageId, sentHeaderMessageId 等）。 |

---

## 4. 推荐流程：多次相互邮件与按会话选一封

- **多轮往来**：每一轮「谁要回复」时，先 **switch_account_context** 到该账号；再确定「要回复的那封」：
  - 若已知 **headerMessageId**（例如上一轮 open_message 或 resolve_message 返回的），直接对 **reply_message** 传 headerMessageId（及 accountId、folderPath 若需）。
  - 若需「会话中某一封」：用 **resolve_message** 或 **open_message** 的 query（folderPath + subject + from + toDate/fromDate）定位一封，用返回的 **headerMessageId** 再调用 **reply_message**。
- **按会话（thread）选一封**：Thunderbird 当前无 threadId API，只能用 **folderPath + subject**（及可选 from、日期）查出一批，取**一条**（如第一条或按日期取最新）；用 **resolve_message** 得到该条的 **headerMessageId** 后用于 **reply_message**，可避免先打开再回复。
- **防重复回复**：对同一封邮件回复时，传相同的 **idempotency_key**（如 `reply-<headerMessageId>` 或业务单号），重复请求会直接返回上次结果。

---

## 5. 如何对接（Node + TypeScript 示例）

以下为最小对接方式：使用 `fetch` 调用 `/command`，并处理超时与错误。

```typescript
const BASE = "http://127.0.0.1:3939";
const DEFAULT_TIMEOUT_MS = 130000;

interface CommandResponse<T = unknown> {
  request_id: string;
  success: boolean;
  result?: T;
  error?: { code: string; message: string; details?: unknown };
}

async function command<T = unknown>(
  action: string,
  payload: Record<string, unknown>,
  options?: { requestId?: string; idempotencyKey?: string; timeoutMs?: number }
): Promise<CommandResponse<T>> {
  const requestId = options?.requestId ?? `cmd-${action}-${Date.now()}`;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${BASE}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: requestId,
        action,
        payload,
        ...(options?.idempotencyKey && { idempotency_key: options.idempotencyKey }),
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const data = (await res.json()) as CommandResponse<T>;
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${data.error?.message ?? res.statusText}`);
    }
    return data;
  } catch (e) {
    clearTimeout(timeout);
    if (e instanceof Error) {
      if (e.name === "AbortError") throw new Error("请求超时，请确认 minimal-server 与扩展已就绪");
      throw e;
    }
    throw e;
  }
}

// 示例：切换账号并解析一封邮件引用，再回复
async function example() {
  const switchRes = await command("switch_account_context", { email: "you@example.com" });
  if (!switchRes.success) throw new Error(switchRes.error?.message);

  const accountId = (switchRes.result as { accountId: string }).accountId;

  const resolveRes = await command("resolve_message", {
    accountId,
    folderPath: "INBOX",
    subject: "尽快处理问题",
  });
  if (!resolveRes.success) throw new Error(resolveRes.error?.message);

  const { headerMessageId } = resolveRes.result as { headerMessageId: string };

  const replyRes = await command(
    "reply_message",
    { accountId, headerMessageId, folderPath: "INBOX", plainTextBody: "知道了，3天内解决" },
    { idempotencyKey: `reply-${headerMessageId}` }
  );
  if (!replyRes.success) throw new Error(replyRes.error?.message);
}
```

- **request_id**：建议业务侧生成唯一 ID，便于日志与排查。
- **timeout**：服务端默认 120 秒，客户端建议略大（如 130 秒），避免先于服务端断开。
- **幂等**：对 send_email、reply_message 传 `idempotency_key` 即可由扩展保证同 key 不重复执行。

---

## 6. 故障排查

| 现象 | 可能原因 | 建议 |
|------|----------|------|
| 连接被拒绝 / ECONNREFUSED | minimal-server 未启动或端口不对 | 先执行 `node minimal-server/server.js`，确认端口 3939。 |
| HTTP 504 | 扩展未在时间内完成（如弹出发送确认、网络慢） | 延长 COMMAND_TIMEOUT_MS；或检查 Thunderbird 是否弹出需用户确认的对话框。 |
| success: false, error.code CONTEXT_NOT_SET | 未先切换账号或 payload 未带 accountId/identityId | 先调用 switch_account_context，或在 payload 中显式传 accountId/identityId。 |
| success: false, error.code NOT_FOUND | 账号/文件夹/邮件不存在或 query 无匹配 | 检查 accountId、folderPath、subject/from 等是否与 Thunderbird 中一致；收件箱是否已同步。 |
| 扩展无响应 | 扩展未加载或未启用 | 在 Thunderbird 附加组件中确认 Mail Automation Agent 已启用；修改代码后点击「重新加载」。 |
