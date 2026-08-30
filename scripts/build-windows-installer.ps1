param(
    [switch]$SkipDependencyInstall
)

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$pythonPath = Join-Path $repositoryRoot ".venv\Scripts\python.exe"
$gatewayRoot = Join-Path $repositoryRoot "services\device-gateway"
$tauriRoot = Join-Path $repositoryRoot "apps\windows\src-tauri"
$binaryDirectory = Join-Path $tauriRoot "binaries"
$sidecarBuildDirectory = Join-Path $tauriRoot "target\sidecar-build"
$sidecarName = "qc-device-gateway-x86_64-pc-windows-msvc"

if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
    throw "Repository Python runtime is missing: $pythonPath"
}

if (-not $SkipDependencyInstall) {
    & $pythonPath -m pip uninstall -y hid
    if ($LASTEXITCODE -ne 0) { throw "Could not remove the incompatible hid wrapper." }
    & $pythonPath -m pip install -r (Join-Path $gatewayRoot "requirements.txt")
    if ($LASTEXITCODE -ne 0) { throw "Could not install gateway runtime dependencies." }
    & $pythonPath -m pip install --no-deps pyquadcortex==0.40.0
    if ($LASTEXITCODE -ne 0) { throw "Could not install pyquadcortex." }
    & $pythonPath -m pip install -r (Join-Path $gatewayRoot "requirements-build.txt")
    if ($LASTEXITCODE -ne 0) { throw "Could not install gateway build dependencies." }
}

New-Item -ItemType Directory -Force -Path $binaryDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $sidecarBuildDirectory | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $sidecarBuildDirectory "spec") | Out-Null

& $pythonPath -m PyInstaller `
    --noconfirm `
    --onefile `
    --console `
    --hidden-import hid `
    --name $sidecarName `
    --paths (Join-Path $gatewayRoot "src") `
    --distpath $binaryDirectory `
    --workpath (Join-Path $sidecarBuildDirectory "work") `
    --specpath (Join-Path $sidecarBuildDirectory "spec") `
    (Join-Path $gatewayRoot "main.py")
if ($LASTEXITCODE -ne 0) { throw "Could not build the packaged device gateway." }

Push-Location $repositoryRoot
try {
    npm run tauri:build
    if ($LASTEXITCODE -ne 0) { throw "Could not build the Windows app and installer." }
}
finally {
    Pop-Location
}
