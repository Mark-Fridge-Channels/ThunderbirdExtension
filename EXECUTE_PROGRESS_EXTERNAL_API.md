# 执行进度：幂等、resolve_message、外部 API 文档、demo 流程

| 步骤 | 状态 | 说明 |
|------|------|------|
| 1. reply_message 幂等 | ✅ 完成 | idempotency_key + storage.local 存/查，重复返回缓存 result |
| 2. resolve_message action | ✅ 完成 | handler + schema + router，只解析不打开，返回 messageId/headerMessageId |
| 3. docs/EXTERNAL_API.md | ✅ 完成 | 仅中文，协议/动作列表/推荐流程/Node+TS 对接示例/排查 |
| 4. demo 用 headerMessageId | ✅ 完成 | demo_flow 用 open 返回的 headerMessageId 做 star/reply，reply 带 idempotency_key |

**整体进度：100%**

## 附：minimal-server 与 envelope

- 服务端已支持将请求体中的 **idempotency_key** 一并放入队列并随 GET /next 返回给扩展，扩展 router 会传给 handler。
