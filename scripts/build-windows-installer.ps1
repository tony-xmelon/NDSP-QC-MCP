$repositoryRoot = Split-Path -Parent $PSScriptRoot
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
& node (Join-Path $PSScriptRoot "version-app.mjs") sync
if ($LASTEXITCODE -ne 0) { throw "Could not synchronize the Windows app version." }

New-Item -ItemType Directory -Force -Path $binaryDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $sidecarBuildDirectory | Out-Null
if (-not (Test-Path -LiteralPath $mediaFetcherTarget -PathType Leaf)) {
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe" -OutFile $mediaFetcherTarget
}
if (-not (Test-Path -LiteralPath $mediaDenoTarget -PathType Leaf)) {
    $denoArchive = Join-Path $sidecarBuildDirectory "deno-2.9.6.zip"
    $denoExtract = Join-Path $sidecarBuildDirectory "deno-2.9.6"
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/denoland/deno/releases/download/v2.9.6/deno-x86_64-pc-windows-msvc.zip" -OutFile $denoArchive
    Expand-Archive -LiteralPath $denoArchive -DestinationPath $denoExtract -Force
    Copy-Item -LiteralPath (Join-Path $denoExtract "deno.exe") -Destination $mediaDenoTarget -Force
}
if (-not (Test-Path -LiteralPath $mediaFfmpegTarget -PathType Leaf)) {
    $ffmpegArchive = Join-Path $sidecarBuildDirectory "ffmpeg-n8.1-win64-lgpl.zip"
    $ffmpegExtract = Join-Path $sidecarBuildDirectory "ffmpeg-n8.1-win64-lgpl"
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-lgpl-8.1.zip" -OutFile $ffmpegArchive
    Expand-Archive -LiteralPath $ffmpegArchive -DestinationPath $ffmpegExtract -Force
    $ffmpegSource = Get-ChildItem -LiteralPath $ffmpegExtract -Filter "ffmpeg.exe" -File -Recurse | Select-Object -First 1
    if (-not $ffmpegSource) { throw "The FFmpeg package did not contain ffmpeg.exe." }
    Copy-Item -LiteralPath $ffmpegSource.FullName -Destination $mediaFfmpegTarget -Force
}
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
$buildLock.Dispose()
