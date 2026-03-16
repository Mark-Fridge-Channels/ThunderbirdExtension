#!/usr/bin/env node
/**
 * 流程测试：mark@fridgechannels.com 发信给 oh.duang@gmail.com → 后者切换账号、打开邮件、标星、回复。
 *
 * 1. 切换 mark@fridgechannels.com，给 oh.duang@gmail.com 发「尽快处理问题」
 * 2. 切换 oh.duang@gmail.com，打开该邮件并标星，回复「知道了，3天内解决」
 *
 * 前置：node minimal-server/server.js 已运行，Thunderbird 已加载 extension。
 * 若步骤 4 报「No message matching query」，多为收件箱尚未同步，可等几秒后重跑。
 *
 * node demos/demo_flow_mark_to_oh.js
 */

const BASE = "http://127.0.0.1:3939";

async function postCommand(action, payload, options = {}) {
  const requestId = options.requestId ?? `flow-${action}-${Date.now()}`;
  const body = { request_id: requestId, action, payload };
  if (options.idempotencyKey) body.idempotency_key = options.idempotencyKey;
  const res = await fetch(`${BASE}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || JSON.stringify(data.error));
  return data;
}

async function run() {
  const subject = "尽快处理问题";

  console.log("1. 切换 mark@fridgechannels.com …");
  await postCommand("switch_account_context", { email: "mark@fridgechannels.com" });
  console.log("   OK\n");

  console.log("2. 给 oh.duang@gmail.com 发信：「尽快处理问题」…");
  await postCommand("send_email", {
    to: "oh.duang@gmail.com",
    subject,
    plainTextBody: "尽快处理问题",
    isPlainText: true,
  });
  console.log("   OK\n");

  console.log("3. 切换 oh.duang@gmail.com …");
  const switchOh = await postCommand("switch_account_context", { email: "oh.duang@gmail.com" });
  const accountIdOh = switchOh.result?.accountId;
  if (!accountIdOh) throw new Error("switch_account_context 未返回 accountId");
  console.log("   OK accountId:", accountIdOh, "\n");

  console.log("4. 等待 30s 以便收件箱同步 …");
  await new Promise((r) => setTimeout(r, 30000));

  console.log("   打开收件箱中主题「尽快处理问题」的邮件 …");
  const openRes = await postCommand("open_message", {
    accountId: accountIdOh,
    folderPath: "INBOX",
    subject,
    open_mode: "tab",
  });
  const headerMessageId = openRes.result?.stableIdentifiers?.headerMessageId;
  if (!headerMessageId) throw new Error("open_message 未返回 stableIdentifiers.headerMessageId");
  console.log("   OK messageId:", openRes.result?.messageId, "headerMessageId:", headerMessageId, "\n");

  console.log("5. 标星该邮件（用 headerMessageId 精确定位）…");
  await postCommand("star_message", {
    accountId: accountIdOh,
    folderPath: "INBOX",
    headerMessageId,
    starred: true,
  });
  console.log("   OK\n");

  console.log("6. 回复「知道了，3天内解决」（用 headerMessageId + idempotency_key 防重复）…");
  await postCommand("reply_message", {
    accountId: accountIdOh,
    folderPath: "INBOX",
    headerMessageId,
    plainTextBody: "知道了，3天内解决",
    isPlainText: true,
  }, { idempotencyKey: `reply-${headerMessageId}` });
  console.log("   OK\n");

  console.log("流程结束：已发信、切换账号、打开并标星、回复。");
}

run().catch((e) => {
  console.error(e.message || e);
  console.error("确保：node minimal-server/server.js 已运行，extension 已加载，且两台邮箱均已配置。");
  process.exit(1);
});
