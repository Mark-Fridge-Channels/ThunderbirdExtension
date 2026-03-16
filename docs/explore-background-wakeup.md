# 探索：后台脚本停止后为何无响应，以及能否不重载就恢复

## 1. 你的现象（复述）

- 外部程序发出动作请求后，Thunderbird 一直没有响应。
- 在扩展管理里看到组件的**后台脚本是「已停止」状态**。
- 你点击「检查」并**重新加载**扩展后，状态变为「已运行」，Thunderbird 才执行了对应动作。
- **问题**：如果不进行重新加载，组件能否**自己激活**或**被动激活**？

---

## 2. 当前架构（与结论直接相关）

- **通信方向**：外部程序 → `POST /command` → **minimal-server**（Node，127.0.0.1:3939）；扩展 **background** 轮询 `GET /next` → minimal-server，取到命令后执行并 `POST /done`。
- **谁在拉命令**：只有扩展的 background 脚本会发 `GET /next`。minimal-server 和外部程序都**不会**向扩展推送任何浏览器内事件。
- **Background 形态**：Manifest V3，background 以 **Service Worker（事件页）** 运行：空闲一段时间后会被平台终止，以节省资源；需要时再被**事件**唤醒，重新执行 `background.js`。

因此：

- 当后台显示「已停止」时，**轮询已经停了**（`setInterval` 随进程结束而消失）。
- **外部请求无法直接唤醒扩展**：HTTP 只到 minimal-server，扩展收不到任何「有命令来了」的浏览器事件。
- 只有 **Thunderbird/扩展内部发生的事件**（例如启动、安装/更新、或某种用户操作触发的 API 调用）才可能再次启动 background。

---

## 3. 能否「自己激活」？

**不能。**

- 「已停止」= 该 Service Worker 进程已被销毁，里面没有任何定时器或逻辑在跑。
- 当前也没有使用能在进程外触发的定时机制（例如 `alarms` API），所以不存在「到点自己醒」。
- 结论：在现有实现下，**扩展不会在无人干预的情况下自己重新开始轮询**。

---

## 4. 能否「被动激活」（不点重载，但被别的事件唤醒）？

**理论上可以，但依赖「有什么事件能再次启动 background」；且当前代码在唤醒后不会恢复轮询。**

### 4.1 哪些事件会再次启动 background？

- **`runtime.onStartup`**：Thunderbird 本次启动时触发（你当前有一个空监听）。只会在「新开 Thunderbird」时触发一次，不能用来响应「发了一条命令」。
- **`runtime.onInstalled`**：安装/更新扩展时。
- **用户操作**：例如打开扩展的选项页、或从扩展里发 `runtime.sendMessage` 到 background，会触发 background 启动以处理消息。
- **「检查」按钮**：打开开发者工具/检查 background 时，平台可能会为了附加调试而启动 background（具体是否一定唤醒、何时唤醒需看实现，不能 100% 依赖）。
- **外部程序 / minimal-server**：**不会**产生任何扩展内事件，所以**不可能**通过「发请求」来被动激活扩展。

所以：  
- **不重载**的情况下，唯一现实的「被动」唤醒是：**用户在 Thunderbird 里做了会触发 background 的操作**（例如打开选项页、或某些 UI 会发 message），或依赖「检查」是否触发启动（未在文档中保证）。  
- **仅靠「外部程序发请求」**，扩展**不会**被动激活。

### 4.2 唤醒后当前代码会不会恢复轮询？

**不会。** 这里有一个和「防重入」相关的逻辑问题：

- `init()` 用 **session storage** 的 `initialized` 做防重入：一旦设为 `true`，同一会话内再次进入 `init()` 会直接 `return`，**不会**再执行 `setInterval(poll, POLL_MS)`。
- Service Worker 被终止后再被**任意事件**唤醒时：会重新执行整个 `background.js`，再次调用 `init()`；但 **session storage 在会话内持久**，`initialized` 通常仍是 `true`，所以会直接 return，**轮询不会被重新建立**。

因此：  
即便某次操作（例如你点「检查」）把 background 唤醒了，**按当前实现**，也不会重新开 `setInterval`，所以仍然不会去拉 `/next`。  
你看到「重新加载后才恢复」，很可能是因为：  
- 重载后扩展上下文重置，**session storage 被清空**（或视为新会话），`initialized` 变回 `false`，`init()` 完整跑一遍，轮询重新建立；或  
- 重载直接重启了 background 并重新执行了整段脚本且没有沿用之前的 `initialized`。

