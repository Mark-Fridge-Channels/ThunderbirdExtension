# Mail Automation Agent (Thunderbird Extension)

通过本地 HTTP 服务（minimal-server）接收命令，在 Thunderbird 中执行切换账号、发信、打开/标星邮件、添加联系人、转发等动作。

**独立收信扩展**：`tb-active-receiver/` 为单独的 MailExtension + Experiment（`TB Active Receiver`），只负责账号发现、定时/手动触发原生收信、`onNewMailReceived` 回信线索与可选 HTTP 上报；与发信桥接（`extension/`）物理分离。打包：`./scripts/build-tb-active-receiver-xpi.sh` → `tb-active-receiver.xpi`。

## 安装扩展

- **开发**：Thunderbird → 附加组件 → 从文件安装附加组件 → 选择 **`extension`** 文件夹（内含 `manifest.json` 的那一层）。**修改扩展代码后必须重新加载**：在该扩展卡片上点击「重新加载」或重启 Thunderbird，否则仍会运行旧脚本。
- **发布/正式安装**：先打包再安装。在项目根目录执行：
  ```bash
  ./scripts/build-xpi.sh
  ```
  生成 **`extension.xpi`**（以及带版本号的 **`extension-<x.y.z>.xpi`**），再在 Thunderbird 中选择「从文件安装附加组件」选中该 `.xpi` 文件。

### 版本号与 `updates.json`

每次执行打包脚本都会：将对应 `manifest.json` 的 **patch 版本 +1**（`x.y.z`）、写入 `browser_specific_settings.gecko.update_url`，并在仓库根目录 **`updates.json`** 里追加该扩展的 `update_link`（指向 GitHub Releases 上的同名 `.xpi` 资源 URL）。

### 推送到 GitHub Releases

默认 **`PUBLISH_MODE=2`**：在生成 `.xpi` 后会 **提交** `manifest.json` 与 `updates.json`、**推送**当前分支，并用 **`gh`** 创建或更新对应 **GitHub Release** 资产。需已安装并登录 [GitHub CLI](https://cli.github.com/)，且当前分支不是 detached HEAD。

若只想本机打包、**不** commit / push / Release：

```bash
PUBLISH_MODE=0 ./scripts/build-xpi.sh
# 独立收信扩展：
PUBLISH_MODE=0 ./scripts/build-tb-active-receiver-xpi.sh
```

`updates.json` 里的 `update_url` 指向的 raw 分支默认为 **`notion-brain-real-email`**；若需与当前发布分支一致，可设置环境变量 **`RELEASE_BRANCH`**（与 `scripts/build-xpi.sh` 内逻辑一致）。

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
