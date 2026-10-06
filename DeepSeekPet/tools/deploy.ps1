# Copies the code and assets from this source tree into a runnable folder, so the two
# stay in step. The runnable folder is the one OUTSIDE the agent workspace: files made
# inside the workspace carry extra AI-sandbox permission entries that make Electron die
# with 0x80000003 before it loads anything (see README).
#
#   powershell -ExecutionPolicy Bypass -File tools\deploy.ps1 -To D:\pet\DeepSeekPet
#
# It copies resources\app (the whole app), test\, tools\ and the docs. The Electron
# runtime files and locales in the target are left alone.
#
# NOTE: keep this file ASCII. Windows PowerShell reads a .ps1 without a byte-order mark
# as ANSI, so non-ASCII text here would come out as mojibake.

param(
  [Parameter(Mandatory = $true)][string]$To
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path $To)) { throw "target does not exist: $To" }
$To = (Resolve-Path $To).Path
if ($To -eq $root) { throw "-To must be a different folder from this source tree" }
if (-not (Test-Path (Join-Path $To 'BlueFishDeskpet.exe'))) {
  throw "$To has no BlueFishDeskpet.exe -- run tools\setup-runtime.ps1 there first"
}

Write-Host "source : $root"
Write-Host "target : $To"

function Copy-Tree([string]$from, [string]$to) {
  if (-not (Test-Path $from)) { Write-Host "  (skip, missing) $from"; return 0 }
  # /R:2 /W:1 -- the defaults (a million retries, 30s apart) make one locked file hang
  # the deploy forever with no output at all.
  robocopy $from $to /E /NFL /NDL /NJH /NJS /NP /R:2 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE) copying $from" }
  $n = (Get-ChildItem $to -Recurse -File).Count
  Write-Host ("  {0,-16} -> {1} files" -f (Split-Path $from -Leaf), $n)
  return $n
}

Copy-Tree (Join-Path $root 'resources\app') (Join-Path $To 'resources\app') | Out-Null
Copy-Tree (Join-Path $root 'test') (Join-Path $To 'test') | Out-Null
Copy-Tree (Join-Path $root 'tools') (Join-Path $To 'tools') | Out-Null
foreach ($f in 'README.md', 'preview.png', 'settings.png', 'LICENSE', 'THIRD_PARTY_NOTICES.md') {
  $from = Join-Path $root $f
  if (Test-Path $from) { Copy-Item $from $To -Force; Write-Host "  $f" }
}
# The launcher has a Chinese file name, and this file must stay ASCII (PowerShell 5.1 reads
# a BOM-less .ps1 as ANSI, so a hard-coded Chinese name here would silently never match and
# the target's launcher would keep pointing at an executable that no longer exists).
foreach ($bat in (Get-ChildItem $root -Filter '*.bat' -File)) {
  Copy-Item $bat.FullName $To -Force
  Write-Host ("  {0}" -f $bat.Name)
}

# A copy inherits permissions from where it lands, so the target should stay clean --
# verify it, because if it does not, the app will start and die instantly over there.
$bad = @()
foreach ($p in @($To, (Join-Path $To 'resources\app'), (Join-Path $To 'BlueFishDeskpet.exe'))) {
  if (-not (Test-Path $p)) { continue }
  $aces = @((Get-Acl $p).Access | Where-Object {
    $_.IdentityReference -like 'S-1-4-*' -or
    ($_.AccessControlType -eq 'Deny' -and $_.IdentityReference -eq 'Everyone')
  })
  if ($aces.Count) { $bad += $p }
}
if ($bad.Count) {
  Write-Host ""
  Write-Host "  WARNING: the target picked up AI-sandbox permission entries on:"
  $bad | ForEach-Object { Write-Host "    $_" }
  Write-Host "  Electron will die there with 0x80000003. Copy the folder somewhere else."
  Write-Host ""
} else {
  Write-Host "  permissions on the target are clean"
}

Write-Host "deployed. Restart the pet there to pick the changes up."
