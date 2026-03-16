# 邮件自动化执行引擎 — 系统设计说明

## 1. 目标与范围

实现一个**可编排的本地邮件执行引擎**：外部程序将任务下发给本地 HTTP 服务（minimal-server），扩展轮询该服务获取命令，调用 Thunderbird 官方 MailExtension API 执行动作，并将结构化结果回传。

- **不做**：GUI 坐标点击、UI 自动化。
- **优先**：官方 MailExtension API；仅在必要时补充 Experiment API。

## 2. 整体架构

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────────────────┐
│  外部程序        │────▶│  minimal-server       │◀────│  Thunderbird 插件           │
│  (POST /command) │     │  (127.0.0.1:3939)     │     │  background 轮询 /next      │
│                 │◀────│  GET /next, POST /done│────▶│  → router → handler → API   │
└─────────────────┘     └──────────────────────┘     └─────────────────────────────┘
```

- **通信**：外部程序 POST /command 到 minimal-server；扩展轮询 GET /next，执行后 POST /done。无 Native Messaging。
- **插件**：Manifest V3，background 为唯一命令入口；所有动作走「命令 → router → handler → adapter → Thunderbird API」四层，逻辑不堆在 background.js。

## 3. 层次划分

| 层 | 职责 | 产物 |
|----|------|------|
| **命令入口** | 接收 Native Message，反序列化，交给 router | background.js |
| **路由** | 按 action 分发到对应 handler，管理执行上下文 | router.js |
| **状态** | 当前 account/identity 上下文、幂等记录 | state.js |
| **Handler** | 参数校验、幂等判断、调用 adapter、组装统一 JSON 结果 | handlers/*.js |
| **Adapter** | 封装 Thunderbird API，返回稳定标识（accountId、folderPath、headerMessageId 等） | adapters/*.js |

## 4. 账号与上下文

- **账号切换**：不依赖前台窗口焦点；通过「当前执行上下文」在内存中保存 `accountId` / `identityId`；发信、查信、标星等均基于该上下文。
- **稳定标识**：不以 Thunderbird 内部 `messageId` 为长期主键；对外暴露 `accountId` + `folderPath` + `headerMessageId`（及可选 folderId）作为稳定引用。

## 5. 幂等与审计

- **幂等**：所有写操作支持幂等（如 idempotency_key 查重、先查再增联系人、标星前比较状态）。
- **审计**：发送邮件等关键操作写入 storage.local 审计日志（可扩展为仅 success/error 摘要 + request_id）。

## 6. 通信协议（Envelope）

- **请求**：`request_id`、`node_id`、`action`、`payload`、`idempotency_key`、`timestamp`。
- **响应**：`request_id`、`success`、`result` | `error`，结果内包含 `stable identifiers` 及 `details`。

## 7. 动作与 API 映射（概要）

| 动作 | 主要 API | 说明 |
|------|----------|------|
| switch_account_context | accounts.list/get, identities.get/list, folders.query | 解析 selector，设置上下文，返回文件夹信息 |
| send_email | compose.beginNew, setComposeDetails, sendMessage | identityId 指定发件身份，支持 dry_run、idempotency_key |
| open_message | messages.query, messageDisplay.open | 先按条件查消息，再 open(messageId/headerMessageId) |
| star_message | messages.get, messages.update(flagged) | 先解析 selector 得 messageId，再更新 flagged |
| add_contact | addressBooks.list, contacts.query/create | vCard 创建，先 query 查重 |
| forward_message | messages.get, compose.beginForward, setComposeDetails, sendMessage | 官方 compose 流程；不足处见 EXPERIMENT_BOUNDARY.md |

## 8. 技术约束

- 全部 async/await；handler 内参数与 schema 校验；错误标准化（shared/errors.js）。
- 不在 background 中堆积业务逻辑；不把 messageId 当长期主键；用户可见字符串走 i18n（本阶段可先占位）。

## 9. 扩展与后续

- 第二阶段：forward_message 完善、实验 API 补充、失败重试、批量任务、onNewMailReceived 等事件监听。
- Experiment API 边界见 `EXPERIMENT_BOUNDARY.md`。
