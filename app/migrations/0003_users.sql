-- Tài khoản đăng nhập (AUTH_MODE=jwt). Mật khẩu: pbkdf2$<vòng>$<salt>$<hash> (SHA-256).
-- token_ver tăng mỗi lần đổi mật khẩu / đổi quyền / đăng xuất mọi nơi: phiên (JWT) cũ hết hiệu lực ngay.
CREATE TABLE IF NOT EXISTS users (
  username     TEXT PRIMARY KEY,
  pass_hash    TEXT NOT NULL,
  can_write    INTEGER NOT NULL DEFAULT 0,
  is_admin     INTEGER NOT NULL DEFAULT 0,
  must_change  INTEGER NOT NULL DEFAULT 0,  -- 1 = phải đổi mật khẩu ở lần đăng nhập tới
  token_ver    INTEGER NOT NULL DEFAULT 1,
  failed       INTEGER NOT NULL DEFAULT 0,  -- số lần sai mật khẩu liên tiếp
  locked_until TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT,
  last_login   TEXT
);
