# 使用与测试指南

本文说明：如何把组件跑起来（含 macOS 沙箱）、如何调用、以及如何做最小测试和完整 demo。

---

## 一、如何跑起来

### 1. 安装插件

- 打开 Thunderbird → **附加组件与主题** → **扩展** → **从文件安装附加组件**。
- 选择项目里的 **`extension.xpi`**（在项目根目录），完成安装并启用「Mail Automation Agent」。

### 2. 注册 Native Host（仅首次）

在终端执行（把路径改成你的项目路径）：

```bash
cd /Users/markbai/Documents/ThunderbirdExtension
# 确认 native-host/mail_automation_agent.json 里的 path 指向 run.sh 的绝对路径
mkdir -p "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
cp native-host/mail_automation_agent.json "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts/"
chmod +x native-host/run.sh
```

### 3. 启动 Thunderbird 并让 3939 可用

**macOS**：由 Thunderbird 拉起的 Host 无法在本机绑定 3939（与 `MOZ_DISABLE_UTILITY_SANDBOX` 无关，因 Native Host 不是 Utility Process）。需先启动 **桥接**，再启动 Thunderbird：

```bash
# 终端 1：启动桥接（保持运行）
cd /path/to/ThunderbirdExtension
node native-host/bridge.js
# 或: ./native-host/run_bridge.sh
```

看到 `[bridge] HTTP listening on http://127.0.0.1:3939/command` 后，用任意方式启动 Thunderbird；Host 在监听失败时会自动连接桥接，3939 由桥接提供。

**Linux/Windows**：无需桥接，直接启动 Thunderbird 即可，Host 会直接监听 3939。

### 4. 触发插件连接

- 打开一次 **附加组件与主题** 或任意邮箱窗口，让插件 background 执行。
- 扩展会 `connectNative("mail_automation_agent")`，Thunderbird 会拉起 Host；**macOS** 上 Host 会连到桥接的 3940，**Linux/Windows** 上 Host 直接监听 **127.0.0.1:3939**。

### 5. 确认 3939 在监听

```bash
lsof -i :3939
```

若有 `node` 在监听，说明可以开始调用。

---

## 二、如何调用组件

**入口**：所有命令都通过 **HTTP POST** 发到：

- **URL**：`http://127.0.0.1:3939/command`
- **Content-Type**：`application/json`
- **Body**：一个 JSON 对象（envelope），至少包含 `request_id`、`action`、`payload`。

**请求体格式：**

```json
{
  "request_id": "唯一请求 id，用于关联响应",
  "action": "动作名",
  "payload": { ... }
}
```

可选：`idempotency_key`（幂等键）、`timestamp`、`node_id`。

**响应格式：**

```json
{
  "request_id": "与请求一致",
  "success": true,
  "result": { ... }
}
```

或失败时：

```json
{
  "request_id": "...",
  "success": false,
  "error": { "code": "...", "message": "..." }
}
```

**调用方式**：任意能发 HTTP POST 的工具或语言均可，例如：

- 终端：`curl`
- Node：`fetch()` 或 `axios`
- Python：`requests.post(...)`
- 其他：任何 HTTP 客户端

---

## 三、各动作的调用示例

以下 `curl` 均需把 **`你的邮箱@example.com`**、**`收件人@example.com`** 等换成你在 Thunderbird 里真实存在的邮箱或参数。

### 1. switch_account_context（切换执行账号）

**作用**：设置“当前账号/身份”，后续发信、查信等会基于该上下文。返回该账号的 accountId、identityId、文件夹列表。

```bash
curl -s -X POST http://127.0.0.1:3939/command \
  -H "Content-Type: application/json" \
  -d '{
    "request_id": "req-1",
    "action": "switch_account_context",
    "payload": { "email": "你的邮箱@example.com" }
  }'
```

也可用 `accountId` 或 `identityId`：`"payload": { "accountId": "xxx" }`。

---

### 2. send_email（发信）

**作用**：用当前上下文身份发一封邮件。支持 `dry_run`（只打开撰写窗口不发送）、`idempotency_key`（防重复）。

**注意**：先发一次 `switch_account_context`，或 payload 里带 `identityId`/`accountId`。

```bash
curl -s -X POST http://127.0.0.1:3939/command \
  -H "Content-Type: application/json" \
  -d '{
    "request_id": "req-2",
    "action": "send_email",
    "payload": {
      "to": "收件人@example.com",
      "subject": "测试主题",
      "plainTextBody": "正文内容",
      "isPlainText": true,
      "dry_run": false
    }
  }'
```

`dry_run: true` 时只打开撰写窗口，不真正发送。

---

### 3. open_message（打开邮件）

**作用**：按条件查出一封邮件并在新标签/窗口打开。需指定账号（或先 `switch_account_context`）。

```bash
curl -s -X POST http://127.0.0.1:3939/command \
  -H "Content-Type: application/json" \
  -d '{
    "request_id": "req-3",
    "action": "open_message",
    "payload": {
      "accountId": "可选，不填则用当前上下文",
      "folderPath": "INBOX",
      "subject": "邮件主题里包含的文字",
      "open_mode": "tab"
    }
  }'
```

`open_mode` 可为 `tab` 或 `window`。

---

### 4. star_message（标星/取消标星）

**作用**：对一封邮件设置或取消“星标”（flagged）。

