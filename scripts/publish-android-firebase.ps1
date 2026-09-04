param(
    [string]$ReleaseNotes = "QC Control Android development build.",
    [string]$Testers = "prezimir@gmail.com"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$androidPackage = Get-Content (Join-Path $repoRoot "apps\android\package.json") | ConvertFrom-Json
$apkPath = Join-Path $repoRoot "artifacts\android\QC-Control-Android-$($androidPackage.version)-debug.apk"
$builtApkPath = Join-Path $repoRoot "apps\android\android\app\build\outputs\apk\debug\app-debug.apk"
$firebaseAppId = "1:762132554544:android:2e6417e3507a3d87e09ef5"

Push-Location $repoRoot
try {
    npm run android:build:debug
    if ($LASTEXITCODE -ne 0) { throw "Android build failed with exit code $LASTEXITCODE." }

    New-Item -ItemType Directory -Force (Split-Path -Parent $apkPath) | Out-Null
    Copy-Item -LiteralPath $builtApkPath -Destination $apkPath -Force

    & node (Join-Path $repoRoot "tools\release-provenance.mjs") $apkPath
    if ($LASTEXITCODE -ne 0) { throw "Could not generate Android release provenance." }

    $firebaseArguments = @("appdistribution:distribute", $apkPath, "--app", $firebaseAppId, "--release-notes", $ReleaseNotes)
    if ($Testers) { $firebaseArguments += @("--testers", $Testers) }
    & firebase @firebaseArguments
    if ($LASTEXITCODE -ne 0) { throw "Firebase upload failed with exit code $LASTEXITCODE." }
}
finally {
    Pop-Location
}
