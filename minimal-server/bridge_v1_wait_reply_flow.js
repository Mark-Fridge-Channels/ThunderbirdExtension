#!/usr/bin/env node
/**
 * E2E：sendEmail（AdrianZ → oh.duang）→ 轮询收件箱直到出现对方回信 → replyEmail。
 *
 * 前置：node minimal-server/server.js + Thunderbird 已加载扩展；AdrianZ 账号可在 TB 里正常发信/收信。
 *
 * 运行（会真实发信与回复）：
 *   SEND_REAL=1 node minimal-server/bridge_v1_wait_reply_flow.js
 *
 * 可选环境变量（覆盖默认）：
 *   BASE=http://127.0.0.1:3939
 *   SENDER_EMAIL=AdrianZ@fcpartners.co
 *   RECIPIENT_TO=oh.duang@gmail.com
 *   REPLY_FROM_EMAIL=oh.duang@gmail.com   # 轮询「发件人含此邮箱」的回信
 *   POLL_INTERVAL_MS=15000
 *   POLL_TIMEOUT_MS=1800000               # 30 分钟
 *   SUBJECT=... OUTGOING_BODY='...' REPLY_BODY='...'  # 覆盖正文（多行建议 export 或改脚本内常量）
 *
 * 不会自动读 .env；请自己在 shell 里 export。
 */

const BASE = process.env.BASE || "http://127.0.0.1:3939";
const SEND_REAL = process.env.SEND_REAL === "1" || process.env.SEND_REAL === "true";

const SENDER_EMAIL = (process.env.SENDER_EMAIL || "AdrianZ@fcpartners.co").trim().toLowerCase();
const RECIPIENT_TO = (process.env.RECIPIENT_TO || "oh.duang@gmail.com").trim();
const REPLY_FROM_NEEDLE = (process.env.REPLY_FROM_EMAIL || "oh.duang@gmail.com").trim().toLowerCase();

const POLL_INTERVAL_MS = Math.max(3000, parseInt(process.env.POLL_INTERVAL_MS || "15000", 10) || 15000);
const POLL_TIMEOUT_MS = Math.max(60000, parseInt(process.env.POLL_TIMEOUT_MS || String(30 * 60 * 1000), 10) || 30 * 60 * 1000);

const DEFAULT_SUBJECT = "New email — hit me here";

const DEFAULT_BODY = `Mark,

Yo — quick heads up, this is my new email.

I'm moving everything over to this inbox, so just use this one from now on. Shoot me a quick reply when you see this so I know it landed.

Catch up soon.
AdrianZ`;

const DEFAULT_REPLY_BODY = `Damn didn't expect an email reply this quick 😂 respect
Yeah I'm around later — what's going on?`;

const SUBJECT = process.env.SUBJECT != null && String(process.env.SUBJECT).length
  ? String(process.env.SUBJECT)
  : DEFAULT_SUBJECT;

const OUTGOING_BODY = process.env.OUTGOING_BODY != null && String(process.env.OUTGOING_BODY).length
  ? String(process.env.OUTGOING_BODY)
  : DEFAULT_BODY;

const REPLY_BODY = process.env.REPLY_BODY != null && String(process.env.REPLY_BODY).length
  ? String(process.env.REPLY_BODY)
  : DEFAULT_REPLY_BODY;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function postCommand(action, payload, requestId) {
  const rid = requestId || `${action}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(`${BASE}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: rid, action, payload }),
  });
  const data = await res.json().catch(() => ({}));
  return { httpStatus: res.status, ...data };
}

function findIdentityAndAccount(accountsPayload, emailLower) {
  for (const acc of accountsPayload.accounts || []) {
    for (const idn of acc.identities || []) {
      if ((idn.email || "").trim().toLowerCase() === emailLower) {
        return { accountId: acc.accountId, identityId: idn.identityId };
      }
    }
  }
  return null;
}

function findInboxFolderId(root) {
  if (!root) return null;
  if (Array.isArray(root.specialUse) && root.specialUse.includes("inbox")) return root.folderId;
  for (const s of root.subFolders || []) {
    const x = findInboxFolderId(s);
    if (x) return x;
  }
  return null;
}

function subjectHints(originalSubject) {
  const s = originalSubject.trim().toLowerCase();
  const short = s.length > 24 ? s.slice(0, 24) : s;
  return { full: s, short };
}

/**
 * 判定：来自 REPLY_FROM 的来信，且在发信之后；主题看起来像对原信的回复。
 */
