# 执行进度：删除 Native、统一扩展、测试与打包

| 步骤 | 状态 | 说明 |
|------|------|------|
| 1. 删除 native-host/ | ✅ 完成 | 已移除 |
| 2. extension 改为 fetch 轮询 + router | ✅ 完成 | background.js 轮询 /next，调用 route()，POST /done |
| 3. manifest 更新（host_permissions，去掉 nativeMessaging） | ✅ 完成 | host_permissions 127.0.0.1:3939/*，已删 nativeMessaging |
| 4. demos/smoke_test.js 统一为 minimal-server | ✅ 完成 | 文案与错误提示已改为 minimal-server |
| 5. smoke_all_actions.js 覆盖 6 个动作 | ✅ 完成 | demos/smoke_all_actions.js，可选 env 控制跳过 |
| 6. build-xpi 脚本与说明 | ✅ 完成 | scripts/build-xpi.sh、README.md、minimal-server/README 更新 |
| 7. 删除 extension-fetch | ✅ 完成 | 逻辑已并入 extension，目录已删 |

**整体进度：100%**

## 使用摘要

- **安装扩展**：临时加载选 `extension` 目录，或执行 `./scripts/build-xpi.sh` 后安装 `extension.xpi`。
- **运行**：`node minimal-server/server.js`，再在 Thunderbird 中加载扩展。
- **测试**：`TEST_ACCOUNT_EMAIL=邮箱 node demos/smoke_test.js` 或 `node demos/smoke_all_actions.js`。
