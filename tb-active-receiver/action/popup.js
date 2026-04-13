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
