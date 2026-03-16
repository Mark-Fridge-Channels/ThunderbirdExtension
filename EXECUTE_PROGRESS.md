# 方案 A 执行进度：扩展 fetch 本机服务 + 切换账号

| 步骤 | 状态 | 说明 |
|------|------|------|
| 1. 最小 HTTP 服务（/ping + 命令队列） | ✅ 完成 | minimal-server/server.js |
| 2. extension-fetch（host_permissions + 轮询） | ✅ 完成 | extension-fetch/manifest.json + background.js |
| 3. 实现 switch_account_context | ✅ 完成 | 在 background.js 中仅支持该 action |
| 4. 验证步骤文档与测试脚本 | ✅ 完成 | minimal-server/README.md + smoke_test.js |

**整体进度：100%**

## 使用步骤

1. 启动服务：`node minimal-server/server.js`
2. 在 Thunderbird 中从文件安装 **extension-fetch** 文件夹
3. 打开扩展调试控制台，确认出现 `GET /ping: 200`
4. 运行：`TEST_ACCOUNT_EMAIL=你的邮箱 node minimal-server/smoke_test.js`
