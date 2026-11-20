/* Sao lưu Cloudflare → máy local qua Cloudflare Tunnel (Workers VPC).

   Worker (cron mỗi giờ hoặc POST /api/backup/run) đọc toàn bộ bảng D1 rồi đẩy sang bản local qua binding VPC
   (env.BACKUP), cùng các file gốc mà máy local chưa có. Bản local ghi đè các bảng của mình bằng bản chụp này,
   nên máy local là bản sao (chỉ để xem / dự phòng): dữ liệu sửa trực tiếp trên local sẽ bị ghi đè ở lần sao lưu sau.

   Bên nhận (node.ts): POST /_replica/snapshot, GET /_replica/blobs, PUT/GET /_replica/blob/:id
   Kho Cloudflare vượt OFFLOAD_ABOVE_MB: file cũ nhất đã có ở local bị xoá khỏi kho Cloudflare (blobs.offloaded = 1),
   Worker đọc lại qua GET /_replica/blob/:id khi có người mở.
   Xác thực: Authorization: Bearer <BACKUP_TOKEN> (>= 24 ký tự, đặt giống nhau ở hai bên). */
import type { Hono } from "hono";
import type { AppEnv, Platform, SqlStmt } from "./types";
import { HttpError, now, safeEqual } from "./util";

/** Bảng được sao lưu. _migrations của bản local không nằm trong danh sách. */
export const REPLICA_TABLES = ["months", "fee_lines", "files", "blobs", "folders", "config", "fee_contracts", "ingest_log", "audit_log", "revs", "users"] as const;
type Table = (typeof REPLICA_TABLES)[number];
const isTable = (s: string): s is Table => (REPLICA_TABLES as readonly string[]).includes(s);

/** Số file gốc gửi tối đa mỗi lần (Worker gói free giới hạn 50 subrequest); phần còn lại gửi ở lần sau. */
const BLOBS_PER_RUN = 30;

export function checkBackupToken(req: Request, expected: string | undefined): void {
  if (!expected || expected.length < 24) throw new HttpError(503, "backup_not_configured", "Chưa đặt BACKUP_TOKEN (tối thiểu 24 ký tự).");
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Bearer ") || !safeEqual(h.slice(7).trim(), expected)) throw new HttpError(401, "unauthenticated", "Token sao lưu không đúng.");
}

/* ---------------------------------------------------------------- bên nhận (local) */

