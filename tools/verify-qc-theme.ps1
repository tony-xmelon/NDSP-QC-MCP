param(
  [string]$ReportPath = "artifacts/theme-comparison.json"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$referenceRoot = Join-Path $repoRoot "artifacts\hardware-ui"
$manifest = Get-Content -LiteralPath (Join-Path $repoRoot "tests\fixtures\qc-theme-reference.json") -Raw | ConvertFrom-Json
$assetManifest = Get-Content -LiteralPath (Join-Path $repoRoot "packages\typescript\qc-theme\src\assets.json") -Raw | ConvertFrom-Json
$themeColorSource = Get-Content -LiteralPath (Join-Path $repoRoot "packages\typescript\qc-theme\src\colors.json") -Raw
$themeCss = Get-Content -LiteralPath (Join-Path $repoRoot "packages\typescript\qc-theme\src\theme.css") -Raw

Add-Type -AssemblyName System.Drawing

function Color-Hex([System.Drawing.Color]$Color) {
  return "#{0:X2}{1:X2}{2:X2}" -f $Color.R, $Color.G, $Color.B
}

function Count-Color([System.Drawing.Bitmap]$Bitmap, [string]$Hex, [int[]]$Rect) {
  $target = $Hex.ToUpperInvariant()
  $count = 0
  $left, $top, $width, $height = $Rect
  for ($y = $top; $y -lt ($top + $height); $y++) {
    for ($x = $left; $x -lt ($left + $width); $x++) {
      if ((Color-Hex $Bitmap.GetPixel($x, $y)) -eq $target) { $count++ }
    }
  }
  return $count
}

function Get-ColorHistogram([System.Drawing.Bitmap]$Bitmap) {
  $histogram = @{}
  $rect = [System.Drawing.Rectangle]::new(0, 0, $Bitmap.Width, $Bitmap.Height)
  $data = $Bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $length = [Math]::Abs($data.Stride) * $data.Height
    $bytes = [byte[]]::new($length)
    [Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $length)
    for ($y = 0; $y -lt $data.Height; $y++) {
      $row = $y * [Math]::Abs($data.Stride)
      for ($x = 0; $x -lt $data.Width; $x++) {
        $offset = $row + ($x * 4)
        $key = ([int]$bytes[$offset + 2] -shl 16) -bor ([int]$bytes[$offset + 1] -shl 8) -bor [int]$bytes[$offset]
        $current = if ($histogram.ContainsKey($key)) { $histogram[$key] } else { 0 }
        $histogram[$key] = 1 + $current
      }
    }
  } finally {
    $Bitmap.UnlockBits($data)
  }
  return $histogram
}

