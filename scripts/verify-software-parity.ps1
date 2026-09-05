param(
    [switch]$BuildApps,
    [switch]$BuildAndroid,
    [switch]$RequireClean
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$previousCargoTargetDirectory = $env:CARGO_TARGET_DIR
if ([string]::IsNullOrWhiteSpace($env:CARGO_TARGET_DIR)) {
    # GNU windres, used by the Windows Tauri shell build, does not reliably
    # preserve spaces in CARGO_TARGET_DIR. Keep the isolated parity cache in a
    # stable, space-free local application data path instead of inside the repo.
    $env:CARGO_TARGET_DIR = Join-Path $env:LOCALAPPDATA "QCControlBuild\software-parity-target"
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Command
    )

    Write-Host "`n== $Name =="
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE."
    }
}

$rustManifests = @(
    "packages/rust/qc-protocol/Cargo.toml",
    "packages/rust/qc-device-runtime/Cargo.toml",
    "packages/rust/qc-relay-protocol/Cargo.toml",
    "packages/rust/qc-relay-client/Cargo.toml",
    "packages/rust/qc-windows-midi/Cargo.toml",
    "packages/rust/qc-android/Cargo.toml",
    "services/device-broker/Cargo.toml",
    "services/qc-relay/Cargo.toml",
    "services/qc-remote/Cargo.toml",
    "services/rust-mcp/Cargo.toml"
)

Push-Location $repositoryRoot
try {
    Invoke-Checked "Package architecture boundaries" { npm run architecture:check }
    Invoke-Checked "Windows and Android capability parity" { npm run app-parity:check }
    Invoke-Checked "Quad Cortex reference corpus integrity" { npm run verify:qc-corpora }
    Invoke-Checked "Windows and Android screen coverage" { npm run verify:qc-coverage }
    Invoke-Checked "Dependency security policy" { npm run security:audit }
    Invoke-Checked "TypeScript typecheck" { npm run typecheck }
    Invoke-Checked "TypeScript and UI tests" { npm test }
    Invoke-Checked "Generated protocol consistency" { npm run protocol:check }
    Invoke-Checked "Gateway surface coverage" { npm run gateway:coverage }
    Invoke-Checked "pyquadcortex upstream surface parity" { npm run parity:pyquadcortex }

    foreach ($manifest in $rustManifests) {
        Invoke-Checked "Rust tests: $manifest" { cargo test --locked --manifest-path $manifest }
    }

    foreach ($manifest in $rustManifests) {
        Invoke-Checked "Rust lints: $manifest" {
            cargo clippy --locked --all-targets --manifest-path $manifest -- -D warnings
        }
    }

    Invoke-Checked "Windows native shell lint" {
        $previousTauriConfig = $env:TAURI_CONFIG
        try {
            # Compile the full shell without requiring release-only sidecars to
            # have been downloaded and staged by build-windows-installer.ps1.
            $env:TAURI_CONFIG = '{"bundle":{"externalBin":[]}}'
            cargo clippy --locked --all-targets --manifest-path "apps/windows/src-tauri/Cargo.toml" -- -D warnings
        }
        finally {
            $env:TAURI_CONFIG = $previousTauriConfig
        }
    }

    if ($BuildApps) {
        Invoke-Checked "Windows web build" { npm run build:windows }
        Invoke-Checked "Android web build" { npm run build:android:web }
    }

    if ($BuildAndroid) {
        Invoke-Checked "Android APK build" { npm run android:build:debug }
    }

    if ($RequireClean) {
        $changes = @(git status --porcelain)
        if ($LASTEXITCODE -ne 0) {
            throw "Could not inspect the Git working tree."
        }
        if ($changes.Count -gt 0) {
            throw "The parity checks passed, but the Git working tree is not clean."
        }
    }

    Write-Host "`nSoftware parity gate passed. Physical Windows and Android conformance is still required for a release."
}
finally {
    $env:CARGO_TARGET_DIR = $previousCargoTargetDirectory
    Pop-Location
}
