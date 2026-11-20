/* Đăng nhập bằng form + phiên JWT (AUTH_MODE=jwt).

   - Tài khoản nằm trong bảng users (D1 / SQLite). Lần đầu bảng trống thì nhập các tài khoản trong LOCAL_USERS,
     đánh dấu phải đổi mật khẩu ở lần đăng nhập đầu.
   - Đăng nhập thành công: máy chủ ký JWT HS256 (JWT_SECRET) và đặt cookie HttpOnly, SameSite=Strict.
   - Mỗi request kiểm tra chữ ký, hạn dùng và token_ver trong bảng users: đổi mật khẩu, đổi quyền, xoá tài khoản
     hay "đăng xuất mọi nơi" đều làm phiên cũ hết hiệu lực ngay.
   - Sai mật khẩu 5 lần liên tiếp: khoá tài khoản 15 phút.
   - Script (seed.mjs…) vẫn dùng được header Authorization: Basic với cùng tài khoản. */
import { SignJWT, jwtVerify } from "jose";
import type { Config, SqlDb, User } from "./types";
import { hashPassword, verifyPassword } from "./auth";
import { HttpError, fromB64, now } from "./util";

export const COOKIE = "sophi_s";
const MAX_FAILED = 5;
const LOCK_MIN = 15;
// mã băm giả để người dùng không tồn tại cũng tốn thời gian như người dùng có thật (không dò được tên)
const DUMMY_HASH = "pbkdf2$5000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export interface UserRow {
  username: string; pass_hash: string; can_write: number; is_admin: number; must_change: number;
  token_ver: number; failed: number; locked_until: string | null; created_at: string; updated_at: string | null; last_login: string | null;
}

export const validUsername = (u: string) => /^[a-z0-9._@-]{3,64}$/.test(u);
export function checkNewPassword(pw: unknown): string {
  if (typeof pw !== "string" || pw.length < 10) throw new HttpError(400, "invalid_argument", "Mật khẩu mới phải có ít nhất 10 ký tự.");
  if (pw.length > 200) throw new HttpError(400, "invalid_argument", "Mật khẩu quá dài.");
  return pw;
}
export const iterOf = (cfg: Config) => Math.max(1000, Number(cfg.PBKDF2_ITER) || 210000);
export const newHash = (pw: string, cfg: Config) => hashPassword(pw, iterOf(cfg));

function secretOf(cfg: Config): Uint8Array {
  const s = cfg.JWT_SECRET || "";
  if (s.length < 32) throw new HttpError(503, "auth_not_configured", "Chưa đặt JWT_SECRET (tối thiểu 32 ký tự).");
  return new TextEncoder().encode(s);
}
const hours = (cfg: Config) => Math.min(24 * 30, Math.max(1, Number(cfg.SESSION_HOURS) || 12));

