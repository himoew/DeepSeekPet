@echo off
setlocal
cd /d "%~dp0"

rem ── 找运行时 ───────────────────────────────────────────────
rem 本目录自带运行时就用本目录的; 没有(源码副本)就用标准安装目录的那份.
rem 那个 D:\pet 的回退只是本机开发方便, 别人的机器不需要它.
set "DSKHOME=%~dp0"
if not exist "%DSKHOME%BlueFishDeskpet.exe" (
  if exist "D:\pet\DeepSeekPet\BlueFishDeskpet.exe" set "DSKHOME=D:\pet\DeepSeekPet\"
)

if not exist "%DSKHOME%BlueFishDeskpet.exe" (
  echo.
  echo   没有找到 BlueFishDeskpet.exe。
  echo   这个目录是源码副本, 先装配运行时(两条命令):
  echo     powershell -ExecutionPolicy Bypass -File tools\setup-runtime.ps1
  echo     powershell -ExecutionPolicy Bypass -File tools\setup-tts.ps1
  echo   然后双击本目录的 启动大肥鱼.bat。
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
