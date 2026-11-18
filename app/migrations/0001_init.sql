-- Sổ phí thẻ & ví: schema dùng chung cho Cloudflare D1 và SQLite local.
-- Tiền lưu bằng số nguyên VND (đồng), giống file tổng hợp đã quy đổi.

-- Kỳ báo cáo: bản tóm tắt đọc từ file tổng hợp mẫu AITS (JSON giữ nguyên cấu trúc trang đang dùng)
CREATE TABLE IF NOT EXISTS months (
  key        TEXT PRIMARY KEY,            -- YYYY-MM
  period     TEXT,
  file       TEXT,
  total_ds   INTEGER,
  total_fee  INTEGER,
  data       TEXT NOT NULL,               -- JSON
  saved_at   TEXT NOT NULL,
  saved_by   TEXT
);

-- Dòng chi tiết phí, tách ra từ months.data.det để truy vấn / xuất CSV
CREATE TABLE IF NOT EXISTS fee_lines (
  month        TEXT NOT NULL REFERENCES months(key) ON DELETE CASCADE,
  sheet        TEXT, gate TEXT, channel TEXT, acq TEXT, mech TEXT, brand TEXT, card_type TEXT, scope TEXT, cur TEXT,
  tx_count     INTEGER, sales_vnd INTEGER, fee_vnd INTEGER, refund_vnd INTEGER,
  ic_vnd       INTEGER, scheme_vnd INTEGER, markup_vnd INTEGER,
  contract_fee_vnd INTEGER, contract_text TEXT
);
CREATE INDEX IF NOT EXISTS fee_lines_month ON fee_lines(month);
CREATE INDEX IF NOT EXISTS fee_lines_acq ON fee_lines(acq, month);

-- File gốc trong thư mục YYMM data (nội dung nằm ở R2 / thư mục local, bảng blobs)
CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,
  month      TEXT NOT NULL,
  sec        TEXT NOT NULL,               -- TONG HOP | BANK STATEMENT | ECOM | BSP
  acq        TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL,
  size       INTEGER,
  blob_id    TEXT,
  sha256     TEXT,
  source     TEXT NOT NULL DEFAULT 'upload', -- upload | email | adyen | agent
  pending    INTEGER NOT NULL DEFAULT 0,  -- 1 = chưa đọc bảng đợt chi trả (file vào từ email/agent/webhook)
  data       TEXT NOT NULL,               -- JSON (meta + đợt chi trả đã đọc)
  created_at TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS files_month ON files(month);
CREATE INDEX IF NOT EXISTS files_sha ON files(sha256);

CREATE TABLE IF NOT EXISTS blobs (
  id           TEXT PRIMARY KEY,
  content_type TEXT,
  size         INTEGER,
  sha256       TEXT,
  created_at   TEXT NOT NULL,
  created_by   TEXT
);

CREATE TABLE IF NOT EXISTS folders (
  id   TEXT PRIMARY KEY,                  -- YYMM
  data TEXT NOT NULL
);

-- Cấu hình dùng chung: terms (chu kỳ T+), email_routes, ...
CREATE TABLE IF NOT EXISTS config (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at TEXT,
  updated_by TEXT
);

-- Biểu phí theo hợp đồng, có hiệu lực theo ngày (thay mảng LPM viết cứng trong trang cũ)
CREATE TABLE IF NOT EXISTS fee_contracts (
  id          TEXT PRIMARY KEY,
  method      TEXT NOT NULL,              -- tên hiển thị: UnionPay, Alipay, ...
  market      TEXT,
  acq         TEXT NOT NULL,              -- acquirer trong file tổng hợp
  match_re    TEXT NOT NULL,              -- regex khớp hãng / phương thức
  match_flags TEXT NOT NULL DEFAULT 'i',
  pct         REAL NOT NULL,              -- tỷ lệ % dạng thập phân (0.018 = 1,80%)
  fixed_jpy   REAL NOT NULL DEFAULT 0,    -- phí cố định mỗi GD (JPY)
  proc        INTEGER NOT NULL DEFAULT 0, -- 1 = cộng phí xử lý Schedule 1 LPM (USD/GD)
  label       TEXT,                       -- cách ghi trong HĐ, vd "1,70% + JPY 165"
  source      TEXT,                       -- văn bản HĐ
  valid_from  TEXT NOT NULL,              -- YYYY-MM-DD
  valid_to    TEXT,                       -- NULL = còn hiệu lực
  sort        INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT,
  updated_by  TEXT
);

-- Nhật ký nhận file tự động (webhook Adyen, email, agent) để thử lại khi lỗi
CREATE TABLE IF NOT EXISTS ingest_log (
  id         TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  status     TEXT NOT NULL,               -- queued | done | failed | rejected | duplicate
  detail     TEXT,                        -- JSON
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ingest_status ON ingest_log(status);

CREATE TABLE IF NOT EXISTS audit_log (
  at     TEXT NOT NULL,
  actor  TEXT,
  action TEXT NOT NULL,
  target TEXT
);

-- Bộ đếm thay đổi theo bảng, trang dùng để biết khi nào cần tải lại
CREATE TABLE IF NOT EXISTS revs (
  col TEXT PRIMARY KEY,
  rev INTEGER NOT NULL
);
