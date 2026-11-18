/// <reference types="@cloudflare/workers-types" />
import { createApp, runMaintenance } from "./core/app";
import type { Config, Platform, SqlDb, BlobStore } from "./core/types";
import { processEmail, receiveEmail } from "./core/email";
import { HttpError } from "./core/util";
import { authenticate } from "./core/auth";

/* Bản chạy trên Cloudflare Workers: D1 + R2 + Email Worker + Cron. */

interface Env extends Config {
  DB: D1Database;
  FILES?: R2Bucket;        // ưu tiên R2 khi đã bật
  FILES_KV?: KVNamespace;  // dự phòng khi tài khoản chưa bật R2 (không cần khai thanh toán, tối đa 25 MB/file)
  ASSETS: Fetcher;
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

const app = createApp((c) => platform(c.env as Env, c.executionCtx as ExecutionContext));
// đường không phải /api, /_blob, /webhooks: trả file tĩnh.
// Đăng nhập bằng tài khoản (basic) thì không có Access đứng trước, nên trang cũng phải đăng nhập
// (wrangler.jsonc đặt run_worker_first: true để mọi đường đều qua đây).
app.all("*", async (c) => {
  const env = c.env as Env;
  if ((env.AUTH_MODE || "").toLowerCase() !== "access") await authenticate(c.req.raw, env);
  const res = await env.ASSETS.fetch(c.req.raw);
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

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runMaintenance(platform(env, ctx)));
  },
} satisfies ExportedHandler<Env>;
