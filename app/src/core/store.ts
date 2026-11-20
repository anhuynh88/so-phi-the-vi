import type { Platform, SqlStmt } from "./types";
import { EXT_CT, extOf, HttpError, isMonth, now, rid, validPlace, yymm } from "./util";

/* Các "collection" mà trang đang dùng (months, files, folders, config, contracts), lưu vào bảng SQL riêng. */

export const COLLECTIONS = ["months", "files", "folders", "config", "contracts"] as const;
export type Col = (typeof COLLECTIONS)[number];
export const isCol = (s: string): s is Col => (COLLECTIONS as readonly string[]).includes(s);

const CONFIG_IDS = ["terms", "email_routes"];
const MAX_DOC = 1_500_000;

export const bump = (col: string): SqlStmt => ({ sql: "INSERT INTO revs(col, rev) VALUES (?, 1) ON CONFLICT(col) DO UPDATE SET rev = rev + 1", params: [col] });
const audit = (actor: string, action: string, target: string): SqlStmt => ({ sql: "INSERT INTO audit_log(at, actor, action, target) VALUES (?, ?, ?, ?)", params: [now(), actor, action, target] });

export async function revs(p: Platform): Promise<Record<string, number>> {
  const rows = await p.db.all<{ col: string; rev: number }>("SELECT col, rev FROM revs");
  const o: Record<string, number> = {};
  for (const c of COLLECTIONS) o[c] = 0;
  for (const r of rows) o[r.col] = r.rev;
  return o;
}

/** Trả JSON {"docs":[{id, data, meta}]} bằng cách nối chuỗi JSON đã lưu sẵn, không parse lại:
    mỗi kỳ ~200 KB, parse + stringify mỗi lần tải trang dễ vượt 10 ms CPU của Worker gói free.
    data được kiểm tra là JSON object khi ghi (put) nên nối trực tiếp an toàn. Trang gộp meta vào data. */
export async function listJson(p: Platform, col: Col): Promise<string> {
  const item = (id: string, data: string, meta?: Record<string, unknown>) =>
    '{"id":' + JSON.stringify(id) + ',"data":' + (data && data[0] === "{" ? data : "{}") + (meta ? ',"meta":' + JSON.stringify(meta) : "") + "}";
  let parts: string[] = [];
  switch (col) {
    case "months":
      parts = (await p.db.all<{ key: string; data: string; saved_by: string }>("SELECT key, data, saved_by FROM months ORDER BY key"))
        .map((r) => item(r.key, r.data, { savedBy: r.saved_by }));
      break;
    case "files":
      parts = (await p.db.all<{ id: string; data: string; pending: number; source: string; created_by: string }>("SELECT id, data, pending, source, created_by FROM files ORDER BY month, name"))
        .map((r) => item(r.id, r.data, { pending: r.pending ? 1 : 0, src: r.source, by: r.created_by }));
      break;
    case "folders":
      parts = (await p.db.all<{ id: string; data: string }>("SELECT id, data FROM folders ORDER BY id")).map((r) => item(r.id, r.data));
      break;
    case "config":
      parts = (await p.db.all<{ id: string; data: string }>("SELECT id, data FROM config")).map((r) => item(r.id, r.data));
      break;
    case "contracts":
      parts = (await p.db.all<Record<string, unknown>>("SELECT * FROM fee_contracts ORDER BY sort, method, valid_from")).map((r) => item(String(r.id), JSON.stringify(r)));
      break;
  }
  return '{"docs":[' + parts.join(",") + "]}";
}

function str(v: unknown, max: number, field: string): string {
  if (v == null) return "";
  if (typeof v !== "string" && typeof v !== "number") throw new HttpError(400, "invalid_argument", field + " không hợp lệ");
  const s = String(v);
  if (s.length > max) throw new HttpError(400, "invalid_argument", field + " quá dài");
  return s;
}

