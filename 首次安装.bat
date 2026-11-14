@echo off
setlocal
cd /d "%~dp0"

rem -- 首次安装：把运行时装配到这个目录 ------------------------------
rem 别人拿到这个文件夹，只要双击本文件一次，之后双击 启动大肥鱼.bat 就能跑。
rem 两个脚本都会跳过已经装好的部分，所以重复双击也安全（会重新校验一次）。
rem 本文件用 GBK 存。.gitattributes 里是 `* -text`，git 不会改它的字节。

echo.
echo   == 大肥鱼桌宠 首次安装 ==
echo.
echo   这一步做两件事：
echo     1. 下载官方 Electron 44.4.4 运行时（约 110 MB，校验 SHA-256；
echo        GitHub 慢会自动换国内镜像 npmmirror）
echo        装好后自动把 exe 改名并盖上图标（tools\patch-exe.ps1）
echo     2. 本地语音（约 40 MB）—— 可选，不装也能跑，只是不会说话
echo.
echo   需要联网。装好后双击 启动大肥鱼.bat 即可。
echo.
pause

if not exist "tools\setup-runtime.ps1" (
  echo   找不到 tools\setup-runtime.ps1 —— 请确认是在解压后的目录里运行本文件。
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
echo   [2/2] 本地语音（可选）：不装她只是不出声，别的都正常。
choice /c YN /n /t 15 /d N /m "   现在装本地语音（约 40 MB）Y=装 / N=跳过（15 秒后自动跳过）"
if errorlevel 2 goto skipTts
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\setup-tts.ps1"
if errorlevel 1 echo   语音没装上 —— 桌宠照样能跑，以后可以重跑本文件或 tools\setup-tts.ps1。
:skipTts

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