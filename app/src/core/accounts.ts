/* API tài khoản cho chế độ đăng nhập bằng form (AUTH_MODE=jwt):
   - công khai: POST /api/auth/login, POST /api/auth/logout
   - đã đăng nhập: POST /api/auth/password (đổi tên đăng nhập / mật khẩu), POST /api/auth/logout-all
   - quản trị: GET /api/users, PUT /api/users/:u (tạo / sửa quyền / đặt lại mật khẩu), DELETE /api/users/:u */
import type { Context, Hono } from "hono";
import type { AppEnv, Platform, SqlStmt } from "./types";
import { checkNewPassword, checkPassword, clearCookie, getUser, issueToken, newHash, sessionCookie, validUsername, type UserRow } from "./session";
import { HttpError, now } from "./util";

const isJwt = (c: Context<AppEnv>) => (c.get("p").cfg.AUTH_MODE || "").toLowerCase() === "jwt";
const needJwt = (c: Context<AppEnv>) => {
  if (!isJwt(c)) throw new HttpError(404, "not_found", "Máy chủ không dùng đăng nhập bằng tài khoản trong database (AUTH_MODE=jwt).");
};
const BAD_NAME = "Tên đăng nhập 3–64 ký tự: chữ thường, số, dấu . _ - @.";

async function jsonBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  try { const b = await c.req.json(); if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>; } catch { /* bỏ qua */ }
  throw new HttpError(400, "invalid_argument", "JSON không hợp lệ.");
}
const audit = (actor: string, action: string, target: string): SqlStmt => ({ sql: "INSERT INTO audit_log(at, actor, action, target) VALUES (?,?,?,?)", params: [now(), actor, action, target] });

/** Đường công khai: gắn TRƯỚC middleware đăng nhập. */
export function mountPublicAuth(app: Hono<AppEnv>): void {
  app.post("/api/auth/login", async (c) => {
    needJwt(c);
    const p = c.get("p"), b = await jsonBody(c);
    const u = await checkPassword(p.db, p.cfg, String(b.username || ""), String(b.password || ""));
    await p.db.run("UPDATE users SET last_login = ? WHERE username = ?", [now(), u.username]);
    const { token, maxAge } = await issueToken(p.cfg, u);
    c.header("set-cookie", sessionCookie(c.req.raw, token, maxAge));
    return c.json({ ok: true, username: u.username, mustChange: !!u.must_change });
  });
  app.post("/api/auth/logout", (c) => {
    c.header("set-cookie", clearCookie(c.req.raw));
    return c.json({ ok: true });
  });
}

