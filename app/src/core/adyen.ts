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

/* ---------------- Kéo báo cáo theo lịch (không cần webhook).
   Báo cáo cấp công ty Adyen tự sinh mỗi ngày (cho ngày hôm trước), tên file đoán được theo ngày:
     settlement_detail_report_YYYY-MM-DD_YYYY-MM-DD.csv   (Settlement details, company-level)
     payments_accounting_report_YYYY_MM_DD.csv           (Payment accounting)
     received_payments_report_YYYY_MM_DD.csv             (Received payment details)
   Mỗi lần chạy thử các ngày trong PULL_DAYS ngày gần nhất; file chưa có (404) thì bỏ qua, lần sau thử lại.
   Chỉ dùng credential Report user (role Merchant Report Download), tức là chỉ đọc. */

export const PULL_CRON = "0 14 * * *"; // 21:00 giờ Việt Nam (UTC+7)
const PULL_DAYS = 3;

export const COMPANY_REPORTS: { key: string; name: (d: string) => string }[] = [
  { key: "settlement", name: (d) => `settlement_detail_report_${d}_${d}.csv` },
  { key: "payments_accounting", name: (d) => `payments_accounting_report_${d.replace(/-/g, "_")}.csv` },
  { key: "received_payments", name: (d) => `received_payments_report_${d.replace(/-/g, "_")}.csv` },
];

export interface PullResult { company: string; got: string[]; missing: string[]; failed: string[]; stoppedBy?: string }

function reportBase(cfg: Platform["cfg"]): string {
  return (cfg.ADYEN_REPORT_BASE || "https://ca-live.adyen.com/reports/download").replace(/\/+$/, "");
}

function authHeaders(cfg: Platform["cfg"]): Record<string, string> {
  if (cfg.ADYEN_REPORT_API_KEY) return { "X-API-Key": cfg.ADYEN_REPORT_API_KEY };
  if (cfg.ADYEN_REPORT_USER && cfg.ADYEN_REPORT_PASS) return { Authorization: "Basic " + btoa(cfg.ADYEN_REPORT_USER + ":" + cfg.ADYEN_REPORT_PASS) };
  throw new Error("Chưa đặt ADYEN_REPORT_API_KEY hoặc ADYEN_REPORT_USER/PASS");
}

/** Các ngày báo cáo (YYYY-MM-DD) cần thử: hôm qua theo giờ Việt Nam và lùi thêm, mới nhất trước. */
export function reportDays(nowIso: string, days = PULL_DAYS): string[] {
  const vn = new Date(new Date(nowIso).getTime() + 7 * 3600_000);
  const out: string[] = [];
  for (let i = 1; i <= days; i++) out.push(new Date(vn.getTime() - i * 86400_000).toISOString().slice(0, 10));
  return out;
}

export async function pullCompanyReports(p: Platform, company: string, nowIso = new Date().toISOString()): Promise<PullResult> {
  const out: PullResult = { company, got: [], missing: [], failed: [] };
  const headers = authHeaders(p.cfg);
  outer: for (const day of reportDays(nowIso)) {
    for (const r of COMPANY_REPORTS) {
      const name = r.name(day);
      const id = "adyen:" + name;
      const seen = await p.db.all<{ status: string }>("SELECT status FROM ingest_log WHERE id = ?", [id]);
      if (seen.length && ["done", "duplicate", "rejected"].includes(seen[0].status)) continue;
      const url = `${reportBase(p.cfg)}/Company/${encodeURIComponent(company)}/${name}`;
      let res: Response;
      try { res = await fetch(url, { headers, redirect: "manual" }); }
      catch (e) { out.stoppedBy = "network: " + String((e as Error)?.message || e).slice(0, 200); break outer; }
      if (res.status === 404) { out.missing.push(name); continue; }
      if (res.status === 401 || res.status === 403) { out.stoppedBy = "Adyen từ chối key (" + res.status + ")"; break outer; }
      const detail = { name, url, eventDate: day + "T00:00:00Z" };
      if (!res.ok) { await logIngest(p, id, "adyen", "failed", { ...detail, error: "Adyen trả mã " + res.status }, true); out.failed.push(name); continue; }
      try {
        const bytes = new Uint8Array(await res.arrayBuffer());
        const f = await addIngestedFile(p, { month: day.slice(0, 7), sec: "ECOM", acq: p.cfg.ADYEN_ACQ || "adyen", name, bytes, source: "adyen", actor: "adyen-cron" });
        await logIngest(p, id, "adyen", f.duplicate ? "duplicate" : "done", { ...detail, fileId: f.id, size: bytes.byteLength }, true);
        out.got.push(name);
      } catch (e) {
        // vd file quá 25 MB khi kho là KV: thử lại không giúp gì nên đánh dấu rejected
        const msg = String((e as Error)?.message || e).slice(0, 300);
        await logIngest(p, id, "adyen", /quá 25 MB/.test(msg) ? "rejected" : "failed", { ...detail, error: msg }, true);
        out.failed.push(name);
      }
    }
  }
  await logIngest(p, "adyen-pull:" + company, "adyen-pull", "state", { at: nowIso, ...out });
  return out;
}

/** Chạy cho mọi công ty trong ADYEN_PULL_COMPANY (cách nhau dấu phẩy). */
export async function runAdyenPull(p: Platform, nowIso?: string): Promise<PullResult[]> {
  const list = (p.cfg.ADYEN_PULL_COMPANY || "").split(",").map((s) => s.trim()).filter(Boolean);
  const out: PullResult[] = [];
  for (const c of list) {
    try { out.push(await pullCompanyReports(p, c, nowIso)); }
    catch (e) { out.push({ company: c, got: [], missing: [], failed: [], stoppedBy: "lỗi: " + String((e as Error)?.message || e).slice(0, 200) }); }
  }
  return out;
}
