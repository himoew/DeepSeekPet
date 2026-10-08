@echo off
setlocal
cd /d "%~dp0"

rem ── 首次安装：把运行时和语音装配到这个目录 ──────────────────────
rem 别人 clone 下来只要双击本文件一次，之后双击 启动大肥鱼.bat 就能跑。
rem 两个脚本都会跳过已经装好的部分，所以重复双击也安全（会重新校验一次）。
rem 注意：本文件用 GBK 存（跟 启动大肥鱼.bat 一致）。.gitattributes 里是 `* -text`,
rem 所以 git 不会改它的字节，中文不会乱码。

echo.
echo   == 大肥鱼桌宠 首次安装 ==
echo.
echo   这一步会做两件事：
echo     1. 下载官方 Electron 44.4.4 运行时（约 110 MB，会校验 SHA-256）
echo        装好后自动把 exe 改名并盖上图标（tools\patch-exe.ps1）
echo     2. 装本地语音（约 40 MB，可以跳过；跳过就是哑的）
echo.
echo   需要联网。装好后双击 启动大肥鱼.bat 即可。
echo.
pause

if not exist "tools\setup-runtime.ps1" (
  echo   找不到 tools\setup-runtime.ps1 —— 请从仓库根目录解压后运行本文件。
  echo.
  pause
  exit /b 1
)

echo.
echo   [1/2] 装配运行时...
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\setup-runtime.ps1"
if errorlevel 1 (
  echo.
  echo   运行时装配失败或者不完整。可以重跑本文件，或者手动看上面的报错。
  echo.
  pause
  exit /b 1
)

echo.
echo   [2/2] 装配本地语音（可以跳过）...
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\setup-tts.ps1"
if errorlevel 1 (
  echo.
  echo   语音没装上 —— 桌宠照样能跑，只是不会说话。想再试就重跑本文件。
  echo.
)

echo.
echo   验收一下装出来的东西...
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\check-runtime.ps1"
echo.

if exist "BlueFishDeskpet.exe" (
  echo   装好了。双击 启动大肥鱼.bat 就能看到它。
  echo.
  pause
  start "" "启动大肥鱼.bat"
  exit /b 0
)

echo   还是没有 BlueFishDeskpet.exe —— 上面应该有原因（多半是网络）。
echo   修好网络后重跑本文件即可，已经装好的部分会跳过。
echo.
pause
exit /b 1
