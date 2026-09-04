param(
    [string]$ReleaseNotes = "QC Control Android development build.",
    [string]$Testers = "prezimir@gmail.com",
    [string]$WindowsHardwareReport,
    [string]$AndroidHardwareReport,
    [switch]$PrepareOnly
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
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
$windowsHardwareReportPath = if ($WindowsHardwareReport) { $WindowsHardwareReport } else { Join-Path $repoRoot "artifacts\hardware-conformance\windows.json" }
$androidHardwareReportPath = if ($AndroidHardwareReport) { $AndroidHardwareReport } else { Join-Path $repoRoot "artifacts\hardware-conformance\android.json" }

Push-Location $repoRoot
try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot "scripts\verify-software-parity.ps1") -BuildApps -RequireClean
    if ($LASTEXITCODE -ne 0) { throw "Software parity preflight failed; Android distribution was not started." }

    if ($PrepareOnly) {
        npm run android:build:debug
        if ($LASTEXITCODE -ne 0) { throw "Android build failed with exit code $LASTEXITCODE." }
        $releaseArtifacts = @(& node (Join-Path $repoRoot "tools\release-candidates.mjs") verify)
        if ($LASTEXITCODE -ne 0) { throw "Prepared Android release bundle did not verify." }
        $androidCandidates = @($releaseArtifacts | Where-Object { $_ -match '[\\/]artifacts[\\/]android[\\/]' })
        if ($androidCandidates.Count -ne 1) { throw "Prepared release bundle does not contain exactly one Android candidate." }
        $apkPath = $androidCandidates[0]
        Write-Host "Prepared Firebase candidate without uploading: $apkPath"
    }
    else {
        $releaseArtifacts = @(& node (Join-Path $repoRoot "tools\release-candidates.mjs") verify)
        if ($LASTEXITCODE -ne 0) { throw "Release bundle verification failed; Android distribution was not started." }
        $androidCandidates = @($releaseArtifacts | Where-Object { $_ -match '[\\/]artifacts[\\/]android[\\/]' })
        if ($androidCandidates.Count -ne 1) { throw "Release bundle does not contain exactly one Android candidate." }
        $apkPath = $androidCandidates[0]

        & node (Join-Path $repoRoot "tools\verify-hardware-release.mjs") $windowsHardwareReportPath $androidHardwareReportPath
        if ($LASTEXITCODE -ne 0) { throw "Hardware conformance failed; Android distribution was not started." }

        $firebaseArguments = @("appdistribution:distribute", $apkPath, "--app", $firebaseAppId, "--release-notes", $ReleaseNotes)
        if ($Testers) { $firebaseArguments += @("--testers", $Testers) }
        & firebase @firebaseArguments
        if ($LASTEXITCODE -ne 0) { throw "Firebase upload failed with exit code $LASTEXITCODE." }
    }
}
finally {
    Pop-Location
}