（具体「重载是否清空 session」需查 Thunderbird 文档或实测，这里列为已知依赖。）

---

## 5. 小结表

| 问题 | 结论 |
|------|------|
| 不重载时，组件能否**自己**激活？ | **不能**。进程已终止，且没有用 alarms 等跨进程定时机制。 |
| 不重载时，能否被**外部请求**被动激活？ | **不能**。请求只到 minimal-server，扩展收不到任何事件。 |
| 不重载时，能否被**浏览器/用户操作**被动激活？ | **有可能**（例如 onStartup、打开选项页、发 message、或「检查」）。 |
| 被动激活后会不会自动恢复轮询？ | **当前不会**。`init()` 的 session 防重入会导致不再执行 `setInterval(poll)`。 |

---

## 6. 与现有 issue 的对应

- 和 **`docs/issues/001-background-script-stopped.md`** 是同一类问题：都是「MV3 下 background 会被终止 + 轮询如何持续/恢复」。
- 本探索补充了：  
  - **谁**能唤醒 background（只有浏览器/扩展内事件）；  
  - **为什么**仅靠外部请求不行（协议与进程模型）；  
  - **为什么**即便被唤醒，当前也不会恢复轮询（init 防重入逻辑）。

---

## 7. 后续若要「不重载也能恢复」需要搞清的点

1. **产品预期**  
   - 是否接受「只有 Thunderbird 重启或用户重载扩展后才恢复」？  
   - 若希望「一段时间不用后，仍能自动恢复响应」，就需要改设计（例如用 alarms 定时唤醒 + 在每次唤醒时跑一次 poll，并处理 init/防重入）。

2. **init 与防重入**  
   - 防重入的初衷是避免同一进程内重复执行 init（例如 onStartup 与顶层 `init()` 同时跑）。  
   - 但当前实现导致「进程被终止后再次启动时也不再建轮询」。  
   - 需要区分：  
     - 「同一 worker 生命周期内只做一次 init」 vs  
     - 「每次 worker 启动时都要确保有轮询（或 alarms 等）在跑」。

3. **Thunderbird 行为**  
   - 扩展「重载」时，`storage.session` 是否一定被清空？若不会，当前「重载后恢复」的稳定程度需要实测。  
   - 「检查」按钮在 TB 里是否保证会启动 background（例如调 getBackgroundPage）？若会，再配合修正 init 逻辑，有可能实现「点一下检查就恢复」而不必点重载。

4. **若引入 alarms**  
   - 用 `alarms` 做「最少每 N 分钟唤醒一次 + 执行一次 poll」：  
     - 可让扩展在长时间无操作后仍能「自己」再次拉命令，但间隔会受平台限制（例如 ≥1 分钟）。  
     - 需在 001 里已有的「alarms 最小间隔 vs 当前 2s 轮询」权衡下做决策。

---

## 8. 当前无需你补充的信息

- 外部请求的格式、minimal-server 的端口与实现已从代码和文档确认。
- 轮询与 init 逻辑已从 `extension/background/background.js` 确认。
- 001 中已覆盖「后台停止」与「alarms/持久化」的调研方向。

若你愿意，可以下一步在 001 里把「init 防重入导致唤醒后不恢复轮询」列为必须修复项，并选定：是只做「文档说明 + 可选修复 init」，还是同时设计 alarms 的接入方式（间隔、与现有 2s 轮询的配合）。

---

## 9. 必须支持的场景：24 小时运行、无人为操作、后台自动恢复

### 9.1 需求（已明确）

- Thunderbird **长期运行**（如 24 小时），不依赖用户手动重载扩展。
- 当 background 显示「已停止」时，扩展必须**自动**恢复轮询并继续响应命令。
- **完全不依靠人为操作**（不点击重载、不点击检查、不打开选项页等）。

### 9.2 可行方案：仅剩 alarms API

在 MV3 下，不依赖用户操作的「定时唤醒」只有一种标准方式：**alarms API**。

