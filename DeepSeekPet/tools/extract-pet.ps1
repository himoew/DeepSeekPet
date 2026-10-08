# Lifts the desktop-pet page and the DeepSeek whale figure out of the Coopanion
# package into resources\app, so the pet runs without any of Cortico.
#
#   powershell -ExecutionPolicy Bypass -File tools\extract-pet.ps1
#
# This rewrites everything under resources\app\web, so it is safe to re-run but it
# will overwrite local edits to those files (our own code under resources\app\*.cjs
# and lines.cjs is never touched).
#
# !! WARNING -- READ BEFORE RUNNING !!
# web\pet-app.js and web\pet-core.js carry OUR OWN changes that are NOT in the upstream
# Coopanion copy, and this script overwrites both with the upstream version. Since
# 2026-10-05 that is a lot more than the pointer-diagnostic tweak (see HANDOVER.md
# section 4 for the full list):
#
#   pet-app.js  voice playback (sayAudio / onVoice / stepDialog's say branch) - the hit
#               regions (REGION_AT / petLocal / petRegion) - the petting state machine
#               (STROKE / STROKE_CFG) - region-aware dragging (GRAB_STYLE / dragAt /
#               stepDrag) - the cursor gaze feed - double-click chat removed
#   pet-core.js createSfx decode/playBuffer - the grab anchor and hang angle (grabAt /
#               grabHang / SCRUFF_GRAB) - the two-circle hit test - the span-based bottom
#               margin - stretch by hang angle - gaze / cling / poke pitch
#
# Re-running this script THROWS ALL OF THAT AWAY: the pet loses the regions, the petting,
# the dragging poses, the gaze, the cling mode and its voice. The script therefore
# REFUSES to run when it finds those edits, backs the two files up first, and only
# proceeds with -Force. (The right long-term fix is to move both files' edits into
# tools\patch-assets.mjs; not done yet.)
#
# NOTE: keep this file ASCII. Windows PowerShell reads a .ps1 without a byte-order
# mark as ANSI, so non-ASCII text here would come out as mojibake.

param(
  [string]$Source = '',
  # Node is only needed to patch pet-app.js and trim model.json. Pass it here if it is
  # not on PATH and not in one of the usual places below.
  [string]$NodeExe = '',
  # Overwrite anyway (after the automatic backup). See the warning above.
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not $Source) { $Source = Join-Path (Split-Path -Parent $root) 'Coopanion' }
$pet = Join-Path $Source 'resources\app\node_modules\cortico-world-desktop-pet'
if (-not (Test-Path $pet)) { throw "desktop-pet package not found: $pet" }

# Two steps below need Node: patching pet-app.js and trimming model.json (a JSON
# round-trip -- ConvertTo-Json would round the float pivots, Node keeps them exact).
# Resolved up front so a missing Node fails before anything has been half-copied.
$node = $NodeExe
if (-not $node) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) {
  foreach ($candidate in @(
    "$env:ProgramFiles\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
  )) { if (Test-Path $candidate) { $node = $candidate; break } }
}
# Agent runtimes (DSH and friends) bundle a Node of their own; take the first one found
# rather than hard-coding anybody's home directory.
if (-not $node) {
  $bundled = Get-ChildItem "$env:USERPROFILE\.dsh\dsh-runtimes\*\dependencies\node\bin\node.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($bundled) { $node = $bundled.FullName }
}
if (-not $node -or -not (Test-Path $node)) {
  throw "needs Node (only to patch pet-app.js and trim model.json). Install it, or pass -NodeExe <path>."
}
Write-Host "node           : $node"

$app = Join-Path $root 'resources\app'
$web = Join-Path $app 'web'

Write-Host "pet package : $pet"
Write-Host "target      : $app"

# ---------------------------------------------------------------------------
# Guard: our own edits to these two files are NOT in patch-assets.mjs, so a
# re-extract silently deletes the hit regions, the petting state machine, the
# region-aware dragging, the gaze feed and the voice plumbing. Back them up, then
# refuse unless -Force was given. (Markers below are the ones our code adds.)
# ---------------------------------------------------------------------------
$guarded = @{
  'pet-app.js'  = 'STROKE_CFG'
  'pet-core.js' = 'SCRUFF_GRAB'
}
$found = @()
foreach ($name in $guarded.Keys) {
  $path = Join-Path $web $name
  if ((Test-Path $path) -and (Select-String -Path $path -Pattern $guarded[$name] -Quiet)) { $found += $name }
}
if ($found.Count) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = Join-Path $web "_backup-$stamp"
  New-Item -ItemType Directory -Force -Path $backup | Out-Null
  foreach ($name in $found) { Copy-Item (Join-Path $web $name) (Join-Path $backup $name) -Force }
  Write-Host ""
  Write-Host "  our own edits found in: $($found -join ', ')"
  Write-Host "  backed up to: $backup"
  if (-not $Force) {
    Write-Host ""
    Write-Host "  REFUSING to overwrite them with the upstream version."
    Write-Host "  Re-extracting would delete the hit regions, the petting state machine,"
    Write-Host "  the region-aware dragging, the cursor gaze, the cling mode and the voice."
    Write-Host "  See HANDOVER.md section 4. If you really mean it, pass -Force"
    Write-Host "  (the backup above is what you would have to port back by hand)."
    Write-Host ""
    throw "refusing to overwrite local edits to $($found -join ', ') -- pass -Force to proceed"
  }
  Write-Host "  -Force given: overwriting anyway (backup kept above)"
  Write-Host ""
}