```bash
curl -s -X POST http://127.0.0.1:3939/command \
  -H "Content-Type: application/json" \
  -d '{
    "request_id": "req-4",
    "action": "star_message",
    "payload": {
      "accountId": "可选",
      "folderPath": "INBOX",
      "headerMessageId": "<某封邮件的 Message-ID>",
      "starred": true
    }
  }'
```

也可用 `messageId` 或 `subject` 等定位邮件。

---

### 5. add_contact（添加联系人）

**作用**：在指定通讯录中创建联系人（先按 email 查重，已有则返回已有 contactId）。

```bash
curl -s -X POST http://127.0.0.1:3939/command \
  -H "Content-Type: application/json" \
  -d '{
    "request_id": "req-5",
    "action": "add_contact",
    "payload": {
      "addressBookId": "通讯录 ID（从 Thunderbird 调试里 browser.addressBooks.list() 获取）",
      "email": "new@example.com",
      "displayName": "显示名",
      "company": "公司",
      "note": "备注"
    }
  }'
```

---

### 6. forward_message（转发邮件）

**作用**：按 messageId 或 headerMessageId 找到邮件并转发给指定收件人。

```bash
curl -s -X POST http://127.0.0.1:3939/command \
  -H "Content-Type: application/json" \
  -d '{
    "request_id": "req-6",
    "action": "forward_message",
    "payload": {
      "accountId": "可选",
      "headerMessageId": "<原邮件 Message-ID>",
      "to": ["转发收件人@example.com"],
      "forward_mode": "inline",
      "dry_run": false
    }
  }'
```

`forward_mode`：`inline` 或 `attachment`。

---

## 四、测试步骤（推荐顺序）

### 步骤 0：确认 3939 已监听

```bash
lsof -i :3939
```

无输出则先按「一、如何跑起来」在 macOS 上启动 `node native-host/bridge.js` 再启动 Thunderbird 并触发插件。

---

### 步骤 1：最小测试（只测“切换账号”）

不发信、不改邮件，只验证「你的程序 → Host → 插件 → Thunderbird」是否通。

```bash
cd /Users/markbai/Documents/ThunderbirdExtension
export TEST_ACCOUNT_EMAIL=你的邮箱@example.com
node demos/smoke_test.js
```

成功时会打印 `success: true` 和 accountId、folders 数量。

---

### 步骤 2：发信测试（可选 dry_run）

```bash
export TEST_ACCOUNT_EMAIL=你的邮箱@example.com
export TEST_TO=收件人@example.com
# 先试 dry_run（只打开撰写窗口）
DRY_RUN=1 node demos/demo1_switch_and_send.js
# 确认无误后真正发送（去掉 DRY_RUN）
node demos/demo1_switch_and_send.js
```

---

### 步骤 3：打开邮件并标星

```bash
export TEST_ACCOUNT_EMAIL=你的邮箱@example.com
export TEST_SUBJECT=某封邮件主题里包含的文字
node demos/demo2_open_and_star.js
```

---

### 步骤 4：添加联系人

需先拿到一个 `addressBookId`（在扩展调试控制台执行 `browser.addressBooks.list()` 看返回里的 `id`）。

```bash
export ADDRESS_BOOK_ID=你的通讯录ID
export CONTACT_EMAIL=new@example.com
export CONTACT_NAME=测试联系人
node demos/demo3_add_contact.js
```

---

## 五、用 curl 做一次完整调用示例

下面是一条从「切换账号」到「发信」的完整 curl 调用（把邮箱换成你的）：

```bash
# 1. 切换账号
curl -s -X POST http://127.0.0.1:3939/command \
  -H "Content-Type: application/json" \
  -d '{"request_id":"r1","action":"switch_account_context","payload":{"email":"你的邮箱@example.com"}}'

# 2. 发信（使用上一步的上下文）
curl -s -X POST http://127.0.0.1:3939/command \
  -H "Content-Type: application/json" \
  -d '{
    "request_id":"r2",
    "action":"send_email",
    "payload":{
      "to":"收件人@example.com",
      "subject":"curl 测试",
      "plainTextBody":"来自 USAGE_AND_TEST 的测试",
      "isPlainText":true,
      "dry_run":true
    }
  }'
```

`dry_run: true` 时只会打开撰写窗口，不会真正发送；改为 `false` 即真实发送。

---

## 六、小结

| 步骤       | 做什么 |
|------------|--------|
| 安装插件   | 从 `extension.xpi` 安装并启用 |
| 注册 Host  | 复制 `mail_automation_agent.json` 到系统目录，`chmod +x run.sh` |
| 启动 TB（macOS） | 先运行 `node native-host/bridge.js`，再启动 Thunderbird |
| 触发连接   | 打开附加组件或邮箱；macOS 上 Host 会连到桥接 3940，3939 由桥接监听 |
| 调用组件   | 对 `http://127.0.0.1:3939/command` 发 POST，body 为 `{ request_id, action, payload }` |
| 测试       | 先跑 `smoke_test.js`，再按需跑 demo1/demo2/demo3 或直接用 curl |

macOS 上由 TB 拉起的 Host **无法绑定 3939**，需先运行 **bridge**（`node native-host/bridge.js`），再启动 Thunderbird，外部仍访问 3939（由桥接转发）。
