# Quad Cortex UI reference corpus

This directory contains exact 800x480 framebuffer captures and matching CorOS
graphics trees from a physical Quad Cortex. The files are the visual oracle for
the desktop reconstruction; they are not remote-desktop frames used at runtime.

## Versioning

Each `coros-X.Y.Z` directory is immutable for that firmware family. A capture
entry records its label, screen family, SHA-256, dimensions, time, and the
navigation actions that led to it. Capture a new version after a CorOS update so
visual changes are reviewable rather than silently folded into the old baseline.

## Current physical-capture subset

This is a 40-frame regression pack. It is not the complete QC screen
inventory; the 103 device screen/states and 16 companion-only screens are tracked
in `docs/qc-screen-inventory.md`.

| Interaction | Reference state |
| --- | --- |
| Grid, clean preset, active and bypassed blocks | `grid-base` |
| Scene selector and scene switching | `grid-scene-selector`, `grid-scene-b` |
| Scene copy/swap destination prompts | `copy-scene-destination`, `swap-scene-destination` |
| Grid contextual menu | `grid-context-menu` |
| Preset browsing | `preset-directory` |
| Input and output routing selectors | `input-route-selector`, `output-route-selector` |
| Add-device category and model browsers | `device-browser-root`, `device-browser-models-clean` |
| Standard block parameter editors | `editor-simple-gate`, `editor-chief-ds1`, `editor-digital-flanger`, `editor-ukc30-topboost`, `editor-ambience` |
| Specialized Cab and EQ editors | `editor-ukc30-cab`, `editor-parametric-8` |
| Gig View | `gig-view`, `gig-view-preset`, `gig-view-scene` |
| Tuner, opened and closed over MIDI CC #45 | `tuner` |

The CorOS 4.1.0 host message named `show_tuner` acknowledges the request without
changing the display. The capture harness instead uses the documented USB-MIDI
CC #45 toggle and verifies `zenUI::TunerDialog` in the physical graphics tree.

## Capture and validation

Close Cortex Control before capturing because only one process may own the USB
interface. Then run:

```powershell
.\.venv\Scripts\python.exe tools\capture_qc_ui_corpus.py --coros 4.1.0
.\.venv\Scripts\python.exe tools\verify_qc_ui_corpus.py references\qc-ui-corpus\coros-4.1.0 --rewrite
.\.venv\Scripts\python.exe tools\verify_qc_ui_corpus.py references\qc-ui-corpus\coros-4.1.0
```

Use `capture SLUG LABEL`, `tap X Y`, `scene 0..7`, and `gig on|off` in the
interactive capture shell. Avoid commands that edit preset data while producing
the baseline corpus. The normal `capture` command rejects stale or mid-paint
framebuffers by requiring two consecutive byte-identical screen reads. Use
`capture-now` only for an intentionally animated state such as a live tuner or
meter, where byte stability is impossible.

Compare an app screenshot (or a crop of its QC display) to a named reference:

```powershell
.\.venv\Scripts\python.exe -m pip install -r tools\requirements-visual.txt
.\.venv\Scripts\python.exe tools\compare_qc_ui_screen.py --coros 4.1.0 `
  --capture grid-base --renderer app.png --crop X Y WIDTH HEIGHT `
  --output .artifacts\ui-diff\grid-base
```

The command writes an alpha overlay, absolute pixel difference, tolerant edge
overlay, and JSON metrics. `--max-mae` makes it suitable for CI once a stable
desktop screenshot viewport is selected.
