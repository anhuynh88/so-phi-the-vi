/// <reference types="@cloudflare/workers-types" />
import { createApp, runMaintenance } from "./core/app";
import type { Config, Platform, SqlDb, BlobStore } from "./core/types";
import { processEmail, receiveEmail } from "./core/email";
import { HttpError } from "./core/util";
import { authenticate } from "./core/auth";
import { runBackup } from "./core/replica";
import { gatePage } from "./core/session";
import { PULL_CRON, runAdyenPull } from "./core/adyen";

/* Bản chạy trên Cloudflare Workers: D1 + R2 + Email Worker + Cron. */

interface Env extends Config {
  DB: D1Database;
  FILES?: R2Bucket;        // ưu tiên R2 khi đã bật
  FILES_KV?: KVNamespace;  // dự phòng khi tài khoản chưa bật R2 (không cần khai thanh toán, tối đa 25 MB/file)
  ASSETS: Fetcher;
  BACKUP?: Fetcher;        // Workers VPC: dịch vụ bản local sau Cloudflare Tunnel
  BACKUP_ORIGIN?: string;  // địa chỉ bản local nhìn từ phía tunnel, mặc định http://127.0.0.1:8788
}

/* ---------------- sao lưu sang bản local (Workers VPC + Tunnel). Trạng thái lưu trong KV. */
const BACKUP_STATE = "_backup/state";
interface BackupState { sig?: string; lastOk?: string; lastError?: string; lastErrorAt?: string; last?: unknown }

async function backupState(env: Env): Promise<BackupState> {
  if (!env.FILES_KV) return {};
  try { return (await env.FILES_KV.get<BackupState>(BACKUP_STATE, "json")) || {}; } catch { return {}; }
}

async function doBackup(env: Env, ctx: ExecutionContext, force: boolean) {
  if (!env.BACKUP || !env.BACKUP_TOKEN) throw new HttpError(503, "backup_not_configured", "Chưa gắn BACKUP (vpc_services) hoặc chưa đặt BACKUP_TOKEN.");
  const st = await backupState(env);
  try {
    const r = await runBackup(platform(env, ctx), env.BACKUP, env.BACKUP_ORIGIN || "http://127.0.0.1:8788", env.BACKUP_TOKEN, { force, lastSig: st.sig });
    const next: BackupState = { ...st, sig: r.sig, lastOk: r.at, last: { ...r, sig: undefined } };
    // KV free chỉ 1.000 lần ghi/ngày: không ghi lại khi không có gì thay đổi
    if (!r.skipped || r.blobsSent || st.lastError) { delete next.lastError; delete next.lastErrorAt; await env.FILES_KV?.put(BACKUP_STATE, JSON.stringify(next)); }
    return r;
  } catch (e) {
    await env.FILES_KV?.put(BACKUP_STATE, JSON.stringify({ ...st, lastError: String((e as Error)?.message || e).slice(0, 500), lastErrorAt: new Date().toISOString() }));
    throw e;
  }
}

function d1(db: D1Database): SqlDb {
  const bind = (sql: string, params: unknown[] = []) => db.prepare(sql).bind(...params);
  return {
    async all(sql, params) { return (await bind(sql, params).all()).results as never[]; },
    async run(sql, params) { await bind(sql, params).run(); },
    async batch(stmts) { if (stmts.length) await db.batch(stmts.map((s) => bind(s.sql, s.params))); },
  };
}

function r2(bucket: R2Bucket): BlobStore {
  return {
    async put(key, bytes) { await bucket.put(key, bytes); },
    async get(key) { const o = await bucket.get(key); return o ? o.body : null; },
    async delete(key) { await bucket.delete(key); },
  };
}

const KV_MAX = 25 * 1024 * 1024;
function kv(ns: KVNamespace): BlobStore {
  return {
    async put(key, bytes) {
      if (bytes.byteLength > KV_MAX) throw new HttpError(413, "too_large", "File quá 25 MB (kho KV). Bật R2 để lưu file lớn hơn.");
      await ns.put(key, bytes);
    },
    async get(key) { const v = await ns.get(key, "arrayBuffer"); return v ? new Uint8Array(v) : null; },
    async delete(key) { await ns.delete(key); },
  };
}

