# 当前项目「不可用」原因分析

基于对 [webext-examples/manifest_v3](https://github.com/thunderbird/webext-examples/tree/master/manifest_v3) 的对照与 Thunderbird WebExtensions 规范（reference.md）的核查。

---

## 一、webext-examples (manifest_v3) 要点

### 1.1 结构共性

- **manifest**：一律使用 `browser_specific_settings.gecko`，无 `applications`；`strict_min_version`: `"128.0"`。
- **background**：多为 `"scripts": ["background.js"]`，与 manifest 同目录；部分使用 `"type": "module"`（如 i18n、menu、menuActionButton、experiment.*）。
- **子目录脚本**：`messageDisplayScript` 使用 `"scripts": ["src/background.js"]`，说明子路径合法。
- **无 Native Messaging**：官方示例均不包含 native host，因此没有「Host 未启动 / 沙箱限制」问题。

### 1.2 与 reference.md 一致的做法

- 使用 `type: "module"` 时，用 `scripts` 数组 + 明确 `import`，例如 i18n 的 `background.mjs`。
- 使用 `browser.runtime.onStartup.addListener(() => {})` 空监听以在启动时唤醒事件页；init 用 session storage 防重入（与当前项目一致）。
- 不使用 async 的 `runtime.onMessage` 监听器；需要异步时用 `sendResponse` 或返回 Promise 的规范写法。

---

## 二、当前项目与示例的对照结果

| 项目 | 当前项目 | webext-examples | 结论 |
|------|----------|-----------------|------|
| manifest.gecko | ✅ `browser_specific_settings.gecko`, id, strict_min_version 128 | ✅ 一致 | 无问题 |
| background 入口 | `scripts: ["background/background.js"]`, `type: "module"` | 有 `src/background.js`、`type: "module"` 等 | 合法且符合 reference |
| init 防重入 | session storage `initialized` + onStartup 空监听 | 示例中 optIn 等无复杂 init | 符合 reference 推荐 |
| MessageList | `list?.messages ?? []` | messageDisplay 用 `messageList.messages` | 用法正确 |
| folders.query | 按数组使用 | 文档为「array of MailFolder」 | 正确 |
| 第三方库 | 无，VENDOR.md 存在 | 部分示例无库 | 无问题 |

**结论**：从 manifest、background 生命周期、API 用法上看，当前项目与官方示例和 reference 一致，**扩展本身写法不是「不可用」的主因**。

---

## 三、「不可用」的最可能原因：Native Host 环境

当前项目**依赖 Native Messaging**：外部请求 → Native Host (host.js) → 扩展 → Thunderbird API。  
webext-examples 没有这一步，因此「不可用」几乎都出在 **Native Host 未就绪或受限** 上。

### 3.1 macOS 沙箱（最主要原因）

Thunderbird 通过 **Utility Process + 沙箱** 启动 Native Host（见 [MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)、[Bug 1576733](https://bugzilla.mozilla.org/show_bug.cgi?id=1576733)）：

- 扩展侧：`connectNative()` 可能成功，控制台显示「native port 已连接」。
- Host 侧：子进程在沙箱内：
  - **无法绑定网络端口** → `server.listen(3939)` 失败，`lsof -i :3939` 看不到。
  - **无法写入项目目录或 /tmp** → `host.log` / `run_sh.log` 可能不生成或写到不可见位置。

因此：**未关闭沙箱时，即使扩展加载正常，外部 curl/Node 也连不上 3939，表现为「不可用」。**

**解决（开发/自用）：**

```bash
export MOZ_DISABLE_UTILITY_SANDBOX=1
open -a Thunderbird
```

然后再做「切换账号」或 smoke_test 等验证。详见 [LOCAL_DEBUG.md](./LOCAL_DEBUG.md) 第 3.1 节。

### 3.2 其他常见原因

| 现象 | 检查项 | 处理 |
|------|--------|------|
| 附加组件报 corrupt | 是否选了 `ThunderbirdExtension` 而不是 `extension` 目录（或 extension.xpi） | 选 `extension` 或安装根目录 `extension.xpi` |
| 无法安装 / 版本不符 | `strict_min_version`: 128.0 | 升级 Thunderbird 到 128+ |
| Host 从未启动 | Native host 是否已注册；path 是否指向 `run.sh` 的**绝对路径** | 见 LOCAL_DEBUG §2，复制 `mail_automation_agent.json` 到 `~/Library/Application Support/Mozilla/NativeMessagingHosts/` |
| 3939 无监听 | 是否用 `MOZ_DISABLE_UTILITY_SANDBOX=1` 启动（macOS） | 同上 |
| 调试里只有「没有找到 Service Worker」 | TB MV3 用事件页，不是 Service Worker | 正常；点「背景页/Event page」或先触发扩展再点「调试」 |

---

## 四、可选清理（与「可用性」无直接关系）

- **background.html**：manifest 未使用 `background.page`，入口仅为 `background/background.js`。STRUCTURE.md 已注明「已不用作入口，可删」；删除可避免误导，不影响运行。
- **icons**：若希望与部分示例一致，可在 manifest 中增加 `icons`（64/32/16），非必须。

---

## 五、总结

- **与 webext-examples 的差异**：当前项目多了 **Native Messaging + 本地 HTTP Host**，结构、manifest、API 用法与官方示例和 reference 一致。
- **「不可用」的主因**：在 macOS 上多为 **Native Host 受沙箱限制**（无法监听 3939、无法写日志）。先用 `MOZ_DISABLE_UTILITY_SANDBOX=1` 启动 Thunderbird，再按 LOCAL_DEBUG 做 Host 注册与 smoke 测试，即可验证整条链路。
- 若在**非 macOS** 或已关沙箱仍不可用，请提供：Thunderbird 版本、安装方式（目录/xpi）、控制台是否有 `connectNative` 报错、以及 `lsof -i :3939` 和 host.log 的最后几行，便于进一步排查。
