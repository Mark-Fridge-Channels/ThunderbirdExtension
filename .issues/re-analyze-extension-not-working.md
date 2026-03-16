# 重新分析扩展「不可用」问题

**Type:** improvement  
**Priority:** normal  
**Effort:** medium  

---

## TL;DR

在现有 [ANALYSIS_WHY_NOT_WORKING.md](../ANALYSIS_WHY_NOT_WORKING.md) 基础上，重新做一轮问题分析：确认根因是否仍为 Native Host / macOS 沙箱，或是否有新现象、新环境需要纳入，并给出可执行的结论与后续动作。

---

## Current state

- 已有分析文档：与 webext-examples 对照后，结论是「扩展写法无问题，不可用主因在 Native Host 环境（尤其 macOS 沙箱）」。
- 若实际现象与文档不符（例如：已用 `MOZ_DISABLE_UTILITY_SANDBOX=1` 仍不可用、或出现新报错），当前分析可能不完整或需更新。

---

## Expected outcome

- 重新梳理「不可用」的**具体表现**（安装失败 / 控制台报错 / 3939 连不上 / 某 action 无响应等）。
- 确认或修正根因（Native Host 注册、沙箱、TB 版本、manifest/路径等）。
- 更新 ANALYSIS_WHY_NOT_WORKING.md（或 LOCAL_DEBUG.md）中的结论与排查步骤，使后续排查可复现、可执行。

---

## Relevant files

- `ANALYSIS_WHY_NOT_WORKING.md` — 主分析结论，需根据 re-analysis 更新
- `LOCAL_DEBUG.md` — 排查步骤，若根因/步骤有变需同步
- `native-host/host.log`、`extension/background/background.js` — 现象与入口，分析时需参考

---

## Notes / risk

- 若问题与平台/环境强相关（如仅 macOS、仅某 TB 版本），请在分析中注明环境与复现条件。
- 避免只更新文档而不做一次实际验证（至少一次 smoke_test 或等价操作）。