function blobsOf(env: Env): BlobStore {
  if (env.FILES) return r2(env.FILES);
  if (env.FILES_KV) return kv(env.FILES_KV);
  throw new HttpError(503, "storage_not_configured", "Chưa gắn kho file (R2 FILES hoặc KV FILES_KV).");
}

function platform(env: Env, ctx: ExecutionContext): Platform {
  let blobs: BlobStore | null = null;
  const lazy = (): BlobStore => (blobs ??= blobsOf(env));
  return {
    mode: "cloudflare", db: d1(env.DB), cfg: env, waitUntil: (p) => ctx.waitUntil(p),
    blobs: { put: (k, b) => lazy().put(k, b), get: (k) => lazy().get(k), delete: (k) => lazy().delete(k) },
  };
}

const app = createApp((c) => platform(c.env as Env, c.executionCtx as ExecutionContext), (a, needWrite) => {
  // chạy ngay việc kéo báo cáo Adyen (giống cron 21h), chỉ người có quyền ghi
  a.post("/api/adyen/pull", async (c) => {
    needWrite(c);
    return c.json(await runAdyenPull(platform(c.env as Env, c.executionCtx as ExecutionContext)));
  });
  a.get("/api/backup/status", async (c) => c.json({ configured: !!((c.env as Env).BACKUP && (c.env as Env).BACKUP_TOKEN), ...(await backupState(c.env as Env)), sig: undefined }));
  a.post("/api/backup/run", async (c) => {
    needWrite(c);
    try { return c.json(await doBackup(c.env as Env, c.executionCtx as ExecutionContext, true)); }
    catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(502, "backup_failed", "Sao lưu lỗi: " + String((e as Error)?.message || e).slice(0, 300)); }
  });
});
// đường không phải /api, /_blob, /webhooks: trả file tĩnh.
// Đăng nhập bằng tài khoản (basic) thì không có Access đứng trước, nên trang cũng phải đăng nhập
// (wrangler.jsonc đặt run_worker_first: true để mọi đường đều qua đây).
app.all("*", async (c) => {
  const env = c.env as Env;
  if ((env.AUTH_MODE || "").toLowerCase() !== "access") {
    const gate = await gatePage(c.req.raw, env, d1(env.DB), authenticate);
    if (gate) return gate;
  }
  // html_handling = "none": tự trỏ "/" về index.html
  const url = new URL(c.req.url);
  if (url.pathname.endsWith("/")) url.pathname += "index.html";
  const res = await env.ASSETS.fetch(new Request(url, c.req.raw));
  const out = new Response(res.body, res);
  out.headers.set("cache-control", "private, no-cache");
  return out;
});

export default {
  fetch: app.fetch,

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    const p = platform(env, ctx);
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    const id = await receiveEmail(p, { from: message.from, to: message.to, raw });
    // đọc file đính kèm ngay; nếu vượt CPU gói free thì email gốc vẫn còn, cron sẽ đọc lại
    ctx.waitUntil(processEmail(p, id));
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    // 21h giờ VN: kéo báo cáo cấp công ty Adyen (chỉ đọc) về thư mục ECOM/adyen
    if (event.cron === PULL_CRON) {
      if (env.ADYEN_PULL_COMPANY) ctx.waitUntil(runAdyenPull(platform(env, ctx)).then((r) => console.log("adyen-pull", JSON.stringify(r))).catch((e) => console.error("adyen-pull", e)));
      return;
    }
    ctx.waitUntil(runMaintenance(platform(env, ctx)));
    if (env.BACKUP && env.BACKUP_TOKEN) ctx.waitUntil(doBackup(env, ctx, false).catch((e) => console.error("backup", e)));
  },
} satisfies ExportedHandler<Env>;
