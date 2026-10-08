# Assembles the local speech (TTS) files this app needs, then stops. Run it again any
# time: every step skips work that is already done.
#
#   powershell -ExecutionPolicy Bypass -File tools\setup-tts.ps1
#   powershell -ExecutionPolicy Bypass -File tools\setup-tts.ps1 -Voice fanchen-c
#
# What it puts in place (everything from free, public sources):
#
#   resources\app\vendor\tts\sherpa-onnx-node\      the JS API          (Apache-2.0)
#   resources\app\vendor\tts\sherpa-onnx-win-x64\   prebuilt addon + onnxruntime DLLs
#   resources\app\vendor\tts\voices\<voice>\        the voice model
#
# Where each piece comes from:
#
#   - the two sherpa packages: an existing Coopanion install if there is one next door
#     (it ships them, so copying is instant), otherwise the public npm registry tarballs
#     (`sherpa-onnx-node` / `sherpa-onnx-win-x64`, version below).
#   - the voice: the sherpa-onnx release assets. The default, `chaowen`, is built on a
#     CC0 dataset. `fanchen-c` is a HuggingFace voice whose model card does NOT state a
#     licence, so it is opt-in: check the terms yourself before redistributing it.
#
# (It goes under resources\app because that is what `__dirname` is inside the app:
#  tts.cjs looks for `vendor\tts` next to itself.)
#
# NOTE: keep this file ASCII. Windows PowerShell reads a .ps1 without a byte-order mark
# as ANSI, so non-ASCII text here would come out as mojibake.

param(
  # Where the app lives. Defaults to this repository's own root (the app is the repo).
  [string]$To = '',
  # Which voice to install when the voices folder is empty. See $VOICE_TABLE below.
  [string]$Voice = 'chaowen',
  # Take the sherpa packages from this Coopanion install instead of downloading them.
  [string]$Source = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
if (-not $To) { $To = $root }
if (-not (Test-Path $To)) { throw "target does not exist: $To" }

$app = Join-Path $To 'resources\app'
if (-not (Test-Path $app)) { throw "$To has no resources\app -- is this a Blue Fish Deskpet folder?" }
$vendor = Join-Path $app 'vendor\tts'
$voices = Join-Path $vendor 'voices'
New-Item -ItemType Directory -Force -Path $vendor, $voices | Out-Null

Write-Host "target         : $To"

# The native addon is built for one Electron/Node ABI; 1.13.8 is what this app is
# tested with. Bumping it means rebuilding or re-downloading the matching win-x64
# prebuilt as well, so keep the pair in step.
$PKGS = [ordered]@{ 'sherpa-onnx-node' = '1.13.8'; 'sherpa-onnx-win-x64' = '1.13.8' }

# The voice: release asset -> the folder name the app looks for.
# NOTE: PowerShell variable names are case-INsensitive, so this table must NOT be called
# $voices -- that is the directory path above, and the table would silently replace it.
$VOICE_BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models'
$VOICE_TABLE = @{
  'chaowen'   = @{ asset = 'vits-piper-zh_CN-chaowen-medium-int8.tar.bz2'; dir = 'chaowen-int8'; label = 'zh_CN-chaowen (super-wen), CC0 dataset' }
  'fanchen-c' = @{ asset = 'vits-zh-hf-fanchen-C.tar.bz2';                  dir = 'fanchen-c';   label = 'vits-zh-hf-fanchen-C (licence not stated - check before redistributing)' }
}

function Copy-Tree([string]$from, [string]$to) {
  if (-not (Test-Path $from)) { throw "missing source: $from" }
  New-Item -ItemType Directory -Force -Path $to | Out-Null
  robocopy $from $to /E /NFL /NDL /NJH /NJS /NP /R:2 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE) copying $from" }
}

# Windows' own tar cannot read bzip2, and the `python.exe` on PATH is often the Microsoft
# Store stub (which fails). So: try candidates in order, and only accept one that can
# actually import tarfile. Fall back to tar.exe (needs a bzip2.exe), then say what to do.
function Find-Python {
  $candidates = @()
  $bundled = Get-ChildItem "$env:USERPROFILE\.dsh\dsh-runtimes\*\dependencies\python\python.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($bundled) { $candidates += $bundled.FullName }
  foreach ($name in 'py', 'python3', 'python') {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    # The WindowsApps entries are Store stubs, not interpreters.
    if ($cmd -and $cmd.Source -notlike '*\WindowsApps\*') { $candidates += $cmd.Source }
  }
  foreach ($c in $candidates) {
    & $c -c "import tarfile" 2>$null
    if ($LASTEXITCODE -eq 0) { return $c }
  }
  return ''
}

function Expand-TarBz2([string]$archive, [string]$dest) {
  $py = Find-Python
  if ($py) {
    & $py -c "import tarfile,sys; tarfile.open(sys.argv[1],'r:bz2').extractall(sys.argv[2])" $archive $dest
    if ($LASTEXITCODE -eq 0) { return }
    Write-Host "  WARNING: $py could not unpack it, trying tar.exe"
  }
  & tar.exe -xjf $archive -C $dest
  if ($LASTEXITCODE -ne 0) {
    throw ("cannot unpack $archive here: Windows' tar needs a bzip2.exe and this machine " +
           "has none. Install Python (any 3.x) or bzip2 and run this again, or unpack the " +
           "archive by hand into $voices -- the file is left in place for you at $archive")
  }
}

