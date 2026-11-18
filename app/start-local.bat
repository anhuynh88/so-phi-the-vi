@echo off
rem Chạy Sổ phí bản local tại http://127.0.0.1:8788 (tài khoản trong .secrets\dang-nhap-local.txt)
cd /d "%~dp0"
start "" http://127.0.0.1:8788
npm run local
