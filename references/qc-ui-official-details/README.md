# Official manual detail corpus

This corpus preserves Neural DSP manual SVGs that document a control, gesture,
editor fragment, or hardware connection without representing a complete
800x480 framebuffer. They are authoritative visual evidence, but they are not
included in full-screen similarity averages.

Each manifest entry records the original URL, checksum, intrinsic geometry,
evidence scope, and canonical screen/state IDs it supports. Regenerate it with:

```powershell
python tools/import_qc_official_detail_corpus.py
python tools/verify_qc_official_detail_corpus.py references/qc-ui-official-details/coros-4.1.0
```

Rasterize one or all assets for a scoped visual comparison with:

```powershell
$env:QC_BROWSER_EXECUTABLE='C:\Program Files\Google\Chrome\Application\chrome.exe'
node tools/render_qc_official_details.mjs references/qc-ui-official-details/coros-4.1.0/manifest.json .artifacts/qc-official-detail-renders official-detail-power-overlay
python tools/compare_qc_official_detail.py --detail .artifacts/qc-official-detail-renders/official-detail-power-overlay.png --renderer .artifacts/ui-manual-reference/windows-power-overlay.png --crop 74 194 652 93 --output .artifacts/power-overlay-detail
```

The comparison tool reports edge-F1 structural match and alpha-masked color
similarity, and emits reference, renderer, overlay, edge, and difference images.
