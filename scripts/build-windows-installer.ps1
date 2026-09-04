$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repositoryRoot "scripts\verify-software-parity.ps1") -BuildApps -RequireClean
if ($LASTEXITCODE -ne 0) { throw "Software parity preflight failed; Windows installer build was not started." }
$buildLockPath = Join-Path $repositoryRoot "apps\windows\src-tauri\target\qc-control-installer.lock"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $buildLockPath) | Out-Null
try {
    $buildLock = [System.IO.File]::Open($buildLockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
}
catch {
    throw "Another QC Control installer build is already running. Wait for it to finish before starting another build."
}
if ([string]::IsNullOrWhiteSpace($env:CARGO_TARGET_DIR)) {
    $env:CARGO_TARGET_DIR = Join-Path $env:LOCALAPPDATA "QCControlBuild\cargo-target"
}
$nativeBrokerRoot = Join-Path $repositoryRoot "services\device-broker"
$tauriRoot = Join-Path $repositoryRoot "apps\windows\src-tauri"
$binaryDirectory = Join-Path $tauriRoot "binaries"
$sidecarBuildDirectory = Join-Path $tauriRoot "target\sidecar-build"
$rustVersion = @(& rustc -vV 2>&1)
$rustExitCode = $LASTEXITCODE
$rustHostLine = $rustVersion | Where-Object { "$_" -match "^host:\s*" } | Select-Object -First 1
if ($rustExitCode -ne 0 -or -not $rustHostLine) {
    throw "Could not determine the active Rust host target."
}
$rustHost = ($rustHostLine -split ":", 2)[1].Trim()
$mediaFetcherTarget = Join-Path $binaryDirectory "qc-media-fetch-$rustHost.exe"
$mediaFfmpegTarget = Join-Path $binaryDirectory "qc-media-ffmpeg-$rustHost.exe"
$mediaDenoTarget = Join-Path $binaryDirectory "qc-media-deno-$rustHost.exe"
$sidecarContract = Get-Content -LiteralPath (Join-Path $repositoryRoot "contracts\windows-sidecars.v1.json") -Raw | ConvertFrom-Json

function Get-SidecarComponent {
    param([Parameter(Mandatory = $true)][string]$Id)
    $component = @($sidecarContract.components | Where-Object { $_.id -eq $Id })
    if ($component.Count -ne 1) { throw "Windows sidecar contract must contain exactly one '$Id' component." }
    return $component[0]
}

function Get-VerifiedDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Sha256
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Path
    }
    # Use the framework API directly so verification remains independent of
    # PowerShell module/function discovery after the nested parity preflight.
    $hashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
    $downloadStream = [System.IO.File]::OpenRead($Path)
    try {
        $actual = ([System.BitConverter]::ToString($hashAlgorithm.ComputeHash($downloadStream))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $downloadStream.Dispose()
        $hashAlgorithm.Dispose()
    }
    if ($actual -ne $Sha256.ToLowerInvariant()) {
        throw "Downloaded build dependency failed SHA-256 verification: $Path (expected $Sha256, received $actual). Remove the cached file and deliberately update its pinned URL/checksum before retrying."
    }
}

& node (Join-Path $PSScriptRoot "version-app.mjs") sync
if ($LASTEXITCODE -ne 0) { throw "Could not synchronize the Windows app version." }

New-Item -ItemType Directory -Force -Path $binaryDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $sidecarBuildDirectory | Out-Null
$mediaFetcher = Get-SidecarComponent -Id "yt-dlp"
Get-VerifiedDownload -Uri $mediaFetcher.url -Path $mediaFetcherTarget -Sha256 $mediaFetcher.sha256

$deno = Get-SidecarComponent -Id "deno"
$denoArchive = Join-Path $sidecarBuildDirectory $deno.cacheName
$denoExtract = Join-Path $sidecarBuildDirectory $deno.extractName
Get-VerifiedDownload -Uri $deno.url -Path $denoArchive -Sha256 $deno.sha256
Expand-Archive -LiteralPath $denoArchive -DestinationPath $denoExtract -Force
Copy-Item -LiteralPath (Join-Path $denoExtract $deno.executable) -Destination $mediaDenoTarget -Force

