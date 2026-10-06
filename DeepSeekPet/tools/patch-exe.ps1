# Stamps our name and icon onto the runtime executable.
#
#   powershell -ExecutionPolicy Bypass -File tools\patch-exe.ps1
#   powershell -ExecutionPolicy Bypass -File tools\patch-exe.ps1 -Rcedit D:\tools\rcedit.exe
#
# Why this is a separate step: setup-runtime.ps1 unpacks a fresh Electron and OVERWRITES
# the executable, so anything stamped on it is gone after a re-install. setup-runtime.ps1
# therefore calls this script at the end (best effort), and you can also run it by hand.
#
# The executable is plain Electron (MIT), so re-branding it is legitimate -- keep the
# LICENSE / LICENSES.chromium.html that came with it next to the executable.
#
# Only ASCII values are written ("Blue Fish Deskpet"): Windows version resources plus
# PowerShell 5.1 (which reads a BOM-less .ps1 as ANSI) both mangle non-ASCII text. What the
# user actually sees -- window title, tray tooltip, the pet's own name -- stays Chinese and
# comes from the app, not from the exe.
#
# Options:
#   -Exe <path>       executable to stamp   (default <root>\BlueFishDeskpet.exe)
#   -Icon <path>      .ico to apply         (default resources\app\web\app-icon.ico)
#   -Rcedit <path>    use this rcedit.exe instead of downloading one
#   -CompanyName <s>  also set CompanyName  (default: leave Electron's own value alone)
#
# NOTE: keep this file ASCII.

param(
  [string]$Exe = '',
  [string]$Icon = '',
  [string]$Rcedit = '',
  [string]$CompanyName = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
if (-not $Exe) { $Exe = Join-Path $root 'BlueFishDeskpet.exe' }
if (-not $Icon) { $Icon = Join-Path $root 'resources\app\web\app-icon.ico' }

if (-not (Test-Path $Exe)) {
  throw "no executable at $Exe -- run tools\setup-runtime.ps1 first"
}
if (-not (Test-Path $Icon)) {
  throw "no icon at $Icon -- run: python tools\make-icons.py"
}

# ---- find rcedit --------------------------------------------------------------------
$rceditPaths = @()
if ($Rcedit) { $rceditPaths += $Rcedit }
$rceditPaths += (Join-Path $PSScriptRoot 'rcedit.exe')
$rceditPaths += (Join-Path $env:TEMP 'rcedit-x64.exe')

$tool = $rceditPaths | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $tool) {
  # No rcedit here yet: fetch the 1 MB official build.
  $tool = Join-Path $env:TEMP 'rcedit-x64.exe'
  $urls = @(
    'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe',
    'https://github.com/electron/rcedit/releases/latest/download/rcedit-x64.exe'
  )
  $ok = $false
  foreach ($u in $urls) {
    try {
      Write-Host "downloading    : $u"
      Invoke-WebRequest $u -OutFile $tool -UseBasicParsing -TimeoutSec 300
      if ((Get-Item $tool).Length -gt 100KB) { $ok = $true; break }
    } catch {
      Write-Host "  failed: $($_.Exception.Message)"
    }
  }
  if (-not $ok) {
    throw ("could not download rcedit. Download rcedit-x64.exe from " +
           "https://github.com/electron/rcedit/releases and pass -Rcedit <path>.")
  }
}
Write-Host "exe            : $Exe"
Write-Host "icon           : $Icon"
Write-Host "rcedit         : $tool"

# ---- stamp it -----------------------------------------------------------------------
# NOTE: do not name this $args -- that is an automatic variable in PowerShell.
$rceditArgs = @(
  $Exe,
  '--set-icon', $Icon,
  '--set-version-string', 'ProductName', 'Blue Fish Deskpet',
  '--set-version-string', 'FileDescription', 'Blue Fish Deskpet',
  '--set-version-string', 'OriginalFilename', 'BlueFishDeskpet.exe',
  '--set-version-string', 'InternalName', 'BlueFishDeskpet'
)
if ($CompanyName) { $rceditArgs += @('--set-version-string', 'CompanyName', $CompanyName) }

& $tool @rceditArgs
if ($LASTEXITCODE -ne 0) { throw "rcedit failed (exit $LASTEXITCODE)" }

$info = (Get-Item $Exe).VersionInfo
Write-Host ""
Write-Host "  ProductName      : $($info.ProductName)"
Write-Host "  FileDescription  : $($info.FileDescription)"
Write-Host "  CompanyName      : $($info.CompanyName)"
Write-Host "  (right-click the exe -> Properties -> Details to see this in Explorer)"
Write-Host "exe stamped."
