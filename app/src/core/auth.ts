import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Config, SqlDb, User } from "./types";
import { viaJwt } from "./session";
import { fromB64, HttpError, safeEqual, b64 } from "./util";

/* Đăng nhập. Mặc định từ chối: thiếu cấu hình hoặc token sai đều trả lỗi, không có đường lui "cho qua". */

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function writerOf(cfg: Config, email: string): boolean {
  const list = (cfg.WRITER_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes("*") || list.includes(email.toLowerCase());
}

function isLocalHost(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

function cookie(req: Request, name: string): string | null {
  const h = req.headers.get("cookie") || "";
  for (const part of h.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

async function viaAccess(req: Request, cfg: Config): Promise<User> {
  const team = (cfg.ACCESS_TEAM_DOMAIN || "").replace(/\/+$/, "");
  const aud = cfg.ACCESS_AUD || "";
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/i.test(team) || !aud) throw new HttpError(503, "auth_not_configured", "Chưa cấu hình Cloudflare Access (ACCESS_TEAM_DOMAIN, ACCESS_AUD).");
  const token = req.headers.get("cf-access-jwt-assertion") || cookie(req, "CF_Authorization");
  if (!token) throw new HttpError(401, "unauthenticated", "Chưa đăng nhập qua Cloudflare Access.");
  let jwks = jwksCache.get(team);
  if (!jwks) { jwks = createRemoteJWKSet(new URL(team + "/cdn-cgi/access/certs")); jwksCache.set(team, jwks); }
  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, { issuer: team, audience: aud }));
  } catch {
    throw new HttpError(401, "unauthenticated", "Phiên đăng nhập không hợp lệ hoặc đã hết hạn.");
  }
  const email = typeof payload.email === "string" ? payload.email : "";
  if (email) return { email, canWrite: writerOf(cfg, email), via: "access" };
  // service token (agent đứng sau Access): common_name = Client ID
  const cn = typeof payload.common_name === "string" ? payload.common_name : "";
  if (cn) return { email: "service:" + cn, canWrite: writerOf(cfg, "service:" + cn), via: "access-service" };
  throw new HttpError(401, "unauthenticated", "Token Access không có email.");
}

/* Mật khẩu local: pbkdf2$<vòng lặp>$<salt base64>$<hash base64>, SHA-256 */
export async function hashPassword(password: string, iterations = 210000): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$${iterations}$${b64(salt)}$${b64(hash)}`;
}
async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, 256));
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const m = /^pbkdf2\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(stored);
  if (!m) return false;
  const got = await pbkdf2(password, fromB64(m[2]), +m[1]);
  return safeEqual(b64(got), m[3]);
}

const BASIC_FAIL = new HttpError(401, "unauthenticated", "Sai tài khoản hoặc mật khẩu.");
/* PBKDF2 chậm có chủ đích; nhớ kết quả 10 phút để trang hỏi dữ liệu liên tục không phải băm lại */
const basicCache = new Map<string, { email: string; until: number }>();
async function viaBasic(req: Request, cfg: Config): Promise<User> {
  const hit = basicCache.get((req.headers.get("authorization") || "") + "|" + (cfg.LOCAL_USERS || ""));
  if (hit && hit.until > Date.now()) return { email: hit.email, canWrite: writerOf(cfg, hit.email), via: "basic" };
  const u = await viaBasicSlow(req, cfg);
  if (basicCache.size > 200) basicCache.clear();
  basicCache.set((req.headers.get("authorization") || "") + "|" + (cfg.LOCAL_USERS || ""), { email: u.email, until: Date.now() + 600000 });
  return u;
}
async function viaBasicSlow(req: Request, cfg: Config): Promise<User> {
  const users = new Map<string, string>();
  for (const part of (cfg.LOCAL_USERS || "").split(";")) {
    const i = part.indexOf(":");
    if (i > 0) users.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
  }
  if (!users.size) throw new HttpError(503, "auth_not_configured", "Chưa có tài khoản local (LOCAL_USERS). Chạy npm run local:user để tạo.");
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) throw BASIC_FAIL;
  let dec = "";
  try { dec = new TextDecoder().decode(fromB64(h.slice(6))); } catch { throw BASIC_FAIL; }
  const i = dec.indexOf(":");
  const email = dec.slice(0, i).trim().toLowerCase(), pass = dec.slice(i + 1);
  const stored = users.get(email);
  if (i < 0 || !stored || !(await verifyPassword(pass, stored))) throw BASIC_FAIL;
  return { email, canWrite: writerOf(cfg, email), via: "basic" };
}

export async function authenticate(req: Request, cfg: Config, db?: SqlDb): Promise<User> {
  const mode = (cfg.AUTH_MODE || "").toLowerCase();
  if (mode === "jwt") {
    if (!db) throw new HttpError(503, "auth_not_configured", "Chế độ jwt cần database.");
    return viaJwt(req, cfg, db);
  }
  if (mode === "access") return viaAccess(req, cfg);
  if (mode === "basic") return viaBasic(req, cfg);
  if (mode === "dev") {
    // chỉ cho phép khi chạy trên máy (wrangler dev / node local), không bao giờ trên tên miền thật
    if (!isLocalHost(new URL(req.url)) || !cfg.DEV_USER) throw new HttpError(403, "forbidden", "Chế độ dev chỉ dùng trên localhost.");
    return { email: cfg.DEV_USER, canWrite: cfg.DEV_READONLY !== "1", via: "dev" };
  }
  throw new HttpError(503, "auth_not_configured", "Chưa đặt AUTH_MODE (jwt | access | basic | dev).");
}

/** Token cho agent đẩy file: Authorization: Bearer <INGEST_TOKEN> */
export function checkBearer(req: Request, expected: string | undefined): void {
  if (!expected || expected.length < 24) throw new HttpError(503, "ingest_not_configured", "Chưa đặt INGEST_TOKEN (tối thiểu 24 ký tự).");
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Bearer ") || !safeEqual(h.slice(7).trim(), expected)) throw new HttpError(401, "unauthenticated", "Token không đúng.");
}

export function checkBasicPair(req: Request, user?: string, pass?: string): void {
  if (!user || !pass) throw new HttpError(503, "webhook_not_configured", "Chưa đặt tài khoản webhook.");
  const h = req.headers.get("authorization") || "";
  let ok = false;
  if (h.startsWith("Basic ")) {
    try { ok = safeEqual(new TextDecoder().decode(fromB64(h.slice(6))), user + ":" + pass); } catch { ok = false; }
  }
  if (!ok) throw new HttpError(401, "unauthenticated", "Sai tài khoản webhook.");
}