function isExpectedReply(msg, sentAtMs, subjectHint) {
  if (!msg || msg.messageId == null) return false;
  const auth = (msg.author || "").toLowerCase();
  if (!auth.includes(REPLY_FROM_NEEDLE)) return false;

  const d = msg.date ? new Date(msg.date).valueOf() : 0;
  if (!d || d < sentAtMs - 120000) return false;

  const sub = (msg.subject || "").toLowerCase();
  if (sub.includes(subjectHint.short) || sub.includes(subjectHint.full)) return true;
  if (sub.startsWith("re:") && subjectHint.full.length > 8 && sub.includes(subjectHint.full.slice(0, 12))) return true;
  return false;
}

async function main() {
  if (!SEND_REAL) {
    console.error("Refuse to send: set SEND_REAL=1 (sends real mail and replies).");
    process.exit(1);
  }

  console.error("[flow] listAccounts …");
  const listRes = await postCommand("listAccounts", { includeSubFolders: true }, "flow-listAccounts");
  if (!listRes.success) {
    console.error(JSON.stringify(listRes, null, 2));
    process.exit(1);
  }

  const ctx = findIdentityAndAccount(listRes.result, SENDER_EMAIL);
  if (!ctx) {
    console.error(`[flow] No account identity matches SENDER_EMAIL=${SENDER_EMAIL} (from listAccounts).`);
    process.exit(1);
  }
  const { accountId, identityId } = ctx;

  const accObj = (listRes.result.accounts || []).find((a) => a.accountId === accountId);
  const inboxFolderId = findInboxFolderId(accObj?.rootFolder);
  if (!inboxFolderId) {
    console.error("[flow] Could not resolve Inbox folderId (specialUse inbox).");
    process.exit(1);
  }

  console.error("[flow] sendEmail …", { accountId, identityId, to: RECIPIENT_TO, subject: SUBJECT });
  const sendRes = await postCommand(
    "sendEmail",
    {
      accountId,
      identityId,
      to: [RECIPIENT_TO],
      cc: [],
      bcc: [],
      subject: SUBJECT,
      body: OUTGOING_BODY,
      bodyFormat: "plain",
      sendMode: "sendNow",
    },
    "flow-sendEmail"
  );
  console.log("sendEmail:", JSON.stringify(sendRes, null, 2));
  if (!sendRes.success) process.exit(1);

  const sentAtMs = Date.now();
  const hint = subjectHints(SUBJECT);
  const fromDate = new Date(sentAtMs - 60000);
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  console.error(
    `[flow] 等待 ${REPLY_FROM_NEEDLE} 的回信（每 ${POLL_INTERVAL_MS}ms 查一次 Inbox，最长 ${Math.round(POLL_TIMEOUT_MS / 60000)} 分钟）…`
  );

  let replyMsg = null;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const findRes = await postCommand(
      "findMessages",
      {
        accountId,
        folderId: inboxFolderId,
        includeSubFolders: false,
        fromDate: fromDate.toISOString(),
        limit: 50,
        messagesPerPage: 50,
      },
      `flow-findMessages-${Date.now()}`
    );

    if (!findRes.success) {
      console.error("[flow] findMessages failed:", JSON.stringify(findRes, null, 2));
      continue;
    }

    const items = findRes.result?.items || [];
    const candidates = items
      .filter((m) => isExpectedReply(m, sentAtMs, hint))
      .sort((a, b) => {
        const da = new Date(a.date || 0).valueOf();
        const db = new Date(b.date || 0).valueOf();
        return db - da;
      });

    if (candidates.length > 0) {
      replyMsg = candidates[0];
      break;
    }
    console.error(`[flow] tick … 暂无匹配回信（共 ${items.length} 封候选窗口内邮件）`);
  }

  if (!replyMsg) {
    console.error("[flow] 超时：未在收件箱检测到符合条件的回信。");
    process.exit(1);
  }

  console.error("[flow] 检测到回信:", {
    messageId: replyMsg.messageId,
    headerMessageId: replyMsg.headerMessageId,
    author: replyMsg.author,
    subject: replyMsg.subject,
    date: replyMsg.date,
  });

  const replyOut = await postCommand(
    "replyEmail",
    {
      accountId,
      identityId,
      messageId: replyMsg.messageId,
      replyType: "replyToSender",
      body: REPLY_BODY,
      bodyFormat: "plain",
      sendMode: "sendNow",
    },
    "flow-replyEmail"
  );
  console.log("replyEmail:", JSON.stringify(replyOut, null, 2));
  if (!replyOut.success) process.exit(1);

  console.error("[flow] 完成：已回复对方来信。");
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
