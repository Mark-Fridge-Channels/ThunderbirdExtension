# 项目目录结构

与 [webext-examples (manifest_v3)](https://github.com/thunderbird/webext-examples/tree/master/manifest_v3) 和 [Thunderbird 插件介绍](https://developer.thunderbird.net/add-ons/about-add-ons) 的对照：

- **manifest**：使用 `browser_specific_settings.gecko`、`strict_min_version`（128.0）、MV3；background 使用 **`scripts` + `type: "module"`**（与官方示例一致，便于事件页生命周期正确触发）。
- **目录**：官方示例多为「单层」即 `manifest.json` 与 `background.js` 同目录；本项目在 `extension/` 下用 **background/**、**handlers/**、**adapters/**、**shared/** 多目录，便于多 action 分层，manifest 中通过 `background/background.js` 引用入口。
- **通信**：无 Native Messaging；扩展通过 **host_permissions** 访问 `http://127.0.0.1:3939/*`，轮询 minimal-server 的 GET /next，执行后 POST /done；外部程序 POST /command 到 minimal-server。

```
ThunderbirdExtension/
├── README.md                 # 安装、运行、测试说明
├── DESIGN.md                 # 系统设计说明
├── STRUCTURE.md              # 本文件：目录结构
├── LOCAL_DEBUG.md            # 本地调试步骤
├── EXPERIMENT_BOUNDARY.md    # 未来 Experiment API 边界清单
├── scripts/
│   └── build-xpi.sh          # 打包 extension.xpi
│
├── extension/
│   ├── manifest.json
│   ├── VENDOR.md             # 第三方库说明（当前无）
│   ├── _locales/
│   │   └── en/
│   │       └── messages.json
│   ├── background/
│   │   ├── background.js     # 唯一命令入口：轮询 minimal-server，调用 router
│   │   ├── background.html   # 已不用作入口，可删；调试见 LOCAL_DEBUG
│   │   ├── router.js         # 按 action 分发到 handler
│   │   └── state.js          # 当前 accountId/identityId 上下文
│   ├── handlers/
│   │   ├── switchAccount.js
│   │   ├── sendEmail.js
│   │   ├── openMessage.js
│   │   ├── starMessage.js
│   │   ├── addContact.js
│   │   └── forwardMessage.js
│   ├── adapters/
│   │   ├── accountsAdapter.js
│   │   ├── messagesAdapter.js
│   │   ├── composeAdapter.js
│   │   ├── contactsAdapter.js
│   │   └── tabsAdapter.js
│   └── shared/
│       ├── schemas.js        # 请求/ payload 校验
│       ├── errors.js         # 统一错误码与响应格式
│       └── logger.js         # 日志与审计
│
├── minimal-server/
│   ├── server.js             # HTTP 服务：/ping, /command, /next, /done
│   ├── README.md             # 方案 A 验证与测试说明
│   └── smoke_test.js         # 单次 switch_account 测试（可选）
│
└── demos/
    ├── smoke_test.js         # 最小链路：switch_account_context
    ├── smoke_all_actions.js  # 覆盖 6 个 action 的回归
    ├── demo1_switch_and_send.js   # 切换账号 + 发信
    ├── demo2_open_and_star.js     # 按条件打开邮件并标星
    └── demo3_add_contact.js       # 创建联系人
```
