# Sổ phí thẻ & ví: bản web

Một bộ mã chạy được hai cách, dùng cùng giao diện, cùng API, cùng schema database:

| | Cloudflare | Máy local / máy chủ nội bộ |
|---|---|---|
| Lệnh | `npm run deploy` | `npm run local` |
| Database | D1 (SQLite) | SQLite (`data/sophi.db`) |
| File gốc | R2 | thư mục `data/files/` |
| Đăng nhập | Cloudflare Access | tài khoản local (`AUTH_MODE=basic`) hoặc Access qua Cloudflare Tunnel |
| Nhận email báo cáo | Email Worker | không có, dùng agent đọc thư mục Outlook |
| Chạy lại việc lỗi | Cron mỗi giờ | mỗi 15 phút trong tiến trình |

**Hybrid:** agent Python (`agent/`) chạy trên máy nội bộ, lấy file từ SFTP ngân hàng/cổng hoặc từ thư mục, rồi đẩy lên **một hoặc nhiều** máy chủ (vd vừa lên máy local, vừa lên Cloudflare). Hai máy chủ không tự đồng bộ với nhau.

```
Trình duyệt ── đọc Excel ngay trên máy (SheetJS) ──▶ API ──▶ D1/SQLite + R2/thư mục
Adyen ── webhook REPORT_AVAILABLE ──▶ /webhooks/adyen ──▶ tải báo cáo về thư mục ECOM/adyen
Email cổng/ngân hàng ──▶ Email Worker ──▶ cất .eml, lấy file đính kèm theo email_routes
Agent (SFTP, thư mục) ──▶ /api/ingest (Bearer token)
```

File vào tự động (Adyen, email, agent) được lưu nguyên và đánh dấu *chờ đọc bảng*. Lần tới người có quyền ghi mở trang, trình duyệt sẽ đọc bảng đợt chi trả của file đó rồi ghi kết quả lên máy chủ. Máy chủ không tự đọc Excel, vì Worker gói free chỉ có 10 ms CPU cho mỗi lần chạy.

## Cấu trúc

```
app/
  public/          giao diện (index.html chuyển từ trang cũ, claude-shim.js nối trang với API)
  src/core/        lõi dùng chung: app.ts (API), store.ts, auth.ts, adyen.ts, email.ts
  src/worker.ts    bản Cloudflare (D1, R2, email, cron)
  src/node.ts      bản local (node:sqlite, thư mục)
  migrations/      schema SQL, dùng chung D1 và SQLite
  agent/           agent Python đẩy file
  scripts/         seed.mjs (nạp số liệu từ HTML cũ), make-user.ts (tạo tài khoản local)
  test/            npm test
```

## Chạy thử trên máy (giả lập Cloudflare)

```bash
cd app
npm install
cp .dev.vars.example .dev.vars        # AUTH_MODE=dev: không đăng nhập, chỉ chạy trên localhost
npm run db:migrate:local
npm run dev                            # http://localhost:8787
node scripts/seed.mjs --html ../T10-2026.html --url http://localhost:8787   # nạp số liệu T10/2026
```

## Chạy bản local (máy kế toán / máy chủ nội bộ)

Cần Node 22.13 trở lên (có sẵn `node:sqlite`).

```bash
cd app
npm install
cp .env.example .env
npm run local:user -- ketoan@congty.vn "mật khẩu dài"   # chép dòng in ra vào LOCAL_USERS trong .env
# sửa WRITER_EMAILS, INGEST_TOKEN trong .env
npm run local                                             # http://127.0.0.1:8788
node scripts/seed.mjs --html ../T10-2026.html --url http://127.0.0.1:8788 --user ketoan@congty.vn --pass "mật khẩu dài"
```

- Mặc định chỉ nghe ở `127.0.0.1`. Nếu đặt `HOST=0.0.0.0` để cả mạng LAN dùng chung thì mật khẩu sẽ đi qua HTTP không mã hoá. Nên đưa ra ngoài bằng **Cloudflare Tunnel + Access** (`AUTH_MODE=access`) hoặc đặt sau reverse proxy có HTTPS.
- Muốn chạy nền khi khởi động máy: dùng Task Scheduler (Windows) chạy `npm run local` trong thư mục `app`, hoặc dùng NSSM / pm2.
- Sao lưu: chép thư mục `SOPHI_DATA` (`sophi.db` và `files/`).

