# 探索：删除旧逻辑、补全所有动作、封装为可安装扩展

## 1. 需求理解

- **删除之前的代码逻辑**：去掉 Native Messaging 相关（native-host、bridge、extension 里 connectNative 等），只保留「扩展 ↔ minimal-server (fetch)」这一条链路。
- **补全所有动作**：当前 extension-fetch 仅实现 `switch_account_context`；需补全其余 5 个动作，并与现有 payload/result 约定一致。
- **封装成可以加载正常扩展**：从「临时从文件夹加载」改为可安装的 .xpi 包（或明确步骤），使扩展能像正式附加组件一样安装。

---

## 2. 现有代码结构概览

### 2.1 要删除或废弃的（Native 链路）

| 路径 | 说明 |
|------|------|
| `native-host/` | host.js、bridge.js、mail_automation_agent.json、run.sh、run_bridge.sh、protocol/*.json；Native Host 与桥接逻辑。 |
| `extension/background/background.js` | 使用 `connectNative("mail_automation_agent")` 接消息、交给 router，需整体替换为「轮询 minimal-server」的入口。 |
| `demos/smoke_test.js` | 当前若仍假设 Native Host 3939 的旧协议，可改为调用 minimal-server 的 POST /command（与 demo1 一致）。 |

### 2.2 要保留并复用的（业务逻辑）

| 路径 | 说明 |
|------|------|
| `extension/handlers/*.js` | 6 个 handler：switchAccount, sendEmail, openMessage, starMessage, addContact, forwardMessage。 |
| `extension/adapters/*.js` | accountsAdapter, messagesAdapter, composeAdapter, tabsAdapter, contactsAdapter。 |
| `extension/background/router.js` | 按 action 分发、校验 envelope/payload、调用 handler、返回统一响应。 |
| `extension/background/state.js` | 内存上下文 accountId/identityId；switch_account 写入，send_email/open/star/forward 读取。 |
| `extension/shared/schemas.js` | 各 action 的 payload 校验。 |
| `extension/shared/errors.js` | 错误码与 makeResponse。 |
| `extension/shared/logger.js` | auditLog 等（可选保留）。 |

### 2.3 已存在的方案 A 组件

| 路径 | 说明 |
|------|------|
| `minimal-server/server.js` | GET /ping, POST /command, GET /next, POST /done，CORS 已加。 |
| `extension-fetch/` | 当前仅 manifest + background.js，只处理 switch_account_context，且未维护 state（无 setContext）。 |

### 2.4 所有动作与依赖

| action | 依赖 API / 权限 | 依赖 context | payload 要点（见 schemas.js） |
|--------|-----------------|-------------|------------------------------|
| switch_account_context | accountsRead, folders | 写入 state | accountId / email / identityId 至少其一 |
| send_email | accountsRead, compose, compose.send, storage | 读 identityId/accountId | identityId 或 accountId, to, 可选 dry_run, idempotency_key |
| open_message | accountsRead, messagesRead, messageDisplay | 读 accountId | accountId, folderPath 或 headerMessageId/subject/from/to/日期 |
| star_message | accountsRead, messagesRead, messagesUpdate | 读 accountId | accountId, messageId 或 headerMessageId 或 folderPath+subject, 可选 starred |
| add_contact | addressBooks | 无 | email, addressBookId 或 parentId, 可选 displayName/company/phone/note |
| forward_message | accountsRead, messagesRead, compose, compose.send | 读 accountId/identityId | accountId, messageId 或 headerMessageId, to/recipients, 可选 forward_mode |

extension 的 manifest 已有：accountsRead, messagesRead, messagesUpdate, compose, compose.send, addressBooks, storage；无 messageDisplay 的显式权限（Thunderbird 中 messageDisplay 可能随 tabs 或默认可用，需确认）。extension-fetch 当前只有 accountsRead + storage + host_permissions。

---

## 3. 集成方式与约束

### 3.1 删除范围（建议）

- **删除整个 `native-host/` 目录**（或保留为归档，不再被调用）。
- **不再保留「两套扩展」**：只保留一套扩展代码，基于「fetch + minimal-server」的入口；原 `extension/` 中与 Native 相关的入口删除，业务逻辑（router、handlers、adapters、shared）迁入或复用。
- **二选一**：
  - **A**：**单一扩展目录**：把 extension-fetch 当作唯一扩展，把 extension 的 handlers、adapters、shared、state、router 迁入 extension-fetch（并补全 manifest 权限），然后删除 extension 的 background 里 connectNative，或直接删除整个 extension 目录，以 extension-fetch 为唯一扩展。
  - **B**：**保留 extension 目录**：在 extension 内把 background.js 改为「轮询 minimal-server」入口（不再 connectNative），删除 native-host；extension-fetch 可删除，避免两套代码。

推荐 **A**：单一扩展目录（extension-fetch 扩容为「完整扩展」），结构清晰，且与「方案 A」命名一致；原 extension 可归档或删。

### 3.2 补全动作的集成方式

- **extension-fetch** 的 background：保留「GET /ping、轮询 GET /next、POST /done」；对每条 command 调用**同一套** router + handlers。
- 需要：
  - 在 extension-fetch 中维护 **state**（setContext 在 switch_account 里调用，其他 handler 读 context）。
  - 在 extension-fetch 的 background 里引入 router（或等价的 dispatch），传入 envelope（request_id, action, payload）、context、idempotency_key；router 内部继续使用 extension 的 getValidator、handlers、makeResponse。
- **复用方式**：要么把 extension 的 handlers、adapters、shared、state、router 拷贝到 extension-fetch 并改成相对路径；要么用构建步骤从 extension 拷到 extension-fetch（不增加构建复杂度的话，直接拷贝/迁入即可）。

### 3.3 边界与注意事项

- **send_email / forward_message**：会打开撰写窗口并 sendMessage，用户可见；dry_run 仅不真正发送。
- **open_message**：依赖 messageDisplay.open，可能依赖 tabs 或默认权限。
- **add_contact**：addressBooks 权限；contacts 的 list/create 在 Thunderbird 中的权限名需与 manifest 一致。
- **幂等与审计**：send_email 的 idempotency_key 存 storage.local；auditLog 写 storage；保留现有行为即可。
- **错误格式**：所有 handler 返回 `{ success, result?, error? }`，error 为 `{ code, message, details? }`；makeResponse 包装为 `{ request_id, success, result, error }`，与 minimal-server 的 POST /done body 一致。

### 3.4 封装为「可正常加载的扩展」

- **当前**：临时加载 = 在 Thunderbird 里选「从文件安装附加组件」指向 **extension-fetch 文件夹**（含 manifest.json 的目录）。
- **目标**：能像正式附加组件一样安装，即生成 **.xpi**。
- **做法**：与现有项目约定一致（见 LOCAL_DEBUG.md）：在扩展根目录（即 extension-fetch）执行 `zip -r ../extension-fetch.xpi .`，得到 `extension-fetch.xpi`；安装时选「从文件安装」选该 .xpi。无需 AMO 签名即可本地安装。
- **可选**：在项目根加脚本（如 `scripts/build-xpi.sh`）自动打包；README 中说明「开发时临时加载 extension-fetch 目录，发布时安装 extension-fetch.xpi」。

---

## 4. 测试脚本

- **minimal-server** 已有 `minimal-server/smoke_test.js`（仅 switch_account）。
- **补全动作后**需要：
  - **各 action 单测**：对 6 个 action 分别有一个小脚本（或一个脚本里 6 个用例），每个用例：POST /command 带对应 action + payload，等待响应，断言 success 或预期 error。
  - **沿用现有 demos**：demo1_switch_and_send、demo2_open_and_star、demo3_add_contact 已用 POST /command 到 3939，与 minimal-server 协议一致；只需保证 minimal-server 与 extension（新入口）运行，demos 即可复用。若 demos 里还有对「旧 Native 协议」的假设，需改成仅用 POST /command。
- **建议**：在 `demos/` 或 `minimal-server/` 下提供 `smoke_all_actions.js`：依次 POST switch_account、send_email（dry_run）、open_message（可选，依赖有邮件）、star_message、add_contact、forward_message（dry_run 或跳过），并打印每步结果，便于回归。

---

## 5. 已确认的结论

### 5.1 你的选择（已确认）

1. **删除范围**：同意删除整个 `native-host/`，只保留一套扩展。
2. **扩展命名**：覆盖 —— 用 **extension** 作为唯一扩展目录（用 fetch 入口覆盖原 extension 内容），打包为 `extension.xpi`。即：不再保留 extension-fetch 目录，而是在 extension 内改为「轮询 minimal-server」入口，并保留/沿用 extension 内现有 handlers/adapters/shared/state/router。
3. **测试流程**：按照当前跑通的流程（minimal-server + POST /command）；demos/smoke_test 统一为只打 minimal-server 的 POST /command。
4. **测试覆盖**：测试需覆盖所有 6 个动作（需提供 smoke_all_actions.js 或等价脚本）。

### 5.2 messageDisplay 权限（调研结论）

- **结论**：**不需要**在 manifest 中单独声明 `messageDisplay` 或 `tabs`。
- **依据**：[Thunderbird messageDisplay API (MV3)](https://webextension-api.thunderbird.net/en/mv3/messageDisplay.html) 写明：*"The permission messagesRead is required to use messenger.messageDisplay.*"*
- **做法**：manifest 中保留 **messagesRead** 即可，open_message 使用的 `messageDisplay.open()` 即可用。与现有 extension 的 permissions（accountsRead, messagesRead, messagesUpdate, compose, compose.send, addressBooks, storage）一致即可，无需新增权限。

---

## 6. 实现阶段清单（探索完成后的执行项）

- [ ] **删除**：整个 `native-host/` 目录。
- [ ] **扩展入口**：在 `extension/background/background.js` 中移除 connectNative，改为「启动时 GET /ping，定时轮询 GET /next，收到命令后走 router → handler，最后 POST /done」；BASE URL 可配置或写死 `http://127.0.0.1:3939`。
- [ ] **manifest**：保留现有 permissions（accountsRead, messagesRead, messagesUpdate, compose, compose.send, addressBooks, storage），**移除** `nativeMessaging`；**新增** `host_permissions: ["http://127.0.0.1:3939/*"]`。名称/描述可改为「通过本地服务接收命令」等。
- [ ] **扩展 id**：可继续用 `mail_automation_agent@markbai.thunderbird.local`（与现有一致），或保持不改。
- [ ] **测试**：  
  - 将 `demos/smoke_test.js` 改为仅对 minimal-server 的 POST /command（若尚未统一）。  
  - 新增 **smoke_all_actions.js**（在 demos 或 minimal-server 下）：依次发送 6 个 action（switch_account、send_email dry_run、open_message、star_message、add_contact、forward_message dry_run 或占位），每步断言或打印结果，覆盖所有动作。
- [ ] **打包**：在 `extension` 目录执行 `zip -r ../extension.xpi .` 生成可安装的 extension.xpi；可选增加 `scripts/build-xpi.sh` 与 README 说明。
- [ ] **extension-fetch**：删除 extension-fetch 目录（逻辑已并入 extension），或保留为备份由你决定；文档中统一写「安装 extension.xpi 或临时加载 extension 目录」。