function cookieOf(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") || "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export function sessionCookie(req: Request, token: string, maxAgeSec: number): string {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
}
export const clearCookie = (req: Request) => sessionCookie(req, "", 0);

/* ---------------------------------------------------------------- tài khoản */

export async function getUser(db: SqlDb, username: string): Promise<UserRow | null> {
  return (await db.all<UserRow>("SELECT * FROM users WHERE username = ?", [username]))[0] || null;
}

/** Bảng users trống: nhập tài khoản từ LOCAL_USERS (đã băm sẵn), bắt đổi mật khẩu lần đầu. */
export async function bootstrapUsers(db: SqlDb, cfg: Config): Promise<void> {
  const n = (await db.all<{ n: number }>("SELECT count(*) AS n FROM users"))[0]?.n || 0;
  if (n) return;
  const writers = (cfg.WRITER_EMAILS || "").split(",").map((s) => s.trim().toLowerCase());
  const t = now();
  for (const part of (cfg.LOCAL_USERS || "").split(";")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const u = part.slice(0, i).trim().toLowerCase(), h = part.slice(i + 1).trim();
    if (!validUsername(u) || !h.startsWith("pbkdf2$")) continue;
    const w = writers.includes("*") || writers.includes(u) ? 1 : 0;
    await db.run("INSERT OR IGNORE INTO users(username, pass_hash, can_write, is_admin, must_change, created_at) VALUES (?,?,?,?,1,?)", [u, h, w, w, t]);
  }
}

/** Kiểm tra tên + mật khẩu, có khoá tạm khi sai nhiều lần. Trả lỗi chung để không dò được tên đăng nhập. */
export async function checkPassword(db: SqlDb, cfg: Config, usernameRaw: string, password: string): Promise<UserRow> {
  await bootstrapUsers(db, cfg);
  const username = String(usernameRaw || "").trim().toLowerCase();
  const fail = new HttpError(401, "unauthenticated", "Sai tên đăng nhập hoặc mật khẩu.");
  const u = validUsername(username) ? await getUser(db, username) : null;
  if (!u) { await verifyPassword(password || "", DUMMY_HASH); throw fail; }
  if (u.locked_until && u.locked_until > now()) throw new HttpError(429, "rate_limited", `Tài khoản tạm khoá do sai mật khẩu nhiều lần. Thử lại sau ${LOCK_MIN} phút.`);
  if (!(await verifyPassword(password || "", u.pass_hash))) {
    const f = u.failed + 1;
    const lock = f >= MAX_FAILED ? new Date(Date.now() + LOCK_MIN * 60000).toISOString() : null;
    await db.run("UPDATE users SET failed = ?, locked_until = ? WHERE username = ?", [lock ? 0 : f, lock, username]);
    throw fail;
  }
  if (u.failed || u.locked_until) await db.run("UPDATE users SET failed = 0, locked_until = NULL WHERE username = ?", [username]);
  return u;
}

export async function issueToken(cfg: Config, u: Pick<UserRow, "username" | "token_ver">): Promise<{ token: string; maxAge: number }> {
  const h = hours(cfg);
  const token = await new SignJWT({ v: u.token_ver }).setProtectedHeader({ alg: "HS256" }).setSubject(u.username)
    .setIssuedAt().setExpirationTime(h + "h").sign(secretOf(cfg));
  return { token, maxAge: h * 3600 };
}

const toUser = (u: UserRow, via: string): User => ({ email: u.username, canWrite: !!u.can_write, isAdmin: !!u.is_admin, mustChange: !!u.must_change, via });

/** Xác thực request ở chế độ jwt: cookie phiên, hoặc Basic (cho script). */
export async function viaJwt(req: Request, cfg: Config, db: SqlDb): Promise<User> {
  const h = req.headers.get("authorization") || "";
  if (h.startsWith("Basic ")) {
    let dec = "";
    try { dec = new TextDecoder().decode(fromB64(h.slice(6))); } catch { /* bỏ qua */ }
    const i = dec.indexOf(":");
    if (i < 0) throw new HttpError(401, "unauthenticated", "Sai tên đăng nhập hoặc mật khẩu.");
    return toUser(await checkPassword(db, cfg, dec.slice(0, i), dec.slice(i + 1)), "basic");
  }
  const token = cookieOf(req, COOKIE);
  if (!token) throw new HttpError(401, "unauthenticated", "Chưa đăng nhập.");
  let sub = "", v = 0;
  try {
    const { payload } = await jwtVerify(token, secretOf(cfg), { algorithms: ["HS256"] });
    sub = String(payload.sub || ""); v = Number(payload.v);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(401, "unauthenticated", "Phiên đăng nhập hết hạn. Đăng nhập lại.");
  }
  const u = await getUser(db, sub);
  if (!u || u.token_ver !== v) throw new HttpError(401, "unauthenticated", "Phiên đăng nhập không còn hiệu lực. Đăng nhập lại.");
  // chống CSRF: cookie đã SameSite=Strict; thêm kiểm tra Origin cho request ghi
  if (!["GET", "HEAD"].includes(req.method)) {
    const origin = req.headers.get("origin");
    if (origin && origin !== new URL(req.url).origin) throw new HttpError(403, "forbidden", "Yêu cầu từ trang khác bị chặn.");
  }
  return toUser(u, "jwt");
}

/* ---------------------------------------------------------------- trang tĩnh */

/** Trang không cần đăng nhập ở chế độ jwt. */
export const PUBLIC_PATHS = new Set(["/login.html", "/auth.css", "/favicon.ico"]);

/** Request trang (không phải API) chưa đăng nhập: chuyển sang /login.html, giữ đường cũ để quay lại. */
export function loginRedirect(req: Request): Response {
  const u = new URL(req.url);
  const next = u.pathname === "/" || u.pathname === "/index.html" ? "" : "?next=" + encodeURIComponent(u.pathname + u.search);
  return new Response(null, { status: 302, headers: { location: "/login.html" + next, "cache-control": "no-store" } });
}

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store" } });

/** Cổng cho file tĩnh. Trả Response (chuyển hướng) nếu chưa được xem trang, null nếu cho qua.
    Chế độ khác jwt: giữ cách cũ (authenticate ném lỗi 401). */
export async function gatePage(req: Request, cfg: Config, db: SqlDb, authenticate: (r: Request, c: Config, d: SqlDb) => Promise<User>): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if ((cfg.AUTH_MODE || "").toLowerCase() !== "jwt") { await authenticate(req, cfg, db); return null; }
  if (PUBLIC_PATHS.has(path)) return null;
  let u: User;
  try { u = await viaJwt(req, cfg, db); }
  catch (e) { if (e instanceof HttpError && e.status === 401) return loginRedirect(req); throw e; }
  if (u.mustChange && path !== "/account.html") return redirect("/account.html");
  return null;
}
