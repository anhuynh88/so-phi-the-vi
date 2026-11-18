import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/core/app";
import { hmacOf, monthOfReport, reportUrlOk, signingString } from "../src/core/adyen";
import { dmarcPass, monthFor, processEmail, receiveEmail } from "../src/core/email";
import { hashPassword } from "../src/core/auth";
import { csvCell } from "../src/core/util";
import type { Config, Platform, SqlDb } from "../src/core/types";

/* ---------------- nền tảng giả: SQLite trong RAM + Map làm kho file */
function makePlatform(cfg: Config): Platform & { files: Map<string, Uint8Array>; pending: Promise<unknown>[] } {
  const sq = new DatabaseSync(":memory:");
  sq.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync("migrations").sort()) sq.exec(readFileSync(join("migrations", f), "utf8"));
  type P = (string | number | null)[];
  const db: SqlDb = {
    async all(sql, params = []) { return sq.prepare(sql).all(...(params as P)) as never[]; },
    async run(sql, params = []) { sq.prepare(sql).run(...(params as P)); },
    async batch(stmts) { sq.exec("BEGIN"); try { for (const s of stmts) sq.prepare(s.sql).run(...((s.params || []) as P)); sq.exec("COMMIT"); } catch (e) { sq.exec("ROLLBACK"); throw e; } },
  };
  const files = new Map<string, Uint8Array>();
  const pending: Promise<unknown>[] = [];
  return {
    mode: "local", db, cfg, files, pending,
    blobs: { async put(k, b) { files.set(k, b); }, async get(k) { return files.get(k) || null; }, async delete(k) { files.delete(k); } },
    waitUntil(p) { pending.push(p); },
  };
}
const H = "http://localhost";

test("Adyen HMAC khớp test vector trong tài liệu Adyen", async () => {
  const it = { pspReference: "7914073381342284", merchantAccountCode: "TestMerchant", merchantReference: "TestPayment-1407325143704",
    amount: { value: 1130, currency: "EUR" }, eventCode: "AUTHORISATION", success: "true" };
  assert.equal(signingString(it), "7914073381342284::TestMerchant:TestPayment-1407325143704:1130:EUR:AUTHORISATION:true");
  assert.equal(await hmacOf(it, "44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056"), "coqCmt/IZ4E3CzPvMY8zTjQVL5hYJUiBRg8UU+iCWo0=");
});

test("Chỉ tải báo cáo từ tên miền adyen.com qua https", () => {
  assert.ok(reportUrlOk("https://ca-live.adyen.com/reports/download/x.csv"));
  assert.ok(!reportUrlOk("http://ca-live.adyen.com/x.csv"));
  assert.ok(!reportUrlOk("https://adyen.com.evil.io/x.csv"));
  assert.ok(!reportUrlOk("https://evil.io/?u=adyen.com"));
});

test("Kỳ của báo cáo Adyen lấy từ tên file, rồi eventDate", () => {
  assert.equal(monthOfReport("settlement_detail_report_2026_10_31.csv"), "2026-10");
  assert.equal(monthOfReport("payments_accounting_report_20260930.csv"), "2026-09");
  assert.equal(monthOfReport("settlement_detail_report_batch_215.csv", "2026-08-02T01:00:00+02:00"), "2026-08");
});

test("DMARC và kỳ email", () => {
  assert.ok(dmarcPass("mx.cloudflare.net; dkim=pass header.d=adyen.com; spf=pass; dmarc=pass"));
  assert.ok(!dmarcPass("evil.example; dmarc=pass"));
  assert.ok(!dmarcPass("mx.cloudflare.net; dmarc=fail"));
  assert.equal(monthFor(new Date("2026-11-03T00:00:00Z"), -1), "2026-10");
  assert.equal(monthFor(new Date("2026-01-03T00:00:00Z"), -1), "2025-12");
});

test("CSV chặn công thức Excel", () => {
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell(-1200), "-1200");
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
});

