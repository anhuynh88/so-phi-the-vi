/* Lớp nền tảng: cùng một app chạy trên Cloudflare (D1 + R2) và trên máy local (SQLite + thư mục). */

export interface SqlStmt { sql: string; params?: unknown[] }

export interface SqlDb {
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
  /** Chạy nhiều câu lệnh trong một transaction. */
  batch(stmts: SqlStmt[]): Promise<void>;
}

export interface BlobStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | ReadableStream | null>;
  delete(key: string): Promise<void>;
}

export interface Config {
  /** access = Cloudflare Access JWT, basic = tài khoản local (LOCAL_USERS), dev = không đăng nhập (chỉ localhost) */
  AUTH_MODE?: string;
  ACCESS_TEAM_DOMAIN?: string; // https://<team>.cloudflareaccess.com
  ACCESS_AUD?: string;
  WRITER_EMAILS?: string;      // danh sách email được ghi, cách nhau dấu phẩy; "*" = mọi người đã đăng nhập
  DEV_USER?: string;
  DEV_READONLY?: string;
  LOCAL_USERS?: string;        // email:pbkdf2$iter$salt$hash;email2:...
  INGEST_TOKEN?: string;       // token cho agent đẩy file
  ADYEN_WEBHOOK_USER?: string;
  ADYEN_WEBHOOK_PASS?: string;
  ADYEN_HMAC_KEY?: string;     // hex
  ADYEN_REPORT_API_KEY?: string;
  ADYEN_REPORT_USER?: string;
  ADYEN_REPORT_PASS?: string;
  ADYEN_ACQ?: string;          // thư mục acquirer cho báo cáo Adyen, mặc định "adyen"
  ADYEN_REPORT_BASE?: string;  // mặc định https://ca-live.adyen.com/reports/download
  ADYEN_PULL_COMPANY?: string;  // kéo báo cáo cấp công ty theo lịch (21h VN), đặt bằng secret (npx wrangler secret put ADYEN_PULL_COMPANY); để trống = tắt
  MAX_UPLOAD_MB?: string;
  STORAGE_LIMIT_MB?: string;   // giới hạn cứng tổng dung lượng file gốc trên kho này; vượt thì từ chối file mới
  OFFLOAD_ABOVE_MB?: string;   // Worker: kho vượt mức này thì chuyển file cũ nhất (đã có ở local) về local và xoá khỏi kho
  BACKUP_TOKEN?: string;       // token sao lưu Cloudflare → local (đặt giống nhau ở hai bên)
  JWT_SECRET?: string;         // AUTH_MODE=jwt: khoá ký phiên đăng nhập (>= 32 ký tự)
  SESSION_HOURS?: string;      // thời hạn phiên, mặc định 12 giờ
  PBKDF2_ITER?: string;        // số vòng băm mật khẩu mới; Worker gói free nên để ~5.000
}

export interface Platform {
  mode: "cloudflare" | "local";
  db: SqlDb;
  blobs: BlobStore;
  cfg: Config;
  waitUntil(p: Promise<unknown>): void;
  /** Đọc file đã chuyển về máy local (Worker: qua tunnel sao lưu). */
  fetchOffloaded?(id: string): Promise<ReadableStream | Uint8Array | null>;
}

export interface User { email: string; canWrite: boolean; via: string; isAdmin?: boolean; mustChange?: boolean }

export type AppEnv = { Variables: { p: Platform; user: User } };
