param(
    [string]$ReleaseNotes = "QC Control Android development build.",
    [string]$Testers = "prezimir@gmail.com"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$androidPackage = Get-Content (Join-Path $repoRoot "apps\android\package.json") | ConvertFrom-Json
$apkPath = Join-Path $repoRoot "artifacts\android\QC-Control-Android-$($androidPackage.version)-debug.apk"
$builtApkPath = Join-Path $repoRoot "apps\android\android\app\build\outputs\apk\debug\app-debug.apk"
$capacitorConfig = Get-Content -LiteralPath (Join-Path $repoRoot "apps\android\capacitor.config.ts") -Raw
if ($capacitorConfig -notmatch 'appId\s*:\s*["'']([^"'']+)["'']') {
    throw "Could not read the Android application ID from capacitor.config.ts."
}
$androidAppId = $Matches[1]
$firebaseConfig = Get-Content -LiteralPath (Join-Path $repoRoot "apps\android\android\app\google-services.json") -Raw | ConvertFrom-Json
$firebaseClients = @($firebaseConfig.client | Where-Object { $_.client_info.android_client_info.package_name -eq $androidAppId })
if ($firebaseClients.Count -ne 1 -or [string]::IsNullOrWhiteSpace($firebaseClients[0].client_info.mobilesdk_app_id)) {
    throw "Firebase configuration must contain exactly one registered $androidAppId client."
}
$firebaseAppId = $firebaseClients[0].client_info.mobilesdk_app_id

Push-Location $repoRoot
try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot "scripts\verify-software-parity.ps1") -BuildApps -RequireClean
    if ($LASTEXITCODE -ne 0) { throw "Software parity preflight failed; Android distribution was not started." }

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