test("Không cấu hình đăng nhập thì từ chối (fail closed)", async () => {
  const app = createApp(() => makePlatform({}));
  assert.equal((await app.request(H + "/api/me")).status, 503);
  const app2 = createApp(() => makePlatform({ AUTH_MODE: "access" }));
  assert.equal((await app2.request(H + "/api/me")).status, 503);
  const app3 = createApp(() => makePlatform({ AUTH_MODE: "access", ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com", ACCESS_AUD: "aud" }));
  assert.equal((await app3.request(H + "/api/me")).status, 401);
  assert.equal((await app3.request(H + "/api/me", { headers: { "cf-access-jwt-assertion": "abc.def.ghi" } })).status, 401);
  assert.equal((await app3.request(H + "/_blob/b123456789")).status, 401);
  // chế độ dev không chạy trên tên miền thật
  const app4 = createApp(() => makePlatform({ AUTH_MODE: "dev", DEV_USER: "a@b.c" }));
  assert.equal((await app4.request("https://so-phi.example.com/api/me")).status, 403);
  assert.equal((await app4.request(H + "/api/me")).status, 200);
});

test("Cloudflare Access: JWT hợp lệ được vào, sai audience / sai issuer / hết hạn bị từ chối", async () => {
  const { generateKeyPair, exportJWK, SignJWT } = await import("jose");
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const team = "https://congty.cloudflareaccess.com";
  const sign = (o: { aud?: string; iss?: string; exp?: string; email?: string }) =>
    new SignJWT({ email: o.email ?? "ketoan@congty.vn" }).setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(o.iss ?? team).setAudience(o.aud ?? "aud-123").setIssuedAt().setExpirationTime(o.exp ?? "5m").sign(privateKey);
  const realFetch = globalThis.fetch;
  let certCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    assert.equal(String(url instanceof Request ? url.url : url), team + "/cdn-cgi/access/certs");
    certCalls++;
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const app = createApp(() => makePlatform({ AUTH_MODE: "access", ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: "aud-123", WRITER_EMAILS: "ketoan@congty.vn" }));
    const get = async (tok: string) => app.request("https://so-phi.congty.vn/api/me", { headers: { "cf-access-jwt-assertion": tok } });
    const ok = await get(await sign({}));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { email: "ketoan@congty.vn", canWrite: true, via: "access", mode: "local" });
    const viewer = await (await get(await sign({ email: "nguoi-xem@congty.vn" }))).json();
    assert.equal(viewer.canWrite, false);
    assert.equal((await get(await sign({ aud: "app-khac" }))).status, 401);
    assert.equal((await get(await sign({ iss: "https://khac.cloudflareaccess.com" }))).status, 401);
    assert.equal((await get(await sign({ exp: "-1m" }))).status, 401);
    // cookie CF_Authorization cũng được chấp nhận (trình duyệt luôn gửi)
    assert.equal((await app.request("https://so-phi.congty.vn/api/me", { headers: { cookie: "CF_Authorization=" + (await sign({})) } })).status, 200);
    assert.ok(certCalls >= 1);
  } finally { globalThis.fetch = realFetch; }
});

test("Tài khoản local (basic): đúng/sai mật khẩu, quyền ghi", async () => {
  const line = "ke-toan@cty.vn:" + (await hashPassword("mat-khau-dai-123", 1000));
  const p = makePlatform({ AUTH_MODE: "basic", LOCAL_USERS: line, WRITER_EMAILS: "khac@cty.vn" });
  const app = createApp(() => p);
  const auth = (u: string, pw: string) => ({ authorization: "Basic " + Buffer.from(u + ":" + pw).toString("base64") });
  assert.equal((await app.request(H + "/api/me", { headers: auth("ke-toan@cty.vn", "sai") })).status, 401);
  const me = await (await app.request(H + "/api/me", { headers: auth("ke-toan@cty.vn", "mat-khau-dai-123") })).json();
  assert.equal(me.email, "ke-toan@cty.vn");
  assert.equal(me.canWrite, false);
  const w = await app.request(H + "/api/c/folders/2610", { method: "PUT", headers: { ...auth("ke-toan@cty.vn", "mat-khau-dai-123"), "content-type": "application/json" }, body: "{}" });
  assert.equal(w.status, 403);
  assert.equal((await w.json()).code, "invalid_argument");
});

test("Lưu kỳ → bảng fee_lines, CSV, đọc lại, xoá", async () => {
  const p = makePlatform({ AUTH_MODE: "dev", DEV_USER: "a@b.c" });
  const app = createApp(() => p);
  const month = { key: "2026-10", period: "T10/2026", file: "x.xlsx", total: { gd: 3, ds: 1000, fee: 20 }, channels: [], acq: [{ acq: "PayPal", gate: "PayPal", ch: "ECOM", gd: 3, ds: 1000, fee: 20 }],
    det: [{ s: "PayPal", g: "PayPal", k: "ECOM", a: "PayPal", b: "PayPal", t: "", p: "", c: "USD", n: 3, v: 1000, f: 20, r: 0, d: 18, x: "1,8%" }, { s: "PayPal", g: "PayPal", k: "ECOM", a: "PayPal", b: "=cmd", c: "USD", n: 1, v: 5, f: 1, r: 0 }] };
  const put = await app.request(H + "/api/c/months/2026-10", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(month) });
  assert.equal(put.status, 200, await put.text());
  const lines = await p.db.all<{ fee_vnd: number; contract_fee_vnd: number | null }>("SELECT fee_vnd, contract_fee_vnd FROM fee_lines WHERE month='2026-10' ORDER BY fee_vnd DESC");
  assert.deepEqual(lines.map((l) => [l.fee_vnd, l.contract_fee_vnd]), [[20, 18], [1, null]]);
  const raw = new Uint8Array(await (await app.request(H + "/api/export/fee-lines.csv?month=2026-10")).arrayBuffer());
  assert.deepEqual([...raw.slice(0, 3)], [0xef, 0xbb, 0xbf], "có BOM để Excel đọc đúng tiếng Việt");
  const csv = new TextDecoder().decode(raw);
  assert.match(csv, /^month,sheet,gate/);
  assert.match(csv, /'=cmd/);
  const list = await (await app.request(H + "/api/c/months")).json();
  assert.equal(list.docs[0].id, "2026-10");
  assert.equal(list.docs[0].data.total.ds, 1000);
  const rev = await (await app.request(H + "/api/rev")).json();
  assert.equal(rev.months, 1);
  // key không khớp → từ chối
  const bad = await app.request(H + "/api/c/months/2026-11", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(month) });
  assert.equal(bad.status, 400);
  await app.request(H + "/api/c/months/2026-10", { method: "DELETE" });
  assert.equal((await p.db.all("SELECT 1 FROM fee_lines")).length, 0);
});

