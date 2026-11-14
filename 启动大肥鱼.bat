@echo off
setlocal
cd /d "%~dp0"

rem -- 找运行时 ------------------------------------------------
rem 这个文件夹里自带运行时就直接用（首次安装.bat 装出来的就是这个样子）。
set "DSKHOME=%~dp0"

if not exist "%DSKHOME%BlueFishDeskpet.exe" (
  echo.
  echo   没有找到 BlueFishDeskpet.exe。
  echo   先双击本目录的 首次安装.bat，它会下载官方运行时（约 110 MB）。
  echo   或者手动跑：
  echo     powershell -ExecutionPolicy Bypass -File tools\setup-runtime.ps1
  echo     powershell -ExecutionPolicy Bypass -File tools\setup-tts.ps1   (可选，本地语音)
  echo.
  pause
  exit /b 1
)

rem 从 DSH / VS Code / Node 终端里启动时, 环境里常带着 ELECTRON_RUN_AS_NODE,
rem 它会让这个 Electron 退化成纯 Node: 不建窗口、不留日志、静默退出。
set "ELECTRON_RUN_AS_NODE="

rem 正常路径.
start "" "%DSKHOME%BlueFishDeskpet.exe"

rem 少数机器上 Chromium 沙箱起不来, 表现同样是静默退出。
rem 等 6 秒; 还没有进程就带上 --no-sandbox 再试一次。
timeout /t 6 /nobreak >nul 2>&1 || ping -n 7 127.0.0.1 >nul
tasklist /fi "imagename eq BlueFishDeskpet.exe" 2>nul | find /i "BlueFishDeskpet.exe" >nul
if not errorlevel 1 exit /b 0

echo   第一次没起来, 改用 --no-sandbox 重试...
start "" "%DSKHOME%BlueFishDeskpet.exe" --no-sandbox
exit /b 0