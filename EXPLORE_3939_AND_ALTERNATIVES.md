# 探索：3939 未监听 + 「程序控制 Thunderbird」方案边界

**阶段**：仅探索与规划，不实现。  
**你的说明**：  
1. 没有成功连上 Host，组件加载成功也启动了，但 3939 端口没有监听到。  
2. 需求固定为「程序能控制 Thunderbird」，是否用扩展由实现决定。  
3. 可以补充。  
4. 已接受「用环境变量关沙箱」作为 macOS 必选步骤，但**你实测 `MOZ_DISABLE_UTILITY_SANDBOX=1` 没有生效**，需要明确用该参数一定能解决问题。  
5. 控制范围可后面再扩展，当前不需要更多操作。  
6. 运行环境需要覆盖 macOS + Linux + Windows。

---

## 一、现象与原因（3939 未监听）

### 1.1 当前链路

- 扩展加载 → background 执行 → `connectNative("mail_automation_agent")` 被调用。
- Thunderbird 根据 Native Messaging 清单启动 Host 进程（`run.sh` → `host.js`），并把该进程的 **stdin/stdout** 接到扩展的 Port。
- Host 进程里还执行了 `http.createServer().listen(3939)`，期望外部程序通过 HTTP 连 3939 发命令。

### 1.2 为何「扩展已连上、但 3939 没有」

