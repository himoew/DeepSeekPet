# Assembles the Electron runtime for Blue Fish Deskpet.
#
#   powershell -ExecutionPolicy Bypass -File tools\setup-runtime.ps1
#
# Two ways to get the runtime:
#
#   1. (default) download the official Electron zip from electron/electron releases and
#      check it against that release's SHASUMS256.txt. Nothing else is needed.
#   2. -Source <dir>  take the payload out of an existing Coopanion install instead
#      (hard-linked when the volume allows it: instant and no extra disk). This is how
#      the project was born -- Coopanion ships the same Electron 44.4.4 -- but a fresh
#      machine will not have it, so it is no longer the default.
#
# Layout it produces (plain Electron, which is what the app expects):
#
#   <root>\BlueFishDeskpet.exe      the renamed electron.exe
#   <root>\*.pak *.dll *.dat *.bin  the Chromium payload
#   <root>\locales\*.pak            UI languages
#   <root>\resources\app\           OUR code (this repo's resources\app, already here)
#
# Options:
#   -Source <dir>   Coopanion folder to take the runtime from
#   -Version <v>    Electron version (default 44.4.4 -- the one the app is tested on;
#                   the TTS native addon is built for this ABI, so do not bump blindly)
#   -Zip <file>     use an already-downloaded electron-v<version>-win32-x64.zip
#   -KeepZip        keep the downloaded zip after a successful install
#
# NOTE: keep this file ASCII. Windows PowerShell reads a .ps1 without a byte-order mark
# as ANSI, so any non-ASCII text here would come out as mojibake. The Chinese notes live
# in README.md instead.

param(
  [string]$Source = '',
  [string]$Version = '44.4.4',
  [string]$Zip = '',
  [switch]$KeepZip
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot          # ...\DeepSeekPet
$exeName = 'BlueFishDeskpet.exe'

Write-Host "target         : $root"
Write-Host "electron       : $Version"

$script:links = 0
$script:copies = 0

function Link-OrCopy([string]$from, [string]$to) {
  $dir = Split-Path -Parent $to
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  if (Test-Path $to) { Remove-Item $to -Force }
  try {
    New-Item -ItemType HardLink -Path $to -Target $from -ErrorAction Stop | Out-Null
    $script:links += 1
    return 'link'
  } catch {
    Copy-Item $from $to -Force
    $script:copies += 1
    return 'copy'
  }
}

# ---------------------------------------------------------------------------
# 1. get the runtime files into a staging folder
# ---------------------------------------------------------------------------
$stage = ''
$fromCoopanion = $false
if ($Source) {
  $fromCoopanion = $true
  $Source = (Resolve-Path $Source).Path
  $stage = $Source
  Write-Host "runtime source : $Source (Coopanion install, hard-linked)"
} else {
  $zipName = "electron-v$Version-win32-x64.zip"
  $zipPath = $Zip
  if (-not $zipPath) { $zipPath = Join-Path $env:TEMP "dsp-$zipName" }
  $base = "https://github.com/electron/electron/releases/download/v$Version"

  if (-not (Test-Path $zipPath)) {
    Write-Host "downloading    : $base/$zipName"
    try {
      Invoke-WebRequest "$base/$zipName" -OutFile $zipPath -UseBasicParsing -TimeoutSec 1800
    } catch {
      throw "could not download Electron: $($_.Exception.Message)`nDownload $base/$zipName by hand and pass -Zip <file>."
    }
  } else {
    Write-Host "using          : $zipPath (already downloaded)"
  }

  # Verify against the release's own checksum list. A failure here is fatal: a truncated
  # or tampered runtime would be very hard to diagnose later.
  try {
    $sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing -TimeoutSec 120).Content
    $line = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape($zipName) } | Select-Object -First 1)
    if ($line) {
      $want = ($line -split '\s+')[0].Trim().ToLower()
      $got = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLower()
      if ($want -ne $got) { throw "SHA-256 mismatch for $zipName`n  expected $want`n  actual   $got" }
      Write-Host "checksum       : ok (SHA-256 matches SHASUMS256.txt)"
    } else {
      Write-Host "checksum       : WARNING - $zipName not listed in SHASUMS256.txt, not verified"
    }
  } catch {
    if ($_.Exception.Message -like 'SHA-256 mismatch*') { throw }
    Write-Host "checksum       : WARNING - could not fetch SHASUMS256.txt ($($_.Exception.Message)), not verified"
  }

  $stage = Join-Path $env:TEMP "dsp-electron-$Version"
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Write-Host "unpacking      : -> $stage"
  Expand-Archive -LiteralPath $zipPath -DestinationPath $stage -Force
}

if (-not (Test-Path $stage)) { throw "staging folder missing: $stage" }

# ---------------------------------------------------------------------------
# 2. lay it down next to resources\app, renaming the executable
# ---------------------------------------------------------------------------
$exeInStage = Join-Path $stage $(if ($fromCoopanion) { 'Coopanion.exe' } else { 'electron.exe' })
if (-not (Test-Path $exeInStage)) {
  throw "no $([System.IO.Path]::GetFileName($exeInStage)) in $stage -- point -Source at a Coopanion install or pass a proper -Zip"
}
if (Test-Path (Join-Path $root 'Coopanion.exe')) {
  Write-Host "  note: an old Coopanion.exe is still here; you can delete it by hand"
}

