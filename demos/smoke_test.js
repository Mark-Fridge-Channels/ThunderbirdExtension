/**
 * 最小流程测试：只发一条 switch_account_context，验证「外部程序 → minimal-server → 插件 → Thunderbird」整条链路。
 * 不发邮件、不改邮件状态，仅切换上下文并返回账号/文件夹信息。
 *
 * 前置：1) node minimal-server/server.js  2) Thunderbird 已加载 extension  3) 执行本脚本
 *   export TEST_ACCOUNT_EMAIL=你的邮箱@example.com
 *   node demos/smoke_test.js
 */

const BASE = "http://127.0.0.1:3939";

async function run() {
  const email = process.env.TEST_ACCOUNT_EMAIL || "mark@fridgechannels.com";
  const requestId = `smoke-${Date.now()}`;

  const res = await fetch(`${BASE}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: requestId,
      action: "switch_account_context",
      payload: { email },
    }),
  });

  if (!res.ok) {
    console.error("HTTP", res.status, res.statusText);
    console.error("确保：1) node minimal-server/server.js 已运行 2) Thunderbird 已加载 extension 3) 端口 3939 可访问");
    process.exit(1);
  }

  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));

  if (data.success) {
    console.log("\n链路正常：外部程序 → minimal-server → 插件 → Thunderbird API 已打通。");
    console.log("当前上下文 accountId:", data.result?.accountId);
    console.log("文件夹数量:", data.result?.folders?.length ?? 0);
  } else {
    console.error("失败:", data.error?.message || data.error);
    process.exit(1);
  }
}

run().catch((e) => {
  console.error(e.message || e);
  console.error("若连接被拒，请先运行 node minimal-server/server.js 并在 Thunderbird 中加载 extension。");
  process.exit(1);
});
