param(
    [ValidateSet("debug", "release")]
    [string]$Profile = "debug"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$ndkRoot = Get-ChildItem (Join-Path $env:ANDROID_HOME "ndk") -Directory |
    Sort-Object Name -Descending | Select-Object -First 1
if (-not $ndkRoot) { throw "Android NDK is not installed." }

$cargoArgs = @("ndk", "-t", "arm64-v8a", "-t", "x86_64", "-o", (Join-Path $repo "apps/android/android/app/src/main/jniLibs"), "build")
if ($Profile -eq "release") { $cargoArgs += "--release" }
Push-Location (Join-Path $repo "packages/rust/qc-android")
try {
    & cargo @cargoArgs
    if ($LASTEXITCODE -ne 0) { throw "Android Rust build failed." }
} finally {
    Pop-Location
}
