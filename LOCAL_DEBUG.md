# 本地调试步骤

**若要「如何测试、如何使用、如何调用」的完整步骤与 curl/Node 示例，请直接看 [USAGE_AND_TEST.md](USAGE_AND_TEST.md)。** 下文侧重安装、注册、沙箱与排错。

### 关于「没有找到 Service Worker」

Thunderbird 的 MV3 使用**事件页（event page）**，不是 Chrome 那种 Service Worker，所以调试界面里出现「没有找到 Service Worker」是**正常**的。本扩展按 [Thunderbird 规范](https://developer.thunderbird.net/add-ons/about-add-ons) 使用 **background.scripts + type: "module"**（与 [webext-examples](https://github.com/thunderbird/webext-examples/tree/master/manifest_v3) 一致）：
- 在 **附加组件与主题 → 扩展 → Mail Automation Agent** 右侧点 **齿轮 → 调试**（或「Inspect」）。
- 若列表里有 **「背景页」/「Background page」/「Event page」** 等入口，点进去即可看到背景脚本的控制台。
- 若只看到「没有找到 Service Worker」且没有其他可选项，说明当前事件页处于休眠；先做一步会唤醒插件的操作（如打开附加组件、点进邮箱），再重新点一次「调试」，或点扩展的「重新加载」后立刻点「调试」。

## 1. 安装插件（临时加载）

1. 打开 Thunderbird → 菜单 → 附加组件与主题 → 扩展。
2. 点击「从文件安装附加组件」：
   - **推荐**：选择项目根目录下已打包好的 **`extension.xpi`** 文件（用本仓库根目录的 `extension.xpi`，不要自己用「右键压缩」打包，否则可能报 corrupt）。
   - 若选文件夹：必须选 **`extension`** 这一层（即里面直接有 `manifest.json` 的那一层），不要选上一级 `ThunderbirdExtension`。
3. 若提示“无法加载”，检查 manifest 中 `browser_specific_settings.gecko.strict_min_version` 与当前 Thunderbird 版本兼容（建议 128+）。

### 若报错「this add-on could not be installed because it appears to be corrupt」

- **选错目录**：选成了 `ThunderbirdExtension` 而不是 `extension`，导致根目录没有 `manifest.json`。请改选 `extension` 文件夹，或直接安装根目录下的 **`extension.xpi`**。
- **自己打的 zip 不对**：zip 里必须是「打开后第一层就是 manifest.json」，不能是「一个 extension 子文件夹再里面才是 manifest」。建议用仓库里的 `extension.xpi`，或进入 `extension` 目录后执行：`zip -r ../extension.xpi .` 再安装生成的 `extension.xpi`。
- **Thunderbird 版本过旧**：本插件要求 128.0+。若版本低于 128，请升级 Thunderbird 后再试。

## 2. 注册 Native Messaging Host

插件通过 `connectNative("mail_automation_agent")` 连接本地 host，需在系统里注册该 host。

### macOS

1. 创建 manifest 文件（若不存在）：
   - 路径：`~/Library/Application Support/Mozilla/NativeMessagingHosts/mail_automation_agent.json`
2. 使用 **`run.sh`** 作为可执行入口（这样从 Dock 启动 Thunderbird 时也能找到 node）：`path` 填 `run.sh` 的**绝对路径**，例如：
   - `"path": "/Users/yourname/Documents/ThunderbirdExtension/native-host/run.sh"`
3. 复制到系统目录：
   ```bash
   mkdir -p "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
   cp native-host/mail_automation_agent.json "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts/"
   ```
4. 确保可执行：`chmod +x native-host/run.sh`（`run.sh` 会再去执行 `host.js`）
5. Host 依赖 Node.js，系统需已安装 `node`。

### Linux

- 目录：`~/.mozilla/native-messaging-hosts/` 或发行版约定目录。
- 同上，将 `mail_automation_agent.json` 放到该目录，`path` 指向绝对路径的 `host.js`。

### Windows

- 注册表或约定目录，参见 [Chrome Native Messaging - Native host location](https://developer.chrome.com/docs/apps/nativeMessaging/#native-messaging-host-location)（Thunderbird 类似）。
- `path` 可指向 `node.exe` 与脚本，例如：`"path": "C:\\Node\\node.exe"`，`"args": ["C:\\path\\to\\host.js"]`（若支持 args）。

## 3. 启动与验证

1. 启动 Thunderbird，并打开一次「附加组件」或任意会唤醒 background 的操作，使插件 background 执行。
2. Background 会调用 `connectNative("mail_automation_agent")`，Thunderbird 会**自动启动** Native Host（通过 `native-host/run.sh` 调用 `node host.js`）。
3. Host 启动成功后，本机 3939 端口会开始监听；可用 `lsof -i :3939` 或 `curl -X POST http://127.0.0.1:3939/command ...` 验证。
4. **若 3939 一直没起来**（但扩展控制台显示 “native port connected”），说明 Host 被 Thunderbird 拉起了，但可能没成功监听 3939 或随后退出了。请查 **Host 日志**：
   - Host 会把关键信息写到 **`native-host/host.log`**（与 host.js 同目录；可通过环境变量 `MAIL_AGENT_LOG` 改路径）。
   - 完全退出 Thunderbird 后重新打开，再在终端执行：  
     `cat /Users/markbai/Documents/ThunderbirdExtension/native-host/host.log`  
     看是否有 `host started`、`HTTP server listening on 127.0.0.1:3939`，或 `HTTP server error: ...` / `uncaughtException: ...`。把最后几行贴出来便于排查。
   - **先确认 Host 本身能跑**：在终端执行  
     `cd /Users/markbai/Documents/ThunderbirdExtension && ./native-host/run.sh`  
     再开另一个终端执行 `lsof -i :3939`。若有 node 在监听 3939，说明 run.sh 和 host.js 正常；用 Ctrl+C 关掉刚才的 run.sh 再继续。
   - 修改过 native host manifest 后务必 **完全退出 Thunderbird 再启动**（否则仍用旧 path）。

### 3.1 问题原因分析：macOS 上 3939 不监听

在 macOS 上，Thunderbird 通过 **Subprocess**（posix_spawn）启动 Native Messaging Host，**不是** Utility Process。因此：

- **`MOZ_DISABLE_UTILITY_SANDBOX=1` 对 Native Host 无效**（该变量只影响 Utility Process，见 [UtilityProcessHost](https://searchfox.org/mozilla-central/source/ipc/glue/UtilityProcessHost.cpp)）。即使用「直接运行可执行文件」方式启动 Thunderbird，由 TB 拉起的 Host 进程仍可能无法绑定端口（受系统/TCC 等限制），3939 依然监听不到。
- **扩展侧**：`connectNative()` 成功，控制台显示 “native port connected”（Host 进程已启动并接好 stdin/stdout）。
- **Host 侧**：`server.listen(3939)` 失败，故 `lsof -i :3939` 看不到。

**可行做法（macOS 推荐）：用桥接进程**

- **做法 A（推荐）**：使用项目自带的 **bridge（桥接）**：由**你**在终端先启动桥接，再正常启动 Thunderbird（Dock 或任意方式均可）。Host 在 `listen(3939)` 失败时会**自动**尝试连接桥接的 3940 端口；外部程序仍访问 **3939**（桥接在此提供 HTTP）。

  1. 在一个终端里运行桥接（保持运行）：
     ```bash
     cd /Users/markbai/Documents/ThunderbirdExtension
     node native-host/bridge.js
     ```
     看到 `[bridge] HTTP listening on http://127.0.0.1:3939/command` 和 `[bridge] listening for host on 127.0.0.1:3940` 即表示就绪。
  2. 启动 Thunderbird（任意方式），并触发一次扩展加载（如打开「附加组件」）。
  3. 桥接终端里应出现 `[bridge] host connected`；此时 `lsof -i :3939` 会看到 node（bridge），外部对 `http://127.0.0.1:3939/command` 的 POST 会经桥接转发到 Host → 扩展。

  **Linux/Windows**：无需桥接，Host 可直接监听 3939，按原有步骤即可。

- **做法 B（仅 Linux/Windows 或 TB 从终端直接启动且端口可用时）**：若 Host 能成功 `listen(3939)`（例如在 Linux 上），则不必运行 bridge，外部直接访问 3939。

## 4. 流程测试：外部程序 → 组件 → 客户端

整条链路是：**你的脚本/程序** → HTTP 到 **Native Host (host.js)** → Native Messaging → **Thunderbird 插件** → Thunderbird API（读账号、发信等）。

### 4.1 前置条件（按顺序做）

1. **启动 Thunderbird**，并确认「Mail Automation Agent」插件已启用。
2. **触发一次插件 background**：例如打开一次「附加组件与主题」或任意邮箱窗口，让 background 执行并调用 `connectNative()`。
3. **Native host 被 Thunderbird 拉起**：host 进程由 Thunderbird 启动，并在本机开 HTTP 服务。  
   - 若你曾用终端单独跑过 `node native-host/host.js`，请关掉那个进程，改由 Thunderbird 拉起（这样 stdin/stdout 才和插件连通）。
4. **确认 3939 端口在监听**（可选）：
   ```bash
   lsof -i :3939
   # 或
   curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3939/command
   # 若连不上会报 Connection refused，连上但 POST 不对会 404
   ```

### 4.2 最小验证（只测「切换账号」）

用 **curl** 或 **Node 烟雾脚本** 发一条 `switch_account_context`，不改邮件、不发信，只验证链路是否通。

**方式 A：curl（把 `你的邮箱@example.com` 换成你在 Thunderbird 里配置过的邮箱）**

```bash
curl -s -X POST http://127.0.0.1:3939/command \
  -H "Content-Type: application/json" \
  -d '{"request_id":"test-1","action":"switch_account_context","payload":{"email":"你的邮箱@example.com"}}'
```

若返回的 JSON 里 `success: true`，且含 `result.accountId`、`result.folders`，说明：外部程序 → Host → 插件 → Thunderbird 已打通。

**方式 B：Node 烟雾脚本**

```bash
cd /Users/markbai/Documents/ThunderbirdExtension
export TEST_ACCOUNT_EMAIL=你的邮箱@example.com
node demos/smoke_test.js
```

同样看输出里是否 `success: true` 以及账号/文件夹信息。

### 4.3 完整 Demo（发信 / 打开并标星 / 添加联系人）

在项目根目录执行（环境变量按需改）：

```bash
# Demo 1：切换账号 + 发一封邮件（DRY_RUN=1 只打开撰写窗口，不真正发送）
export TEST_ACCOUNT_EMAIL=你的邮箱@example.com
export TEST_TO=收件人@example.com
DRY_RUN=1 node demos/demo1_switch_and_send.js
# 去掉 DRY_RUN=1 即真实发送

# Demo 2：按条件打开一封邮件并标星
export TEST_ACCOUNT_EMAIL=你的邮箱@example.com
export TEST_SUBJECT=邮件主题里包含的文字
node demos/demo2_open_and_star.js

# Demo 3：添加联系人（需 addressBookId，见下）
export ADDRESS_BOOK_ID=你的通讯录ID
export CONTACT_EMAIL=new@example.com
node demos/demo3_add_contact.js
```

获取 `addressBookId`：在 Thunderbird 开发者工具（扩展调试）控制台里执行 `browser.addressBooks.list()`，从返回结果里取某个通讯录的 `id`。

## 5. 不通过 Native Host 的纯插件调试

若暂时不跑 native host，可在 background 里用 `browser.runtime.onMessage` 接收来自扩展内其他页面或调试的控制消息，并同样调用 `route(envelope)` 做测试（需自行在控制台或选项页里 `browser.runtime.sendMessage({...})`）。

## 6. 常见问题

- **Host 未启动**：确认 manifest 中 `path` 为绝对路径且指向正确的 `host.js`；确认 Thunderbird 已真正加载插件并执行过 background（如重启 Thunderbird 或重载插件）。
- **连接被拒绝**：先确认插件已加载且无报错，再确认 host 的 HTTP 在 127.0.0.1:3939 监听。
- **request_id 不匹配**：Host 和插件均以 envelope 的 `request_id` 关联请求与响应，请勿在测试时随意去掉该字段。

### 6.1 无法正常调用组件的服务时排查

按下面顺序检查，多数情况是 **macOS 沙箱** 或 **Native Host 未注册/未拉起** 导致：

| 步骤 | 检查项 | 做法 |
|------|--------|------|
| 1 | macOS 上 3939 不可用 | 使用**桥接**：先在一个终端运行 `node native-host/bridge.js`，再启动 Thunderbird；外部仍访问 3939，由桥接转发到 Host。 |
| 2 | Native Host 是否已注册 | 确认 `~/Library/Application Support/Mozilla/NativeMessagingHosts/mail_automation_agent.json` 存在，且 `path` 指向 `run.sh` 的**绝对路径**。 |
| 3 | 扩展是否已加载且 background 已跑 | 打开「附加组件」→ 扩展 → 本扩展「调试」，看是否有「背景页/Event page」入口；控制台应看到 `native port 已连接` 或 `connectNative 失败`。 |
| 4 | 3939 是否在监听 | 终端执行 `lsof -i :3939`；若无输出，在 macOS 上回到步骤 1。 |
| 5 | 请求格式是否正确 | POST `http://127.0.0.1:3939/command`，Body 为 JSON：`{ "request_id": "唯一ID", "action": "switch_account_context", "payload": { "email": "账号邮箱" } }`。 |

与 [webext-examples](https://github.com/thunderbird/webext-examples/tree/master/manifest_v3) 和 [Thunderbird 插件介绍](https://developer.thunderbird.net/add-ons/about-add-ons) 的差异：本扩展使用 **Native Messaging + 本地 HTTP**，因此多出 Native Host 注册与（macOS）沙箱两步；扩展内 background 已按规范使用 `background.scripts` + `type: "module"`。
