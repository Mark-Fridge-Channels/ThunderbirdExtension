# Feature Implementation Plan: Background 自动恢复（alarms）

**Overall Progress:** `0%`

## TLDR

在 Thunderbird 长期运行、无人为操作的前提下，当 MV3 的 background（Service Worker）被平台终止后，通过 **alarms API** 周期性（30 秒）唤醒并执行一次 poll，使扩展自动恢复拉取命令，无需用户重载。保留现有 setInterval 2s 轮询，运行中不触发重启。

## Critical Decisions

- **用 alarms 做唯一“跨进程”定时**：MV3 下 setInterval 随 Worker 终止而消失；只有 alarms 由平台在进程外调度，可到点唤醒 Worker。
- **periodInMinutes: 0.5（30 秒）**：满足「最多 30s 恢复」；若目标 Thunderbird 不支持 0.5，可改为 1 并实测。
- **保留 setInterval**：Worker 存活时仍每 2s 轮询；alarm 到点只多跑一次 poll，不改变“运行中”状态，不触发重启。
- **不写对外文档**：EXTERNAL_API 等不增加自动恢复说明。不改 minimal-server、不改协议。

## Tasks

- [ ] 🟥 **Step 1: manifest 增加 alarms 权限**
  - [ ] 🟥 在 `extension/manifest.json` 的 `permissions` 中加入 `"alarms"`。

- [ ] 🟥 **Step 2: background.js 接入 alarms**
  - [ ] 🟥 在脚本顶部增加常量（如 `ALARM_PERIOD_MINUTES = 0.5`），便于后续改为 1 做兼容。
  - [ ] 🟥 在顶层注册 `browser.alarms.onAlarm.addListener(callback)`；callback 内若 `alarm.name === "poll"` 则调用现有 `poll()`。
  - [ ] 🟥 在 `init()` 内首次完整执行分支（即通过 session 防重入后）：在 `setInterval` 之后，先 `browser.alarms.get("poll")`，若不存在则 `browser.alarms.create("poll", { periodInMinutes: ALARM_PERIOD_MINUTES })`。
  - [ ] 🟥 保持现有 `init` 防重入、`ping`、`setInterval(poll, POLL_MS)`、`onStartup` 与 `init()` 调用不变。

- [ ] 🟥 **Step 3: 自测与可选验证**
  - [ ] 🟥 在 Thunderbird 中重载扩展，确认无报错；确认 GET /next 仍每 2s 发生（setInterval 正常）。
  - [ ] 🟥 （可选）在目标 TB 版本上验证 `periodInMinutes: 0.5` 是否生效；若不生效则改为 `1` 并更新常量。
