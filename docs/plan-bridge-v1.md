# Bridge V1 — 实施追踪

协议：仅支持驼峰 `listAccounts` / `sendEmail` / `replyEmail` / `findMessages` / `restoreToInbox`；Node 经 `POST http://127.0.0.1:3939/command` 调用。

## 进度

| 项 | 状态 | 说明 |
|---|------|------|
| 扩展 manifest `messagesMove` | 🟩 完成 | `extension/manifest.json` |
| 归一化与五 handler | 🟩 完成 | `extension/shared/bridgeNormalize.js`, `extension/handlers/*.js` |
| schema + router | 🟩 完成 | `extension/shared/schemas.js`, `extension/background/router.js` |
| 移除旧 action / 适配层 | 🟩 完成 | 旧 handlers/adapters 已删 |
| Notion executor 对齐 V1 | 🟩 完成 | `minimal-server/executor.js`（Send/Reply；队列仅支持二者） |
| InteractionLOG 规则对齐 | 🟩 完成 | `Status=Todo/Progress/Success/Failed`、`Platform=Email`、`InNOut=Out`、`FCAccount` 本机过滤、窗口兼容（Execute Window 或 Trigger+10min） |
| 常驻回信监听 | 🟩 完成 | `startExecutor` 同步轮询 Inbound：检测到回复后自动新增 `In` 记录并把 Out 的 `Reply Status` 置为 `Done` |
| HTTP 测试脚本 | 🟩 完成 | `minimal-server/smoke_test.js`, `minimal-server/bridge_v1_test.js` |
| 等回信后自动 replyEmail | 🟩 完成 | `minimal-server/bridge_v1_wait_reply_flow.js` |

**总体进度：100%**

## 测试命令

```bash
node minimal-server/server.js
# 另开终端
node minimal-server/smoke_test.js
node minimal-server/bridge_v1_test.js
# 危险操作需 SEND_REAL=1，见 bridge_v1_test.js 头部说明

# 先发信再等人回复后自动回信：bridge_v1_wait_reply_flow.js
```
