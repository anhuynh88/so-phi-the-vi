@echo off
rem Máy nhận sao lưu: chạy bản local (http://127.0.0.1:8788) và Cloudflare Tunnel "sophi-backup".
rem Worker trên Cloudflare đẩy dữ liệu về mỗi giờ (phút 17) qua tunnel này. Tắt cửa sổ là ngừng nhận sao lưu.
cd /d "%~dp0"
start "So phi - local" cmd /k npm run local
start "So phi - tunnel" cmd /k npx wrangler tunnel run sophi-backup