test("Tải file lên, đọc lại, xoá file thì xoá luôn nội dung", async () => {
  const p = makePlatform({ AUTH_MODE: "dev", DEV_USER: "a@b.c" });
  const app = createApp(() => p);
  const bytes = new TextEncoder().encode("a,b\n1,2\n");
  const up = await (await app.request(H + "/api/blobs", { method: "POST", headers: { "content-type": "text/csv" }, body: bytes })).json();
  assert.match(up.id, /^b/);
  const doc = { m: "2026-10", f: "2610 data", sec: "ECOM", acq: "paypal", name: "a.csv", ext: "csv", size: bytes.length, asset: up.id, wrap: 0, nb: 0, b: [] };
  assert.equal((await app.request(H + "/api/c/files/abc123", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(doc) })).status, 200);
  const got = await app.request(H + "/_blob/" + up.id);
  assert.equal(got.status, 200);
  assert.equal(await got.text(), "a,b\n1,2\n");
  // acquirer lạ → từ chối
  const bad = await app.request(H + "/api/c/files/x2", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...doc, acq: "../etc" }) });
  assert.equal(bad.status, 400);
  await app.request(H + "/api/c/files/abc123", { method: "DELETE" });
  assert.equal(p.files.size, 0);
  assert.equal((await app.request(H + "/_blob/" + up.id)).status, 404);
});