if ($fromCoopanion) {
  # A Coopanion install root also holds an uninstaller and other app files, so copy the
  # known payload rather than everything. libEGL/libGLESv2 are included for machines where
  # Chromium falls back to ANGLE instead of D3D11.
  $files = @(
    'chrome_100_percent.pak', 'chrome_200_percent.pak', 'resources.pak',
    'icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin',
    'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll',
    'libEGL.dll', 'libGLESv2.dll',
    'vulkan-1.dll', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json',
    'LICENSE.electron.txt', 'LICENSES.chromium.html', 'version'
  )
  $missing = @()
  foreach ($f in @($files + 'Coopanion.exe')) { if (-not (Test-Path (Join-Path $stage $f))) { $missing += $f } }
  if ($missing.Count) { throw "source is missing: $($missing -join ', ')" }
  $how = Link-OrCopy $exeInStage (Join-Path $root $exeName)
  Write-Host ("  {0,-30} {1}" -f $exeName, "$how (from Coopanion.exe)")
  foreach ($f in $files) {
    if (-not (Test-Path (Join-Path $stage $f))) { continue }
    Write-Host ("  {0,-30} {1}" -f $f, (Link-OrCopy (Join-Path $stage $f) (Join-Path $root $f)))
  }
  foreach ($l in @('en-US.pak', 'zh-CN.pak')) {
    $p = Join-Path $stage "locales\$l"
    if (Test-Path $p) { Write-Host ("  {0,-30} {1}" -f "locales\$l", (Link-OrCopy $p (Join-Path $root "locales\$l"))) }
  }
} else {
  # Straight from the official zip: copy its whole root except the two names that must not
  # land here as-is.
  $n = 0
  foreach ($item in (Get-ChildItem $stage -Force)) {
    # `resources` holds Electron's default_app.asar; our resources\app has to win.
    if ($item.Name -ieq 'resources') { continue }
    # The executable is copied separately, under our own name.
    if ($item.Name -ieq 'electron.exe') { continue }
    # The zip ships Electron's MIT LICENSE at its root -- and so does this app (AGPL).
    # Copying it in place would silently replace our licence, so it becomes
    # LICENSE.electron.txt (the name the Coopanion path uses too).
    if ($item.Name -ieq 'LICENSE') {
      Copy-Item $item.FullName (Join-Path $root 'LICENSE.electron.txt') -Force
      Write-Host ("  {0,-30} copied as LICENSE.electron.txt (our AGPL LICENSE stays)" -f 'LICENSE')
      $n += 1
      continue
    }
    Copy-Item $item.FullName (Join-Path $root $item.Name) -Recurse -Force
    $n += 1
  }
  Copy-Item $exeInStage (Join-Path $root $exeName) -Force
  Write-Host ("  {0,-30} copied (renamed from electron.exe)" -f $exeName)
  Write-Host ("  {0,-30} copied" -f "$n runtime files/folders")
}

if (-not $fromCoopanion -and -not $KeepZip -and -not $Zip) {
  Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "  (zip and staging folder cleaned up)"
}

# ---------------------------------------------------------------------------
# 3. the check that would have saved an afternoon.
#
# Files created inside an AI agent's workspace can pick up extra inherited
# permission entries: a Deny for Everyone plus an Allow for an S-1-4-* sandbox
# identity. Chromium's Windows sandbox then fails its startup CHECK and the app
# dies instantly with exit code 0x80000003 -- no window, no log line, nothing.
# Nothing in the application code can detect or work around it.
# ---------------------------------------------------------------------------
$suspect = @()
foreach ($p in @($root, (Join-Path $root 'resources\app'), (Join-Path $root $exeName))) {
  if (-not (Test-Path $p)) { continue }
  $aces = @((Get-Acl $p).Access | Where-Object {
    $_.IdentityReference -like 'S-1-4-*' -or
    ($_.AccessControlType -eq 'Deny' -and $_.IdentityReference -eq 'Everyone')
  })
  if ($aces.Count) { $suspect += $p }
}
if ($suspect.Count) {
  Write-Host ""
  Write-Host "  WARNING: this folder carries AI-sandbox permission entries on:"
  $suspect | ForEach-Object { Write-Host "    $_" }
  Write-Host "  Electron started from here dies instantly with 0x80000003, silently."
  Write-Host "  Fix: copy the whole folder OUTSIDE the agent workspace and run it there."
  Write-Host ""
}

Write-Host "runtime ready."

# ---------------------------------------------------------------------------
# 4. stamp our name and icon on the fresh executable.
#
# This MUST happen after the copy above, because every runtime install overwrites the
# executable. Best effort on purpose: it needs rcedit (1 MB, downloaded once into TEMP),
# and a machine without a network should still end up with a working runtime -- just run
# tools\patch-exe.ps1 again later if this step complained.
# ---------------------------------------------------------------------------
$patch = Join-Path $PSScriptRoot 'patch-exe.ps1'
if (Test-Path $patch) {
  & powershell -ExecutionPolicy Bypass -File $patch -Exe (Join-Path $root $exeName)
  if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  NOTE: name/icon were NOT applied (see above). The runtime still works."
    Write-Host "        Run tools\patch-exe.ps1 again when you have a network."
  }
}