- 在 **macOS** 上，由 Thunderbird 启动的 Native Host 运行在 **Utility Process 沙箱** 里（与 Firefox 相同机制，见 [Bug 1576733](https://bugzilla.mozilla.org/show_bug.cgi?id=1576733)）。
- 沙箱内**不允许绑定网络端口**，所以 `server.listen(3939)` 会失败或不起作用，`lsof -i :3939` 看不到。
- 因此会出现：扩展侧「native port 已连接」、控制台显示组件加载/启动成功，但 Host 侧 3939 从未成功监听。

**结论**：不是扩展或 Host 脚本配错，而是「由 Thunderbird 拉起的同一进程既做 stdio 又开 3939」在 macOS 上被沙箱拦截；要让这条链路跑通，必须让 Thunderbird（及其拉起的 Host 子进程）在**关闭 Utility 沙箱**的情况下启动。

---

## 二、为何「MOZ_DISABLE_UTILITY_SANDBOX=1」对 3939 无效（关键）

- **根本原因**：Native Messaging Host 是由 **Subprocess**（posix_spawn）拉起的，**不是** Utility Process。[UtilityProcessHost](https://searchfox.org/mozilla-central/source/ipc/glue/UtilityProcessHost.cpp) 里的 `MOZ_DISABLE_UTILITY_SANDBOX` 只影响 Utility 子进程；Native Host 不受该变量控制。
- 因此：即使用「直接运行可执行文件」方式启动 Thunderbird（`/Applications/Thunderbird.app/Contents/MacOS/thunderbird`），由 TB 启动的 Host 进程仍可能无法绑定 3939（受系统/TCC 等限制），**不能依赖该环境变量解决 macOS 上 3939 不监听的问题**。

---

## 三、macOS 上「完整可用」的步骤：使用桥接（bridge）

因 Native Host 不受 `MOZ_DISABLE_UTILITY_SANDBOX` 控制，在 macOS 上要让「外部程序 → 3939 → Host → 扩展」跑通，需使用项目提供的 **bridge（桥接）**：

1. **先在一个终端里启动桥接**（保持运行）：
   ```bash
   cd /path/to/ThunderbirdExtension
   node native-host/bridge.js
   ```
   看到 `[bridge] HTTP listening on http://127.0.0.1:3939/command` 和 `[bridge] listening for host on 127.0.0.1:3940` 即表示就绪。
2. **正常启动 Thunderbird**（Dock、`open -a`、或直接运行可执行文件均可）。
3. 触发一次扩展加载（如打开「附加组件」）；Host 在 `listen(3939)` 失败时会**自动**连接桥接的 3940，桥接终端会显示 `[bridge] host connected`。
4. 外部程序仍访问 **http://127.0.0.1:3939/command**；桥接在 3939 提供 HTTP，并转发到已连接的 Host（3940），Host 再经 stdio 与扩展通信。

**小结**：macOS 上 3939 由 **bridge** 监听；Host 只做出站连接（连到 3940），通常不被系统禁止，整条链可稳定跑通。

---

## 四、Linux / Windows（无需关沙箱）

- **Linux**：由 Thunderbird 启动的 Native Host **不会**进与 macOS 相同的 Utility 沙箱，可直接 `listen(3939)`。按现有文档安装扩展、注册 Host 清单、启动 Thunderbird 后，3939 即会监听，无需设置任何环境变量。
- **Windows**：同样无此沙箱限制，Host 可直接监听 3939；按现有文档配置注册表与 Host 路径即可。

文档中会区分：**macOS：必须用「export + 直接运行可执行文件」启动**；**Linux/Windows：按常规方式启动 Thunderbird 即可**。

---

## 五、「程序控制 Thunderbird」的可行路线（是否用扩展）

在「需求固定、是否用扩展可商量」的前提下，可选路线大致如下。

| 方案 | 是否用扩展 | 程序如何控制 TB | 能力边界 | 在你环境 (macOS 148 aarch64) |
|------|------------|------------------|----------|------------------------------|
| **A. 当前方案**（扩展 + Native Host + HTTP 3939 或桥接） | 是 | 外部程序 HTTP POST → 3939（Host 或 bridge）→ Host → 扩展 → TB API | 发信、切换账号、打开/标星邮件、添加联系人等；范围可后续扩展 | **macOS**：先运行 `node native-host/bridge.js`，再启动 TB；3939 由 bridge 监听，Host 自动连 3940。**Linux/Windows**：正常启动 TB，Host 直接监听 3939。 |
| **B. 仅用 Thunderbird 命令行** | 否 | `thunderbird -compose "to=...,subject=...,body=..."` | 仅能打开预填撰写窗口，**不能自动发送**，需用户点发送 | 无需扩展，但无法「程序全自动」发信或做其他操作 |
| **C. macOS AppleScript / 系统自动化** | 否 | 用 AppleScript/Automator 操作 TB 界面 | Thunderbird 对 AppleScript 支持很有限，难以可靠实现发信/读信等 | 不推荐，且与「程序控制」的可靠性要求不符 |
| **D. 换用 SMTP/API 等** | 否 | 程序直连 SMTP 或邮件服务 API | 不经过 Thunderbird，也就不是「控制 Thunderbird」 | 与「控制 Thunderbird 客户端」的需求不一致 |

**结论**：  
- 若坚持「程序控制的是 Thunderbird 客户端本身」（发信、账号、邮件列表等都通过 TB），**只有当前这种「扩展 + Native Host」的路线**能实现；是否叫「扩展」只是命名，本质都是「TB 里有一块逻辑 + 一个本机进程做桥」。  
- 在该路线下：**macOS** 上需用 **bridge**（第三节）；**Linux/Windows** 无需桥接，正常启动即可。

---

## 六、依赖与约束（当前实现）

- **扩展**：依赖 `nativeMessaging`、`browser_specific_settings.gecko.id`，以及 background 里 `connectNative` 的 name 与 Host 清单的 `name` 一致。
- **Host 清单**：必须放在 `~/Library/Application Support/Mozilla/NativeMessagingHosts/mail_automation_agent.json`，`path` 为 `run.sh` 的**绝对路径**，`allowed_extensions` 含扩展 ID。
- **Host 进程**：同一进程既处理 stdio（与扩展通信）又 `listen(3939)`；在 macOS 上若不关沙箱，后者不可用。
- **外部程序**：只需能发 HTTP POST（如 curl、Node、Python）到 `http://127.0.0.1:3939/command`，body 为现有协议 JSON 即可。

---

## 七、已确认与后续可补充

- **macOS 上 3939 可用**：使用 **bridge**（先运行 `node native-host/bridge.js`，再启动 Thunderbird）；`MOZ_DISABLE_UTILITY_SANDBOX` 对 Native Host 无效（第二节）。
- **控制范围**：当前不扩展，后续可再补充。
- **运行环境**：需覆盖 **macOS + Linux + Windows**；Linux/Windows 无需桥接。

LOCAL_DEBUG 已更新为 macOS 使用 bridge、Linux/Windows 按原步骤。