- 平台在扩展进程外维护闹钟；到点会**触发事件**，从而启动（或唤醒）Service Worker。
- Worker 被唤醒后执行 `onAlarm` 监听器，在回调里执行一次 `poll()` 即可拉取并执行命令；无需用户操作。
- 周期性闹钟用 `alarms.create(name, { periodInMinutes })`，会按间隔**重复触发**，无需在回调里再次 create。

因此：**要实现「后台停止后自动恢复、无人为操作」，必须使用 alarms 做周期性唤醒，并在 onAlarm 里跑 poll。**

### 9.3 与现有实现的集成方式

| 项目 | 说明 |
|------|------|
| **manifest** | 增加权限 `"alarms"`。Thunderbird MV3 文档要求使用 alarms 须声明该权限。 |
| **background.js** | ① 在**脚本顶层**注册 `browser.alarms.onAlarm.addListener(callback)`，在 callback 里调用现有 `poll()`。② 在**首次完整 init** 时（即当前 session 防重入通过后）调用 `browser.alarms.create("poll", { periodInMinutes })`，若希望避免重复创建可先 `alarms.get("poll")` 再决定是否 create。 |
| **init 防重入** | 保持不变。首次 run 时：ping、setInterval(poll, 2000)、create 周期性 alarm。Worker 被终止后由 alarm 唤醒时，init 因 `initialized === true` 直接 return，**不会**再建 setInterval；但 **onAlarm 仍会触发**，执行一次 poll，从而在无人为操作下恢复拉取命令。 |
| **setInterval 是否保留** | 建议**保留**：Worker 存活期间每 2s 轮询，响应更快；Worker 被终止后由 alarm 按 N 分钟唤醒一次，保证自动恢复。两者并存，互不冲突。 |

依赖与影响范围：

- **minimal-server**：无需改动（仍为 GET /next、POST /done）。
- **EXTERNAL_API**：无需改协议，且对外不写自动恢复相关说明（已确认）。
- **router / handlers**：无改动。

### 9.4 周期与平台限制

- **MDN/Chrome**：`periodInMinutes` 有效最小值通常为 **0.5**（30 秒）；小于 0.5 会按 30 秒处理并可能产生警告。Chrome 120+ 明确支持 0.5。
- **Thunderbird**：官方 MV3 文档未写明确最小值，一般沿用 Firefox/Chromium 行为；**需在目标 Thunderbird 版本上实测**（例如试 0.5 与 1，取可接受的最短间隔）。
- **产品权衡**：  
  - 若用 **0.5 分钟**：后台停止后最多约 30 秒延迟恢复拉取（在 TB 支持的前提下）。  
  - 若用 **1 分钟**：更保守，兼容性更好，最多约 1 分钟延迟。  
  实现时建议用常量配置（如 `ALARM_PERIOD_MINUTES = 0.5` 或 `1`），便于后续调参或按 TB 版本区分。

### 9.5 边界与约束（需在实现/文档中体现）

1. **机器休眠/睡眠**：设备进入睡眠时，闹钟可能被推迟或合并；唤醒后可能有一段时间的「追赶」行为。文档可说明「机器从睡眠恢复后，扩展会在下一次闹钟触发时恢复轮询」。
2. **Thunderbird 未运行**：alarms 只在 Thunderbird 进程内有效；若 TB 退出，扩展不运行，无「自动启动 TB」一说。需求中的「24 小时启动」应理解为「Thunderbird 本身 24 小时运行」，扩展在其内自动恢复即可。
3. **alarm 未触发**：极少数环境下曾有「alarm 已登记但 onAlarm 长时间不触发」的反馈（如长时间睡眠后）；若遇此类问题，可再考虑在 onStartup 里补一次「确保 alarm 存在」的逻辑。
4. **onAlarm 参数**：Thunderbird 文档中 `onAlarm` 的监听器参数类型为 `Alarm`（对象），不是字符串 name；实现时按 `alarm.name === "poll"` 判断即可，与当前设计兼容。

### 9.6 小结：为满足「24h、无人为、自动恢复」需要做的

- **必须**：manifest 增加 `"alarms"`；background 顶层注册 `onAlarm` 并调用 `poll()`；在首次 init 时创建周期 alarm（`periodInMinutes` 取 0.5 或 1，可配置）。
- **建议**：保留现有 setInterval 2s 轮询，与 alarm 并行。
- **不必**：为自动恢复而改 minimal-server、改外部协议、或依赖用户点击任何按钮。

