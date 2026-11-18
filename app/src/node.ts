/* Bản chạy trên máy local / máy chủ nội bộ: SQLite (node:sqlite) + thư mục file. Cùng API, cùng giao diện với bản Cloudflare. */
import { serve } from "@hono/node-server";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, runMaintenance } from "./core/app";
import { authenticate } from "./core/auth";
import type { BlobStore, Config, Platform, SqlDb } from "./core/types";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = resolve(process.env.SOPHI_DATA || join(ROOT, "data"));
mkdirSync(join(DATA, "files"), { recursive: true });

const sqlite = new DatabaseSync(join(DATA, "sophi.db"));
sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

/* migrations: chạy các file migrations/*.sql chưa áp dụng (cùng bộ file với D1) */
sqlite.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
const done = new Set((sqlite.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name));
for (const f of readdirSync(join(ROOT, "migrations")).filter((x) => x.endsWith(".sql")).sort()) {
  if (done.has(f)) continue;
  sqlite.exec("BEGIN");
  try {
    sqlite.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
    sqlite.prepare("INSERT INTO _migrations(name, applied_at) VALUES (?, ?)").run(f, new Date().toISOString());
    sqlite.exec("COMMIT");
    console.log("migration:", f);
  } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
}

type P = (string | number | null)[];
const db: SqlDb = {
  async all(sql, params = []) { return sqlite.prepare(sql).all(...(params as P)) as never[]; },
  async run(sql, params = []) { sqlite.prepare(sql).run(...(params as P)); },
  async batch(stmts) {
    sqlite.exec("BEGIN");
    try { for (const s of stmts) sqlite.prepare(s.sql).run(...((s.params || []) as P)); sqlite.exec("COMMIT"); }
    catch (e) { sqlite.exec("ROLLBACK"); throw e; }
  },
};

const safePath = (key: string) => {
  if (!/^[A-Za-z0-9_./-]+$/.test(key) || key.includes("..")) throw new Error("bad key");
  return join(DATA, "files", key);
};
const blobs: BlobStore = {
  async put(key, bytes) { const f = safePath(key); await mkdir(dirname(f), { recursive: true }); await writeFile(f, bytes); },
  async get(key) { const f = safePath(key); return existsSync(f) ? new Uint8Array(await readFile(f)) : null; },
  async delete(key) { await rm(safePath(key), { force: true }); },
};

const cfg = process.env as unknown as Config;
const platform: Platform = { mode: "local", db, blobs, cfg, waitUntil: (p) => { p.catch((e) => console.error(e)); } };

const app = createApp(() => platform);
/* file tĩnh trong public/ (giống phần assets của Worker) */
const PUB = resolve(ROOT, "public");
const STATIC_CT: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", svg: "image/svg+xml", png: "image/png", ico: "image/x-icon", json: "application/json" };
app.get("*", async (c) => {
  // bản local không có Cloudflare Access đứng trước: trang cũng phải đăng nhập
  await authenticate(c.req.raw, cfg);
  let path = decodeURIComponent(new URL(c.req.url).pathname);
  if (path.endsWith("/")) path += "index.html";
  const f = resolve(PUB, "." + path);
  if (!f.startsWith(PUB + sep) || /(^|[\\/])_headers$/.test(f)) return c.text("Not found", 404);
  try {
    const body = await readFile(f);
    const ext = (/\.([a-z0-9]+)$/i.exec(f)?.[1] || "").toLowerCase();
    return new Response(body, { headers: { "content-type": STATIC_CT[ext] || "application/octet-stream", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "same-origin" } });
  } catch { return c.text("Not found", 404); }
});

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8788);
if (host !== "127.0.0.1" && host !== "localhost" && (cfg.AUTH_MODE || "") === "dev") {
  console.error("AUTH_MODE=dev chỉ được chạy với HOST=127.0.0.1. Dừng.");
  process.exit(1);
}
serve({ fetch: app.fetch, hostname: host, port }, () => {
  console.log(`Sổ phí chạy local: http://${host === "0.0.0.0" ? "localhost" : host}:${port}  (dữ liệu: ${DATA}, đăng nhập: ${cfg.AUTH_MODE || "chưa đặt"})`);
});

setInterval(() => { runMaintenance(platform).catch((e) => console.error(e)); }, 15 * 60000);
