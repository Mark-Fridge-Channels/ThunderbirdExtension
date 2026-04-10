/**
 * Built-in minimal-server webhook (matches default `tb_receiver_report_path`).
 * Empty storage / empty options field resolves to this URL.
 */
export const DEFAULT_REPORT_URL = "http://127.0.0.1:3939/tb-active-receiver/report";

export function effectiveReportUrl(stored) {
  const t = String(stored ?? "").trim();
  return t || DEFAULT_REPORT_URL;
}