$ffmpeg = Get-SidecarComponent -Id "ffmpeg"
$ffmpegArchive = Join-Path $sidecarBuildDirectory $ffmpeg.cacheName
$ffmpegExtract = Join-Path $sidecarBuildDirectory $ffmpeg.extractName
Get-VerifiedDownload -Uri $ffmpeg.url -Path $ffmpegArchive -Sha256 $ffmpeg.sha256
Expand-Archive -LiteralPath $ffmpegArchive -DestinationPath $ffmpegExtract -Force
$ffmpegSource = Get-ChildItem -LiteralPath $ffmpegExtract -Filter $ffmpeg.executable -File -Recurse | Select-Object -First 1
if (-not $ffmpegSource) { throw "The FFmpeg package did not contain ffmpeg.exe." }
Copy-Item -LiteralPath $ffmpegSource.FullName -Destination $mediaFfmpegTarget -Force
foreach ($windowsTarget in @("x86_64-pc-windows-msvc", "x86_64-pc-windows-gnu")) {
    foreach ($mediaTool in @("fetch", "ffmpeg", "deno")) {
        $source = Join-Path $binaryDirectory "qc-media-$mediaTool-$rustHost.exe"
        $target = Join-Path $binaryDirectory "qc-media-$mediaTool-$windowsTarget.exe"
        if ($source -ne $target) { Copy-Item -LiteralPath $source -Destination $target -Force }
    }
}

& cargo build --release --manifest-path (Join-Path $nativeBrokerRoot "Cargo.toml")
if ($LASTEXITCODE -ne 0) { throw "Could not build the native QC device broker." }
$nativeBrokerSource = Join-Path $env:CARGO_TARGET_DIR "release\qc-device-broker.exe"
if (-not (Test-Path -LiteralPath $nativeBrokerSource -PathType Leaf)) {
    throw "Native QC broker build output is missing: $nativeBrokerSource"
}
$nativeBrokerTarget = Join-Path $binaryDirectory "qc-device-broker-$rustHost.exe"
Copy-Item -LiteralPath $nativeBrokerSource -Destination $nativeBrokerTarget -Force
& node (Join-Path $repositoryRoot "tools\verify-packaged-gateway.mjs") $nativeBrokerTarget
if ($LASTEXITCODE -ne 0) { throw "The Rust device gateway does not match the current application API." }
foreach ($windowsTarget in @("x86_64-pc-windows-msvc", "x86_64-pc-windows-gnu")) {
    $targetNativeBroker = Join-Path $binaryDirectory "qc-device-broker-$windowsTarget.exe"
    if ($targetNativeBroker -ne $nativeBrokerTarget) {
        Copy-Item -LiteralPath $nativeBrokerSource -Destination $targetNativeBroker -Force
    }
}
& node (Join-Path $repositoryRoot "tools\verify-packaged-gateway.mjs") (Join-Path $binaryDirectory "qc-device-broker-x86_64-pc-windows-msvc.exe")
if ($LASTEXITCODE -ne 0) { throw "The Windows bundle target contains a mismatched Rust device gateway." }

Push-Location $repositoryRoot
try {
    npm run tauri:build
    if ($LASTEXITCODE -ne 0) { throw "Could not build the Windows app and installer." }
}
finally {
    Pop-Location
}
$tauriConfig = Get-Content -LiteralPath (Join-Path $tauriRoot "tauri.conf.json") -Raw | ConvertFrom-Json
$expectedInstallerName = "$($tauriConfig.productName)_$($tauriConfig.version)_x64-setup.exe"
$expectedInstallerPath = Join-Path $env:CARGO_TARGET_DIR "release\bundle\nsis\$expectedInstallerName"
$windowsInstallers = @(Get-Item -LiteralPath $expectedInstallerPath -ErrorAction SilentlyContinue | ForEach-Object FullName)
if ($windowsInstallers.Count -ne 1) {
    throw "The Windows installer build completed without its exact current-version NSIS artifact: $expectedInstallerPath"
}
& node (Join-Path $repositoryRoot "tools\release-provenance.mjs") @windowsInstallers
if ($LASTEXITCODE -ne 0) { throw "Could not generate Windows release provenance." }
$buildLock.Dispose()
