# 探索：通过程序自动控制 Thunderbird 扩展 / 客户端

**目标**：理清官方与开发者文档，得到**完整可跑通、他人已验证**的「外部程序 → 控制 Thunderbird」闭环。  
**环境**：Thunderbird 148.0.1 (aarch64)。

---

## 一、官方与开发者文档来源（已查阅）

| 来源 | 内容 |
|-----|------|
| [Thunderbird 附加组件介绍](https://developer.thunderbird.net/add-ons/about-add-ons) | WebExtension/MailExtension 概述、入口 |
| [Thunderbird MailExtensions 指南](https://developer.thunderbird.net/add-ons/mailextensions) | manifest、background、权限、Experiments |
| [Thunderbird Hello World 教程](https://developer.thunderbird.net/add-ons/hello-world-add-on) | 安装、临时加载、调试 |
| [Thunderbird 资源与文档](https://developer.thunderbird.net/add-ons/resources) | API 文档、示例仓库、MDN 链接 |
| [Thunderbird runtime API (MV3)](https://webextension-api.thunderbird.net/en/mv3/runtime.html) | `connectNative(application)`、`sendNativeMessage(application, message)`、需 `nativeMessaging` 权限 |
| [MDN: Native messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging) | 扩展与原生应用通过 stdio 交换 JSON、协议格式、故障排查 |
| [MDN: Native manifests](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_manifests) | Host manifest 字段、**各平台 manifest 存放路径** |
| [MDN native-messaging 示例 README](https://github.com/mdn/webextensions-examples/blob/main/native-messaging/README.md) | 一步步安装与测试说明（Firefox，机制与 Thunderbird 一致） |

**结论**：  
- 「通过程序自动控制插件 / 控制 Thunderbird 客户端」在 WebExtension 体系下**只有一条官方路径**：**Native Messaging**。  
- 扩展不能直接被外部进程调用；必须通过**已注册的 Native Messaging Host**：外部程序 ↔ 原生 Host ↔ 扩展（`runtime.connectNative` / `sendNativeMessage`）↔ Thunderbird API。

---

## 二、完整闭环流程（他人已验证）

以下流程与 **MDN native-messaging 示例**、**Thunderbird runtime API**、**MDN Native manifests** 一致，且可在本项目中复现。

### 2.1 扩展侧（必须）

1. **manifest.json**
   - `browser_specific_settings.gecko.id`：固定扩展 ID（Host 的 `allowed_extensions` 会引用）。
   - `permissions` 包含 `"nativeMessaging"`。
   - `background.scripts` + 可选 `type: "module"`（与 [webext-examples](https://github.com/thunderbird/webext-examples) 一致）。

2. **Background 脚本**
   - 调用 `browser.runtime.connectNative(application)`，其中 `application` 为 Host 的 **name**（与 manifest 文件名 `<name>.json` 一致）。
   - 通过返回的 `Port`：`port.onMessage.addListener` 收、`port.postMessage` 发。
   - 协议：每条消息为 **4 字节小端长度 + UTF-8 JSON**（[MDN 协议](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging#app_side)）。

### 2.2 Native Host 侧（必须）

1. **Host manifest（JSON）**
   - `name`：与 `connectNative(name)` 一致，文件名即 `<name>.json`。
   - `path`：**macOS/Linux 必须为可执行文件的绝对路径**（[MDN Native manifests](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_manifests#native_messaging_manifests)）。
   - `type`: `"stdio"`。
   - `allowed_extensions`：包含扩展 ID 的数组。

2. **Manifest 存放位置（MDN 规定，Thunderbird 与 Firefox 共用）**
   - **macOS 用户级**：`~/Library/Application Support/Mozilla/NativeMessagingHosts/<name>.json`
   - **Linux 用户级**：`~/.mozilla/native-messaging-hosts/<name>.json`
   - **Windows**：注册表 `HKEY_CURRENT_USER\SOFTWARE\Mozilla\NativeMessagingHosts\<name>` 默认值为 manifest 的完整路径。

3. **可执行文件**
   - 从 stdin 读：4 字节长度 + 对应长度 JSON。
   - 向 stdout 写：同样 4 字节长度 + JSON。
   - 由 Thunderbird 启动；扩展连接时 Host 进程被拉起。

### 2.3 外部程序如何“控制” Thunderbird

- **唯一方式**：外部程序与 **Native Host 进程** 通信，由 Host 把请求通过 **stdio ↔ Port** 转给扩展，扩展再调 Thunderbird API。
- 因此 Host 必须同时：
  - 被 Thunderbird 通过 manifest 的 `path` 启动，并保持 stdin/stdout 与扩展连接；
  - 对外提供某种接口（如本项目的 **HTTP 127.0.0.1:3939**），供外部脚本/程序发送命令。
- 本项目的 Host（`native-host/host.js`）正是这种「stdio 协议 + HTTP 服务」的桥接实现，结构正确。

### 2.4 已验证的“最小可跑通”步骤（与 MDN 示例一致）

1. 安装扩展：Thunderbird → 附加组件 → 从文件安装 / 临时加载，选包含 `manifest.json` 的目录或 xpi。
2. 准备 Host manifest：`path` 改为本机可执行文件的**绝对路径**，`allowed_extensions` 与扩展 ID 一致。
3. 将 Host manifest 复制到上述 **Mozilla** 路径，文件名 `<name>.json`。
4. 确保可执行文件有执行权限（`chmod +x`）。
5. 启动 Thunderbird，触发一次 background（如打开附加组件或任意邮箱），使扩展执行 `connectNative`。
6. 若 Host 内还跑 HTTP：外部用 `curl` 或脚本 POST 到 `http://127.0.0.1:3939/command`（或你定义的 endpoint），即可完成「外部 → Host → 扩展 → Thunderbird」闭环。

**参考**：  
- [MDN native-messaging README - Setup & Testing](https://github.com/mdn/webextensions-examples/blob/main/native-messaging/README.md)（Firefox，Thunderbird 机制相同）。  
- 本项目 [LOCAL_DEBUG.md](./LOCAL_DEBUG.md)、[USAGE_AND_TEST.md](./USAGE_AND_TEST.md) 中的安装、注册、smoke_test 步骤。

---

## 三、与本项目实现的对齐情况

| 项目 | 本项目 | 官方/文档要求 | 结论 |
|------|--------|----------------|------|
| 扩展 ID | `mail_automation_agent@markbai.thunderbird.local` | 固定 ID，与 Host `allowed_extensions` 一致 | ✅ |
| 权限 | `nativeMessaging` 等 | 需 `nativeMessaging` | ✅ |
| connectNative | `browser.runtime.connectNative("mail_automation_agent")` | name = Host manifest 的 `name` | ✅ |
| Host manifest 路径 (macOS) | 文档写 `~/Library/Application Support/Mozilla/NativeMessagingHosts/` | MDN 规定同上 | ✅ |
| 协议 | 4 字节长度 + JSON | MDN 规定同上 | ✅ |
| 外部入口 | Host 内 HTTP 3939，POST /command | 非标准要求，仅为“外部控制”的合理实现 | ✅ 设计合理 |

当前实现与官方文档和“他人已验证”的 Native Messaging 流程一致；闭环能否在你这台机器上跑通，只取决于：**Host manifest 路径与 path、可执行权限、以及 Host 进程能否在你这台机上正常监听 3939**（见下节）。

---

## 四、macOS (aarch64) 上保证“完整可用”的单一条件

- Thunderbird 通过 **Utility Process** 启动 Native Host；在 **macOS** 上该子进程默认处于沙箱，**不能绑定网络端口**（因此 3939 会绑定失败）。
- **要让“外部程序 → Host HTTP → 扩展 → Thunderbird”在你本地 148.0.1 (aarch64) 上完整跑通**，需在**开发/自用环境**下关闭该沙箱后启动 Thunderbird：

```bash
export MOZ_DISABLE_UTILITY_SANDBOX=1
open -a Thunderbird
```

之后按 2.4 的步骤操作即可形成闭环；无需改代码或架构。  
（Linux/Windows 无此限制；本段仅说明“完整可用”在 macOS 上的唯一前提。）

---

## 五、尚未澄清或需你确认的点

1. **Thunderbird 专用路径**：MDN 写的是 **Mozilla** 的路径（`~/Library/Application Support/Mozilla/NativeMessagingHosts/`），你当前文档也按此配置。有历史 PR 提到 Thunderbird 可能用不同路径，但未在 developer.thunderbird.net 上找到单独说明。你 148.0.1 上若用 Mozilla 路径已能正常连接，可视为以 Mozilla 路径为准。
2. **“别人已经验证过的”范围**：  
   - **已验证**：Native Messaging 的“扩展 ↔ 原生 Host（stdio）”流程（MDN 示例、Thunderbird runtime API 文档）。  
   - **本项目额外**：在 Host 内开 HTTP 供外部调用，属同一机制上的扩展，逻辑正确；若你希望“仅采纳 100% 官方示例”，可先跑通 MDN 的 ping_pong（或 TB 同机制），再切回本项目的 HTTP 桥接。
3. **148.0.1 与 strict_min_version**：当前 manifest 为 `strict_min_version": "128.0"`，148 > 128，无冲突；若你后续要写死 148，可改为 `"148.0"`。

---

## 六、小结

- **官方/开发者文档**：Thunderbird 附加组件介绍、MailExtensions 指南、Hello World、[webextension-api.thunderbird.net](https://webextension-api.thunderbird.net/en/mv3/runtime.html)、[MDN Native messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging) 与 [Native manifests](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_manifests) 已覆盖“通过程序控制”的**唯一标准路径**：Native Messaging。
- **完整可跑通流程**：扩展（nativeMessaging + connectNative） + Host manifest 放在 Mozilla 规定路径 + Host 可执行文件 path/权限正确 + 在 macOS 上用 `MOZ_DISABLE_UTILITY_SANDBOX=1` 启动 Thunderbird，即可实现「外部程序 → Native Host (HTTP) → 扩展 → Thunderbird API」闭环。
- 当前项目结构与该流程一致；若你愿意，下一步可针对你机器上的实际报错或现象（例如 connectNative 失败、3939 连不上）做逐项核对清单或补充到 LOCAL_DEBUG.md。
