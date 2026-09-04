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
    npm run android:sync
    if ($LASTEXITCODE -ne 0) { throw "Capacitor sync failed with exit code $LASTEXITCODE." }
    & ".\android\gradlew.bat" -p ".\android" assembleDebug
    if ($LASTEXITCODE -ne 0) { throw "Gradle failed with exit code $LASTEXITCODE." }
}
finally {
    Pop-Location
}

$builtApkPath = Join-Path $androidRoot "android\app\build\outputs\apk\debug\app-debug.apk"
& node (Join-Path $repoRoot "tools\release-provenance.mjs") $builtApkPath
if ($LASTEXITCODE -ne 0) { throw "Could not generate Android release provenance." }
