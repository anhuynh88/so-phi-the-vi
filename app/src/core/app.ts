import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv, Platform } from "./types";
import { authenticate, checkBasicPair, checkBearer } from "./auth";
import { addIngestedFile, createBlob, del, deleteBlobIfUnused, getBlob, isCol, listJson, logIngest, put, revs } from "./store";
import { downloadReport, handleWebhook } from "./adyen";
import { processEmail } from "./email";
import { HttpError, csvCell, isMonth, sha256Hex } from "./util";
import { mountAccounts, mountPublicAuth } from "./accounts";

/** mount: cho từng nền tảng gắn thêm đường /api riêng (sau bước đăng nhập, trước trang 404 của /api). */
export function createApp(platformOf: (c: Context) => Platform, mount?: (app: Hono<AppEnv>, needWrite: (c: Context<AppEnv>) => void) => void) {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      // tài khoản local: báo trình duyệt hiện hộp đăng nhập
      if (err.status === 401 && (c.get("p")?.cfg.AUTH_MODE || "").toLowerCase() === "basic") c.header("WWW-Authenticate", 'Basic realm="So phi the vi", charset="UTF-8"');
      return c.json({ code: err.code, message: err.message }, err.status as 400);
    }
    console.error(err);
    return c.json({ code: "internal", message: "Lỗi máy chủ." }, 500);
  });

  app.use("*", async (c, next) => { c.set("p", platformOf(c)); await next(); });

  const maxBytes = (p: Platform) => (Number(p.cfg.MAX_UPLOAD_MB) || 50) * 1048576;
  async function bodyBytes(c: Context<AppEnv>): Promise<Uint8Array> {
    const len = Number(c.req.header("content-length") || 0);
    if (len > maxBytes(c.get("p"))) throw new HttpError(413, "too_large", "File quá lớn.");
    const b = new Uint8Array(await c.req.arrayBuffer());
    if (b.byteLength > maxBytes(c.get("p"))) throw new HttpError(413, "too_large", "File quá lớn.");
    return b;
  }

  /* ---------------- đường không qua đăng nhập người dùng: có xác thực riêng */

  app.post("/webhooks/adyen", async (c) => {
    const p = c.get("p");
    checkBasicPair(c.req.raw, p.cfg.ADYEN_WEBHOOK_USER, p.cfg.ADYEN_WEBHOOK_PASS);
    let body: unknown;
    try { body = await c.req.json(); } catch { throw new HttpError(400, "invalid_argument", "JSON không hợp lệ."); }
    await handleWebhook(p, body);
    return c.text("[accepted]");
  });

  // agent trên máy nội bộ đẩy file: Authorization: Bearer <INGEST_TOKEN>
  app.post("/api/ingest", async (c) => {
    const p = c.get("p");
    checkBearer(c.req.raw, p.cfg.INGEST_TOKEN);
    const q = (k: string) => c.req.header("x-sophi-" + k) || c.req.query(k) || "";
    const name = decodeURIComponent(q("name"));
    if (!/\.(xlsx|xlsm|xls|csv|md|markdown|txt)$/i.test(name)) throw new HttpError(400, "unsupported_type", "Chỉ nhận .xlsx, .xls, .xlsm, .csv, .md, .txt.");
    const bytes = await bodyBytes(c);
    // agent gửi sẵn sha256 (đã xác thực bằng token) để Worker gói free không tốn CPU băm lại file lớn
    const claimed = q("sha256").toLowerCase();
    const sha = /^[0-9a-f]{64}$/.test(claimed) ? claimed : await sha256Hex(bytes);
    const agent = (q("agent") || "local").slice(0, 40);
    const r = await addIngestedFile(p, { month: q("month"), sec: q("sec"), acq: q("acq"), name, bytes, source: "agent", actor: "agent:" + agent, sha256: sha });
    await logIngest(p, "agent:" + sha.slice(0, 32) + ":" + q("month"), "agent", r.duplicate ? "duplicate" : "done", { name, month: q("month"), sec: q("sec"), acq: q("acq"), agent, fileId: r.id, size: bytes.byteLength });
    return c.json(r);
  });

  // đăng nhập / đăng xuất bằng form (AUTH_MODE=jwt)
  mountPublicAuth(app);

  /* ---------------- mọi đường còn lại: phải đăng nhập */

  // tài khoản phải đổi mật khẩu (mật khẩu tạm): chỉ được xem mình là ai và đổi mật khẩu
  const MUST_CHANGE_OK = new Set(["/api/me", "/api/auth/password", "/api/auth/logout-all"]);
  app.use("/api/*", async (c, next) => {
    const u = await authenticate(c.req.raw, c.get("p").cfg, c.get("p").db);
    if (u.mustChange && !MUST_CHANGE_OK.has(c.req.path)) throw new HttpError(403, "must_change_password", "Cần đổi mật khẩu trước khi dùng tiếp.");
    c.set("user", u);
    await next();
  });
  app.use("/_blob/*", async (c, next) => {
    const u = await authenticate(c.req.raw, c.get("p").cfg, c.get("p").db);
    if (u.mustChange) throw new HttpError(403, "must_change_password", "Cần đổi mật khẩu trước khi dùng tiếp.");
    c.set("user", u);
    await next();
  });
  const needWrite = (c: Context<AppEnv>) => {
    if (!c.get("user").canWrite) throw new HttpError(403, "invalid_argument", "Bạn chỉ có quyền xem.");
  };

  app.get("/api/me", (c) => {
    const u = c.get("user"), p = c.get("p");
    return c.json({ email: u.email, canWrite: u.canWrite, isAdmin: !!u.isAdmin, mustChange: !!u.mustChange, via: u.via, mode: p.mode, auth: (p.cfg.AUTH_MODE || "").toLowerCase() });
  });

  mountAccounts(app);

  app.get("/api/rev", async (c) => c.json(await revs(c.get("p"))));

  app.get("/api/c/:col", async (c) => {
    const col = c.req.param("col");
    if (!isCol(col)) throw new HttpError(404, "not_found", "Không có collection " + col);
    return new Response(await listJson(c.get("p"), col), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" } });
  });

  app.put("/api/c/:col/:id", async (c) => {
    needWrite(c);
    const col = c.req.param("col");
    if (!isCol(col)) throw new HttpError(404, "not_found", "Không có collection " + col);
    let data: Record<string, unknown>;
    try { data = await c.req.json(); } catch { throw new HttpError(400, "invalid_argument", "JSON không hợp lệ."); }
    await put(c.get("p"), col, c.req.param("id"), data, c.get("user").email);
    return c.json({ ok: true });
  });

  app.delete("/api/c/:col/:id", async (c) => {
    needWrite(c);
    const col = c.req.param("col");
    if (!isCol(col)) throw new HttpError(404, "not_found", "Không có collection " + col);
    await del(c.get("p"), col, c.req.param("id"), c.get("user").email);
    return c.json({ ok: true });
  });

  app.post("/api/blobs", async (c) => {
    needWrite(c);
    const bytes = await bodyBytes(c);
    const ct = (c.req.header("content-type") || "application/octet-stream").split(";")[0].trim();
    const sha = (c.req.header("x-sophi-sha256") || "").toLowerCase();
    const id = await createBlob(c.get("p"), bytes, ct, c.get("user").email, /^[0-9a-f]{64}$/.test(sha) ? sha : undefined);
    return c.json({ id });
  });

  app.delete("/api/blobs/:id", async (c) => {
    needWrite(c);
    await deleteBlobIfUnused(c.get("p"), c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/_blob/:id", async (c) => {
    const b = await getBlob(c.get("p"), c.req.param("id"));
    if (!b) throw new HttpError(404, "not_found", "Không tìm thấy file.");
    return new Response(b.body as BodyInit, {
      headers: { "content-type": b.contentType, "content-length": String(b.size), "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-disposition": "attachment" },
    });
  });

  // xuất dòng chi tiết phí (bảng fee_lines) ra CSV để mở bằng Excel
  app.get("/api/export/fee-lines.csv", async (c) => {
    const p = c.get("p"), m = c.req.query("month") || "";
    if (m && !isMonth(m)) throw new HttpError(400, "invalid_argument", "month phải dạng YYYY-MM");
    const rows = await p.db.all<Record<string, unknown>>(
      `SELECT month, sheet, gate, channel, acq, mech, brand, card_type, scope, cur, tx_count, sales_vnd, fee_vnd, refund_vnd, ic_vnd, scheme_vnd, markup_vnd, contract_fee_vnd, contract_text
       FROM fee_lines ${m ? "WHERE month = ?" : ""} ORDER BY month, gate, acq, brand`, m ? [m] : []);
    const cols = ["month", "sheet", "gate", "channel", "acq", "mech", "brand", "card_type", "scope", "cur", "tx_count", "sales_vnd", "fee_vnd", "refund_vnd", "ic_vnd", "scheme_vnd", "markup_vnd", "contract_fee_vnd", "contract_text"];
    const csv = "﻿" + [cols.join(","), ...rows.map((r) => cols.map((k) => csvCell(r[k])).join(","))].join("\r\n");
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="fee-lines${m ? "-" + m : ""}.csv"`, "cache-control": "private, no-store" } });
  });

  // nhật ký nhận file tự động (Adyen, email, agent)
  app.get("/api/ingest-log", async (c) => {
    const rows = await c.get("p").db.all<Record<string, unknown>>("SELECT id, source, status, detail, attempts, created_at, updated_at FROM ingest_log ORDER BY created_at DESC LIMIT 100");
    return c.json({ items: rows.map((r) => { let d: Record<string, unknown> = {}; try { d = JSON.parse(String(r.detail)); } catch { /* bỏ qua */ } delete d.url; delete d.key; return { ...r, detail: d }; }) });
  });

  app.post("/api/ingest-log/:id/retry", async (c) => {
    needWrite(c);
    const p = c.get("p"), id = c.req.param("id");
    if (id.startsWith("adyen:")) await downloadReport(p, id);
    else if (id.startsWith("email:")) await processEmail(p, id);
    else throw new HttpError(400, "invalid_argument", "Không thử lại được mục này.");
    return c.json({ ok: true });
  });

  mount?.(app, needWrite);

  app.all("/api/*", () => { throw new HttpError(404, "not_found", "Không có API này."); });

  return app;
}

/** Việc định kỳ: thử lại báo cáo Adyen / email lỗi hoặc còn chờ (tối đa 5 lần). */
export async function runMaintenance(p: Platform): Promise<void> {
  const cutoff = new Date(Date.now() - 5 * 60000).toISOString();
  const jobs = await p.db.all<{ id: string; source: string }>(
    "SELECT id, source FROM ingest_log WHERE status IN ('queued','failed') AND attempts < 5 AND COALESCE(updated_at, created_at) < ? ORDER BY created_at LIMIT 10", [cutoff]);
  for (const j of jobs) {
    if (j.source === "adyen") await downloadReport(p, j.id);
    else if (j.source === "email") await processEmail(p, j.id);
  }
}
