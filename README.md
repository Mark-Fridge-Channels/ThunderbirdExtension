# Mail Automation Agent (Thunderbird Extension)

通过本地 HTTP 服务（minimal-server）接收命令，在 Thunderbird 中执行切换账号、发信、打开/标星邮件、添加联系人、转发等动作。

## 安装扩展

- **开发**：Thunderbird → 附加组件 → 从文件安装附加组件 → 选择 **`extension`** 文件夹（内含 `manifest.json` 的那一层）。**修改扩展代码后必须重新加载**：在该扩展卡片上点击「重新加载」或重启 Thunderbird，否则仍会运行旧脚本。
- **发布/正式安装**：先打包再安装。在项目根目录执行：
  ```bash
  ./scripts/build-xpi.sh
  ```
  生成 **`extension.xpi`**，再在 Thunderbird 中选择「从文件安装附加组件」选中该 `.xpi` 文件。

## 运行前置条件

1. 启动本地服务（与扩展通信）：
   ```bash
   node minimal-server/server.js
   
   ```
2. 在 Thunderbird 中已加载本扩展（见上「安装扩展」）。

## 测试

- 最小链路：`TEST_ACCOUNT_EMAIL=你的邮箱 node demos/smoke_test.js`
- 覆盖 6 个动作：`TEST_ACCOUNT_EMAIL=你的邮箱 node demos/smoke_all_actions.js`（可选 env：`ADDRESS_BOOK_ID`、`TEST_SUBJECT`、`TEST_TO` 等，见脚本注释）
- Demo：`demos/demo1_switch_and_send.js`、`demo2_open_and_star.js`、`demo3_add_contact.js`

更多说明见 `minimal-server/README.md`。
