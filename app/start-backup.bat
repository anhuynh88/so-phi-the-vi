@echo off
rem May nhan sao luu: chay ban local (http://127.0.0.1:8788) va Cloudflare Tunnel sophi-backup.
rem Worker day du lieu ve moi gio (phut 17) qua tunnel nay va doc lai file da chuyen ve local (FIFO > 8 GB).
rem Du lieu local nam o SOPHI_DATA trong .env. Tat 2 cua so la ngung nhan sao luu.
cd /d "%~dp0"
start "So phi - local" cmd /k npm run local
start "So phi - tunnel" cmd /k npx wrangler tunnel run sophi-backup
timeout /t 6 /nobreak >nul
start "" http://127.0.0.1:8788/
