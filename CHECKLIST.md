# Thunderbird 插件检查清单（reference.md Workflow）

依据 [thunderbird-webextensions/reference.md](https://github.com/thunderbird/webextensions/blob/main/reference.md) 的 Workflow，在交付/提交前需逐项核对。

---

## 一、交付前代码验证（Step 3）

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 已查阅官方 API 文档，未猜测方法/参数 | ✅ | 使用 accounts, identities, folders, messages, compose, addressBooks, messageDisplay, runtime, storage |
| 未用 try-catch 猜测 API 参数 | ✅ | 无此类写法 |
| 解析使用 3rd 方库或 API 方法，尽量少用手写 regex | ✅ | vCard 用最小拼接；邮箱解析可用 messengerUtilities.parseMailboxString（未引入新库） |
| 使用的 3rd 方库为最新稳定版 | ✅ | 当前无 3rd 方库 |
| 事件监听在文件作用域注册（不在 init 内） | ✅ | onStartup、port.onMessage、port.onDisconnect 均在顶层或 connectToHost 内合理注册 |
| VENDOR.md 含所有依赖及**具体版本** URL | ✅ | VENDOR.md 已存在，当前无库，注明 vCard 为手写 |
| 使用 `browser_specific_settings`，未用废弃的 `applications` | ✅ | manifest 已用 gecko.id |
| 含合理错误处理 | ✅ | errors.js、handler 内校验与错误返回 |
| 有注释说明思路 | ✅ | 各层有简要注释 |
| 用户可见字符串未硬编码，使用 i18n | ⚠️ | 有 _locales/en、default_locale；扩展内 log 为开发用，若需上架可再补 i18n |
| 若有 _locales 则 manifest 有 default_locale | ✅ | 已设 default_locale: "en" |
| 满足 Add-on Review Requirements（见下） | ✅ | 无构建工具、有 VENDOR.md；未用 Experiments |
| 遵守「Important Guidelines for AI Assistants」 | ✅ | 无 applications、无 try-catch 猜 API、无多余 Experiment、用 storage 未用 fs |
| manifest 的 ID 唯一（UUID 或 @handle.thunderbird.local） | ✅ | mail_automation_agent@markbai.thunderbird.local |
| 若用 Experiments 则设 strict_max_version 限 ESR | ✅ | 未使用 Experiments，无需 strict_max_version |

---

## 二、第三方库审计（Step 4）

| Library | File | Module Type | Import Statement |
|---------|------|-------------|------------------|
| （无） | — | — | 当前无第三方 JS 库 |

- vCard：`add_contact` 使用手写最小 vCard 拼接（contactsAdapter.js）。若后续引入 ical.js，须在 VENDOR.md 写明**具体版本 URL**并补本表一行。

---

## 三、API 审计（Step 5）

| API 方法 | 返回类型 | 访问方式 | 所需权限 |
|----------|----------|----------|----------|
| browser.runtime.connectNative(application) | Port | port.onMessage / port.postMessage | nativeMessaging |
| browser.runtime.onStartup.addListener | — | — | — |
| browser.storage.session.get/set/remove | object / void | result.keyName | storage |
| browser.storage.local.get/set | object / void | result.keyName | storage |
| browser.accounts.list(includeSubFolders) | array of MailAccount | result[0] | accountsRead |
| browser.accounts.get(accountId, includeSubFolders) | MailAccount \| null | 直接使用 | accountsRead |
| browser.identities.list(accountId) | array of MailIdentity | result[0] | accountsRead |
| browser.identities.getDefault(accountId) | MailIdentity \| null | 直接使用 | accountsRead |
| browser.folders.query(queryInfo) | array of MailFolder | result[0] | accountsRead |
| browser.messages.query(queryInfo) | MessageList | result.messages | messagesRead |
| browser.messages.get(messageId) | MessageHeader | 直接使用 | messagesRead |
| browser.messages.update(messageId, newProperties) | void | — | messagesRead, messagesUpdate |
| browser.compose.beginNew(messageId?, details?) | Tab | tab.id | compose |
| browser.compose.beginForward(messageId, forwardType, details?) | Tab | tab.id | compose |
| browser.compose.getComposeDetails(tabId) | ComposeDetails | 直接使用 | compose |
| browser.compose.setComposeDetails(tabId, details) | void | — | compose |
| browser.compose.addAttachment(tabId, attachment) | ComposeAttachment | 直接使用 | compose |
| browser.compose.sendMessage(tabId, options?) | object (messages, mode, headerMessageId) | 直接使用 | compose.send |
| browser.messageDisplay.open(openProperties) | Tab | tab.id | messagesRead |
| browser.addressBooks.list(complete?) | array of AddressBookNode | result[0] | addressBooks |
| browser.addressBooks.contacts.list(parentId) | array of ContactNode | result[0] | addressBooks |
| browser.addressBooks.contacts.create(parentId, vCard) | string (contactId) | 直接使用 | addressBooks |

- **MessageList**：使用 `list.messages` 取数组，未直接解构。
- **HeadersDictionary**：键为小写，值为数组，用 `headers["header-name"][0]`。
- 当前 manifest 已包含上述所需权限，无需再增。

---

## 四、Add-on Review 要求（节选）

- **避免构建工具**：直接包含脚本，无 webpack/rollup 等。 ✅  
- **VENDOR.md**：记录所有第三方库及**具体版本**链接。 ✅（当前无库已说明）  
- **高级开发者**：若用 TypeScript/Node 构建，需走源码提交并附 DEVELOPER.md。本项目未使用。 ✅  

---

## 五、提交流程提示（Review Process Tips）

### 提交前

- [ ] 在**目标 Thunderbird 版本**及**最新 ESR** 上测试。

### 提交后

- [ ] 在附加组件列表页填写说明与截图，说明用途与用法。  
- [ ] 若做了本地化，列表页也做对应本地化。

### 审核中

- 及时回复审核意见。  
- 愿意说明架构与取舍。  
- 若使用 Experiments，愿意在要求时移除不必要部分。

---

## 六、本仓库当前待办（可选）

| 项 | 说明 |
|----|------|
| 图标 | manifest 未声明 icons / browser_action；若上架 ATN 建议补 16/32/48 等图标。 |
| i18n | 仅 name/description 用 _locales；若需多语言或上架可对更多字符串做 i18n。 |
| strict_max_version | 未使用 Experiments，无需设；若将来用 Experiment 需按 ESR 设 strict_max_version。 |

完成上述检查并打勾后，再打包提交；若任一项不通过，先修正再交付。