## Đưa lên Cloudflare

Cần chuẩn bị trước:
1. Tài khoản Cloudflare. R2 thường yêu cầu bật thanh toán, dù vẫn có 10 GB miễn phí.
2. Zero Trust (Cloudflare Access): tạo team, miễn phí tới 50 người dùng.
3. Email Routing (nếu nhận báo cáo qua email): cần một tên miền đang dùng DNS của Cloudflare.

```bash
cd app
npx wrangler login
npx wrangler d1 create so-phi             # chép database_id vào wrangler.jsonc
npx wrangler r2 bucket create so-phi-files
npm run db:migrate:remote
npx wrangler secret put INGEST_TOKEN      # chuỗi ngẫu nhiên >= 24 ký tự
npm run deploy
```

**Đăng nhập không cần thẻ (đang dùng):** `AUTH_MODE=basic` trong `wrangler.jsonc`. Tài khoản đặt bằng
`npm run local:user -- admin "mật khẩu" 5000`, rồi chép dòng in ra vào `npx wrangler secret put LOCAL_USERS`
(dùng 5.000 vòng vì Worker gói free chỉ có 10 ms CPU; mật khẩu nên là chuỗi ngẫu nhiên dài). `run_worker_first: true`
nên cả trang lẫn API đều hỏi mật khẩu.

**Cloudflare Access** (tuỳ chọn, cần kích hoạt Zero Trust, Cloudflare bắt khai thẻ dù gói Free 0 đ). Đổi `AUTH_MODE=access`, rồi:
1. Zero Trust → Access → Applications → *Self-hosted*: chọn tên miền của Worker (cả `*.workers.dev` nếu còn bật), policy *Allow* cho email công ty.
2. Chép **Application Audience (AUD) tag** vào `ACCESS_AUD`, đặt `ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com`.
3. `WRITER_EMAILS`: danh sách email được tải file và lưu kỳ, cách nhau dấu phẩy. Người khác chỉ được xem.
4. Tạo thêm một application cho đường `/webhooks/*` với policy **Bypass** cho mọi người, vì Adyen không đăng nhập Access được. Đường này có xác thực riêng bằng Basic auth + HMAC.
5. Agent: chọn một trong hai cách. (a) Bypass cho `/api/ingest`, vì đường này đã có Bearer token. (b) Tạo **Service Token**, thêm policy *Service Auth*, rồi khai `access_client_id_env` / `access_client_secret_env` trong `agent.json`.

## Nối Adyen (báo cáo tự động)

1. Customer Area → Developers → API credentials → tạo credential loại **Report user**, gán role **Merchant Report Download**. Lưu API key (hoặc mật khẩu Basic) bằng `npx wrangler secret put ADYEN_REPORT_API_KEY`.
2. Developers → Webhooks → *Standard notification*: URL `https://<tên miền>/webhooks/adyen`, bật Basic auth (`ADYEN_WEBHOOK_USER` / `ADYEN_WEBHOOK_PASS`), tạo **HMAC key** (`ADYEN_HMAC_KEY`), bật sự kiện **REPORT_AVAILABLE**. Đặt cả ba bằng `wrangler secret put`.
3. Bật tự sinh các báo cáo cần (Settlement details, Payment accounting…). Mỗi báo cáo sinh xong sẽ tự về `YYMM data/ECOM/adyen`, kỳ lấy theo ngày trong tên file.

Lưu ý:
- Chữ ký HMAC của Adyen không bao phủ trường `reason` (URL tải). Vì vậy máy chủ chỉ tải từ `https://*.adyen.com`, và chỉ gửi API key tới các địa chỉ đó.
- Báo cáo mã hoá PGP (nếu đã đăng ký khoá PGP với Adyen) được lưu nguyên dạng mã hoá.

## Nhận báo cáo qua email

1. Email Routing → tạo địa chỉ, vd `baocao@congty.vn` → *Send to a Worker* → `so-phi`.
2. Khai danh sách người gửi được nhận bằng cấu hình `email_routes`. Ví dụ (chạy khi đã đăng nhập, người có quyền ghi):

