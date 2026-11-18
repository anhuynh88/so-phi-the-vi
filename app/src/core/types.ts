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
  MAX_UPLOAD_MB?: string;
}

export interface Platform {
  mode: "cloudflare" | "local";
  db: SqlDb;
  blobs: BlobStore;
  cfg: Config;
  waitUntil(p: Promise<unknown>): void;
}

export interface User { email: string; canWrite: boolean; via: string }

export type AppEnv = { Variables: { p: Platform; user: User } };
