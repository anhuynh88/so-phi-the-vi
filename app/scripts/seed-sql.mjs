/* Tạo file SQL nạp số liệu window.SOPHI_PRELOAD (file HTML cũ) thẳng vào D1/SQLite, không cần đăng nhập API.
   D1 giới hạn 100 KB mỗi câu lệnh nên JSON được chia nhỏ vào bảng tạm rồi ghép lại.

   node scripts/seed-sql.mjs ../T10-2026.html > seed.sql
   npx wrangler d1 execute DB --remote --file seed.sql */
import { readFileSync } from "node:fs";

const html = readFileSync(process.argv[2], "utf8");
const m = /window\.SOPHI_PRELOAD\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/.exec(html);
if (!m) { console.error("Không thấy window.SOPHI_PRELOAD"); process.exit(1); }
const pre = JSON.parse(m[1]);
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const CH = 20000; // ký tự; tiếng Việt tối đa ~3 byte/ký tự → < 100 KB mỗi câu
const out = ["DROP TABLE IF EXISTS _seed;", "CREATE TABLE _seed (k TEXT, i INTEGER, part TEXT);"];
const now = new Date().toISOString();
for (const key of Object.keys(pre)) {
  if (!/^\d{4}-\d{2}$/.test(key)) throw new Error("kỳ không hợp lệ: " + key);
  const data = JSON.stringify({ ...pre[key], key, savedAt: pre[key].savedAt || now });
  for (let i = 0, n = 0; i < data.length; i += CH, n++) out.push(`INSERT INTO _seed (k, i, part) VALUES (${q(key)}, ${n}, ${q(data.slice(i, i + CH))});`);
  const full = `(SELECT group_concat(part, '') FROM (SELECT part FROM _seed WHERE k = ${q(key)} ORDER BY i))`;
  out.push(
    `INSERT INTO months (key, period, file, total_ds, total_fee, data, saved_at, saved_by)
     SELECT ${q(key)}, json_extract(d, '$.period'), json_extract(d, '$.file'), json_extract(d, '$.total.ds'), json_extract(d, '$.total.fee'), d, ${q(now)}, 'seed'
     FROM (SELECT ${full} AS d) WHERE json_valid(d)
     ON CONFLICT(key) DO UPDATE SET period=excluded.period, file=excluded.file, total_ds=excluded.total_ds, total_fee=excluded.total_fee, data=excluded.data, saved_at=excluded.saved_at, saved_by=excluded.saved_by;`,
    `DELETE FROM fee_lines WHERE month = ${q(key)};`,
    `INSERT INTO fee_lines(month, sheet, gate, channel, acq, mech, brand, card_type, scope, cur, tx_count, sales_vnd, fee_vnd, refund_vnd, ic_vnd, scheme_vnd, markup_vnd, contract_fee_vnd, contract_text)
     SELECT m.key, json_extract(j.value,'$.s'), json_extract(j.value,'$.g'), json_extract(j.value,'$.k'), json_extract(j.value,'$.a'), json_extract(j.value,'$.m'),
            json_extract(j.value,'$.b'), json_extract(j.value,'$.t'), json_extract(j.value,'$.p'), json_extract(j.value,'$.c'), json_extract(j.value,'$.n'),
            json_extract(j.value,'$.v'), json_extract(j.value,'$.f'), json_extract(j.value,'$.r'), json_extract(j.value,'$.i'), json_extract(j.value,'$.h'),
            json_extract(j.value,'$.u'), json_extract(j.value,'$.d'), json_extract(j.value,'$.x')
     FROM months m, json_each(m.data, '$.det') j WHERE m.key = ${q(key)};`,
  );
  console.error(key + ": " + data.length + " ký tự, " + Math.ceil(data.length / CH) + " phần");
}
out.push("DROP TABLE _seed;", "INSERT INTO revs(col, rev) VALUES ('months', 1) ON CONFLICT(col) DO UPDATE SET rev = rev + 1;",
  `INSERT INTO audit_log(at, actor, action, target) VALUES (${q(now)}, 'seed', 'seed-sql', 'months');`);
console.log(out.join("\n"));
