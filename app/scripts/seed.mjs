/* Nạp số liệu có sẵn trong file HTML cũ (window.SOPHI_PRELOAD, vd T10-2026.html) vào database qua API.
   Dùng API thay vì SQL trực tiếp để đi qua cùng bước kiểm tra dữ liệu và chạy được cho cả local lẫn Cloudflare.

   node scripts/seed.mjs --html ../T10-2026.html --url http://localhost:8787
   node scripts/seed.mjs --html ../T10-2026.html --url http://127.0.0.1:8788 --user ban@congty.vn --pass "..."
   node scripts/seed.mjs --html ../T10-2026.html --url https://so-phi.example.com --access-id <id> --access-secret <secret> */
import { readFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
if (!args.html || !args.url) { console.error("Cần --html <file> và --url <địa chỉ máy chủ>"); process.exit(1); }

const html = readFileSync(args.html, "utf8");
const m = /window\.SOPHI_PRELOAD\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/.exec(html);
if (!m) { console.error("Không thấy window.SOPHI_PRELOAD trong file."); process.exit(1); }
const pre = JSON.parse(m[1]);

const headers = { "content-type": "application/json" };
if (args.user) headers.authorization = "Basic " + Buffer.from(args.user + ":" + (args.pass || "")).toString("base64");
if (args["access-id"]) { headers["CF-Access-Client-Id"] = args["access-id"]; headers["CF-Access-Client-Secret"] = args["access-secret"] || ""; }

for (const key of Object.keys(pre)) {
  const data = { ...pre[key], key, savedAt: pre[key].savedAt || new Date().toISOString() };
  const res = await fetch(args.url.replace(/\/+$/, "") + "/api/c/months/" + key, { method: "PUT", headers, body: JSON.stringify(data) });
  const body = await res.text();
  console.log(key, res.status, body.slice(0, 200));
  if (!res.ok) process.exitCode = 1;
}
