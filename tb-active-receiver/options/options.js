import { effectiveReportUrl } from "../lib/constants.js";

const browser = globalThis.browser ?? globalThis.messenger;

function t(id) {
  return browser.i18n.getMessage(id) || id;
}

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const k = el.getAttribute("data-i18n");
    const msg = browser.i18n.getMessage(k);
    if (msg) el.textContent = msg;
  });
  document.title = t("optionsTitle");
}

async function requestOriginsForUrl(urlStr) {
  const u = urlStr.trim();
  if (!u) return true;
  let uo;
  try {
    uo = new URL(u);
  } catch {
    return true;
  }
  if (uo.protocol !== "http:" && uo.protocol !== "https:") return true;
  const origin = `${uo.protocol}//${uo.host}`;
  const have = await browser.permissions.contains({ origins: [`${origin}/*`] });
  if (have) return true;
  return browser.permissions.request({ origins: [`${origin}/*`] });
}

async function load() {
  const { tbActiveReceiverOptions: opt } = await browser.storage.local.get("tbActiveReceiverOptions");
  const o = opt && typeof opt === "object" ? opt : {};
  document.getElementById("enabled").checked = o.enabled !== false;
  document.getElementById("pollMinutes").value = String(o.pollIntervalMinutes ?? 1);
  document.getElementById("pollAll").checked = o.pollAllAccounts !== false;
  document.getElementById("monitorAllFolders").checked = o.monitorAllFolders !== false;
  document.getElementById("reportUrl").value = effectiveReportUrl(o.reportUrl);
  document.getElementById("reportIncludeBody").checked = o.reportIncludeBody !== false;
  document.getElementById("reportSecret").value = o.reportSecret ?? "";
  document.getElementById("mailTabFallback").checked = !!o.useMailTabFallback;
  document.getElementById("settleMs").value = String(o.settleAfterFetchMs ?? 3000);
}

async function save() {
  const status = document.getElementById("status");
  status.textContent = "";

  const reportUrl = effectiveReportUrl(document.getElementById("reportUrl").value);
  const okPerm = await requestOriginsForUrl(reportUrl);
  if (!okPerm) {
    status.textContent = t("optPermissionDenied");
  }

  const pollIntervalMinutes = Math.max(
    1,
    Math.min(1440, Math.floor(Number(document.getElementById("pollMinutes").value) || 1))
  );

  const settleAfterFetchMs = Math.max(
    500,
    Math.min(120000, Math.floor(Number(document.getElementById("settleMs").value) || 3000))
  );

  const { tbActiveReceiverOptions: prevRaw } = await browser.storage.local.get("tbActiveReceiverOptions");
  const base = prevRaw && typeof prevRaw === "object" ? prevRaw : {};

  await browser.storage.local.set({
    tbActiveReceiverOptions: {
      ...base,
      enabled: document.getElementById("enabled").checked,
      pollIntervalMinutes,
      pollAllAccounts: document.getElementById("pollAll").checked,
      monitorAllFolders: document.getElementById("monitorAllFolders").checked,
      reportUrl,
      reportIncludeBody: document.getElementById("reportIncludeBody").checked,
      reportSecret: document.getElementById("reportSecret").value.trim(),
      useMailTabFallback: document.getElementById("mailTabFallback").checked,
      settleAfterFetchMs,
    },
  });

  await browser.runtime.sendMessage({ type: "tbActiveRx.reloadSettings" });
  status.textContent = okPerm ? t("optSave") + " — OK" : t("optSave") + " — " + t("optPermissionDenied");
}

applyI18n();
load();

document.getElementById("save").addEventListener("click", () => {
  save();
});
