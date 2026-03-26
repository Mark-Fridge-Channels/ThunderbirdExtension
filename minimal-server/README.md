# 方案 A：扩展 fetch 本机服务（无 Native Messaging）

## 0. Warmup Executor（Notion Queue → 扩展执行 → 回写）

> 目标：由 **minimal-server 自己轮询 Notion Queue**，把动作投递给扩展执行，并将结果回写 Notion。
> 外部程序不再需要读队列或调用 `/command`（`/command` 仍保留作手动调试入口）。

### 0.1 配置

1. 复制示例配置：

   ```bash
   cp minimal-server/config.example.json minimal-server/config.json
   ```

2. 编辑 `minimal-server/config.json`：

   - `notion.token`: Notion integration token（明文落盘在本机）
   - `notion.database_id`: Queue database_id
   - `executor.poll_interval_ms`: 默认 60000（60s）
   - `executor.page_size`: 默认 20
   - `executor.address_book_id`：Bridge V1 下 Notion 队列只做 **Send / Reply**，该项已无意义，可留空。

### 0.2 运行

```bash
node minimal-server/server.js
```

启动日志会打印已加载的配置摘要，并显示 executor 启动信息。

## 1. 最小验证（确认扩展能访问 127.0.0.1）

1. 启动本机服务：
   ```bash
   cd /path/to/ThunderbirdExtension
   node minimal-server/server.js
   ```
   应看到：`[minimal-server] listening on http://127.0.0.1:3939`

2. 在 Thunderbird 中加载扩展（临时选 **`extension`** 文件夹，或安装已打包的 **extension.xpi**）：
   - 附加组件与主题 → 扩展 → 从文件安装附加组件 → 选择 **`extension`** 文件夹或 `extension.xpi`。

3. 打开扩展的**调试/控制台**（该扩展右侧齿轮 → 调试 → 背景页/Event page）。

4. 看控制台是否出现 GET /ping 成功日志（如 `GET /ping: 200 ...`）  
   - **若出现**：方案 A 可行，可继续用下方「切换账号」测试。  
   - **若不出现**：Thunderbird 可能不允许扩展 fetch 127.0.0.1，需查 host_permissions 或 CSP。

## 2. Bridge V1：端到端探测（listAccounts）

1. 保持 `node minimal-server/server.js` 运行；Thunderbird 已加载扩展。
2. 另一终端：
   ```bash
   curl -s -X POST http://127.0.0.1:3939/command \
     -H "Content-Type: application/json" \
     -d '{"request_id":"test-1","action":"listAccounts","payload":{"includeSubFolders":true}}'
   ```
3. `success: true` 时 `result.accounts` 为账号树（含 `specialUse`）。完整 HTTP 测试见 `minimal-server/bridge_v1_test.js`。

## 3. 用 Node 脚本测试（可选）

```bash
node minimal-server/smoke_test.js
node minimal-server/bridge_v1_test.js
# 真实发信/移动邮件需设置 SEND_REAL=1，见 bridge_v1_test.js 文件头注释

# 发信 → 等待对方回信 → 自动 replyEmail（场景脚本，默认 AdrianZ@fcpartners.co ↔ oh.duang@gmail.com）
SEND_REAL=1 node minimal-server/bridge_v1_wait_reply_flow.js
```