New-Item -ItemType Directory -Force -Path $web, (Join-Path $web 'rig'), (Join-Path $web 'whale'), (Join-Path $app 'node_modules') | Out-Null

# The page and the body/rig it draws with.
foreach ($f in 'pet.html', 'pet.css', 'pet-app.js', 'pet-core.js') {
  Copy-Item (Join-Path $pet "web\$f") (Join-Path $web $f) -Force
  Write-Host "  web\$f"
}
Copy-Item (Join-Path $pet 'web\rig\rig.js') (Join-Path $web 'rig\rig.js') -Force
Write-Host "  web\rig\rig.js"

# The DeepSeek whale ("the fat fish"): the original colour scheme lives at the root of
# web\whale, the other seven schemes under schemes\ are not copied.
Copy-Item (Join-Path $pet 'web\whale\figure.js') (Join-Path $web 'whale\figure.js') -Force
Copy-Item (Join-Path $pet 'web\whale\model.json') (Join-Path $web 'whale\model.json') -Force
# Remove the destination first: `Copy-Item -Recurse` into an existing directory nests
# (dest\tex\tex) instead of replacing it, which silently doubles the textures on a re-run.
foreach ($sub in 'tex', 'feat') {
  $to = Join-Path $web "whale\$sub"
  if (Test-Path $to) { Remove-Item $to -Recurse -Force }
  Copy-Item (Join-Path $pet "web\whale\$sub") $to -Recurse -Force
}
Write-Host ("  web\whale\figure.js + model.json + tex({0}) + feat({1})" -f `
  (Get-ChildItem (Join-Path $web 'whale\tex') -File).Count, (Get-ChildItem (Join-Path $web 'whale\feat') -File).Count)

# The window host (transparent / click-through / always-on-top / multi-display) and its preload.
Copy-Item (Join-Path $pet 'host\electron-main.cjs') (Join-Path $app 'pet-host.cjs') -Force
Copy-Item (Join-Path $pet 'host\preload.cjs') (Join-Path $app 'preload.cjs') -Force
Write-Host "  pet-host.cjs + preload.cjs"

# The menu portrait (served at /api/avatar). **This is our own artwork now** - it comes from
# web\avatar.png in the repo, regenerated by tools\make-icons.py from web\icon-source.png.
# Only seed it from upstream's thumbnail when it is missing entirely (a fresh extract on a
# machine that has no avatar yet), otherwise leave ours alone.
if (-not (Test-Path (Join-Path $web 'avatar.png'))) {
  Copy-Item (Join-Path $pet 'web\whale\thumbs\deepseek.png') (Join-Path $web 'avatar.png') -Force
  Write-Host "  web\avatar.png (upstream thumbnail - ours was missing)"
} else {
  Write-Host "  web\avatar.png kept (ours; tools\make-icons.py regenerates it)"
}

# `ws` is the only third-party module the app needs; it has no dependencies of its own.
Copy-Item (Join-Path $Source 'resources\app\node_modules\ws') (Join-Path $app 'node_modules\ws') -Recurse -Force
Write-Host "  node_modules\ws"

# ---------------------------------------------------------------------------
# The six edits the extracted files need (all live in tools\patch-assets.mjs):
#
#   1. pet-app.js ships a pointer diagnostic that writes a `[pointer] {...}` line to
#      the run log about once a second, forever, with no way to switch it off. It is
#      useful when click-through misbehaves, so it is gated behind `?diag=1` rather
#      than deleted. Without this, real errors are buried in the noise.
#   2. model.json keeps only the deepseek scheme, so web\whale\schemes is not needed.
#   3. pet-host.cjs's tray menu: the dead "dress up" item is replaced by settings / open log.
#   4. figure.js: the ahoge and the two head fins get a mood-driven oscillator and a
#      visible idle sway (upstream only has tiny fixed sines, under one pixel at the
#      pet's size). See the comment there for the amplitudes.
#   5. pet-host.cjs: window icon web\app-icon.png, tray icon web\tray-icon.png (the
#      upstream drawn C stays as a fallback), title / tray tooltip = Blue Fish Deskpet.
#   6. pet.html: page title = Blue Fish Deskpet.
#
#   NOTE (when adding a 7th): give the new edit its OWN edit() call and marker.
#   edit() skips a whole file once its marker is present, so adding pairs to an
#   existing call would silently skip them on files that were already patched.
#
#   Everything else is copied verbatim. pet-app.js and pet-core.js also carry later
#   edits that are NOT in patch-assets.mjs yet (voice playback, hit regions, petting,
#   region-aware dragging, gaze) - see HANDOVER section 4.
# ---------------------------------------------------------------------------
& $node (Join-Path $PSScriptRoot 'patch-assets.mjs') `
  (Join-Path $web 'pet-app.js') (Join-Path $web 'whale\model.json') (Join-Path $app 'pet-host.cjs') `
  (Join-Path $web 'whale\figure.js') (Join-Path $web 'pet.html')
if ($LASTEXITCODE -ne 0) { throw "patching the extracted assets failed" }

Write-Host "pet assets ready."
