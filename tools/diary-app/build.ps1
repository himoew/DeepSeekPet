# Her diary - APK build (no Gradle).
#   javac -> d8 -> aapt2 link -> add classes.dex -> zipalign -> apksigner
#
# NOTE: this file is intentionally ASCII-only (Windows PowerShell 5.1 reads
# BOM-less files as ANSI and Chinese comments break the parser).
#
#   .\build.ps1              build only
#   .\build.ps1 -Install     build and install into the emulator
param(
    [switch]$Install,
    [string]$Adb = 'D:\mumulvse\MuMuPlayer\nx_main\adb.exe',
    # Toolchain (jdk / build-tools / platform). Default: <repo>\_android
    [string]$Toolchain = ''
)

# Native tools (keytool/d8/...) write progress to stderr; EAP=Stop would treat
# that as fatal. Judge success by $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root     = $PSScriptRoot
$tcRoot   = if ($Toolchain) { $Toolchain } else { Join-Path (Split-Path (Split-Path (Split-Path $root -Parent) -Parent) -Parent) '_android' }
$build    = Join-Path $root 'build'
$outDir   = Join-Path $root 'out'
$srcDir   = Join-Path $root 'src'
$manifest = Join-Path $root 'AndroidManifest.xml'

function Fail($msg) { Write-Host "[X] $msg" -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host ">> $msg" -ForegroundColor Cyan }

# ---------- 1. locate toolchain ----------
function Find-Home($sub, $probe) {
    $base = Join-Path $tcRoot $sub
    if (!(Test-Path $base)) { return $null }
    Get-ChildItem $base -Directory | Where-Object { Test-Path (Join-Path $_.FullName $probe) } | Select-Object -First 1
}

$jdk  = Find-Home 'jdk'         'bin\javac.exe'
$bt   = Find-Home 'build-tools' 'aapt2.exe'
$plat = Find-Home 'platform'    'android.jar'
if (-not $jdk)  { Fail 'JDK not found (_android\jdk\<ver>\bin\javac.exe)' }
if (-not $bt)   { Fail 'build-tools not found (no aapt2.exe)' }
if (-not $plat) { Fail 'platform not found (no android.jar)' }

$java       = Join-Path $jdk.FullName  'bin\java.exe'
$javac      = Join-Path $jdk.FullName  'bin\javac.exe'
$keytool    = Join-Path $jdk.FullName  'bin\keytool.exe'
$aapt2      = Join-Path $bt.FullName   'aapt2.exe'
$zipalign   = Join-Path $bt.FullName   'zipalign.exe'
$d8Jar      = Join-Path $bt.FullName   'lib\d8.jar'
$signerJar  = Join-Path $bt.FullName   'lib\apksigner.jar'
$androidJar = Join-Path $plat.FullName 'android.jar'

Step "JDK         $($jdk.Name)"
Step "build-tools $($bt.Name)"
Step "platform    $($plat.Name)"

# ---------- 2. clean ----------
if (Test-Path $build) { Remove-Item $build -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $build 'classes'), (Join-Path $build 'dex'), $outDir | Out-Null

# ---------- 3. javac ----------
Step 'javac'
$srcs = Get-ChildItem (Join-Path $srcDir 'com\bluefish\diary') -Filter *.java | ForEach-Object { $_.FullName }
$classes = Join-Path $build 'classes'
& $javac -encoding UTF-8 -nowarn -source 8 -target 8 -bootclasspath $androidJar -d $classes @srcs 2>&1 | ForEach-Object { "    $_" }
if ($LASTEXITCODE -ne 0) { Fail 'javac failed' }

# ---------- 4. d8 ----------
Step 'd8 (classes.dex)'
$classFiles = Get-ChildItem $classes -Recurse -Filter *.class | ForEach-Object { $_.FullName }
$dexOut = Join-Path $build 'dex'
& $java -cp $d8Jar com.android.tools.r8.D8 --lib $androidJar --min-api 26 --output $dexOut @classFiles 2>&1 | ForEach-Object { "    $_" }
if ($LASTEXITCODE -ne 0) { Fail 'd8 failed' }
$dex = Join-Path $dexOut 'classes.dex'
if (!(Test-Path $dex)) { Fail 'classes.dex missing' }

# ---------- 5. aapt2 link ----------
$resDir = Join-Path $root 'res'
$resZip = Join-Path $build 'res.zip'
if (Test-Path $resDir) {
    Step 'aapt2 compile (res)'
    & $aapt2 compile --dir $resDir -o $resZip 2>&1 | ForEach-Object { "    $_" }
    if ($LASTEXITCODE -ne 0) { Fail 'aapt2 compile failed' }
}

Step 'aapt2 link'
$baseApk = Join-Path $build 'base.apk'
$linkArgs = @('-o', $baseApk, '--manifest', $manifest, '-I', $androidJar, '--min-sdk-version', '26', '--target-sdk-version', '31', '--version-code', '1', '--version-name', '1.0')
if (Test-Path $resZip) { $linkArgs += @('-R', $resZip) }
& $aapt2 link @linkArgs 2>&1 | ForEach-Object { "    $_" }
if ($LASTEXITCODE -ne 0) { Fail 'aapt2 link failed' }

# ---------- 6. put dex into the apk ----------
Step 'pack classes.dex'
$zip = [System.IO.Compression.ZipFile]::Open($baseApk, 'Update')
try {
    $entry = $zip.GetEntry('classes.dex')
    if ($entry) { $entry.Delete() }
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $dex, 'classes.dex', [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
} finally { $zip.Dispose() }

# ---------- 7. zipalign ----------
Step 'zipalign'
$aligned = Join-Path $build 'aligned.apk'
& $zipalign -f -p 4 $baseApk $aligned 2>&1 | ForEach-Object { "    $_" }
if ($LASTEXITCODE -ne 0) { Fail 'zipalign failed' }

# ---------- 8. debug keystore + sign ----------
$ks = Join-Path $root 'debug.keystore'
if (!(Test-Path $ks)) {
    Step 'generate debug keystore'
    & $keytool -genkeypair -keystore $ks -storepass android -keypass android -alias androiddebugkey -dname 'CN=Android Debug,O=Android,C=US' -keyalg RSA -keysize 2048 -validity 10000 2>&1 | ForEach-Object { "    $_" }
    if ($LASTEXITCODE -ne 0) { Fail 'keytool failed' }
}

Step 'apksigner'
$apk = Join-Path $outDir 'her-diary.apk'
& $java -jar $signerJar sign --ks $ks --ks-pass pass:android --key-pass pass:android --ks-key-alias androiddebugkey --out $apk $aligned 2>&1 | ForEach-Object { "    $_" }
if ($LASTEXITCODE -ne 0) { Fail 'apksigner failed' }

Step 'verify'
& $java -jar $signerJar verify --print-certs $apk 2>&1 | Select-Object -First 4 | ForEach-Object { "    $_" }

$size = [math]::Round((Get-Item $apk).Length / 1KB, 1)
Write-Host ""
Write-Host "[OK] APK: $apk  ($size KB)" -ForegroundColor Green

# ---------- 9. install ----------
if ($Install) {
    Step 'adb install -r'
    & $Adb install -r $apk 2>&1 | ForEach-Object { "    $_" }
    if ($LASTEXITCODE -ne 0) { Fail 'adb install failed' }
    Write-Host "[OK] installed: com.bluefish.diary" -ForegroundColor Green
}
