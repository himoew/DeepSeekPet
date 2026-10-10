@echo off
rem ============================================================================
rem  一键部署：把工作区这份代码推到桌宠运行目录（D:\pet\DeepSeekPet）
rem ============================================================================
rem  为什么要用脚本、而不是手敲 robocopy：
rem    · 这个文件夹**不能**直接从工作区跑 —— 工作区里造的文件带 AI 沙箱权限项，
rem      Electron 一加载就 0x80000003 当场死（README 里记着）。所以"改代码"和"跑桌宠"
rem      必须在两个目录，靠复制保持同步。
rem    · 复制完之后有几件事**必须核一遍**（下面自动做），不然"部署了但还是旧版"这种
rem      事会再发生一次：fx.js 的字节数、pet.html 里有没有两块画布、进程有没有在跑。
rem
rem  用法：双击本文件，或在命令行里跑   dev-weather\go-deploy.cmd
rem  ⚠️ 部署前请**确认桌宠没在运行**（在跑的话文件可能被占用，而且新版要重启才生效）。
rem ============================================================================
setlocal
set SRC=%~dp0..
set DST=D:\pet\DeepSeekPet

echo.
echo === 0. 前置检查 ===
if not exist "%DST%\BlueFishDeskpet.exe" (
  echo   [X] 找不到 %DST%\BlueFishDeskpet.exe
  echo       先在那个目录跑 tools\setup-runtime.ps1 装好运行环境。
  goto :end
)
tasklist /FI "IMAGENAME eq BlueFishDeskpet.exe" | find /I "BlueFishDeskpet.exe" >nul
if not errorlevel 1 (
  echo   [!] 桌宠正在运行。请先从托盘退出它，再跑这个脚本。
  echo       ^(复制到正在运行的程序上可能被占用，而且新版要重启才生效^)
  goto :end
)
echo   [OK] 目标目录有 exe，而且桌宠没在跑。

echo.
echo === 1. 复制代码与资源 ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%SRC%\tools\deploy.ps1" -To "%DST%"
if errorlevel 1 ( echo   [X] 部署脚本失败，看上面的输出。& goto :end )

echo.
echo === 2. 部署后核对（这几条就是"实装成功"的判据）===
powershell -NoProfile -Command ^
  "$d='%DST%\resources\app\web';" ^
  "$fx=Get-Item \"$d\fx.js\"; $ph=Get-Item \"$d\pet.html\";" ^
  "$html=Get-Content \"$d\pet.html\" -Raw;" ^
  "$near = $html -match 'fxCanvasNear'; $far = $html -match 'id=\"fxCanvas\"';" ^
  "$spend = (Get-Content \"$d\fx.js\" -Raw) -match 'spend: \(\) => lastCost';" ^
  "Write-Host ('  fx.js       {0} bytes' -f $fx.Length);" ^
  "Write-Host ('  pet.html    {0} bytes' -f $ph.Length);" ^
  "Write-Host ('  远层画布    {0}' -f $(if($far){'有'}else{'**没有**'}));" ^
  "Write-Host ('  近层画布    {0}' -f $(if($near){'有'}else{'**没有**'}));" ^
  "Write-Host ('  spend 接口  {0}' -f $(if($spend){'有'}else{'**没有**'}));" ^
  "if ($far -and $near -and $spend -and $fx.Length -gt 60000) { Write-Host '  => 实装成功' -ForegroundColor Green } else { Write-Host '  => **没实装成功**（上面有**没有**的项）' -ForegroundColor Red }"

echo.
echo === 3. 启动 ===
echo   去 %DST% 双击「BlueFishDeskpet.exe」或「启动大肥鱼.bat」。
echo   起来之后：右键小肥鱼 → 悬停菜单里那格「天气」循环切 关/雪/樱花/落叶/雨。
echo   ^(这一轮天气**只有画面没有声音** —— 音效在校正中，见 WEATHER-FX-交接.md^)
echo.
:end
pause
endlocal