```bash
curl -X PUT https://<tên miền>/api/c/config/email_routes -H "content-type: application/json" \
  -H "CF-Access-Client-Id: ..." -H "CF-Access-Client-Secret: ..." \
  -d '{"routes":[
        {"from":"@vnpay\\.vn$","sec":"ECOM","acq":"vnpay","monthOffset":-1},
        {"from":"@momo\\.vn$","sec":"ECOM","acq":"momo","monthOffset":-1,"name":"doi.?soat"},
        {"from":"@vietcombank\\.com\\.vn$","sec":"BANK STATEMENT","acq":""}]}'
```

- Email từ người gửi không có trong danh sách, hoặc không qua DMARC, bị từ chối. Email gốc vẫn được cất trong R2 (`inbox/`) và ghi vào nhật ký.
- `acq` là id thư mục: `adyen, 2c2p, paypal, amex-ecom, vcb, vnpay, napas, shopeepay, vietqr-mb, momo, kcp, ecom-khac` (ECOM) và `worldpay, amex-bsp, accelya, payone, jcb-jp, uc-card-jp, bsp-khac` (BSP).
- Email gốc luôn được cất trước. Nếu bước đọc file đính kèm vượt giới hạn CPU của gói free, cron sẽ thử lại (tối đa 5 lần). File đính kèm lớn thì nên dùng gói Workers Paid.

## Agent trên máy nội bộ

```bash
cd app/agent
copy agent.example.json agent.json      # sửa nguồn và máy chủ đích
set SOPHI_LOCAL_TOKEN=...               # INGEST_TOKEN của từng máy chủ
python sophi_agent.py --config agent.json --dry-run
python sophi_agent.py --config agent.json
```

- Nguồn `folder`: thư mục bất kỳ, vd thư mục Outlook tự lưu file đính kèm hay thư mục tải từ portal VNPay/MoMo/VCB.
- Nguồn `sftp`: cần `pip install paramiko`. Khoá máy chủ phải có sẵn trong `known_hosts`. Mật khẩu đọc từ biến môi trường (`password_env`), không ghi trong file.
- `month`: `mtime`, `mtime-1` (file gửi đầu tháng sau cho tháng trước), `filename` (lấy năm-tháng trong tên file) hoặc một kỳ cố định `2026-10`.
- Đặt lịch chạy bằng Task Scheduler, vd mỗi giờ.

## API

| Đường | Quyền | Việc |
|---|---|---|
| `GET /api/me` | đã đăng nhập | người dùng, quyền ghi |
| `GET /api/c/{months,files,folders,config,contracts}` | xem | đọc dữ liệu |
| `PUT/DELETE /api/c/:col/:id` | ghi | lưu / xoá |
| `GET /api/rev` | xem | bộ đếm thay đổi; trang hỏi mỗi 5 giây để tự cập nhật |
| `POST /api/blobs`, `GET /_blob/:id` | ghi / xem | file gốc |
| `GET /api/export/fee-lines.csv?month=YYYY-MM` | xem | dòng chi tiết phí (bảng `fee_lines`) |
| `GET /api/ingest-log`, `POST /api/ingest-log/:id/retry` | xem / ghi | nhật ký nhận file tự động |
| `POST /api/ingest` | Bearer `INGEST_TOKEN` | agent đẩy file |
| `POST /webhooks/adyen` | Basic + HMAC | webhook Adyen |

## Thay đổi so với trang HTML cũ

- Bỏ khoá `admin/admin` ở trang Tải file. Đăng nhập do máy chủ xử lý (Access hoặc tài khoản local); ai không có trong `WRITER_EMAILS` thì chỉ xem.
- Biểu phí LPM (UnionPay, Alipay, WeChat Pay, Konbini, UPI, RuPay) chuyển từ mã cứng sang bảng `fee_contracts` có ngày hiệu lực, sửa được ở cuối trang Đối soát. Phí xử lý LPM theo bậc (USD 0,08 / 0,09 mỗi GD) và chu kỳ T+ mặc định vẫn nằm trong mã trang.
- File gốc lưu dạng nhị phân (không còn gói base64), tối đa 50 MB.
- Các trang báo cáo dùng nguyên mã hiển thị cũ. Với số liệu T10/2026, nội dung các trang Tổng quan, Cổng & acquirer, Hãng thẻ, BIN, Adyen Card, VCB Card trùng khớp từng ký tự với `T10-2026.html`.

## Kiểm thử

```bash
npm test          # 13 test: HMAC Adyen (test vector chính thức), đăng nhập, phân quyền, lưu kỳ, file, agent, email
npm run typecheck
```
