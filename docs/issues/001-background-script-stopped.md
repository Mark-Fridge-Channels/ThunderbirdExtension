# 调研：组件加载后「后台脚本已停止」与后台常驻/唤醒方案

**类型**：improvement / 调研  
**优先级**：normal  
**预估**：medium  

---

## TL;DR

组件加载后出现「后台脚本已停止」的提示。需调研：这是否为 MV3 下 background（Service Worker）的正常行为，以及是否有办法让轮询逻辑持续可靠运行（常驻或定时唤醒）。

---

## 当前状态

- 用户/开发者看到 Thunderbird 扩展管理界面或调试信息中提示「后台脚本已停止」。
- 扩展使用 Manifest V3，`manifest.json` 中 `background.scripts: ["background/background.js"]`，即 background 以 **Service Worker** 形式运行。
- 当前实现：`background.js` 启动时 `ping` + 每 2s `setInterval(poll)` 轮询 `127.0.0.1:3939/next`。

## 期望结果

- **选项 A**：确认这是平台预期行为，在文档中说明「后台会在空闲时被终止，有新事件或下次被调用时会自动重启」，并验证轮询在重启后仍能通过现有 init 守卫正常恢复。
- **选项 B**：若业务需要「尽量持续轮询」，调研并实现一种可靠方案，例如：
  - 使用 `alarms` API 定时唤醒 background，在 alarm 回调里执行一次 poll 并再次设 alarm；
  - 或其它 Thunderbird MV3 官方推荐的「替代 setInterval 长驻」的方式。

---

## 相关文件

- `extension/manifest.json` — background 声明
- `extension/background/background.js` — 当前轮询与 init 逻辑
- （可选）Thunderbird MV3 官方文档中关于 background / Service Worker 生命周期的说明

---

## 风险与备注

- MV3 下 background 不保证常驻；`setInterval` 在 worker 被终止后会停止，下次启动依赖 `onStartup` 或其它事件重新执行 `init()`。
- 若采用 `alarms`，需注意最小间隔限制（通常 ≥ 1 分钟），与当前 2s 轮询的语义可能不同，需产品权衡（例如改为 1 分钟轮询 + 或由本地服务端提供长轮询/WebSocket）。
- 若 Thunderbird 对 MV3 background 有与 Chrome 不同的策略（例如更长存活时间），需在调研中一并记录。

---

## 验收

- [ ] 文档或代码注释中明确说明「后台脚本已停止」是否为预期现象及原因。
- [ ] 若采用新方案，轮询或定时拉取在 background 多次终止/重启后仍能可靠执行，且无重复 init（已有 session storage 守卫可复用）。
