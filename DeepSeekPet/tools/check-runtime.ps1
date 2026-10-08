# Checks a Blue Fish Deskpet installation and says exactly what is missing.
#
#   powershell -ExecutionPolicy Bypass -File tools\check-runtime.ps1
#   powershell -ExecutionPolicy Bypass -File tools\check-runtime.ps1 -To D:\pet\DeepSeekPet
#
# Exit code 0 = the app can start (speech is optional: without it the pet is simply mute).
# Run this after setup-runtime.ps1 / setup-tts.ps1, or when "it does not start".
#
# NOTE: keep this file ASCII.

param([string]$To = '')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $To) { $To = $root }
if (-not (Test-Path $To)) { throw "target does not exist: $To" }

$problems = @()
$notes = @()
function Check([string]$what, [bool]$ok, [string]$fix = '') {
  if ($ok) {
    Write-Host ("  ok    {0}" -f $what)
  } else {
    Write-Host ("  MISS  {0}" -f $what)
    if ($fix) { Write-Host ("        -> {0}" -f $fix) }
    $script:problems += $what
  }
}

Write-Host "target : $To"
Write-Host ""

# ---- 1. the Electron payload --------------------------------------------------------
$exe = Join-Path $To 'BlueFishDeskpet.exe'
Check 'BlueFishDeskpet.exe (the runtime)' (Test-Path $exe) 'run tools\setup-runtime.ps1'

$payload = @('chrome_100_percent.pak', 'chrome_200_percent.pak', 'resources.pak', 'icudtl.dat',
             'snapshot_blob.bin', 'v8_context_snapshot.bin', 'd3dcompiler_47.dll', 'dxcompiler.dll',
             'dxil.dll', 'ffmpeg.dll', 'vulkan-1.dll', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json')
$missingPayload = @($payload | Where-Object { -not (Test-Path (Join-Path $To $_)) })
Check ("Chromium payload ({0} files)" -f $payload.Count) ($missingPayload.Count -eq 0) `
  ("missing: {0} -- run tools\setup-runtime.ps1" -f ($missingPayload -join ', '))
Check 'locales\zh-CN.pak' (Test-Path (Join-Path $To 'locales\zh-CN.pak')) 'run tools\setup-runtime.ps1'

# ---- 2. our app inside resources\app ------------------------------------------------
$app = Join-Path $To 'resources\app'
Check 'resources\app\package.json (our app)' (Test-Path (Join-Path $app 'package.json')) 'this crate is incomplete'
foreach ($f in 'main.cjs', 'pet.cjs', 'lines.cjs', 'server.cjs') {
  Check ("resources\app\{0}" -f $f) (Test-Path (Join-Path $app $f))
}
Check 'resources\app\web\whale\model.json (the whale)' (Test-Path (Join-Path $app 'web\whale\model.json'))
# Electron loads resources\app before resources\default_app.asar, so what matters is that
# ours is there. (A leftover default_app.asar from an older install is harmless.)
Check 'resources\app can be loaded by Electron' (Test-Path (Join-Path $app 'package.json'))
if (Test-Path (Join-Path $To 'resources\default_app.asar')) {
  Write-Host '        note: resources\default_app.asar is also present (harmless; app wins)'
}

# ---- 3. name and icon ---------------------------------------------------------------
$info = if (Test-Path $exe) { (Get-Item $exe).VersionInfo } else { $null }
$stamped = $info -and $info.ProductName -eq 'Blue Fish Deskpet'
Check "exe is stamped (ProductName = 'Blue Fish Deskpet')" $stamped 'run tools\patch-exe.ps1'
if ($stamped) {
  Write-Host ("        icon should be {0}" -f (Join-Path $app 'web\app-icon.ico'))
} else {
  $notes += 'the exe still carries Electron''s own name/icon; the window and tray icons are ours either way'
}
Check 'resources\app\web\app-icon.ico (icon source)' (Test-Path (Join-Path $app 'web\app-icon.ico')) 'run: python tools\make-icons.py'

# ---- 4. speech (optional) -----------------------------------------------------------
$vendor = Join-Path $app 'vendor\tts'
$hasPkgs = (Test-Path (Join-Path $vendor 'sherpa-onnx-node\package.json')) -and
           (Test-Path (Join-Path $vendor 'sherpa-onnx-win-x64\package.json'))
$voices = @(Get-ChildItem (Join-Path $vendor 'voices') -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -ne '' -and (Get-ChildItem $_.FullName -Filter '*.onnx' -File -ErrorAction SilentlyContinue).Count -gt 0 })
$active = Join-Path $vendor 'voices\.active'
$activeName = if (Test-Path $active) { (Get-Content $active -Raw).Trim() } else { '' }
$activeOk = $activeName -and ($voices.Name -contains $activeName)

if ($hasPkgs -and $voices.Count -gt 0 -and $activeOk) {
  Write-Host ("  ok    speech: {0} ({1} voice(s) installed)" -f $activeName, $voices.Count)
} else {
  Write-Host "  note  speech is NOT ready -- the pet will be silent (everything else still works)"
  if (-not $hasPkgs) { Write-Host '        -> run tools\setup-tts.ps1' }
  elseif ($voices.Count -eq 0) { Write-Host '        -> run tools\setup-tts.ps1' }
  elseif (-not $activeOk) { Write-Host ("        -> .active says '{0}' but that voice is not installed; run: node tools\set-voice.cjs" -f $activeName) }
}

# ---- 5. the workspace permission trap (only matters for agent workspaces) -----------
$suspect = @()
foreach ($p in @($To, $app, $exe)) {
  if (-not (Test-Path $p)) { continue }
  $aces = @((Get-Acl $p).Access | Where-Object {
    $_.IdentityReference -like 'S-1-4-*' -or
    ($_.AccessControlType -eq 'Deny' -and $_.IdentityReference -eq 'Everyone')
  })
  if ($aces.Count) { $suspect += $p }
}
if ($suspect.Count) {
  Write-Host ""
  Write-Host "  WARNING: AI-sandbox permission entries found on:"
  $suspect | ForEach-Object { Write-Host "    $_" }
  Write-Host "  Electron started from here dies instantly with 0x80000003. Copy the folder"
  Write-Host "  outside the agent workspace and run it there."
  $problems += 'workspace permission entries'
}

# ---- summary ------------------------------------------------------------------------
$total = [math]::Round(((Get-ChildItem $To -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB), 0)
Write-Host ""
Write-Host ("  size: {0} MB" -f $total)
foreach ($n in $notes) { Write-Host ("  note: {0}" -f $n) }
if ($problems.Count) {
  Write-Host ("  {0} problem(s) -- see above." -f $problems.Count)
  exit 1
}
Write-Host "all checks passed."
