@echo off
chcp 65001 >nul
cd /d %~dp0
title 云上禅寺服务器
where node >nul 2>nul
if errorlevel 1 (
  echo [!] 未检测到 Node.js，请先安装：https://nodejs.org/zh-cn
  pause
  exit /b
)
if not exist node_modules\ws (
  echo [*] 首次运行，正在安装依赖（约 10 秒）...
  call npm install --registry=https://registry.npmmirror.com --no-fund --no-audit
)
echo [*] 正在开启云上禅寺...
node server.js
pause
