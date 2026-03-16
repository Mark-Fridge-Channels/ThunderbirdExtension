# 探索：实现「程序控制 Thunderbird」的可行方式（不依赖当前实现）

**目标**：梳理能达成「外部程序控制 Thunderbird」的**所有可行路径**，基于调研与约束，给出可跑通的最简方案，不依赖现有 Native Host/bridge 实现。

---

## 一、需求与约束（明确）

- **需求**：外部程序能控制 Thunderbird（发信、切换账号、打开邮件等）。
- **环境**：Thunderbird 148.0.1 (aarch64)，macOS；需覆盖 Linux/Windows。
- **约束**：流程可跑通、越简单越好；可完全不用当前已开发代码，按调研结果重做。

---

## 二、当前方案为何在 macOS 上失败（根因未确认）

- **现象**：扩展 `connectNative()` 成功（「native port 已连接」），随后「native port 已断开」；bridge 从未出现「host connected」；503。
- **已做改动**：优先连 bridge、Unix socket、不 exit  on uncaughtException、延迟连接等；**日志与行为无变化**（仅多了一行 bridge 的 socket 监听）。
- **结论**：**没有定位到真实根因**。可能包括但不限于：
  - 由 Thunderbird 拉起的 Host 进程在发起任何网络连接（TCP 或 Unix socket）时被系统/TB 终止；
  - Host 进程在能执行到 `tryConnectBridge` 之前就退出（例如加载阶段崩溃、权限、或 TB 侧断开）；
  - 未看到 TB 侧对 Native Host 的 stderr 输出或崩溃信息，无法区分是「连不上」还是「进程被 kill」。
- **教训**：在未拿到 Host 进程的明确错误/日志前，继续在「Host 连 bridge」上堆逻辑只是猜测；应换不依赖「TB 拉起的进程做网络」的方案。

---

## 三、可行方案梳理（基于官方能力）

### 方案 A：扩展直连本机 HTTP 服务（无 Native Messaging）

**思路**：外部程序只和「用户自己起的本地 HTTP 服务」通信；**扩展 background 用 `fetch()` 主动请求该服务**（轮询或长轮询），取到命令后执行 TB API，再把结果 POST 回服务；服务把结果转给外部调用方。

**链路**：  
`外部程序` → POST `http://127.0.0.1:3939/command` → `本地 HTTP 服务（用户运行）` ← 轮询/长轮询 ← `扩展 background (fetch)` → TB API。

**要点**：
- 扩展需在 manifest 中声明对 `127.0.0.1` 的访问（如 `host_permissions: ["http://127.0.0.1:*/*"]` 或等价）。Firefox/MDN 文档支持此类声明；Thunderbird 继承同一套 manifest，**需在你这台机上做一次最小验证**（仅扩展 + 一个固定端口的 HTTP 服务 + fetch）。
- 不涉及 Native Messaging，**没有「TB 拉起的进程」**，因此没有当前遇到的「Host 连不上 / 断开」问题。
- 实现简单：一个很小的 Node（或任意语言）HTTP 服务（例如 3939）+ 扩展里一个定时轮询 + 现有路由/handler 逻辑（可极大简化，只保留「取一条命令 → 执行 → 回写」）。

**风险**：Thunderbird 在实际版本上是否允许 background 对 `http://127.0.0.1:*` 的 fetch，需一次最小测试确认（见下「最简验证」）。

---

### 方案 B：继续用 Native Messaging，但先确认 Host 为何退出

**思路**：保留「扩展 ↔ Native Host (stdio) ↔ 某处」的架构，但**先独立于「连 bridge」**，把「TB 拉起的 Host 进程为何退出」查清楚。

**可做的最小诊断**：
- 在 Host 入口最顶部写固定内容到**已知可写**的位置（例如 `os.tmpdir() + '/mail_agent_host_started.txt'`），看该文件是否在「native port 已连接」后出现；若从不出现，说明进程在跑我们代码前就挂了或未执行到。
- 若出现，再在 `tryConnectBridge` 前后写类似标记文件；看是「连 bridge 前就断」还是「连的时候/之后断」。
- 若有办法看到 TB 启动的该子进程的 stderr（TB 调试、或系统级日志），可直接看到 Node 的报错。

**用途**：仅用于**定位根因**，而不是继续在未确认前提下改连 bridge 的方式。根因清楚后，再决定是修当前架构还是切到方案 A。

---

### 方案 C：仅用 Thunderbird 命令行

**思路**：`thunderbird -compose "to=...,subject=...,body=..."` 等。  
**限制**：只能打开撰写窗口，不能自动发送，无法满足「程序全自动控制」。  
**结论**：不满足「程序控制」的完整需求，仅作补充手段。

---

## 四、推荐最简路径：方案 A + 一次最小验证

1. **最小验证（不依赖现有扩展业务）**  
   - 新建一个最小扩展：manifest 里只有 `host_permissions: ["http://127.0.0.1:3939/*"]`（及必要 name/version/background），background 里仅 `fetch("http://127.0.0.1:3939/ping")` 并 `console.log` 结果。  
   - 本机起一个最简 HTTP 服务，监听 3939，对 `/ping` 返回 200。  
   - 在 Thunderbird 148 中加载该扩展，看 background 控制台是否成功拿到响应。  
   - **若成功**：方案 A 可行，用「扩展 fetch 本机服务」做「程序控制 Thunderbird」的最简实现，不再依赖 Native Host 做网络。  
   - **若失败**：再查 Thunderbird 对 127.0.0.1 的权限/CSP 文档或 Bugzilla，或退回方案 B 做 Host 退出诊断。

2. **若方案 A 验证通过，最简实现形态**  
   - **服务端（用户运行）**：单脚本，监听 3939。  
     - `POST /command`：body 为 `{ request_id, action, payload }`，将请求放入队列，挂起 HTTP 响应不返回。  
     - `GET /next`：扩展轮询；若有队列中的请求则返回一条并移除，否则 204。  
     - `POST /done`：body 为 `{ request_id, result }`，根据 request_id 把对应挂起的 POST /command 响应返回给调用方。  
   - **扩展**：background 定时（如每 1–2 秒）`fetch("http://127.0.0.1:3939/next")`；若有命令则用现有路由/handler 执行 TB API，再 `fetch("http://127.0.0.1:3939/done", { method: "POST", body: JSON.stringify({ request_id, result }) })`。  
   - 不包含 Native Messaging、不包含 Host、不包含 bridge；流程仅：外部 → 3939 服务 ↔ 扩展 fetch。

---

## 五、需要你拍板或补充的点

1. **是否同意先做「方案 A 最小验证」**（仅 manifest host_permissions + background 单次 fetch 127.0.0.1:3939）？若同意，我可以给出最小扩展 + 最小服务的具体代码片段和步骤，你在本机跑一遍即可确认。  
2. **若方案 A 不可行**，是否接受做「方案 B 的最小诊断」（Host 写标记文件 + 必要时看 stderr），专门用来定位「Host 为何断开」，再决定下一步？  
3. **“程序控制”必须包含哪些操作**？目前按「切换账号、发信、打开/标星邮件等」理解；若你希望最简版只保留 1～2 个动作（例如仅「发信」或仅「切换账号」），可进一步简化实现和测试。

确认以上三点后，可以按你选的路径给出「最小可跑通」的具体实现步骤与代码（从零、不依赖现有 Host/bridge 复杂逻辑）。