test("Agent đẩy file bằng token, trùng nội dung thì bỏ qua", async () => {
  const p = makePlatform({ AUTH_MODE: "dev", DEV_USER: "a@b.c", INGEST_TOKEN: "t".repeat(32) });
  const app = createApp(() => p);
  const send = (tok: string) => app.request(H + "/api/ingest?month=2026-10&sec=ECOM&acq=vnpay&name=" + encodeURIComponent("đối soát.xlsx"), { method: "POST", headers: { authorization: "Bearer " + tok }, body: new Uint8Array([1, 2, 3]) });
  assert.equal((await send("sai")).status, 401);
  const r1 = await (await send("t".repeat(32))).json();
  assert.equal(r1.duplicate, false);
  const r2 = await (await send("t".repeat(32))).json();
  assert.equal(r2.duplicate, true);
  const files = (await (await app.request(H + "/api/c/files")).json()).docs;
  assert.equal(files.length, 1);
  assert.equal(files[0].meta.pending, 1);
  assert.equal(files[0].meta.src, "agent");
  const folders = (await (await app.request(H + "/api/c/folders")).json()).docs;
  assert.equal(folders[0].id, "2610");
});

test("Webhook Adyen: sai tài khoản/chữ ký bị từ chối; REPORT_AVAILABLE tải báo cáo về thư mục adyen", async () => {
  const key = "44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056";
  const p = makePlatform({ ADYEN_WEBHOOK_USER: "u", ADYEN_WEBHOOK_PASS: "p", ADYEN_HMAC_KEY: key, ADYEN_REPORT_API_KEY: "k" });
  const app = createApp(() => p);
  const item: Record<string, unknown> = { eventCode: "REPORT_AVAILABLE", success: "true", pspReference: "settlement_detail_report_2026_10_31.csv",
    reason: "https://ca-test.adyen.com/reports/download/MerchantAccount/X/settlement_detail_report_2026_10_31.csv", merchantAccountCode: "X", amount: { value: 0, currency: "EUR" } };
  item.additionalData = { hmacSignature: await hmacOf(item, key) };
  const body = JSON.stringify({ live: "false", notificationItems: [{ NotificationRequestItem: item }] });
  const basic = "Basic " + Buffer.from("u:p").toString("base64");
  assert.equal((await app.request(H + "/webhooks/adyen", { method: "POST", body })).status, 401);
  // URL ngoài adyen.com: ghi nhật ký "rejected", không tải
  const offsite = { ...item, pspReference: "x_2026_10_01.csv", reason: "https://evil.io/x.csv" } as Record<string, unknown>;
  offsite.additionalData = { hmacSignature: await hmacOf(offsite, key) };
  assert.equal((await app.request(H + "/webhooks/adyen", { method: "POST", headers: { authorization: basic }, body: JSON.stringify({ notificationItems: [{ NotificationRequestItem: offsite }] }) })).status, 200);
  assert.equal(p.pending.length, 0);
  assert.equal((await p.db.all<{ status: string }>("SELECT status FROM ingest_log WHERE id = 'adyen:x_2026_10_01.csv'"))[0].status, "rejected");

  const realFetch = globalThis.fetch;
  let sentKey = "";
  globalThis.fetch = (async (url: string, init: RequestInit) => { sentKey = (init.headers as Record<string, string>)["X-API-Key"]; assert.match(String(url), /^https:\/\/ca-test\.adyen\.com\//); return new Response("a,b\n"); }) as typeof fetch;
  try {
    const res = await app.request(H + "/webhooks/adyen", { method: "POST", headers: { authorization: basic }, body });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "[accepted]");
    await Promise.all(p.pending);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(sentKey, "k");
  const f = await p.db.all<{ month: string; acq: string; source: string }>("SELECT month, acq, source FROM files WHERE name = 'settlement_detail_report_2026_10_31.csv'");
  assert.deepEqual(f.map((x) => [x.month, x.acq, x.source]), [["2026-10", "adyen", "adyen"]]);

  const tampered = JSON.stringify({ live: "false", notificationItems: [{ NotificationRequestItem: { ...item, pspReference: "khac.csv" } }] });
  assert.equal((await app.request(H + "/webhooks/adyen", { method: "POST", headers: { authorization: basic }, body: tampered })).status, 401);
});

test("Email: chỉ nhận người gửi trong email_routes và qua DMARC", async () => {
  const p = makePlatform({});
  await p.db.run("INSERT INTO config(id, data) VALUES ('email_routes', ?)", [JSON.stringify({ routes: [{ from: "@vnpay\\.vn$", sec: "ECOM", acq: "vnpay", monthOffset: -1 }] })]);
  // auth = các header Authentication-Results theo thứ tự trong email (Cloudflare thêm header của mình lên đầu)
  const eml = (from: string, auth: string[]) => new TextEncoder().encode([
    ...auth.map((a) => "Authentication-Results: " + a),
    "From: " + from, "To: baocao@cty.vn", "Subject: Doi soat T10", "Date: Mon, 2 Nov 2026 08:00:00 +0700", "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="x"', "", "--x", "Content-Type: text/plain", "", "Kinh gui", "--x",
    'Content-Type: text/csv; name="doisoat.csv"', 'Content-Disposition: attachment; filename="doisoat.csv"', "Content-Transfer-Encoding: base64", "",
    Buffer.from("a,b\n1,2\n").toString("base64"), "--x--", ""].join("\r\n"));
  const run = async (envFrom: string, hdrFrom: string, auth: string[]) => {
    const id = await receiveEmail(p, { from: envFrom, to: "baocao@cty.vn", raw: eml(hdrFrom, auth) });
    await processEmail(p, id);
    return id;
  };
  const ok = await run("report@vnpay.vn", "report@vnpay.vn", ["mx.cloudflare.net; dmarc=pass"]);
  const nodmarc = await run("report@vnpay.vn", "report@vnpay.vn", ["mx.cloudflare.net; dmarc=fail"]);
  const stranger = await run("x@evil.io", "x@evil.io", ["mx.cloudflare.net; dmarc=pass"]);
  // người gửi tự chèn header dmarc=pass phía dưới header thật của Cloudflare
  const injected = await run("report@vnpay.vn", "report@vnpay.vn", ["mx.cloudflare.net; dmarc=fail", "mx.cloudflare.net; dmarc=pass"]);
  // phong bì đúng tên miền nhưng From trong thư (thứ DMARC xác nhận) là tên miền khác
  const hdrMismatch = await run("bounce@vnpay.vn", "ceo@evil.io", ["mx.cloudflare.net; dmarc=pass"]);
  const log = await p.db.all<{ id: string; status: string }>("SELECT id, status FROM ingest_log");
  const st = Object.fromEntries(log.map((l) => [l.id, l.status]));
  assert.equal(st[ok], "done");
  assert.equal(st[nodmarc], "rejected");
  assert.equal(st[stranger], "rejected");
  assert.equal(st[injected], "rejected");
  assert.equal(st[hdrMismatch], "rejected");
  const f = await p.db.all<{ month: string; acq: string; name: string }>("SELECT month, acq, name FROM files");
  assert.deepEqual(f.map((x) => [x.month, x.acq, x.name]), [["2026-10", "vnpay", "doisoat.csv"]]);
  assert.equal([...p.files.keys()].filter((k) => k.startsWith("inbox/")).length, 5, "email gốc luôn được cất trước");
});

test("Biểu phí: seed 6 phương thức, kiểm tra dữ liệu khi sửa", async () => {
  const p = makePlatform({ AUTH_MODE: "dev", DEV_USER: "a@b.c" });
  const app = createApp(() => p);
  const docs = (await (await app.request(H + "/api/c/contracts")).json()).docs;
  assert.equal(docs.length, 6);
  const wechat = docs.find((d: { id: string }) => d.id === "lpm-wechat-2026-05").data;
  assert.equal(wechat.pct, 0.012);
  const bad = await app.request(H + "/api/c/contracts/x1", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...wechat, pct: 1.2 }) });
  assert.equal(bad.status, 400);
  const good = await app.request(H + "/api/c/contracts/lpm-wechat-2027-01-01", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...wechat, pct: 0.011, valid_from: "2027-01-01" }) });
  assert.equal(good.status, 200);
});