export async function put(p: Platform, col: Col, id: string, data: Record<string, unknown>, actor: string): Promise<void> {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpError(400, "invalid_argument", "Dữ liệu phải là object.");
  const json = JSON.stringify(data);
  if (json.length > MAX_DOC) throw new HttpError(413, "too_large", "Bản ghi quá lớn.");
  const t = now();
  const stmts: SqlStmt[] = [];
  switch (col) {
    case "months": {
      if (!isMonth(id) || data.key !== id) throw new HttpError(400, "invalid_argument", "Kỳ phải dạng YYYY-MM và khớp key trong dữ liệu.");
      if (!Array.isArray(data.det) || !Array.isArray(data.acq)) throw new HttpError(400, "invalid_argument", "Thiếu det/acq.");
      const tot = (data.total || {}) as Record<string, unknown>;
      stmts.push({
        sql: `INSERT INTO months(key, period, file, total_ds, total_fee, data, saved_at, saved_by) VALUES (?,?,?,?,?,?,?,?)
              ON CONFLICT(key) DO UPDATE SET period=excluded.period, file=excluded.file, total_ds=excluded.total_ds, total_fee=excluded.total_fee,
              data=excluded.data, saved_at=excluded.saved_at, saved_by=excluded.saved_by`,
        params: [id, str(data.period, 100, "period"), str(data.file, 300, "file"), Number(tot.ds) || 0, Number(tot.fee) || 0, json, t, actor],
      });
      stmts.push({ sql: "DELETE FROM fee_lines WHERE month = ?", params: [id] });
      stmts.push({
        sql: `INSERT INTO fee_lines(month, sheet, gate, channel, acq, mech, brand, card_type, scope, cur, tx_count, sales_vnd, fee_vnd, refund_vnd, ic_vnd, scheme_vnd, markup_vnd, contract_fee_vnd, contract_text)
              SELECT m.key, json_extract(j.value,'$.s'), json_extract(j.value,'$.g'), json_extract(j.value,'$.k'), json_extract(j.value,'$.a'), json_extract(j.value,'$.m'),
                     json_extract(j.value,'$.b'), json_extract(j.value,'$.t'), json_extract(j.value,'$.p'), json_extract(j.value,'$.c'), json_extract(j.value,'$.n'),
                     json_extract(j.value,'$.v'), json_extract(j.value,'$.f'), json_extract(j.value,'$.r'), json_extract(j.value,'$.i'), json_extract(j.value,'$.h'),
                     json_extract(j.value,'$.u'), json_extract(j.value,'$.d'), json_extract(j.value,'$.x')
              FROM months m, json_each(m.data, '$.det') j WHERE m.key = ?`,
        params: [id],
      });
      break;
    }
    case "files": {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpError(400, "invalid_argument", "id file không hợp lệ");
      const m = String(data.m || ""), sec = String(data.sec || ""), acq = String(data.acq || "");
      if (!isMonth(m) || !validPlace(sec, acq)) throw new HttpError(400, "invalid_argument", "Kỳ / mục / acquirer không hợp lệ.");
      const clean = { ...data }; delete clean.pending; delete clean.src; delete clean.by; delete clean.buf; delete clean.local;
      stmts.push({
        sql: `INSERT INTO files(id, month, sec, acq, name, size, blob_id, source, pending, data, created_at, created_by) VALUES (?,?,?,?,?,?,?,'upload',?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET month=excluded.month, sec=excluded.sec, acq=excluded.acq, name=excluded.name, size=excluded.size,
              blob_id=excluded.blob_id, pending=excluded.pending, data=excluded.data`,
        params: [id, m, sec, acq, str(data.name, 200, "name"), Number(data.size) || 0, data.asset ? String(data.asset) : null, data.pending ? 1 : 0, JSON.stringify(clean), t, actor],
      });
      break;
    }
    case "folders":
      if (!/^\d{4}$/.test(id)) throw new HttpError(400, "invalid_argument", "Thư mục phải dạng YYMM.");
      stmts.push({ sql: "INSERT INTO folders(id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", params: [id, json] });
      break;
    case "config":
      if (!CONFIG_IDS.includes(id)) throw new HttpError(400, "invalid_argument", "Cấu hình không được hỗ trợ: " + id);
      stmts.push({ sql: "INSERT INTO config(id, data, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at, updated_by=excluded.updated_by", params: [id, json, t, actor] });
      break;
    case "contracts": {
      if (!/^[A-Za-z0-9_.-]{1,80}$/.test(id)) throw new HttpError(400, "invalid_argument", "id biểu phí không hợp lệ");
      const vf = String(data.valid_from || ""), vt = data.valid_to ? String(data.valid_to) : null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(vf) || (vt && (!/^\d{4}-\d{2}-\d{2}$/.test(vt) || vt < vf))) throw new HttpError(400, "invalid_argument", "Ngày hiệu lực không hợp lệ.");
      const pct = Number(data.pct);
      if (!(pct >= 0 && pct < 0.2)) throw new HttpError(400, "invalid_argument", "Tỷ lệ phí phải từ 0 đến 20% (nhập dạng thập phân, vd 0.018).");
      const re = str(data.match_re, 200, "match_re");
      try { new RegExp(re, "i"); } catch { throw new HttpError(400, "invalid_argument", "Biểu thức khớp phương thức không hợp lệ."); }
      stmts.push({
        sql: `INSERT INTO fee_contracts(id, method, market, acq, match_re, match_flags, pct, fixed_jpy, proc, label, source, valid_from, valid_to, sort, updated_at, updated_by)
              VALUES (?,?,?,?,?,'i',?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET method=excluded.method, market=excluded.market, acq=excluded.acq, match_re=excluded.match_re, pct=excluded.pct,
              fixed_jpy=excluded.fixed_jpy, proc=excluded.proc, label=excluded.label, source=excluded.source, valid_from=excluded.valid_from,
              valid_to=excluded.valid_to, sort=excluded.sort, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
        params: [id, str(data.method, 80, "method") || "?", str(data.market, 80, "market"), str(data.acq, 120, "acq"), re, pct, Number(data.fixed_jpy) || 0,
          data.proc ? 1 : 0, str(data.label, 120, "label"), str(data.source, 300, "source"), vf, vt, Number(data.sort) || 0, t, actor],
      });
      break;
    }
  }
  stmts.push(bump(col), audit(actor, "put", col + "/" + id));
  await p.db.batch(stmts);
}

export async function del(p: Platform, col: Col, id: string, actor: string): Promise<void> {
  const stmts: SqlStmt[] = [];
  let blob: string | null = null;
  switch (col) {
    case "months": stmts.push({ sql: "DELETE FROM fee_lines WHERE month = ?", params: [id] }, { sql: "DELETE FROM months WHERE key = ?", params: [id] }); break;
    case "files": {
      const r = await p.db.all<{ blob_id: string | null }>("SELECT blob_id FROM files WHERE id = ?", [id]);
      blob = r[0]?.blob_id || null;
      stmts.push({ sql: "DELETE FROM files WHERE id = ?", params: [id] });
      break;
    }
    case "folders": stmts.push({ sql: "DELETE FROM folders WHERE id = ?", params: [id] }); break;
    case "config": stmts.push({ sql: "DELETE FROM config WHERE id = ?", params: [id] }); break;
    case "contracts": stmts.push({ sql: "DELETE FROM fee_contracts WHERE id = ?", params: [id] }); break;
  }
  stmts.push(bump(col), audit(actor, "delete", col + "/" + id));
  await p.db.batch(stmts);
  if (blob) await deleteBlobIfUnused(p, blob);
}

/* ---------------------------------------------------------------- blobs (nội dung file) */

/** Giới hạn tổng dung lượng file gốc (STORAGE_LIMIT_MB). Vượt thì không nhận file mới, để không vượt gói miễn phí. */
export async function storageUsage(p: Platform): Promise<{ usedBytes: number; limitBytes: number }> {
  const r = await p.db.all<{ s: number | null }>("SELECT SUM(size) AS s FROM blobs WHERE offloaded = 0");
  const mb = Number(p.cfg.STORAGE_LIMIT_MB);
  return { usedBytes: Number(r[0]?.s || 0), limitBytes: mb > 0 ? mb * 1048576 : Infinity };
}

export async function createBlob(p: Platform, bytes: Uint8Array, contentType: string, actor: string, sha256?: string): Promise<string> {
  const { usedBytes, limitBytes } = await storageUsage(p);
  if (usedBytes + bytes.byteLength > limitBytes)
    throw new HttpError(507, "storage_full", `Kho file đã dùng ${(usedBytes / 1048576).toFixed(0)} MB, chạm giới hạn ${(limitBytes / 1048576).toFixed(0)} MB (STORAGE_LIMIT_MB). Xoá bớt file cũ hoặc nâng giới hạn.`);
  const id = rid("b");
  await p.blobs.put("blobs/" + id, bytes);
  await p.db.run("INSERT INTO blobs(id, content_type, size, sha256, created_at, created_by) VALUES (?,?,?,?,?,?)",
    [id, contentType.slice(0, 120), bytes.byteLength, sha256 || null, now(), actor]);
  return id;
}

export async function getBlob(p: Platform, id: string) {
  if (!/^b[a-z0-9]{6,40}$/.test(id)) return null;
  const meta = await p.db.all<{ content_type: string; size: number; offloaded: number }>("SELECT content_type, size, offloaded FROM blobs WHERE id = ?", [id]);
  if (!meta.length) return null;
  let body = await p.blobs.get("blobs/" + id);
  if (!body && meta[0].offloaded) {
    // file đã chuyển về máy local: đọc lại qua tunnel
    if (!p.fetchOffloaded) throw new HttpError(503, "offloaded", "File đã chuyển về máy local.");
    body = await p.fetchOffloaded(id);
    if (!body) throw new HttpError(503, "offloaded_unavailable", "File đã chuyển về máy local nhưng máy local đang tắt hoặc tunnel chưa chạy.");
  }
  if (!body) return null;
  return { body, contentType: meta[0].content_type || "application/octet-stream", size: meta[0].size };
}

export async function deleteBlobIfUnused(p: Platform, id: string): Promise<void> {
  if (!/^b[a-z0-9]{6,40}$/.test(id)) return;
  const used = await p.db.all("SELECT 1 FROM files WHERE blob_id = ? LIMIT 1", [id]);
  if (used.length) return;
  await p.blobs.delete("blobs/" + id);
  await p.db.run("DELETE FROM blobs WHERE id = ?", [id]);
}

/* ---------------------------------------------------------------- file vào tự động (agent, email, Adyen) */

export interface IngestInput {
  month: string; sec: string; acq: string; name: string; bytes: Uint8Array;
  source: "agent" | "email" | "adyen"; actor: string; sha256?: string;
}

export async function addIngestedFile(p: Platform, o: IngestInput): Promise<{ id: string; duplicate: boolean }> {
  if (!isMonth(o.month)) throw new HttpError(400, "invalid_argument", "month phải dạng YYYY-MM");
  if (!validPlace(o.sec, o.acq)) throw new HttpError(400, "invalid_argument", "sec/acq không nằm trong danh sách thư mục");
  const name = o.name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").slice(0, 180) || "file";
  const dup = o.sha256
    ? await p.db.all<{ id: string }>("SELECT id FROM files WHERE sha256 = ? AND month = ? LIMIT 1", [o.sha256, o.month])
    : await p.db.all<{ id: string }>("SELECT id FROM files WHERE month = ? AND sec = ? AND acq = ? AND name = ? AND size = ? LIMIT 1", [o.month, o.sec, o.acq, name, o.bytes.byteLength]);
  if (dup.length) return { id: dup[0].id, duplicate: true };
  const ext = extOf(name);
  const blobId = await createBlob(p, o.bytes, EXT_CT[ext] || "application/octet-stream", o.actor, o.sha256);
  const id = rid("f");
  const t = now();
  const data = { m: o.month, f: yymm(o.month) + " data", sec: o.sec, acq: o.acq, name, ext, size: o.bytes.byteLength, at: t, sheets: [], b: [], nb: 0, asset: blobId, wrap: 0 };
  const fy = yymm(o.month);
  await p.db.batch([
    { sql: "INSERT INTO files(id, month, sec, acq, name, size, blob_id, sha256, source, pending, data, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      params: [id, o.month, o.sec, o.acq, name, o.bytes.byteLength, blobId, o.sha256 || null, o.source, /^(xlsx|xlsm|xls|csv)$/.test(ext) ? 1 : 0, JSON.stringify(data), t, o.actor] },
    { sql: "INSERT OR IGNORE INTO folders(id, data) VALUES (?, ?)", params: [fy, JSON.stringify({ name: fy + " data", m: o.month, at: t })] },
    bump("files"), bump("folders"), audit(o.actor, "ingest:" + o.source, "files/" + id),
  ]);
  return { id, duplicate: false };
}

export async function logIngest(p: Platform, id: string, source: string, status: string, detail: unknown, incAttempt = false): Promise<void> {
  const t = now();
  await p.db.run(
    `INSERT INTO ingest_log(id, source, status, detail, attempts, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET status=excluded.status, detail=excluded.detail, attempts=ingest_log.attempts + ?, updated_at=excluded.updated_at`,
    [id, source, status, JSON.stringify(detail ?? null).slice(0, 4000), incAttempt ? 1 : 0, t, t, incAttempt ? 1 : 0]);
}
