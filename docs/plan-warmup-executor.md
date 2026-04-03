# Feature Implementation Plan: Warmup Executor（Notion Queue → 扩展执行 → 回写）

**Overall Progress:** `100%`

## InteractionLOG schema alignment（2026-04）

- [x] 🟩 **OutReach Status**：通过 `executor.notion_property_names.Status` 映射写回；解析支持 `OutReach Status` / `Status` 别名。
- [x] 🟩 **Outreach Subject / Outreach Body / Action(Select)**：`parseQueueRow` 从列读取（兼容旧列名 Subject/Body）；Action 支持 Select + 旧 title/rich_text。
- [x] 🟩 **收信人**：`KeyPerson ID` relation → `GET /pages/{id}` 读 `Email`（Notion `email` 类型）；可选配置 `notion.key_person_database_id`（预留）。
- [x] 🟩 **依赖**：`depends_on_task_id` 存依赖页 `page.id`，`getPage` + 读 outreach 状态列。
- [x] 🟩 **入站回信**：`Reply Body` 列写入 `findMessages` body；`Payload` 仅线程元数据（无 `body`）；入站行同时写 `Outreach Subject` / `Outreach Body`（可配置）。
- [x] 🟩 **Notion 客户端**：新增 `getPage`。

## TLDR

在本项目的 `minimal-server` 内实现 Warmup Executor：每 60s 轮询 Notion Queue（database_id），筛选窗口内的 Pending+Keep 任务，按队列串行调用扩展 action（Send/Open/Reply/Star/Add Contact）并拿到执行结果后回写 Notion（Status/executed_at/execution_result_detail/external_event_id），从而移除「外部程序读队列→HTTP 调用→再回写」的链路。

## Critical Decisions

- **执行器放在 minimal-server**：minimal-server 直接读/写 Notion，并通过现有 GET /next ↔ POST /done 机制驱动扩展执行。
- **配置真源为 minimal-server 本地配置（明文落盘可接受）**：Notion token、database_id、addressBookId 等由 minimal-server 读取。
- **轮询 60s + page_size=20 + 方案 1**：databases.query 按 Execute Window 升序取一页，内存过滤窗口内候选并执行。
- **幂等用稳定 external_event_id**：例如 `exec-{taskId}-{planned_event_type}`；若该列已有值则视为已执行并跳过。
- **Add Contact 不新增扩展 action**：addressBookId 由 minimal-server 配置提供；缺失时回写 Failed（reason：`missing_address_book_id`）。

## Tasks

- [x] 🟩 **Step 1: 定义 minimal-server 配置与启动方式**
  - [x] 🟩 新增配置文件（`minimal-server/config.json`）与读取逻辑（token、database_id、addressBookId、pollInterval=60s、pageSize=20）
  - [x] 🟩 明确 Notion database URL → database_id 的输入方式（优先直接用 id；配置中填 `database_id`）
  - [x] 🟩 启动时打印有效配置概览（隐藏 token）

- [x] 🟩 **Step 2: 封装 Notion API 客户端（无额外复杂度）**
  - [x] 🟩 实现 `databases.query`（排序 Execute Window 升序、page_size=20）
  - [x] 🟩 实现 `pages.update` 回写（Status/executed_at/execution_result_detail/external_event_id）
  - [x] 🟩 处理 Notion API 错误（最小策略：记录并在下一轮继续）

- [x] 🟩 **Step 3: Queue 行解析与候选过滤**
  - [x] 🟩 解析 Notion properties（select/date range/rich_text/title，多 key 兼容）
  - [x] 🟩 内存过滤规则落地：planned_event_type 可解析、Status=Pending、audit_decision=Keep、Execute Window 命中
  - [x] 🟩 统一生成稳定 `external_event_id = exec-{taskId}-{planned_event_type}`

- [x] 🟩 **Step 4: processOne 执行管线（串行）**
  - [x] 🟩 已执行跳过：若 external_event_id 已有值则跳过不写回
  - [x] 🟩 依赖检查：按 depends_on_task_id 在同库按 Task ID query 取依赖 Status（missing/Cancelled/Failed → Failed；非 Sent → 跳过）
  - [x] 🟩 动作必填校验（Send/Reply/Open/Star/Add Contact），失败回写 Failed + reason
  - [x] 🟩 账号上下文：执行前投递 switch_account_context { email: actor_mailbox_id }
  - [x] 🟩 动作投递与结果等待：把 action 入 minimal-server 队列，等待扩展 POST /done 返回结果（或超时）
  - [x] 🟩 执行异常映射为 Failed（timeout/not_found/api_error/executor_exception 等写入 detail）

- [x] 🟩 **Step 5: 动作到扩展 action 的参数映射**
  - [x] 🟩 Send → send_email（to=counterparty_mailbox_id，subject/body→plainTextBody，isPlainText=true）
  - [x] 🟩 Reply → reply_message（headerMessageId=reply_to_message_id，folderPath=INBOX，plainTextBody/body）
  - [x] 🟩 Open → open_message（headerMessageId=reply_to_message_id；必要时可退化 subject/from）
  - [x] 🟩 Star → star_message（headerMessageId=reply_to_message_id，starred=true）
  - [x] 🟩 Add Contact → add_contact（email=counterparty_mailbox_id，addressBookId=配置项；缺失则 Failed: missing_address_book_id）

- [x] 🟩 **Step 6: Notion 回写格式与 reason 约定**
  - [x] 🟩 成功：Status=Sent + executed_at + execution_result_detail（含 action 结果关键字段）+ external_event_id
  - [x] 🟩 失败：Status=Failed + executed_at + execution_result_detail（含 reason/错误详情）+ external_event_id
  - [x] 🟩 reason 列表对齐文档（missing_dependency / missing_subject / timeout / api_error / missing_address_book_id 等）

- [x] 🟩 **Step 7: 运行与验证（最小化）**
  - [x] 🟩 增加 minimal-server 的「executor 主循环」入口（启动 server 同时启动轮询；缺配置时不启动 executor）
  - [x] 🟩 新增一个本地 smoke 脚本/说明：`node minimal-server/smoke_warmup_executor.js`（验证 Notion 查询 + 候选筛选）
  - [x] 🟩 更新/新增文档：`minimal-server/README.md` 已补充 Warmup Executor 配置与运行

- [x] 🟩 **Step 8: 兼容性与边界处理（不扩 scope）**
  - [x] 🟩 处理扩展 background 可能被终止的情况（依赖现有 alarms 恢复轮询；minimal-server 超时后标 Failed）
  - [x] 🟩 确保单轮串行执行，避免并发覆盖回写
  - [x] 🟩 日志包含 taskId / action / external_event_id / outcome / reason（每行处理打印一条；写回失败时 console.error）

## Post-review fixes (executed)

- **CRITICAL**：`POST /command` 先校验 envelope（action 必填），再唯一通过 `enqueueAndWait(envelope, res)` 响应，避免双写。
- **HIGH**：Notion 回写列名可配置（`executor.notion_property_names`），写回失败时打日志（taskId、pageId、error）。
- **HIGH**：Open/Star 在无 `reply_to_message_id` 时退化为 subject + from（Open）或 folderPath + subject（Star）；Queue 解析增加 `fromEmail`。
- **LOW**：Notion API 错误信息包含 `data.code`，便于排障。
- **Step 8**：每行处理打印一条对账日志（taskId、action、external_event_id、outcome、reason）。
