import PostalMime from "postal-mime";
import type { Platform } from "./types";
import { addIngestedFile, logIngest } from "./store";
import { OK_EXT, isMonth, now, rid } from "./util";

/* Nhận báo cáo qua email (Cloudflare Email Routing → Email Worker).
   Bước 1 luôn cất nguyên email (.eml) trước, rồi mới đọc file đính kèm; đọc lỗi/hết CPU thì cron đọc lại sau.
   Chỉ nhận khi:
   - header Authentication-Results ĐẦU TIÊN (do mx.cloudflare.net thêm vào) có dmarc=pass
     (các header cùng tên phía dưới có thể do người gửi tự chèn nên không tin), và
   - địa chỉ From trong thư (thứ DMARC xác nhận) khớp một dòng trong config "email_routes".
     Địa chỉ phong bì (MAIL FROM) chỉ dùng để lọc sơ bộ. */

export interface EmailRoute {
  from: string;          // regex khớp địa chỉ người gửi, vd "@adyen\\.com$"
  sec: "ECOM" | "BSP" | "BANK STATEMENT";
  acq: string;           // id thư mục acquirer ("" cho BANK STATEMENT)
  monthOffset?: number;  // -1 = báo cáo gửi đầu tháng sau cho tháng trước
  name?: string;         // regex lọc tên file đính kèm (tuỳ chọn)
  allowNoDmarc?: boolean;
}

async function routes(p: Platform): Promise<EmailRoute[]> {
  const r = await p.db.all<{ data: string }>("SELECT data FROM config WHERE id = 'email_routes'");
  try { const v = JSON.parse(r[0]?.data || "{}"); return Array.isArray(v.routes) ? v.routes : []; } catch { return []; }
}

const matches = (re: string, s: string) => { try { return new RegExp(re, "i").test(s); } catch { return false; } };

/** value = header Authentication-Results đầu tiên (một header, không phải chuỗi đã gộp) */
export function dmarcPass(firstAuthResults: string | null | undefined): boolean {
  return !!firstAuthResults && /^\s*mx\.cloudflare\.net\b/i.test(firstAuthResults) && /\bdmarc=pass\b/i.test(firstAuthResults);
}

export function monthFor(date: Date, offset = 0): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

export async function receiveEmail(p: Platform, msg: { from: string; to: string; raw: Uint8Array }): Promise<string> {
  const id = "email:" + rid();
  const key = "inbox/" + id.slice(6) + ".eml";
  await p.blobs.put(key, msg.raw);
  await logIngest(p, id, "email", "queued", { key, from: msg.from, to: msg.to, at: now(), size: msg.raw.byteLength });
  return id;
}

export async function processEmail(p: Platform, jobId: string): Promise<void> {
  const rows = await p.db.all<{ detail: string }>("SELECT detail FROM ingest_log WHERE id = ?", [jobId]);
  if (!rows.length) return;
  const d = JSON.parse(rows[0].detail || "{}") as { key: string; from: string; to: string; at: string };
  try {
    const all = await routes(p);
    // lọc sơ bộ theo địa chỉ phong bì: không khớp dòng nào thì khỏi đọc email
    if (!all.some((r) => matches(r.from, d.from))) { await logIngest(p, jobId, "email", "rejected", { ...d, why: "Người gửi chưa có trong email_routes" }, true); return; }
    const raw = await p.blobs.get(d.key);
    if (!raw) throw new Error("Không thấy email gốc " + d.key);
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(await new Response(raw).arrayBuffer());
    const mail = await PostalMime.parse(bytes);
    const headerFrom = mail.from && "address" in mail.from && mail.from.address ? mail.from.address : "";
    const firstAuth = (mail.headers || []).find((h) => h.key === "authentication-results")?.value;
    const dmarc = dmarcPass(firstAuth);
    const info = { ...d, headerFrom, dmarc, subject: (mail.subject || "").slice(0, 200) };
    const route = all.find((r) => matches(r.from, headerFrom) && matches(r.from, d.from));
    if (!route) { await logIngest(p, jobId, "email", "rejected", { ...info, why: "Địa chỉ From trong thư không khớp email_routes" }, true); return; }
    if (!dmarc && !route.allowNoDmarc) { await logIngest(p, jobId, "email", "rejected", { ...info, why: "Email không qua DMARC" }, true); return; }
    const month = monthFor(mail.date ? new Date(mail.date) : new Date(d.at), route.monthOffset || 0);
    if (!isMonth(month)) throw new Error("Không xác định được kỳ");
    const nameRe = route.name ? new RegExp(route.name, "i") : null;
    const saved: string[] = [], skipped: string[] = [];
    for (const att of mail.attachments || []) {
      const name = att.filename || "dinh-kem";
      if (!OK_EXT.test(name) || (nameRe && !nameRe.test(name))) { skipped.push(name); continue; }
      const content = typeof att.content === "string" ? new TextEncoder().encode(att.content) : new Uint8Array(att.content as ArrayBuffer);
      const r = await addIngestedFile(p, { month, sec: route.sec, acq: route.acq || "", name, bytes: content, source: "email", actor: "email:" + headerFrom });
      saved.push(name + (r.duplicate ? " (trùng)" : ""));
    }
    await logIngest(p, jobId, "email", saved.length ? "done" : "rejected", { ...info, month, saved, skipped, why: saved.length ? undefined : "Không có file đính kèm hợp lệ" }, true);
  } catch (e) {
    await logIngest(p, jobId, "email", "failed", { ...d, error: (e as Error).message }, true);
  }
}
