/* Tạo dòng tài khoản cho LOCAL_USERS: npm run local:user -- ten-dang-nhap "mat-khau" [số vòng PBKDF2]
   Mặc định 210.000 vòng cho bản local. Trên Worker gói free (10 ms CPU) dùng ~5.000 vòng kèm mật khẩu ngẫu nhiên dài;
   LOCAL_USERS là secret của Worker nên mã băm không lộ ra ngoài. */
import { hashPassword } from "../src/core/auth";
const [email, pass, iters] = process.argv.slice(2);
if (!email || !pass || pass.length < 10) {
  console.error('Cách dùng: npm run local:user -- ten-dang-nhap "mật khẩu ít nhất 10 ký tự" [số vòng]');
  process.exit(1);
}
const line = email.trim().toLowerCase() + ":" + (await hashPassword(pass, Number(iters) || 210000));
console.log("Thêm vào LOCAL_USERS (nhiều tài khoản cách nhau dấu ;):\n" + line);
