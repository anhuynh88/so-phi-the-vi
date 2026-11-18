import type { Platform } from "./types";
import { addIngestedFile, logIngest } from "./store";
import { b64, fromHex, HttpError, safeEqual } from "./util";

/* Webhook Adyen (standard notification) + tải báo cáo khi có REPORT_AVAILABLE.
   Theo docs.adyen.com:
   - chữ ký: HMAC-SHA256 (khoá hex → bytes) trên
     pspReference:originalReference:merchantAccountCode:merchantReference:value:currency:eventCode:success, base64,
     nằm ở additionalData.hmacSignature
   - REPORT_AVAILABLE: reason = URL tải, pspReference = tên file
   - tải bằng credential loại Report user (API key hoặc Basic auth), role Merchant Report Download */

export interface AdyenItem {
  pspReference?: string; originalReference?: string; merchantAccountCode?: string; merchantReference?: string;
  amount?: { value?: number | string; currency?: string }; eventCode?: string; success?: string | boolean;
  reason?: string; eventDate?: string; additionalData?: Record<string, string>;
}

export function signingString(it: AdyenItem): string {
  const v = (x: unknown) => (x == null ? "" : String(x));
  return [it.pspReference, it.originalReference, it.merchantAccountCode, it.merchantReference,
    it.amount?.value, it.amount?.currency, it.eventCode, it.success].map(v).join(":");
}

export async function hmacOf(it: AdyenItem, hexKey: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", fromHex(hexKey) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingString(it))));
}

export async function verifyItem(it: AdyenItem, hexKey: string): Promise<boolean> {
  const sig = it.additionalData?.hmacSignature;
  if (!sig) return false;
  return safeEqual(await hmacOf(it, hexKey), sig);
}

export function reportUrlOk(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && (url.hostname === "adyen.com" || url.hostname.endsWith(".adyen.com"));
  } catch { return false; }
}

/** Kỳ của báo cáo: ngày trong tên file (vd _2026_10_31), nếu không có thì theo eventDate, cuối cùng là tháng hiện tại. */
export function monthOfReport(name: string, eventDate?: string): string {
  const m = /(20\d{2})[_-]?(0[1-9]|1[0-2])[_-]?([0-2]\d|3[01])/.exec(name);
  if (m) return m[1] + "-" + m[2];
  const d = eventDate ? new Date(eventDate) : new Date();
  const dd = isNaN(d.getTime()) ? new Date() : d;
  return dd.getUTCFullYear() + "-" + String(dd.getUTCMonth() + 1).padStart(2, "0");
}

export async function handleWebhook(p: Platform, body: unknown): Promise<number> {
  const cfg = p.cfg;
  if (!cfg.ADYEN_HMAC_KEY) throw new HttpError(503, "webhook_not_configured", "Chưa đặt ADYEN_HMAC_KEY.");
  const items = ((body as { notificationItems?: { NotificationRequestItem?: AdyenItem }[] })?.notificationItems || [])
    .map((x) => x?.NotificationRequestItem).filter((x): x is AdyenItem => !!x);
  if (!items.length) throw new HttpError(400, "invalid_argument", "Không có notificationItems.");
  for (const it of items) if (!(await verifyItem(it, cfg.ADYEN_HMAC_KEY))) throw new HttpError(401, "bad_signature", "Chữ ký HMAC không đúng.");
  let queued = 0;
  for (const it of items) {
    if (it.eventCode !== "REPORT_AVAILABLE") continue;
    const name = String(it.pspReference || ""), url = String(it.reason || "");
    const id = "adyen:" + name.slice(0, 150);
    if (!name || !reportUrlOk(url)) { await logIngest(p, id, "adyen", "rejected", { name, url, why: "URL không thuộc adyen.com" }); continue; }
    const seen = await p.db.all<{ status: string }>("SELECT status FROM ingest_log WHERE id = ?", [id]);
    if (seen.length && seen[0].status === "done") continue;
    await logIngest(p, id, "adyen", "queued", { name, url, eventDate: it.eventDate || null, merchant: it.merchantAccountCode || null });
    p.waitUntil(downloadReport(p, id).catch(() => {}));
    queued++;
  }
  return queued;
}

export async function downloadReport(p: Platform, jobId: string): Promise<void> {
  const rows = await p.db.all<{ detail: string }>("SELECT detail FROM ingest_log WHERE id = ?", [jobId]);
  if (!rows.length) return;
  const d = JSON.parse(rows[0].detail || "{}") as { name: string; url: string; eventDate?: string };
  const cfg = p.cfg;
  try {
    if (!reportUrlOk(d.url)) throw new Error("URL không thuộc adyen.com");
    const headers: Record<string, string> = { "Accept-Encoding": "gzip" };
    if (cfg.ADYEN_REPORT_API_KEY) headers["X-API-Key"] = cfg.ADYEN_REPORT_API_KEY;
    else if (cfg.ADYEN_REPORT_USER && cfg.ADYEN_REPORT_PASS) headers.Authorization = "Basic " + btoa(cfg.ADYEN_REPORT_USER + ":" + cfg.ADYEN_REPORT_PASS);
    else throw new Error("Chưa đặt ADYEN_REPORT_API_KEY hoặc ADYEN_REPORT_USER/PASS");
    const res = await fetch(d.url, { headers, redirect: "manual" });
    if (!res.ok) throw new Error("Adyen trả mã " + res.status);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const r = await addIngestedFile(p, { month: monthOfReport(d.name, d.eventDate), sec: "ECOM", acq: cfg.ADYEN_ACQ || "adyen", name: d.name, bytes, source: "adyen", actor: "adyen-webhook" });
    await logIngest(p, jobId, "adyen", r.duplicate ? "duplicate" : "done", { ...d, fileId: r.id, size: bytes.byteLength }, true);
  } catch (e) {
    await logIngest(p, jobId, "adyen", "failed", { ...d, error: (e as Error).message }, true);
  }
}
