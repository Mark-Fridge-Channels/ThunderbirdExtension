# 需求：发信/回信等失败时向外部程序提供最详细失败日志

**类型**：feature  
**优先级**：normal  
**预估**：medium  

---

## TL;DR

外部程序通过 `/command` 调用 send_email、reply_message、forward_message 时，若发生发信失败、回信失败等，需要拿到**最详细的问题日志**（例如邮箱不存在、被退回、SMTP 错误等），并通过现有外部 API 或新接口返回给调用方，便于自动化侧诊断与重试。

---

## 当前状态

- **同步失败**：`compose.sendMessage()` 在「发信到发件服务器失败」时会 **throw**（见 [Thunderbird compose API](https://webextension-api.thunderbird.net/en/mv3/compose.html)）。当前实现中，handler 的 catch 只把 `e?.message` 放进 `error.message`，以 `API_ERROR` 返回，**没有**区分失败类型（如邮箱无效、连接超时、认证失败等），也没有把原始错误对象或更多细节带给外部。
- **异步失败**：Thunderbird 提供 **`compose.onAfterSend`** 事件，在「发送成功或失败」时触发，`sendInfo.error` 为失败时的错误描述。当前扩展**未监听**该事件，因此「sendMessage 返回后、实际发信过程中失败」的情况无法反馈给外部程序；且即使监听，也需要把事件与某次 `/command` 的 `request_id` 关联起来，才能回传给正确的调用方。
- **退信 / 投递状态**：退信（bounce）通常由收件方服务器稍后发回一封退信邮件，属于**收件侧**信息。标准 WebExtension API 没有「投递状态」或「退信通知」的专门接口；要拿到退信原因，可能需要监控收件箱中的退信邮件或依赖 Experiment API，需单独调研。
- **对外暴露**：外部程序目前只能从 `POST /command` 的响应里拿到 `success: false` 与 `error: { code, message, details? }`，没有专门「失败日志」或「历史失败记录」查询接口。

---

## 期望结果

1. **同步失败**：在 send_email、reply_message、forward_message 的 catch 中，尽可能解析或保留更详细的失败信息（例如从异常中提取 SMTP 状态码、错误类型），通过现有 `error.details` 或扩展字段返回给外部，便于区分「邮箱找不到」「认证失败」「网络超时」等。
2. **异步失败**：监听 `compose.onAfterSend`，将 `sendInfo.error` 与对应请求关联（例如通过 tabId → request_id 的映射），在扩展侧暂存或通过某种方式通知外部程序（例如回调 URL、或新增「查询某 request_id 的发送结果」接口）。
3. **退信 / 投递**（若在范围内）：调研 Thunderbird 是否暴露退信或投递状态；若可获取，设计接口（如「按 headerMessageId 查询该封邮件的投递/退信状态」）并暴露给外部。
4. **对外形态**：在现有 `/command` 响应中增强 `error.details`；可选新增如 `GET /command/:request_id/result` 或 webhook 回调，用于异步发送结果与详细日志。

---

## 相关文件

- `extension/handlers/sendEmail.js` — 发信 catch 与返回结构
- `extension/handlers/replyMessage.js` — 回信 catch 与返回结构
- `extension/handlers/forwardMessage.js` — 转发 catch 与返回结构
- `extension/adapters/composeAdapter.js` — `createAndSend` / `replyToMessage` / `forwardMessage`，可在此或上层统一增强错误解析
- `extension/background/background.js` — 可在此注册 `compose.onAfterSend` 并维护 request_id 与 compose tab 的关联
- `extension/shared/errors.js` — 可扩展 `details` 结构（如 `smtpCode`, `phase`, `rawMessage`）
- `docs/EXTERNAL_API.md` — 需补充错误码与 failure details 说明；若新增查询/回调，需写清协议
- `minimal-server/server.js` — 若支持异步结果回调或查询接口，需扩展路由与存储

---

## 风险与备注

- **Thunderbird 错误形态**：`sendMessage()` 抛出的异常可能只是字符串或简单 Error，不一定带结构化 SMTP 码；需实测并视情况做字符串解析或保守地原样放入 `details.rawMessage`。
- **onAfterSend 与 request_id 关联**：由扩展触发的 compose 需在调用 `sendMessage` 前记录 `tabId → request_id`（及 action），在 onAfterSend 里用 tab 匹配并写入结果；要处理 tab 已关闭等边界情况。
- **退信**：标准 API 可能不提供「某封已发邮件的退信状态」；若需此能力，可能依赖 webext-experiments 或监控收件箱，实现成本与范围需单独评估。
- **外部调用方式**：若采用 webhook 回调，需考虑 minimal-server 与外部程序的网络可达性及安全；若采用轮询「按 request_id 查结果」，需在服务端或扩展侧保留一定时间的结果缓存。

---

## 验收

- [ ] 同步发信/回信/转发失败时，外部程序收到的 `error.details` 包含可用的详细信息（如 rawMessage 或解析后的类型/码）。
- [ ] 异步发信失败（onAfterSend 带 error）能被关联到对应 request_id，并通过约定方式（响应增强或新接口）提供给外部程序。
- [ ] 文档（EXTERNAL_API.md）中补充失败场景与错误码/细节说明。
- [ ] （可选）退信或投递状态若可实现，有设计说明或单独 issue 跟踪。