---

## 10. 已确认的结论（来自你的回复）

1. **恢复延迟**  
   - 后台被终止后：**最多 30 秒**恢复第一次拉取 → 使用 `periodInMinutes: 0.5`（需在目标 Thunderbird 上实测支持）。  
   - **运行中不需要重启**：当 background 已是「运行中」时，不触发任何重启或多余的重初始化。当前设计已满足：  
     - Worker 存活时由 setInterval 每 2s 轮询；alarm 到点只是多执行一次 `poll()`，不会导致 Worker 被平台终止或「重启」。  
     - 平台不会因为 onAlarm 触发而主动停掉 Worker；「运行中」状态不会被 alarm 改变。  
     - 因此无需在 onAlarm 里判断「若已在轮询则跳过」——多一次 poll 无害，且 alarm 必须每次触发才能在被终止后起到唤醒作用。

2. **对外文档**  
   - **不需要**在 EXTERNAL_API 等对外文档中写「N 分钟内自动恢复」的承诺。

3. **Thunderbird 未启动时自动启动**  
   - 见下节 11：扩展内不可行；扩展外（minimal-server 或系统）可行，作为后续可选能力。  
   - 实现顺序：**先做扩展内 24h 运行 + alarms 自动恢复**；若需「TB 未运行时自动启动 TB」，再在 minimal-server 或部署侧做。

---

## 11. Thunderbird 未启动时「根据本扩展自动启动 Thunderbird」的可行性

### 11.1 由扩展本身实现：不可行

- 扩展代码**只会在 Thunderbird 进程内执行**。Thunderbird 未启动时，没有任何扩展脚本在跑，也没有 alarms、onStartup 等会触发。
- 因此**不可能**在「本扩展」内部实现「当 TB 未运行时由扩展去启动 Thunderbird」。
- 结论：**由扩展自动启动 Thunderbird → 不可以。**

### 11.2 由扩展以外的组件实现：可行（部署/集成层面）

在**不改变扩展本身**的前提下，可以由**外部进程**在「需要时」启动 Thunderbird，从而间接实现「有命令或定时检测时若 TB 未运行则启动 TB」：

| 方式 | 说明 | 约束 |
|------|------|------|
| **minimal-server 侧** | 在收到 `POST /command`（或健康检查）时，若判断扩展未在轮询（例如一段时间内没有 GET /next），可先尝试用 `child_process.spawn` 启动 Thunderbird（如 `thunderbird` 或系统可执行路径），再等待扩展连上并拉取命令。 | 需配置 TB 可执行路径；多平台（Windows/macOS/Linux）路径不同；TB 为 GUI 应用，无头环境需虚拟显示（如 Xvfb）或仅限桌面环境。 |
| **系统级** | 用 cron / launchd / Task Scheduler 定时启动 Thunderbird，或由系统服务在「有网络/有请求」时启动 TB。 | 与「本扩展」无直接关系，属于部署/运维配置。 |

因此：

- **可以**做到「Thunderbird 未启动时，根据**本方案/本系统**自动启动 Thunderbird」，但实现主体是 **minimal-server 或系统/脚本**，不是扩展。
- 若你希望「如果可以就做」：  
  - **扩展内**：不做「启动 TB」逻辑（做不了）。  
  - **扩展外**：可以在 minimal-server（或单独的小脚本）里加「收到命令且检测到无 GET /next 时 spawn Thunderbird」的逻辑，作为**后续需求**单独实现。

### 11.3 建议实现顺序（与你一致）

1. **先做**：扩展 24 小时运行场景下的**自动恢复**（alarms 每 0.5 分钟唤醒 + 运行中不重启、对外文档不写）。
2. **若需要**「TB 未运行时自动启动 TB」：再在 **minimal-server 或部署侧**增加「检测 + 启动 Thunderbird」的逻辑，与扩展解耦。

---

## 12. 实现前无待确认项

- 恢复间隔 30s（periodInMinutes: 0.5）、运行中不重启、对外不写文档、TB 未启动时扩展内不可为/扩展外可为且后做，均已明确。  
- 可按 9.6 清单进入实现阶段。
