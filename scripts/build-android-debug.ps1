$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$androidRoot = Join-Path $repoRoot "apps\android"

function Test-JavaHome([string]$candidate) {
    if (-not $candidate) { return $false }
    $java = Join-Path $candidate "bin\java.exe"
    if (-not (Test-Path -LiteralPath $java)) { return $false }
    $version = (Get-Item -LiteralPath $java).VersionInfo.ProductVersion
    return $version -match '^(17|21)\.'
}

$javaCandidates = @(
    $env:JAVA_HOME,
    "$env:ProgramFiles\Android\Android Studio\jbr"
)
$javaCandidates += Get-ChildItem "$env:ProgramFiles\Microsoft" -Directory -Filter "jdk-21*" -ErrorAction SilentlyContinue | ForEach-Object FullName
$javaCandidates += Get-ChildItem "$env:USERPROFILE\.cache\codex-runtimes\jdk-21" -Directory -Filter "jdk-21*" -ErrorAction SilentlyContinue | ForEach-Object FullName
$javaHome = $javaCandidates | Where-Object { Test-JavaHome $_ } | Select-Object -First 1

if (-not $javaHome) {
    throw "Android builds require JDK 17 or 21. Install Microsoft.OpenJDK.21 or Android Studio, then rerun this command."
}

$env:JAVA_HOME = $javaHome
$env:Path = "$(Join-Path $javaHome 'bin');$env:Path"

Push-Location $androidRoot
try {
    & node (Join-Path $repoRoot "scripts\version-app.mjs") android sync
    if ($LASTEXITCODE -ne 0) { throw "Could not synchronize the Android app version." }
    npm run android:sync
    if ($LASTEXITCODE -ne 0) { throw "Capacitor sync failed with exit code $LASTEXITCODE." }
    & ".\android\gradlew.bat" -p ".\android" assembleDebug lintDebug
    if ($LASTEXITCODE -ne 0) { throw "Gradle failed with exit code $LASTEXITCODE." }
}
finally {
    Pop-Location
}

$builtApkPath = Join-Path $androidRoot "android\app\build\outputs\apk\debug\app-debug.apk"
if (-not (Test-Path -LiteralPath $builtApkPath -PathType Leaf)) {
    throw "Android build completed without an APK: $builtApkPath"
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$apkArchive = [System.IO.Compression.ZipFile]::OpenRead($builtApkPath)
try {
    $packagedEntries = @($apkArchive.Entries | ForEach-Object FullName)
    foreach ($nativeLibrary in @("lib/arm64-v8a/libqc_android.so", "lib/x86_64/libqc_android.so")) {
        if ($nativeLibrary -notin $packagedEntries) {
            throw "Android APK is missing the shared Rust runtime for $nativeLibrary."
        }
    }
}
finally {
    $apkArchive.Dispose()
}
$stagedApkPath = @(& node (Join-Path $repoRoot "tools\release-candidates.mjs") stage android $builtApkPath)
if ($LASTEXITCODE -ne 0 -or $stagedApkPath.Count -ne 1) { throw "Could not stage the Android release candidate." }
$releaseArtifacts = @(& node (Join-Path $repoRoot "tools\release-candidates.mjs") list)
if ($LASTEXITCODE -ne 0 -or $releaseArtifacts.Count -lt 1) { throw "Could not enumerate current release candidates." }
& node (Join-Path $repoRoot "tools\release-provenance.mjs") @releaseArtifacts
if ($LASTEXITCODE -ne 0) { throw "Could not generate Android release provenance." }
