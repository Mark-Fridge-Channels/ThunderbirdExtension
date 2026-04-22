const browser = globalThis.browser ?? globalThis.messenger;

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const k = el.getAttribute("data-i18n");
    const msg = browser.i18n.getMessage(k);
    if (msg) el.textContent = msg;
  });
}

async function refresh() {
  const out = document.getElementById("out");
  const res = await browser.runtime.sendMessage({ type: "tbActiveRx.getStatus" });
  if (res?.ok) {
    out.textContent = JSON.stringify(res.status, null, 2);
  } else {
    out.textContent = res?.error ?? "error";
  }
}

applyI18n();
refresh();

document.getElementById("fetchAll").addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "tbActiveRx.fetchNowAll" });
  await refresh();
});

document.getElementById("fetchCurrent").addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "tbActiveRx.fetchNowCurrent" });
  await refresh();
});

document.getElementById("reconcileInbox").addEventListener("click", async () => {
  const btn = document.getElementById("reconcileInbox");
  btn.disabled = true;
  btn.textContent = "Reconciling…";
  try {
    await browser.runtime.sendMessage({ type: "tbActiveRx.reconcileInboxNow" });
  } finally {
    btn.disabled = false;
    btn.textContent = "Reconcile Inbox Now";
  }
  await refresh();
});

document.getElementById("debugLogInbox").addEventListener("click", async () => {
  const btn = document.getElementById("debugLogInbox");
  btn.disabled = true;
  btn.textContent = "Logging…";
  try {
    await browser.runtime.sendMessage({ type: "tbActiveRx.debugLogInbox" });
  } finally {
    btn.disabled = false;
    btn.textContent = "Log Inbox messages";
  }
  await refresh();
});

async function runSentMailScan({ entireSent }) {
  const out = document.getElementById("out");
  const startedAt = Date.now();
  console.log(`[TB Active Receiver][popup] scanSentMail click mode=${entireSent ? "entire" : "recent"}`);
  const res = await browser.runtime.sendMessage({
    type: "tbActiveRx.scanSentMail",
    entireSent: !!entireSent,
  });
  const elapsedMs = Date.now() - startedAt;
  if (res?.ok) {
    console.log(
      `[TB Active Receiver][popup] scanSentMail result totalPosted=${res.result?.totalPosted ?? 0} accounts=${res.result?.perAccount?.length ?? 0} elapsedMs=${elapsedMs}`
    );
    out.textContent = JSON.stringify(res.result, null, 2);
  } else {
    console.warn(`[TB Active Receiver][popup] scanSentMail error: ${res?.error ?? "unknown"}`);
    out.textContent = res?.error ?? "error";
  }
}

document.getElementById("scanSentMail").addEventListener("click", async () => {
  const btn = document.getElementById("scanSentMail");
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Scanning…";
  try {
    await runSentMailScan({ entireSent: false });
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

document.getElementById("scanSentMailAll").addEventListener("click", async () => {
  const btn = document.getElementById("scanSentMailAll");
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Scanning all…";
  try {
    await runSentMailScan({ entireSent: true });
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});