/** Đường cần đăng nhập: gắn SAU middleware đăng nhập. */
export function mountAccounts(app: Hono<AppEnv>): void {
  app.post("/api/auth/password", async (c) => {
    needJwt(c);
    const p = c.get("p"), me = c.get("user"), b = await jsonBody(c);
    const cur = await checkPassword(p.db, p.cfg, me.email, String(b.current || ""));
    const pw = checkNewPassword(b.newPassword);
    if (pw === b.current) throw new HttpError(400, "invalid_argument", "Mật khẩu mới phải khác mật khẩu hiện tại.");
    let name = cur.username;
    const want = String(b.newUsername ?? "").trim().toLowerCase();
    if (want && want !== name) {
      if (!validUsername(want)) throw new HttpError(400, "invalid_argument", BAD_NAME);
      if (await getUser(p.db, want)) throw new HttpError(409, "already_exists", "Tên đăng nhập đã có người dùng.");
      name = want;
    }
    const ver = cur.token_ver + 1;
    await p.db.batch([
      { sql: "UPDATE users SET username = ?, pass_hash = ?, must_change = 0, token_ver = ?, updated_at = ? WHERE username = ?", params: [name, await newHash(pw, p.cfg), ver, now(), cur.username] },
      audit(cur.username, name === cur.username ? "password" : "password+rename", "users/" + name),
    ]);
    const { token, maxAge } = await issueToken(p.cfg, { username: name, token_ver: ver });
    c.header("set-cookie", sessionCookie(c.req.raw, token, maxAge));
    return c.json({ ok: true, username: name });
  });

  // đăng xuất khỏi mọi thiết bị: tăng token_ver, mọi phiên cũ hết hiệu lực
  app.post("/api/auth/logout-all", async (c) => {
    needJwt(c);
    await c.get("p").db.run("UPDATE users SET token_ver = token_ver + 1 WHERE username = ?", [c.get("user").email]);
    c.header("set-cookie", clearCookie(c.req.raw));
    return c.json({ ok: true });
  });

  const needAdmin = (c: Context<AppEnv>) => {
    needJwt(c);
    if (!c.get("user").isAdmin) throw new HttpError(403, "forbidden", "Chỉ quản trị viên được quản lý người dùng.");
  };
  const pub = (u: UserRow) => ({ username: u.username, canWrite: !!u.can_write, isAdmin: !!u.is_admin, mustChange: !!u.must_change,
    locked: !!(u.locked_until && u.locked_until > now()), createdAt: u.created_at, lastLogin: u.last_login });
  const otherAdmins = async (p: Platform, name: string) =>
    (await p.db.all<{ n: number }>("SELECT count(*) AS n FROM users WHERE is_admin = 1 AND username <> ?", [name]))[0]?.n || 0;

  app.get("/api/users", async (c) => {
    needAdmin(c);
    return c.json({ users: (await c.get("p").db.all<UserRow>("SELECT * FROM users ORDER BY username")).map(pub) });
  });

  // tạo mới hoặc sửa: { canWrite?, isAdmin?, password? }. Mật khẩu do quản trị đặt luôn bắt người dùng đổi ở lần đăng nhập tới.
  app.put("/api/users/:u", async (c) => {
    needAdmin(c);
    const p = c.get("p"), me = c.get("user"), b = await jsonBody(c);
    const name = decodeURIComponent(c.req.param("u")).trim().toLowerCase();
    if (!validUsername(name)) throw new HttpError(400, "invalid_argument", BAD_NAME);
    const ex = await getUser(p.db, name), t = now();
    const isAdmin = b.isAdmin === undefined ? !!ex?.is_admin : !!b.isAdmin;
    const canWrite = isAdmin || (b.canWrite === undefined ? !!ex?.can_write : !!b.canWrite);
    if (name === me.email && !isAdmin) throw new HttpError(400, "invalid_argument", "Không tự bỏ quyền quản trị của mình được.");
    if (ex?.is_admin && !isAdmin && (await otherAdmins(p, name)) === 0) throw new HttpError(400, "invalid_argument", "Phải còn ít nhất một quản trị viên.");
    const w = canWrite ? 1 : 0, a = isAdmin ? 1 : 0;
    const stmts: SqlStmt[] = [];
    if (!ex) {
      if (b.password == null) throw new HttpError(400, "invalid_argument", "Tài khoản mới cần mật khẩu tạm.");
      stmts.push({ sql: "INSERT INTO users(username, pass_hash, can_write, is_admin, must_change, created_at, updated_at) VALUES (?,?,?,?,1,?,?)",
        params: [name, await newHash(checkNewPassword(b.password), p.cfg), w, a, t, t] });
    } else if (b.password != null && b.password !== "") {
      stmts.push({ sql: "UPDATE users SET pass_hash = ?, must_change = 1, failed = 0, locked_until = NULL, can_write = ?, is_admin = ?, token_ver = token_ver + 1, updated_at = ? WHERE username = ?",
        params: [await newHash(checkNewPassword(b.password), p.cfg), w, a, t, name] });
    } else {
      // đổi quyền thì phiên cũ hết hiệu lực để quyền mới áp dụng ngay
      stmts.push({ sql: "UPDATE users SET token_ver = token_ver + CASE WHEN can_write <> ? OR is_admin <> ? THEN 1 ELSE 0 END, can_write = ?, is_admin = ?, failed = 0, locked_until = NULL, updated_at = ? WHERE username = ?",
        params: [w, a, w, a, t, name] });
    }
    stmts.push(audit(me.email, !ex ? "user:create" : b.password ? "user:reset" : "user:update", "users/" + name));
    await p.db.batch(stmts);
    return c.json({ ok: true, user: pub((await getUser(p.db, name))!) });
  });

  app.delete("/api/users/:u", async (c) => {
    needAdmin(c);
    const p = c.get("p"), me = c.get("user"), name = decodeURIComponent(c.req.param("u")).trim().toLowerCase();
    if (name === me.email) throw new HttpError(400, "invalid_argument", "Không tự xoá tài khoản của mình được.");
    const ex = await getUser(p.db, name);
    if (!ex) throw new HttpError(404, "not_found", "Không có tài khoản này.");
    if (ex.is_admin && (await otherAdmins(p, name)) === 0) throw new HttpError(400, "invalid_argument", "Phải còn ít nhất một quản trị viên.");
    await p.db.batch([{ sql: "DELETE FROM users WHERE username = ?", params: [name] }, audit(me.email, "user:delete", "users/" + name)]);
    return c.json({ ok: true });
  });
}