/** Ghi đè các bảng bằng bản chụp: mỗi bảng có trong body được xoá rồi chép lại, tất cả trong một transaction. */
export async function applySnapshot(p: Platform, body: unknown): Promise<Record<string, number>> {
  const tables = (body as { tables?: Record<string, unknown> })?.tables;
  if (!tables || typeof tables !== "object") throw new HttpError(400, "invalid_argument", "Thiếu tables.");
  const stmts: SqlStmt[] = [];
  const counts: Record<string, number> = {};
  for (const [t, rows] of Object.entries(tables)) {
    if (!isTable(t) || !Array.isArray(rows)) throw new HttpError(400, "invalid_argument", "Bảng không hợp lệ: " + t);
    const cols = new Set((await p.db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${t}')`)).map((r) => r.name));
    stmts.push({ sql: `DELETE FROM ${t}` });
    for (const r of rows as Record<string, unknown>[]) {
      const keys = Object.keys(r).filter((k) => cols.has(k));
      if (!keys.length) continue;
      stmts.push({ sql: `INSERT INTO ${t}(${keys.map((k) => `"${k}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`, params: keys.map((k) => r[k] ?? null) });
    }
    counts[t] = rows.length;
  }
  await p.db.batch(stmts);
  return counts;
}

export async function localBlobIds(p: Platform): Promise<string[]> {
  // chỉ tính file đã thật sự có trên đĩa (bảng blobs đã chép trước nên không dùng làm căn cứ)
  const rows = await p.db.all<{ id: string }>("SELECT id FROM blobs");
  const have: string[] = [];
  for (const r of rows) if (await p.blobs.get("blobs/" + r.id)) have.push(r.id);
  return have;
}

/** Gắn 3 đường nhận sao lưu vào app của bản local. Không qua đăng nhập người dùng, chỉ BACKUP_TOKEN. */
export function mountReplica(app: Hono<AppEnv>, p: Platform): void {
  app.post("/_replica/snapshot", async (c) => {
    checkBackupToken(c.req.raw, p.cfg.BACKUP_TOKEN);
    let body: unknown;
    try { body = await c.req.json(); } catch { throw new HttpError(400, "invalid_argument", "JSON không hợp lệ."); }
    const tables = await applySnapshot(p, body);
    console.log(now(), "nhận sao lưu từ Cloudflare:", JSON.stringify(tables));
    return c.json({ ok: true, tables });
  });
  app.get("/_replica/blobs", async (c) => {
    checkBackupToken(c.req.raw, p.cfg.BACKUP_TOKEN);
    return c.json({ ids: await localBlobIds(p) });
  });
  app.put("/_replica/blob/:id", async (c) => {
    checkBackupToken(c.req.raw, p.cfg.BACKUP_TOKEN);
    const id = c.req.param("id");
    if (!/^b[a-z0-9]{6,40}$/.test(id)) throw new HttpError(400, "invalid_argument", "id không hợp lệ");
    await p.blobs.put("blobs/" + id, new Uint8Array(await c.req.arrayBuffer()));
    return c.json({ ok: true });
  });
  app.get("/_replica/blob/:id", async (c) => {
    checkBackupToken(c.req.raw, p.cfg.BACKUP_TOKEN);
    const id = c.req.param("id");
    if (!/^b[a-z0-9]{6,40}$/.test(id)) throw new HttpError(400, "invalid_argument", "id không hợp lệ");
    const body = await p.blobs.get("blobs/" + id);
    if (!body) throw new HttpError(404, "not_found", "Máy local không có file này.");
    return new Response(body as BodyInit, { headers: { "content-type": "application/octet-stream" } });
  });
}

/* ---------------------------------------------------------------- bên gửi (Worker) */

export interface BackupTarget { fetch(input: string, init?: RequestInit): Promise<Response> }

export interface BackupResult { skipped?: boolean; tables?: Record<string, number>; blobsSent: number; blobsLeft: number; offloaded?: number; offloadedBytes?: number; at: string }

async function signature(p: Platform): Promise<string> {
  const r = await p.db.all<Record<string, unknown>>(
    "SELECT (SELECT group_concat(col || ':' || rev) FROM revs) AS revs, (SELECT count(*) || '@' || max(at) FROM audit_log) AS audit, (SELECT max(COALESCE(updated_at, created_at)) FROM ingest_log) AS ingest");
  return JSON.stringify(r[0] || {});
}

/** Đẩy dữ liệu sang bản local. force = bỏ qua kiểm tra "không có gì thay đổi". */
export async function runBackup(p: Platform, target: BackupTarget, origin: string, token: string, opt: { force?: boolean; lastSig?: string } = {}): Promise<BackupResult & { sig: string }> {
  const base = origin.replace(/\/+$/, "");
  const auth = { authorization: "Bearer " + token };
  const sig = await signature(p);

  let tables: Record<string, number> | undefined;
  const skipped = !opt.force && opt.lastSig === sig;
  if (!skipped) {
    const snap: Record<string, unknown[]> = {};
    for (const t of REPLICA_TABLES) snap[t] = await p.db.all(`SELECT * FROM ${t}`);
    const res = await target.fetch(base + "/_replica/snapshot", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ tables: snap, at: now() }) });
    if (!res.ok) throw new Error("Sao lưu bảng lỗi " + res.status + ": " + (await res.text()).slice(0, 200));
    tables = ((await res.json()) as { tables: Record<string, number> }).tables;
  }

  // file gốc: chỉ gửi những file máy local chưa có
  const lr = await target.fetch(base + "/_replica/blobs", { headers: auth });
  if (!lr.ok) throw new Error("Đọc danh sách file local lỗi " + lr.status);
  const have = new Set(((await lr.json()) as { ids: string[] }).ids);
  const all = await p.db.all<{ id: string; content_type: string }>("SELECT id, content_type FROM blobs ORDER BY created_at");
  const missing = all.filter((b) => !have.has(b.id));
  let sent = 0;
  for (const b of missing.slice(0, BLOBS_PER_RUN)) {
    const body = await p.blobs.get("blobs/" + b.id);
    if (!body) continue;
    const r = await target.fetch(base + "/_replica/blob/" + b.id, { method: "PUT", headers: { ...auth, "content-type": "application/octet-stream" }, body: body as BodyInit });
    if (!r.ok) throw new Error("Gửi file " + b.id + " lỗi " + r.status);
    have.add(b.id);
    sent++;
  }
  const off = await offloadOldBlobs(p, have);
  return { skipped, tables, blobsSent: sent, blobsLeft: missing.length - sent, ...off, at: now(), sig };
}

/** Kho Cloudflare vượt OFFLOAD_ABOVE_MB: xoá khỏi kho các file cũ nhất mà máy local đã có, tới khi về dưới mức đó. */
export async function offloadOldBlobs(p: Platform, onLocal: Set<string>): Promise<{ offloaded: number; offloadedBytes: number }> {
  const mb = Number(p.cfg.OFFLOAD_ABOVE_MB);
  if (!(mb > 0)) return { offloaded: 0, offloadedBytes: 0 };
  const target = mb * 1048576;
  const used = Number((await p.db.all<{ s: number | null }>("SELECT SUM(size) AS s FROM blobs WHERE offloaded = 0"))[0]?.s || 0);
  let over = used - target, n = 0, bytes = 0;
  if (over <= 0) return { offloaded: 0, offloadedBytes: 0 };
  const rows = await p.db.all<{ id: string; size: number }>("SELECT id, size FROM blobs WHERE offloaded = 0 ORDER BY created_at");
  for (const b of rows) {
    if (over <= 0) break;
    if (!onLocal.has(b.id)) continue; // chỉ xoá file đã chắc chắn có ở local
    await p.db.run("UPDATE blobs SET offloaded = 1 WHERE id = ?", [b.id]);
    await p.blobs.delete("blobs/" + b.id);
    over -= b.size || 0; bytes += b.size || 0; n++;
  }
  return { offloaded: n, offloadedBytes: bytes };
}