$results = [System.Collections.Generic.List[object]]::new()
$failures = [System.Collections.Generic.List[string]]::new()
$bitmaps = @{}
$histograms = @{}
try {
  foreach ($file in $manifest.screenshots) {
    $path = Join-Path $referenceRoot $file
    $bitmap = [System.Drawing.Bitmap]::FromFile($path)
    $bitmaps[$file] = $bitmap
    $histograms[$file] = Get-ColorHistogram $bitmap
    $sizePass = $bitmap.Width -eq $manifest.captureSize.width -and $bitmap.Height -eq $manifest.captureSize.height
    $results.Add([pscustomobject]@{ kind = "capture"; name = $file; expected = "$($manifest.captureSize.width)x$($manifest.captureSize.height)"; actual = "$($bitmap.Width)x$($bitmap.Height)"; pass = $sizePass })
    if (-not $sizePass) { $failures.Add("$file has the wrong dimensions") }
    foreach ($probe in $manifest.commonPalette) {
      $key = [Convert]::ToInt32($probe.color.Substring(1), 16)
      $count = if ($histograms[$file].ContainsKey($key)) { $histograms[$file][$key] } else { 0 }
      $pass = $count -ge $probe.minimumPixels
      $results.Add([pscustomobject]@{ kind = "palette"; name = "$file/$($probe.name)"; expected = $probe.color; actual = $count; minimum = $probe.minimumPixels; pass = $pass })
      if (-not $pass) { $failures.Add("$file is missing $($probe.name) $($probe.color)") }
    }
  }

  foreach ($file in $manifest.unsavedScreenshots) {
    $count = Count-Color $bitmaps[$file] $manifest.unsavedColor @(0, 0, 800, 100)
    $pass = $count -ge 500
    $results.Add([pscustomobject]@{ kind = "palette"; name = "$file/unsaved"; expected = $manifest.unsavedColor; actual = $count; minimum = 500; pass = $pass })
    if (-not $pass) { $failures.Add("$file does not contain the captured Unsaved tone") }
  }

  foreach ($probe in $manifest.variants) {
    $count = Count-Color $bitmaps[$probe.file] $probe.color @(0, 0, 800, 100)
    $pass = $count -ge $probe.minimumPixels
    $results.Add([pscustomobject]@{ kind = "variant"; name = "$($probe.file)/$($probe.name)"; expected = $probe.color; actual = $count; minimum = $probe.minimumPixels; pass = $pass })
    if (-not $pass) { $failures.Add("$($probe.file) is missing $($probe.name)") }
  }

  foreach ($probe in $manifest.regions) {
    $count = Count-Color $bitmaps[$probe.file] $probe.color @($probe.rect)
    $pass = $count -ge $probe.minimumPixels
    $results.Add([pscustomobject]@{ kind = "glyph-or-geometry"; name = $probe.name; expected = $probe.color; actual = $count; minimum = $probe.minimumPixels; pass = $pass })
    if (-not $pass) { $failures.Add("$($probe.name) does not match its captured region") }
  }
} finally {
  foreach ($bitmap in $bitmaps.Values) { $bitmap.Dispose() }
}

$themeColors = @($manifest.themeTokens)
foreach ($color in $themeColors) {
  $pass = $themeColorSource.IndexOf($color, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $themeCss.IndexOf($color, [StringComparison]::OrdinalIgnoreCase) -ge 0
  $results.Add([pscustomobject]@{ kind = "theme-token"; name = $color; expected = "canonical JSON and CSS"; actual = $(if ($pass) { "both" } else { "missing" }); pass = $pass })
  if (-not $pass) { $failures.Add("Shared theme is missing $color") }
}

function Get-Sha256Hex([string]$Path) {
  if ([System.IO.Path]::GetExtension($Path) -eq ".svg") {
    $canonical = ([System.IO.File]::ReadAllText($Path)).Replace("`r`n", "`n")
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($canonical)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
      return ([System.BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    } finally {
      $hasher.Dispose()
    }
  }
  $stream = [System.IO.File]::OpenRead($Path)
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($hasher.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  } finally {
    $hasher.Dispose()
    $stream.Dispose()
  }
}
foreach ($assetProperty in $assetManifest.PSObject.Properties) {
  $asset = $assetProperty.Value
  foreach ($relative in @($asset.sourcePath) + @($asset.deployedPaths)) {
    $actual = Get-Sha256Hex (Join-Path $repoRoot $relative)
    $pass = $actual -eq $asset.sha256
    $results.Add([pscustomobject]@{ kind = "asset"; name = "$($assetProperty.Name)/$relative"; expected = $asset.sha256; actual = $actual; pass = $pass })
    if (-not $pass) { $failures.Add("$relative differs from the canonical $($assetProperty.Name)") }
  }
}

$report = [pscustomobject]@{
  generatedAt = [DateTimeOffset]::Now.ToString("o")
  captures = $manifest.screenshots.Count
  checks = $results.Count
  passed = @($results | Where-Object pass).Count
  failed = $failures.Count
  failures = $failures
  results = $results
}
$absoluteReport = Join-Path $repoRoot $ReportPath
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $absoluteReport -Encoding utf8
Write-Host "QC theme comparison: $($report.passed)/$($report.checks) checks passed across $($report.captures) device captures."
Write-Host "Report: $absoluteReport"
if ($failures.Count) {
  $failures | ForEach-Object { Write-Error $_ }
  exit 1
}