# ---- 1. the JS API and the prebuilt native addon -------------------------------------
$coop = if ($Source) { $Source } else { Join-Path (Split-Path -Parent $root) 'Coopanion' }
$coopModules = Join-Path $coop 'resources\app\node_modules'
foreach ($pkg in $PKGS.Keys) {
  $version = $PKGS[$pkg]
  $to = Join-Path $vendor $pkg
  if (Test-Path (Join-Path $to 'package.json')) { Write-Host "  $pkg $version already there"; continue }
  $neighbour = Join-Path $coopModules $pkg
  if (Test-Path (Join-Path $neighbour 'package.json')) {
    Write-Host "  copying $pkg from the Coopanion install ..."
    Copy-Tree $neighbour $to
    continue
  }
  Write-Host "  downloading $pkg $version from npm ..."
  $tgz = Join-Path $env:TEMP "dsp-$pkg-$version.tgz"
  $url = "https://registry.npmjs.org/$pkg/-/$pkg-$version.tgz"
  try {
    Invoke-WebRequest $url -OutFile $tgz -UseBasicParsing -TimeoutSec 900
  } catch {
    throw "could not download $url : $($_.Exception.Message)"
  }
  $work = Join-Path $env:TEMP "dsp-unpack-$pkg"
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  & tar.exe -xzf $tgz -C $work          # npm tarballs are gzip: Windows' tar reads these
  if ($LASTEXITCODE -ne 0) { throw "cannot unpack $tgz" }
  New-Item -ItemType Directory -Force -Path $to | Out-Null
  Copy-Item (Join-Path $work 'package\*') $to -Recurse -Force
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $tgz -Force -ErrorAction SilentlyContinue
}

# ---- 2. the voice model --------------------------------------------------------------
$installed = @(Get-ChildItem $voices -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne '' })
$active = Join-Path $voices '.active'
if ($installed.Count -eq 0) {
  if (-not $VOICE_TABLE.ContainsKey($Voice)) {
    throw "unknown voice '$Voice'. Known: $($VOICE_TABLE.Keys -join ', ') -- or unpack one by hand into $voices"
  }
  $v = $VOICE_TABLE[$Voice]
  Write-Host "  voice: $Voice ($($v.label))"
  # One archive per voice, so a retry (or an offline machine that already has the file)
  # reuses it instead of downloading again. Delete it to force a fresh download.
  $tmp = Join-Path $env:TEMP "dsp-tts-$Voice.tar.bz2"
  if ((Test-Path $tmp) -and ((Get-Item $tmp).Length -gt 5MB)) {
    Write-Host "  using  : $tmp (already there; delete it to re-download)"
  } else {
    try {
      Invoke-WebRequest "$VOICE_BASE/$($v.asset)" -OutFile $tmp -UseBasicParsing -TimeoutSec 1800
    } catch {
      throw "could not download the voice: $($_.Exception.Message)"
    }
  }
  $work = Join-Path $env:TEMP 'dsp-tts-unpack'
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  Expand-TarBz2 $tmp $work          # Windows' tar cannot read bzip2; see the function
  $src = (Get-ChildItem $work -Directory | Select-Object -First 1).FullName
  Copy-Tree $src (Join-Path $voices $v.dir)
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "  kept   : $tmp (so a re-run does not download it again)"
  if (-not (Test-Path $active)) {
    Set-Content -LiteralPath $active -Value $v.dir -NoNewline -Encoding ASCII
    Write-Host "  .active -> $($v.dir)"
  }
  $installed = @(Get-ChildItem $voices -Directory | Where-Object { $_.Name -ne '' })
} else {
  Write-Host "  voices already there: $(($installed | ForEach-Object { $_.Name }) -join ', ')"
}

# What the app will actually use: the folder named in `.active`, else the only one there.
if (Test-Path $active) {
  $wanted = (Get-Content $active -Raw).Trim()
  if ($installed.Name -notcontains $wanted) {
    Write-Host "  WARNING: .active says '$wanted' but that voice is not installed -- speech stays off."
    Write-Host "           Fix it with: node tools\set-voice.cjs $($installed[0].Name)"
  }
} elseif ($installed.Count -eq 1) {
  Set-Content -LiteralPath $active -Value $installed[0].Name -NoNewline -Encoding ASCII
  Write-Host "  .active -> $($installed[0].Name)"
}

# ---- 3. what it all came to ----------------------------------------------------------
$total = (Get-ChildItem $vendor -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ("  vendor\tts is {0} MB" -f [math]::Round($total / 1MB, 1))
foreach ($pkg in $PKGS.Keys) {
  if (-not (Test-Path (Join-Path $vendor "$pkg\package.json"))) { Write-Host "  MISSING: $pkg" }
}
foreach ($d in $installed) {
  $onnx = @(Get-ChildItem $d.FullName -Filter '*.onnx' -File)
  if (-not $onnx.Count) { Write-Host "  MISSING model file in $($d.Name)" }
}
Write-Host "speech files ready. The app picks them up at the next start (see log: 'tts ...')."
