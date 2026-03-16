# 方案 A：扩展 fetch 本机服务（无 Native Messaging）

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

## 2. 切换账号端到端测试

1. 保持 `node minimal-server/server.js` 运行；Thunderbird 已加载 **Mail Automation Agent** 扩展。
2. 在**另一终端**执行（把 `你的邮箱@example.com` 换成你在 TB 里配置的邮箱）：
   ```bash
   curl -s -X POST http://127.0.0.1:3939/command \
     -H "Content-Type: application/json" \
     -d '{"request_id":"test-1","action":"switch_account_context","payload":{"email":"你的邮箱@example.com"}}'
   ```
3. 响应应包含 `"success":true` 及 `result.accountId`、`result.folders` 等。  
   若长时间无响应，检查扩展控制台是否有错误；扩展每 2 秒轮询一次 `/next`，通常几秒内会取到命令并执行。

## 3. 用 Node 脚本测试（可选）

```bash
TEST_ACCOUNT_EMAIL=你的邮箱 node demos/smoke_test.js
# 或覆盖 6 个动作：
TEST_ACCOUNT_EMAIL=你的邮箱 node demos/smoke_all_actions.js
```
