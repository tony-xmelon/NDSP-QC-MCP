# Quad Cortex screen reconstruction report

Audit date: 2026-09-05
Reference: physical Quad Cortex, CorOS 4.1.0, 800x480 framebuffer corpus

## Executive summary

| Client | Physical corpus rendered | Mean structural match | Mean color similarity |
| --- | ---: | ---: | ---: |
| Windows | 40/40 (100%) | **91.39%** | **97.25%** |
| Android | 40/40 (100%) | **91.38%** | **97.25%** |

These are native-size measurements, not audit estimates. Both hosts render the
same versioned `coros410` scratch-preset fixture through `@ndsp-qc/ui`; each
script asserts that the captured element is exactly 800x480 before comparison.
Structural match is edge F1 with a two-pixel tolerance. Color similarity is
`1 - MAE`. These values are from the interactive app path: the capture driver
opens the Directory, route selectors, and each block editor before taking the
frame. An earlier driver did not wait for asynchronous editor opening and
therefore compared the underlying Grid for seven editor states; those invalid
measurements have been replaced. Both capture drivers now exclude the decorative
host bezel and measure the same raw 800x480 framebuffer; their aggregate
structural scores differ by only 0.01 point. The live Grid, Directory, routing,
and parameter editor implementations are shared.

The complete product target is larger than the measured corpus. The canonical
inventory contains **103 CorOS screen/state rows** plus **16 Cortex Control-only
rows**. Current canonical CorOS implementation counts are:

| Status | Windows | Android |
| --- | ---: | ---: |
| Built | 103 | 103 |
| Partial | 0 | 0 |
| Shell only | 0 | 0 |
| Missing | 0 | 0 |

“40/40” therefore means every physical regression state has a renderer. All 103
cataloged states are built, but only 40 currently have matching device captures.

The separate manual-reference smoke corpus now contains **85 states / 170 exact
800x480 host captures** (Windows and Android). These validate shared composition
and framebuffer containment but are intentionally excluded from the physical
similarity percentages until matching device captures exist.

Across the physical and official full-frame corpora, **58 canonical states**
have directly comparable 800x480 evidence. A separate checksummed corpus of
**27 official manual SVG details** supplies scoped control, editor-fragment,
interaction, or hardware-diagram evidence for additional states, bringing the
number with some authoritative visual evidence to **78/103**. Detail assets do
not enter full-screen similarity averages.

Two UI-bearing details now also have crop-level regression measurements. These
scores use each SVG's intrinsic dimensions and are reported separately from
both full-frame corpora.

| Official detail | Windows structural / color | Android structural / color |
| --- | ---: | ---: |
| Power and locking controls | **92.85% / 94.25%** | **92.86% / 94.25%** |
| Scene-assigned parameter editor | **63.90% / 92.50%** | **63.87% / 92.50%** |

## Official manual corpus

The official CorOS 4.1 manual contributes **37 checksummed native 800x480
frames**. Of those, **36 are full-size Quad Cortex screens mapped to the shared
renderer**; the remaining frame is a Quad Cortex mini Support screen and is
tracked as a different device variant rather than forced into the full-size
comparison.

| Client | Official frames rendered | Mean structural match | Mean color similarity |
| --- | ---: | ---: | ---: |
| Windows | 36/36 (100%) | **89.68%** | **97.03%** |
| Android | 36/36 (100%) | **89.60%** | **97.03%** |

This broader corpus is deliberately reported separately from the 40-frame
physical-device regression pack. It adds authoritative coverage for I/O,
Directory, Capture, Settings, Looper, expression assignment, plugin, and Hybrid
Gig View states, while its lower score identifies which nominally Built screens
still need pixel-level reconstruction work.

### Official-reference screen scores

| Screen | Windows structural match | Android structural match |
| --- | ---: | ---: |
| Tuner | 88.59% | 88.39% |
| Tempo & Metronome | 87.72% | 87.62% |
| Modes Configuration | 91.84% | 91.71% |
| Gig View — PRESET | 95.61% | 95.54% |
| Gig View — SCENE | 93.50% | 93.42% |
| Gig View — STOMP | 88.85% | 88.79% |
| Gig View — HYBRID | 90.68% | 90.60% |
| Analog I/O Settings | 87.52% | 87.43% |
| USB I/O Settings | 88.08% | 88.02% |
| Global EQ | 87.39% | 87.29% |
| Brit 2203 Grid | 88.21% | 88.13% |
| Empty slot | 87.30% | 87.36% |
| Amp device browser | 87.36% | 87.54% |
| Virtual Device presets | 88.56% | 88.62% |
| Virtual Device preset actions | 89.08% | 89.09% |
| Expression bypass | 91.73% | 91.66% |
| Looper X | 87.37% | 87.30% |
| Directory — Presets | 91.97% | 91.86% |
| Directory — Favorites | 88.37% | 88.29% |
| Directory — Captures | 87.94% | 87.86% |
| Directory — IRs | 88.99% | 88.89% |
| Directory — Plugin presets | 87.11% | 86.93% |
| Directory — Search results | 88.38% | 88.30% |
| Directory — Nested folders | 90.10% | 90.02% |
| Directory — Cloud upload | 91.02% | 90.89% |
| Capture — Settings | 92.87% | 92.79% |
| Capture — Training | 90.61% | 90.50% |
| Capture — A/B test | 88.17% | 88.03% |
| Capture — Metadata | 92.95% | 92.80% |
| Plugin devices | 87.29% | 87.38% |
| Plugin folders | 88.15% | 87.95% |
| MIDI Settings | 96.08% | 95.99% |
| Preset MIDI Out | 88.72% | 88.62% |
| Settings — Account | 93.09% | 92.95% |
| Settings — System | 90.03% | 89.94% |
| Settings — Device | 87.07% | 87.00% |

## Measured physical corpus

| Physical state | Windows structural match | Android structural match |
| --- | ---: | ---: |
| `grid-base` | **93.42%** | **93.42%** |
| `grid-scene-selector` | **94.81%** | **94.81%** |
| `grid-context-menu` | 91.00% | 91.03% |
| `copy-scene-destination` | **91.79%** | **91.51%** |
| `swap-scene-destination` | **91.70%** | **91.43%** |
| `preset-directory` | 92.46% | 92.47% |
| `input-route-selector` | **90.18%** | **90.21%** |
| `output-route-selector` | **91.22%** | **91.24%** |
| `splitter-editor` | **89.28%** | **89.31%** |
| `mixer-editor` | **90.48%** | **90.52%** |
| `device-browser-root` | **89.66%** | **89.67%** |
| `device-browser-models` | **90.41%** | **90.40%** |
| `device-browser-models-clean` | **90.77%** | **90.77%** |
| `device-browser-plugin-list` | **88.61%** | **88.61%** |
| `device-browser-plugin-models` | 90.50% | 90.50% |
| `device-browser-plugin-locked` | 88.42% | 88.42% |
| `device-presets-exotic-z-boost` | 90.33% | 90.33% |
| `device-preset-actions` | 96.10% | 96.10% |
| `device-presets-user` | 89.71% | 89.70% |
| `editor-simple-gate` | **91.57%** | **91.56%** |
| `editor-chief-ds1` | **91.35%** | **91.35%** |
| `editor-digital-flanger` | **88.43%** | **88.44%** |
| `editor-ukc30-topboost` | **90.25%** | **90.24%** |
| `editor-ukc30-cab` | **92.99%** | **92.99%** |
| `editor-parametric-8` | **89.45%** | **89.45%** |
| `editor-ambience` | **89.70%** | **89.68%** |
| `gig-view` (STOMP) | **94.41%** | **94.41%** |
| `grid-restored` | **93.42%** | **93.42%** |
| `grid-scene-b` | **93.43%** | **93.43%** |
| `grid-scene-a-restored` | **93.42%** | **93.42%** |
| `tempo-metronome` | **90.46%** | **90.46%** |
| `tuner` | **90.68%** | **90.68%** |
| `tuner-live-enabled` | **90.85%** | **90.86%** |
| `gig-view-live-tuner` | **94.50%** | **94.50%** |
| `preset-midi-out` | **89.33%** | **89.33%** |
| `gig-view-preset` | 93.94% | 93.94% |
| `gig-view-scene` | 88.75% | 88.76% |
| `modes-configuration` | 96.35% | 96.35% |
| `save-as-editor` | 88.97% | 88.97% |
| `edit-details-editor` | 92.63% | 92.63% |

## Improvements in this pass

- Restored the physical plugin browser rail's green-black active surface,
  neutral white category artwork, 68px selected target, and measured plug
  proportions. The screen rises from **87.32% Windows / 87.33% Android to
  88.61%** on both hosts, while color similarity rises from **97.76% to
  97.85%**. Complete-corpus recomparison reaches **91.39% / 97.25%** on
  Windows and **91.38% / 97.25%** on Android.
- Fixed Digital Flanger's dead page-cell selectors so the live `<button>`
  controls receive the physical active/inactive colors, matched their measured
  bounds, aligned the confirmation control, and corrected the two-line title's
  scale and baseline. The screen rises from **86.60% to 88.43% Windows / 86.61%
  to 88.44% Android**, while color similarity rises from **97.69% to 97.75%**.
  The complete benchmark reaches **91.36% / 97.25%** on Windows and **91.35% /
  97.25%** on Android.
- Matched Parametric-8's four measured graph-node bounds and colors, replaced
  its approximate striped preset mark with the stacked vector glyph, and
  corrected the title scale. The editor rises from **88.33% to 89.45%**
  structural match on both hosts, with **98.21% color similarity**. A complete
  40-screen rerun raises the physical benchmark to **91.32% / 97.24%**
  structural/color on Windows and **91.31% / 97.25%** on Android.
- Fixed Preset MIDI Out's browser-dependent serif fallback, matched the
  expression-label offsets and pedal tread cadence, and tightened footswitch
  and preset-message typography. The screen rises from **88.29% to 89.33%**
  structural match on both hosts.
- Matched the Splitter panel's physical top edge and rotary-control bounds,
  and replaced the Splitter/Mixer single-character scene arrows with measured
  double chevrons. Splitter rises from **87.61% to 89.28% Windows / 87.65% to
  89.31% Android** and Mixer from **89.85% to 90.48% / 89.89% to 90.52%**.
  Corrected the shared standard-editor bypass glyph and removed erroneous
  14px header offsets from TopBoost and Ambience. The four affected editors
  gain 0.62–1.95 structural points; all seven physical editors now average
  **90.11% structural match**.
- Replaced Digital Flanger's incorrect bypass blob with the linked-control
  glyph visible in the physical editor, raising structural match from
  **85.91% to 86.60% Windows / 85.92% to 86.61% Android**. Restored the
  plugin-list Grid underlay's distinct endpoint tiles and black add-device
  target, raising that screen from **86.22% to 87.32% / 87.33%**.
- Reconstructed the Cab editor's four independently positioned parameter
  columns, measured per-control value bars, microphone targets, footer sizing,
  and stacked-preset glyph. Cab structural match rises from **85.59% to
  92.99%** with **97.69% color similarity** on both hosts; the seven physical
  editor screens now average **89.29% structural match**.
- Corrected the shared live Grid header against the physical framebuffer: the
  active preset slot is red rather than green, Undo and Save use their measured
  coordinates, the scene badge is 25px rather than 31px, and the mode icon and
  label no longer drift left. Grid base rises from **90.26% to 93.42%** and the
  fix propagates through route pickers and standard editors; the seven captured
  editors now average **88.23%** structural match.
- Restored the physical device browser's independently sized bank code, red
  slot letter, and 40px preset title instead of stretching one 64px text run
  across the dimmed Grid. Aligned its category rail and model typography and
  replaced the placeholder favorite diamond with a vector pushpin. The root,
  tipped-model, and clean-model frames rise to **89.66%**, **90.41%**, and
  **90.77%** on Windows (within 0.01 point on Android).
- Reconstructed physical STOMP Gig View typography, header geometry, device
  glyph scale, vector edit affordances, and per-tile label placement. The base
  frame rises from **83.30% to 94.41%** structural match and its Live Tuner
  variant from **84.88% to 94.50%**, identically on Windows and Android. Scoped
  capture filters now skip unrelated navigation, reducing two-screen probes
  from roughly a minute to a few seconds.
- Replaced the desktop-style white selection ring with the QC's thick
  category-colored block border, pinned standard editor header actions to their
  measured framebuffer positions, and matched the 24px scene badge plus filled
  double-triangle arrows. Corrected Flanger's DRIVE rotary, knob positions, and
  value precision; removed leaked draggable-mic markers from the C30 cab; and
  fixed Ambience's captured TRAILS, filter, and knob states. The seven editor
  frames reached **86.82%**, up from **84.46%**, with every editor improved in
  that pass.
- Parked the benchmark pointer outside the framebuffer before every capture so
  transient desktop hover artwork can no longer contaminate physical-device
  comparisons.
- Matched the physical scene-copy and scene-swap overlays: exact dimmed block,
  rail, title, modal, and button geometry lifts both states from about 80% to
  **91.4–91.8% structural match** on both hosts.
- Corrected the output route list's measured 18px type, 8px vertical offset,
  and opposing row-flow arrows, raising it from **77.76% to 90.74% Windows**
  and **78.90% to 90.76% Android**.
- Removed the Android host's decorative rounded glass overlay from framebuffer
  benchmarking. Both capture paths now isolate the same raw 800x480 UI output,
  eliminating a systematic measurement artifact without changing the app UI.

- Matched the live Directory's measured 60px folder cadence, 52px bank tiles
  on an 8px vertical rhythm, 51px preset rows, and exact physical panel colors.
  The shared Directory rises from **77.89% to 92.36% Windows** and **77.82% to
  92.28% Android**, while its color error falls to 1.95% on both hosts.
- Shifted the standard editor encoders to the physical right-hand control
  positions, corrected their 64px geometry and panel colors, and made the
  scratch corpus preserve ModelRepo-style binary switches for Boost, Sync,
  Polarity, Drive, and Trails. The canonical Grid palette now keeps Overdrive
  orange distinct from the yellow physical Drive footswitch lamp. The four
  affected non-flanger editors rise
  by 1.9–7.0 structural points, and their dimmed Grid underlay now matches the
  physical screen instead of remaining at full brightness.
- Replaced the live Grid's older approximate block and row coordinates with
  the measured 86px block cadence and 94px signal-row cadence already recorded
  in the physical corpus, restored the six empty-row plus targets, and removed
  a false input-connection indicator from the reference preset. Base Grid
  structural match rises from **68.94% to 90.24% Windows / 68.31% to 89.97%
  Android**; the scene and context overlays exceed 91%. The same shared geometry
  raises the input/output route selectors to **85.55% / 77.76% Windows** and
  **86.99% / 78.90% Android**.
- Matched Parametric-8's logarithmic frequency grid to all 26 measured vertical
  positions, corrected its background and tab tones, and aligned the shared
  footswitch, double-scene-arrow, bypass, and confirmation header controls.
  Parametric-8 rises from **63.35% to 88.33%**; the seven physical editor
  screens reached **86.82% structural match** in that pass. The latest complete
  physical benchmark reached **91.29% / 97.24% structural/color on Windows**
  and **91.28% / 97.24% on Android** in that pass.
- Restored the omitted right-hand model column in the two physical plugin
  browser fixtures, including the selected Plini and locked Cory Wong device
  lists, block artwork, preset controls, and license locks. The model screen
  rises from **54.61% to 90.72% Windows / 53.50% to 87.23% Android**; the
  locked screen rises from **51.68% to 88.50% / 50.70% to 85.52%**. The
  complete physical benchmark consequently reaches **81.87% / 96.55%**
  structural/color on Windows and **80.71% / 96.42%** on Android.
- Moved the physical benchmark onto the real interactive Grid path and added
  deterministic waits for all seven asynchronous block editors. The shared
  Windows/Android reconstruction now uses measured standard, Cab, and
  Parametric-8 editor layouts; the captured Directory's 19–32 bank window and
  complete visible setlists; physical scene and context menus; and the measured
  route focus mask and list scale. Directory structural match rises from
  **48% to 77.89%** and both route screens fall from roughly **40% pixel error
  to 3.7%**. The corrected complete physical benchmark is **80.04% / 96.33%**
  structural/color on Windows and **78.99% / 96.21%** on Android before the
  plugin-model correction above.
- Reconstructed Directory — Nested folders with the manual's outline folder
  glyphs, repeated rounded hierarchy elbows, Capture category mark, funnel
  control, and asymmetric final toolbar gap. The toolbar correction aligns four
  controls at once. Structural match rises from **87.23% to 90.10% Windows /
  87.14% to 90.02% Android**, while color similarity improves from **97.40% to
  97.69%**. The complete pass131 benchmark reaches **89.68% Windows / 89.60%
  Android** structural match and **97.03%** mean color similarity.
- Reconstructed Preset MIDI Out's two expression pedals as recessed housings
  with separately inset tread surfaces and aligned groove fields, raising the
  screen from **87.03% to 88.72% Windows / 86.93% to 88.62% Android** and
  improving its color similarity from **97.32% to 97.52%**. Plugin Devices now
  uses the official four-cell scene mark and closer gate, waveform, and paired
  speaker glyphs, lifting it to **87.29% / 87.38%**. The complete pass130
  benchmark reaches **89.60% Windows / 89.52% Android** structural match and
  **97.02%** mean color similarity.
- Replaced USB I/O's fragile fixed whitespace with the measured three-cell
  reading cadence, aligned all eight channel labels and values to the official
  rows, shifted the asymmetric cell inset by one pixel, and aligned the lower
  meter bars. USB I/O rises from **84.57% to 88.08% Windows / 84.52% to
  88.02% Android**, while color similarity improves from **96.34% to 96.48%**.
  The complete pass129 benchmark reaches **89.55% Windows / 89.47% Android**
  structural match and **97.02%** mean color similarity.
- Sampled Settings — Device's surfaces and bypass controls directly from the
  official frame, reduced its device cards from 70px to the measured 66px,
  and aligned its row labels and switches. Structural match rises from
  **86.66% to 87.07% Windows / 86.59% to 87.00% Android**, while color
  similarity improves from **95.69% to 95.96%**. Replacing the remaining undo
  and save text placeholders with shared vector controls raises Empty Slot to
  **87.30% / 87.36%** and Amp Browser to **87.36% / 87.54%**. The complete
  pass128 benchmark reaches **89.45% Windows / 89.37% Android** structural
  match and **97.01%** mean color similarity.
- Replaced the SCENE and HYBRID tiles' browser-dependent Unicode edit, swap,
  and copy placeholders with shared measured vector controls, and reconstructed
  the SCENE mode's four-cell A/B/C/D header mark. SCENE rises from **86.90% to
  93.50% Windows / 86.83% to 93.42% Android**; HYBRID rises from **87.74% to
  90.68% / 87.67% to 90.60%**. The complete pass127 benchmark reaches
  **89.41% Windows / 89.33% Android** structural match and **97.01%** mean
  color similarity.
- Matched Global EQ's three independent parameter values by rotating the GAIN,
  FREQ, and Q pointers to their measured 0°, -90°, and -135° positions. Its
  header now uses the measured title and power-button columns, compact green
  status rail, and vector bypass control. Structural match rises from **86.51%
  to 87.39% Windows / 86.40% to 87.29% Android**. Corrected the Amp browser's
  four output targets to the same 94px cadence found in the official frame
  without altering its central add target, raising it from **86.19% to 86.93%
  / 86.37% to 87.12%**. The complete pass126 benchmark reaches **89.15%
  Windows / 89.07% Android** structural match and **97.01%** mean color
  similarity.
- Restored Empty Slot's omitted Row 4 output target, aligned the complete
  four-row stack to the official 94px cadence, and sampled the distinct grid
  and target-button colors from the framebuffer. Structural match rises from
  **85.92% to 86.78% Windows / 86.04% to 86.84% Android**, while color
  similarity rises from **96.62% to 97.68%**. Matched the I/O title and Global
  EQ typography and replaced USB's nested-square placeholder with the actual
  framed connector symbol. Analog I/O reaches **87.52% / 87.43%** and USB I/O
  reaches **84.57% / 84.52%**. The complete pass125 benchmark reaches
  **89.10% Windows / 89.02% Android** structural match and **97.00%** mean
  color similarity.
- Matched Capture Settings' measured 23px instruction-line rhythm instead of
  the browser's loose list defaults. Structural match rises from **84.68% to
  92.87% Windows / 84.61% to 92.79% Android**. Reconstructed the Plugin
  Presets mark as the manual's stroked waveform rather than a filled polygon,
  raising that screen from **85.81% to 87.11% / 85.64% to 86.93%**. Preset
  MIDI Out now uses the measured title scale, fixed-width header actions, and
  18px inter-button gap, improving to **87.03% / 86.93%**. The complete pass124
  benchmark reaches **89.06% Windows / 88.98% Android** structural match and
  **96.98%** mean color similarity.
- Restored the second stacked meter bar in all eight USB channels and matched
  their asymmetric cell padding. USB I/O rises from **81.37% to 84.19%
  Windows / 81.32% to 84.14% Android**, while color similarity improves from
  **96.02% to 96.35%**.
- Rescaled Analog I/O's TYPE, PHANTOM 48V, and GROUND LIFT rows to the measured
  16px labels and 20px radio controls, restored the lower panel divider and
  `IN 1 LEVEL` label, and aligned its value and meter width. Structural match
  rises from **84.13% to 87.17% Windows / 84.05% to 87.09% Android**, with
  color similarity improving to **97.32%**.
- Corrected Global EQ's three control-knob diameters and centers, value insets,
  TYPE selector bounds, and BYPASS vertical anchor. The screen rises from
  **85.84% to 86.51% Windows / 85.74% to 86.40% Android**. Separated the Amp
  and Plugin device-browser control stacks after detecting a shared-selector
  regression; Amp recovers from **82.79% to 86.19% / 82.98% to 86.37%** while
  Plugin Devices retains **87.25% / 87.34%**. The complete pass123 benchmark
  reaches **88.79% Windows / 88.71% Android** structural match and **96.97%**
  mean color similarity.
- Reconstructed Capture Metadata's capture-kind cards from sampled framebuffer
  geometry: 70px cards on 83px centers, a 3px black outer frame, 4px inset
  category outlines, and the exact gray, red, purple, and orange device colors.
  Structural match rises from **82.97% to 92.95% Windows / 82.82% to 92.80%
  Android**, while color similarity improves from **98.22% to 98.30%**.
- Removed seven invented full-width row separators from Directory Presets after
  regional scoring isolated its right pane at only 66.70% structural match.
  The screen rises from **80.97% to 91.97% Windows / 80.89% to 91.86%
  Android**, and color similarity improves to **97.85%**.
- Restored Plugin Folders' single measured preset-row separator, raising the
  screen from **82.00% to 88.15% Windows / 81.80% to 87.95% Android**. Fixed
  Directory Search Results' inherited generic-search margin and grid layout,
  then aligned its search field, tabs, toolbar gaps, and proper search glyph;
  that screen rises from **85.21% to 88.38% / 85.12% to 88.30%**. The complete
  pass122 benchmark reaches **88.51% Windows / 88.44% Android** structural
  match and **96.95%** mean color similarity.
- Corrected Plugin Devices' grid-control model: child-position selectors now
  address the controls independently of the seven preceding device blocks, and
  the center add control plus the complete Row 3 / Multi Out stack occupy their
  measured locations. Structural match rises from **84.45% to 87.25% Windows /
  84.83% to 87.34% Android**, while color similarity rises from **97.20% to
  97.41%** on both hosts.
- Restored the USB, MIDI OUT, and MIDI IN connector stems omitted from the USB
  I/O reconstruction. Structural match rises from **80.93% to 81.37% Windows /
  80.87% to 81.32% Android**. Replacing Capture Settings' two placeholder
  bullets with the measured circular information controls raises that screen
  from **83.81% to 84.68% / 83.74% to 84.61%**. The complete pass121 benchmark
  reaches **87.67% Windows / 87.60% Android** structural match and **96.94%**
  mean color similarity.
- Matched USB I/O's 109px Global EQ header control and replaced the headphone
  placeholder with a measured headset glyph shared by the Analog and USB views.
  USB structural match rises from **80.26% to 80.93% Windows / 80.21% to
  80.87% Android**; Analog I/O rises from **83.82% to 84.13% / 83.74% to
  84.05%**. Replacing Directory Captures' tiny header placeholder with a
  correctly bounded striped capture mark raises that screen again to
  **87.94% / 87.86%**. The complete pass120 benchmark reaches **87.65% Windows
  / 87.58% Android** structural match and **96.95%** mean color similarity.
- Added the missing Directory Captures alphabet index, moved row counts and
  action menus to their measured column, prevented child-folder labels from
  wrapping, aligned their 2px text offset, and replaced the Captures Library
  placeholder with a purpose-built glyph. Structural match rises from
  **83.50% to 87.47% Windows / 83.43% to 87.39% Android**, while MAE improves
  from **0.0272 to 0.0254**. A complete 36-screen rerun advances the official
  benchmark to **87.61% / 87.54%** structural and **96.95%** color similarity.
- Corrected Plugin Folders' measured header and navigation anchors: the Plugins
  label moves 12px right, every folder label moves 2px left, and the plugin
  glyph is scaled to its reference bounds. Structural match rises from
  **81.53% to 82.00% Windows / 81.34% to 81.80% Android**, while MAE improves
  from **0.0098 to 0.0092**. The complete 36-screen official benchmark now
  reaches **87.50% / 87.43%** structural match with **96.94%** mean color
  similarity.
- Rebuilt the Power and Locking overlay from its 652x93 official SVG geometry:
  exact 157px action widths, 404x38 lock control, 8px gaps, measured radii,
  colors, typography, and a real lock glyph. Its scoped structural/color match
  rises from **48.80% / 86.50% to 92.85% / 94.25% on Windows** and from
  **48.81% / 86.50% to 92.86% / 94.25% on Android**.
- Replaced the invented full-screen Scene Assignment dialog with the actual
  lower parameter-editor interaction: device header, Scene selector, bypass
  and confirm controls, two measured parameter rows, assigned MID outline, and
  touch gesture. Against the official 800x283 editor fragment, structural
  match rises from **7.70% to 63.90% Windows / 7.70% to 63.87% Android** and
  color similarity rises from **90.60% / 90.59% to 92.50% on both hosts**.
- Added reproducible official-detail rasterization and crop comparison tools.
  Transparent SVG pixels remain outside the evidence scope, while visible
  controls receive masked color error and two-pixel edge-F1 measurements.
- Added the official-manual detail corpus with **27 source-preserving SVGs**,
  intrinsic geometry, checksums, evidence scopes, and bidirectional canonical
  state mappings. This raises authoritative visual coverage from **58 to 78 of
  103 states** while retaining **58** as the honest full-frame count. The
  coverage verifier now rejects missing, orphaned, or mis-mapped detail assets.
- Hardened physical corpus acquisition after a live-device probe exposed a
  stale first framebuffer. Static `capture` now requires two consecutive
  byte-identical device reads, preset identity reads retry transient protocol
  timeouts, and unstable screens are rejected instead of silently entering the
  corpus. A guarded live QC run verified the settled capture path at 800x480;
  animated states remain available only through explicit `capture-now`.
- Reconstructed the official Brit 2203 Grid title as separate, measured bank,
  scene, and preset-name runs, corrected its scene color, and replaced eight
  incorrect fixture block categories with the devices visible in the reference.
  Structural match rises from **84.35% to 88.21% Windows / 84.28% to 88.13%
  Android**, while MAE falls from **0.0553 to 0.0428**.
- Replaced Gig View's STOMP and HYBRID placeholder characters with the measured
  device tiles, including the plugin, wah, drive, looper, transpose, grouped-
  device, and room artwork. STOMP rises from **84.79% to 88.85% Windows /
  84.74% to 88.79% Android**; HYBRID rises from **86.62% to 87.74% Windows /
  86.55% to 87.67% Android**. The complete official benchmark now reaches
  **87.49% / 87.42%** structural match and **96.94%** color similarity.
- Refit Global EQ's response curve to the manual trace, enlarged the selected
  and unselected graph nodes to their measured radii, and aligned the remaining
  node centers. Structural match rises from **82.60% to 85.84% Windows / 82.51%
  to 85.74% Android**, with MAE improving from **0.0397 to 0.0382**.
- Corrected Capture Training's step-list offset, content spacing, and progress
  spinner anchor. Structural match rises from **82.97% to 90.61% Windows /
  82.89% to 90.50% Android**, while MAE falls from **0.0302 to 0.0281**.
- Aligned Capture Settings' three level dials with the measured control centers,
  lifting it from **83.57% to 83.81% Windows / 83.49% to 83.74% Android**.
- Added the missing selected-preset background in Directory Presets. Its
  structural score is unchanged at **80.97% / 80.89%**, but MAE improves from
  **0.0234 to 0.0218**. A six-font sweep confirmed Arial remains the strongest
  available match for this screen. The full official benchmark now reaches
  **87.23% / 87.17%** structural match and **96.90%** color similarity.
- Moved and resized the shared device-browser category rail to its measured
  framebuffer anchor. The Amp browser rises from **81.00% to 86.08% Windows /
  81.19% to 86.27% Android**, and Plugin Devices rises from **80.66% to 84.45%
  / 81.12% to 84.83%**. Both screens also reduce MAE.
- Corrected Plugin Presets' right-pane and refresh-control colors, aligned its
  Neural DSP mark, and replaced the category placeholder with the plugin glyph.
  Structural match rises from **83.92% to 85.81% Windows / 83.72% to 85.64%
  Android**, while MAE drops sharply from **0.0511 to 0.0167**.
- Aligned Plugin Folders' preset-row text and shortcut column. Structural match
  rises from **81.06% to 81.53% Windows / 80.87% to 81.34% Android** while
  retaining **0.0098 MAE**.
- Expanded the Analog I/O Global EQ control to its measured width without
  applying the change to USB, where it regressed edge agreement. Analog I/O
  rises again from **83.27% to 83.82% Windows / 83.19% to 83.74% Android**.
  The USB meter style was restored byte-for-byte to its stronger accepted frame
  after detecting an incomplete experimental revert. The complete official
  benchmark now reaches **86.93% / 86.86%** structural match and **96.89%**
  color similarity.
- Repositioned the Analog I/O TYPE, PHANTOM 48V, and GROUND LIFT switch rows to
  the measured vertical and horizontal anchors. Structural match rises from
  **81.33% to 83.27% Windows / 81.25% to 83.19% Android**, while MAE improves
  from **0.0280 to 0.0275**.
- Corrected Capture Metadata's folder-icon spacing and the two section-label
  baselines. Structural match rises from **82.05% to 82.97% Windows / 81.90%
  to 82.82% Android**, and MAE falls from **0.0189 to 0.0178**.
- Scoped the measured Roboto sizing to the Amp browser's model list. Structural
  match rises from **80.79% to 81.00% Windows / 80.94% to 81.19% Android**,
  with MAE improving from **0.0195 to 0.0191 / 0.0192**. Together these retained
  corrections bring the complete official benchmark to **86.57% / 86.51%**
  structural match and **96.79%** color similarity.
- Matched Empty Slot's Roboto text metrics and moved its scrollbar from the
  inset content edge to the measured panel boundary. Structural match rises
  from **83.30% to 85.92% Windows / 83.42% to 86.04% Android**, and MAE falls
  from **0.0344 to 0.0338**.
- Replaced Plugin Folders' remaining outlined/Unicode plugin and export marks
  with the filled plugin glyph and vector export action shown in the manual.
  Structural match rises from **80.33% to 81.06% Windows / 80.14% to 80.87%
  Android**, with MAE improving from **0.0099 to 0.0098**. The complete official
  benchmark now reaches **86.51% / 86.45%**.
- Rebuilt the official Modes Configuration header controls and mode tiles with
  vector glyphs, then expanded its undersized Quad Cortex silhouette to the
  measured chassis, display, encoder, and footswitch coordinates. Structural
  match rises from **82.58% to 91.84% Windows / 82.44% to 91.71% Android**,
  with MAE improving from **0.0336 to 0.0325**.
- Scoped the bundled Roboto face to Settings — Device, matching the manual's
  line wrapping and glyph widths without changing the higher-scoring Account
  and System states. Its structural match rises from **82.59% to 86.66%
  Windows / 82.53% to 86.59% Android**. A custom icon replacement was measured
  and rejected because it reduced edge agreement. The full official benchmark
  now reaches **86.42% / 86.36%** with **96.78%** color similarity.
- Corrected the evidence ledger so the official Amp browser is attached to the
  Guitar/Bass model-list state, Plugin Devices to the plugin license-list state,
  and the official Brit 2203 Grid to the base Grid state. The verifier now
  rejects any orphaned physical image or comparable official frame. This
  corrects the direct-evidence count from **59 to 58 canonical states**; all 36
  comparable official frames and all 40 physical frames are explicitly
  represented without misclassifying Search as the Amp browser.
- Matched Capture Metadata's folder/name control widths and header spacing.
  Structural match rises from **81.61% to 82.05% Windows / 81.47% to 81.90%
  Android**, while MAE falls from **0.0197 to 0.0189**.
- Moved the shared I/O connector row to the measured vertical anchors. Analog
  I/O rises from **80.96% to 81.33% Windows / 80.88% to 81.25% Android**; USB
  rises from **79.96% to 80.26% / 79.91% to 80.21%**.
- Replaced Plugin Devices' refresh, undo, export, overflow, and mode Unicode
  stand-ins with vector controls. Plugin Devices rises from **80.33% to 80.66%
  Windows / 80.81% to 81.12% Android**. The same change was measured and
  rejected for the Amp browser, so it remains scoped to the plugin state. The
  complete official benchmark reaches **86.05% / 85.99%**.
- Reconstructed Expression bypass's switch tracks, selected-ring placement,
  delay dial, text weights, and assignment-button baselines. Structural match
  rises from **80.23% to 91.73% Windows / 80.17% to 91.66% Android** and MAE
  improves from **0.0341 to 0.0305**.
- Replaced Capture Settings' Unicode input selectors with the manual's vertical
  Mic/Instrument switch geometry. Structural match rises from **81.76% to
  83.57% Windows / 81.68% to 83.49% Android**, while MAE improves from
  **0.0478 to 0.0469 / 0.0470**.
- Corrected Global EQ typography, graph-node coordinates, TYPE and BYPASS
  control placement, and dial scale. Structural match rises from **80.05% to
  82.60% Windows / 79.97% to 82.51% Android**, and MAE falls from **0.0417 to
  0.0397**. With all retained changes, the full official benchmark reaches
  **86.01% / 85.95%** structural match and **96.78%** color similarity.
- Matched the official Plugin Folders typography to the Roboto face bundled by
  both clients. This raises the weakest official state from **79.93% to 80.33%
  Windows / 79.75% to 80.14% Android** and lowers its MAE from **0.0103 to
  0.0099**. The complete official benchmark reaches **85.57% / 85.51%**
  structural match while retaining **96.76%** color similarity.
- Replaced Capture Metadata's close, destination-folder, note, and save font
  symbols with outlined SVG controls and matched its state-specific canvas,
  capture-tile, note, save, and instrument-button colors. Structural match
  rises from **81.01% to 81.61% Windows / 80.89% to 81.47% Android**, while MAE
  falls from **0.0235 to 0.0197**. The complete official benchmark reaches
  **85.56% / 85.50%** structural match and **96.76%** color similarity.
- Replaced the Directory Captures, IRs, and Plugin Presets placeholder square
  folder marks with measured outline SVG folders. Plugin Presets rises from
  **80.76% to 83.92% Windows / 80.57% to 83.72% Android**, Captures from
  **82.73% to 83.50% / 82.66% to 83.43%**, and IRs from **88.68% to 88.99% /
  88.58% to 88.89%**. The rule is deliberately excluded from Nested Folders,
  where an independent comparison showed a small regression. The complete
  official benchmark reaches **85.54% / 85.48%** structural match.
- Separated the official manual's active-note Tuner state from the physical
  neutral 422 Hz fixture. The new authoritative renderer adds the manual's
  −1.4-cent reading, adjacent pitch arrows, D♯/E♭–E–F note display, green target,
  440 Hz dial, and enabled Live Tuner state without changing any physical tuner
  capture. Official Tuner rises from **81.55% to 88.59% Windows / 81.35% to
  88.39% Android**. The complete official benchmark reaches **85.42% / 85.36%**
  structural match and **96.75%** color similarity.
- Corrected I/O dial-value baselines by ten pixels, moved the impedance dial to
  its measured horizontal center, and retained the filled primary-input
  connector treatment. Analog I/O rises from **80.08% to 80.96% Windows /
  80.01% to 80.88% Android**, with MAE improving from **0.0283 to 0.0279**; USB
  rises from **79.42% to 79.96% / 79.37% to 79.91%** and reaches **0.0400 MAE**.
  A replacement switch-control DOM was measured and rejected because its text
  anchors reduced parity. The complete official benchmark now reaches
  **85.23% / 85.17%** structural match with **96.74%** color similarity.
- Corrected Looper X's full-width timeline split from the approximate 50% to
  the measured 52% boundary and matched its `#101010`, `#181c18`, and `#282c28`
  surfaces plus recording red. That removes a four-pixel-wide horizontal
  mismatch across the framebuffer: structural match rises from **80.45% to
  87.37% Windows / 80.42% to 87.30% Android**, while MAE falls from **0.0410 to
  0.0305**.
- Replaced Expression Bypass's close, save, bypass-power, and parameter-link
  font symbols with outlined SVG controls and matched its measured canvas,
  panel, selected-row, and green accent colors. Structural match rises from
  **80.16% to 80.23% Windows / 80.12% to 80.17% Android**, while MAE falls from
  **0.0353 to 0.0341**. Together with the retained prior pass, the complete
  official benchmark reaches **85.19% / 85.13%** structural match and
  **96.74%** color similarity on both hosts after refreshing the shared Amp
  browser, whose MAE falls from **0.0315 to 0.0195**.
- Replaced the official Plugin Folders toolbar's five font-symbol stand-ins
  with shared outlined SVG controls for back, plugin category, arrange, search,
  and done. Structural match rises from **79.58% to 79.93% Windows / 79.40% to
  79.75% Android** with its already improved **0.0103 MAE** preserved.
- Matched the official analog/USB I/O canvases, panels, selector buttons, dial
  tracks, and active Input 1 connector to sampled framebuffer colors. Analog
  MAE falls from **0.0369 to 0.0283** and USB from **0.0490 to 0.0402** while
  structural scores stay within 0.08 points. A more aggressive Global EQ graph
  recoloring was measured and rejected because it suppressed reference edges;
  the retained control-palette correction keeps structure flat and lowers MAE.
  With all retained changes, the complete official corpus reaches **84.99%
  Windows / 84.94% Android** structural match and **96.68%** color similarity.
- Replaced the official Plugin Devices screen's seven placeholder Unicode block
  marks with purpose-built vector gate, amp, capture, cab, modulation, IR, and
  dual-cab glyphs, and matched the dimmed Grid palette sampled from the manual.
  Plugin Devices rises from **79.22% to 80.33% Windows / 79.33% to 80.81%
  Android**, while MAE falls from **0.0410 to 0.0293**. Matching Plugin Folders'
  exact panel palette also lowers its MAE from **0.0127 to 0.0103**. Together
  these changes raise the complete 36-screen official benchmark to **84.99% /
  84.93%** structural match and **96.63%** color similarity on both hosts.
- Corrected the official Directory bank controls so their numeric labels are
  centered instead of inheriting the parent folder-navigation grid, and matched
  the manual's exact shared canvas, panel, and selected-row colors. Presets rises
  from **79.02% to 80.97% Windows / 78.94% to 80.89% Android** and Cloud Upload
  from **88.80% to 91.02% / 88.68% to 90.89%**. Across all eight official
  Directory screens, mean color error falls without changing their geometry;
  the complete 36-screen official benchmark reaches **84.96% / 84.89%**
  structural match and **96.59%** color similarity on both hosts.
- Reconstructed the shared Grid preset title with the embedded device typeface
  and a measured 418-unit SVG length, selected through an in-memory font/weight/
  length sweep rather than visual estimation. Clean Grid rises from **88.26% to
  90.14% Windows / 88.15% to 90.02% Android**; the same correction improves
  scene, routing, browser, and parameter-editor overlays by roughly 0.8–1.9
  points. The independent official Brit 2203 Grid also rises from **83.33% to
  84.35% / 83.26% to 84.28%**. A fresh 40-screen rerun reaches **89.66% Windows /
  89.58% Android**, with **97.16% / 97.15%** mean color similarity and no missing
  renders.
- Replaced filled unavailable-plugin silhouettes with the physical outlined
  padlock treatment and matched the plugin header canvas. The plugin list rises
  from **85.87% to 86.36% Windows / 85.84% to 86.33% Android**, plugin models
  from **90.69% to 91.08% / 90.66% to 91.05%**, and the locked-model screen from
  **90.70% to 91.05% / 90.67% to 91.03%**. The complete benchmark reaches
  **89.21% / 89.13%** structural match; the extra icon contours move aggregate
  MAE by **0.0001** to **0.0296**, reported rather than hidden.
- Reconstructed the physical Preset Directory palette from sampled framebuffer
  colors and corrected the folder icon-to-label and category-header gaps. The
  selected folder/current row retain their measured contrasting surfaces so
  structural boundaries remain intact. Structural match rises from **85.49% to
  87.55% Windows / 85.00% to 87.03% Android**, while MAE falls from **0.0269 to
  0.0215 / 0.0216**. Recomparison of all 40 physical states raises the benchmark
  to **89.18% / 89.10%**, with **97.05%** mean color similarity on both hosts.
- Corrected the bypass compositing model for the physical Digital Flanger
  control surface. Its pre-dim canvas, dial faces, toggle tracks, cell dividers,
  and two-row separator now resolve to the sampled framebuffer colors instead
  of the generic editor's near-black palette. Structural match rises from
  **82.81% to 84.84% Windows / 82.74% to 84.78% Android**, while MAE falls from
  **0.0337 to 0.0267**. Recomparison of all 40 physical states raises the
  benchmark to **89.12% / 89.05%**, with **97.03%** mean color similarity on
  both hosts. A measured preset-title scaling experiment was rejected because
  it reduced structural accuracy despite improving the apparent bounding box.
- Aligned the physical Virtual Device model browser's category rail to the
  framebuffer's vertical cadence and corrected the pinned-device mark without
  affecting the root browser or plugin drawers. The clean model list rises from
  **85.47% to 86.78% Windows / 85.45% to 86.77% Android**, and the onboarding-tip
  state rises from **85.90% to 87.09% / 85.87% to 87.07%**. Recomparison of all
  40 physical states raises the benchmark to **89.07% Windows / 89.00% Android**,
  with mean color similarity of **97.02% / 97.01%**.
- Reconstructed the physical Splitter and Mixer editors around their shared
  full-width `#101010` panel, inset rounded control surface, measured header
  groups, explicit Mixer mark, exact signal-path colors, and the physical
  bypass treatment for Digital Flanger. Splitter rises from **85.42% to 87.61%
  Windows / 85.34% to 87.53% Android**; Mixer rises from **87.46% to 89.84%
  Windows / 87.37% to 89.75% Android**. Their MAE falls to **0.0263 / 0.0249**,
  and a complete 40-screen rerun raises the physical benchmark to **89.01% /
  88.94%**, with **97.01%** mean color similarity on both hosts. The other 38
  physical screen scores remain unchanged.
- Reconstructed the physical input-route selector while preserving the actual
  translucent Grid composite: exact `#101010` panel layers, regular embedded
  typography, measured header/list gaps, 32-pixel USB route marks, correctly
  sized FX/unused marks, a dedicated two-lane stereo-input SVG, and the
  persistent 2-pixel scrollbar that Chromium otherwise hides. Structural match
  rises from **84.88% to 91.15% Windows / 84.87% to 91.14% Android**, while MAE
  falls from **0.0263 to 0.0212 / 0.0213**. The complete corpus confirms the
  other 39 physical scores are unchanged and raises the benchmark to **88.90% /
  88.82%**, with **96.99%** mean color similarity on both hosts.
- Reconstructed the physical 212 UK C30 65 (M) Cab editor with exact
  header/panel/footer colors, embedded device typography, a measured fixed-cell
  scene selector, the physical 24-pixel scene badge, corrected speaker radial
  regions and microphone markers, and one-pixel footer sizing. Structural match
  rises from **84.34% to 86.61% Windows / 84.29% to 86.55% Android**, while MAE
  falls from **0.0302 to 0.0246**. The full dual-host corpus confirms the other
  39 screen scores are unchanged and raises the benchmark to **88.74% / 88.67%**,
  with **96.98% / 96.97%** mean color similarity.
- Reconstructed the physical Edit Details keyboard with the sampled
  `#101010` canvas, `#212421` key field, `#181c18` special keys, `#102818`
  name field, exact header control colors, embedded device typography, and a
  separately scaled/positioned preset-name layer. Structural match rises from
  **84.43% to 92.54% Windows / 84.62% to 92.49% Android**, while MAE falls from
  **0.0345 to 0.0182**. A complete dual-host rerun confirms the other 39
  physical scores are unchanged and raises the benchmark to **88.68% / 88.61%**,
  with **96.96%** mean color similarity on both hosts.
- Reconstructed the bypassed Digital Flanger editor's physical header framing
  and scene control without changing the other parameter editors. The shared
  header now has semantic arrow elements, while Flanger receives its measured
  fixed arrow cells, divider lines, exact 24-pixel yellow scene badge, page
  treatment, and sampled `#101010` framing. Structural match rises from
  **81.61% to 82.81% Windows / 81.55% to 82.74% Android**, while MAE falls from
  **0.0372 to 0.0337**. A complete rerun confirms the other 39 physical screen
  scores are unchanged and raises the benchmark to **88.48% / 88.41%**, with
  **96.92%** mean color similarity on both hosts.
- Reconstructed the shared Copy Scene and Swap Scene destination overlay using
  the physical dimmed-frame composite color, exact modal canvas and action
  button colors, and measured content/button offsets. Copy rises from **82.53%
  to 87.05% Windows / 82.54% to 87.07% Android**; Swap rises from **82.59% to
  87.09% Windows / 82.61% to 87.12% Android**. Their MAE falls from
  **0.0255/0.0252 to 0.0123/0.0119**, and the complete 40-screen benchmark rises
  to **88.45% / 88.38%**, with **96.91%** mean color similarity on both hosts.
  The other 38 physical screen scores remain unchanged.
- Reconstructed the physical Save As destination's exact canvas, folder,
  selected-folder, bank, preset-list, and active-preset colors; corrected the
  bank column width; matched the 51-pixel preset-row cadence; embedded the
  device typography; and aligned the header and folder-label baselines.
  Structural match rises from **84.10% to 89.73% Windows / 84.05% to 89.64%
  Android**, while MAE falls from **0.0286 to 0.0155 / 0.0156**. The fresh
  40-screen rerun raises the physical benchmark to **88.23% / 88.16%**, with
  mean color similarity of **96.85% / 96.84%**; every other physical screen is
  unchanged.
- Reconstructed physical PRESET Gig View with the framebuffer's exact canvas,
  tile, active-state, and header-control colors; embedded device typography;
  measured control widths; lighter and earlier preset numbers; and the smaller
  active-preset label. Structural match rises from **84.08% to 96.84% Windows /
  84.03% to 96.75% Android**, while MAE falls from **0.0555 to 0.0288**. The
  complete 40-screen rerun raises the physical benchmark to **88.08% / 88.02%**
  and mean color similarity to **96.81%** on both hosts; all other physical
  screen scores remain unchanged.
- Reconstructed Modes Configuration from the physical framebuffer: exact
  `#101010` canvas and `#292c29` cards, measured header/control and card
  positions, the missing cycle arrowheads, embedded typography, a real info
  glyph, and the shared canonical PRESET/SCENE/STOMP SVG marks. Structural match
  rises from **82.61% to 96.74% Windows / 82.39% to 96.52% Android**, while MAE
  falls from **0.0312 to 0.0138**. The fresh all-screen rerun raises the complete
  physical benchmark to **87.77% / 87.70%** and mean color similarity to
  **96.75%** on both hosts; the separately reconstructed official-manual Modes
  variant remains scoped and unchanged.
- Reconstructed the Grid contextual menu's visible FILE section with six
  purpose-built SVG action glyphs, embedded device typography, measured icon
  and label spacing, the physical `#101010` panel, and its visible scroll track.
  Structural match rises from **82.79% to 88.61% Windows / 82.91% to 88.65%
  Android**, while MAE falls from **0.0429 to 0.0315**. A fresh 40/40 dual-host
  run raises the complete physical benchmark to **87.41% / 87.35%**, with
  **96.70%** mean color similarity on both clients and no regression in the
  closed Grid or other menu interactions.
- Reconstructed the scrolled output-route selector using the physical panel
  color, capitalization, embedded typography, 32-pixel route symbols, and exact
  left alignment, then corrected the repeated 10-pixel vertical offset after
  the `OTHER` heading. Structural match rises from **82.54% to 89.59% Windows /
  82.46% to 89.59% Android**, while MAE falls from **0.0259 to 0.0211**. The
  combined 40-state rerun, which also includes the scene-selector work below,
  reaches **87.27% / 87.20%** structural match and **96.67%** mean color
  similarity on both hosts with no missing render.
- Rebuilt the Grid scene selector around its physical open state: a dark active
  row, 24-pixel scene badges, exact content padding, embedded device typography,
  an open-state grey header badge, and no browser hover/focus decoration. Its
  structural match rises from **82.58% to 90.63% Windows / 82.50% to 90.53%
  Android**, and MAE falls from **0.0483 to 0.0359** on both. The complete
  physical benchmark now reaches **87.09% / 87.02%**, with **96.66%** mean
  color similarity on both hosts; a fresh 40/40 dual-host rerun verifies that
  the closed Grid and the other 38 states remain unchanged.
- Reconstructed physical SCENE Gig View from sampled framebuffer colors and
  geometry. The shared renderer now exposes the large A-H background letters
  that a later host stylesheet had suppressed, uses exact per-tile background
  and letter colors, replaces Unicode approximations with edit/swap/copy SVG
  controls, embeds the device font, and aligns the title and scene labels.
  Structural match rises from **81.89% to 90.47% on Windows** and from **81.85%
  to 90.18% on Android**, while MAE falls from **0.0416 to 0.0310** on both.
  A fresh all-screen rerun confirms the other 39 physical states are unchanged
  and raises the complete benchmark to **86.89% / 86.82%**, with **96.63%**
  mean color similarity on both hosts.
- Matched the physical Virtual Device browser's inset Guitar/Bass tabs,
  60-pixel model-row cadence, panel colors, text padding, and favorite-pin
  spacing. Its tipped state rises from **82.86% to 85.90% Windows / 82.84% to
  85.87% Android**, and the clean state from **82.12% to 85.47% / 82.10% to
  85.45%**. Copy/Swap Scene now use the embedded device font, omit the false
  desktop shadow, and reproduce the short first-row Grid cell; Copy reaches
  **82.53% / 82.54%** and Swap **82.59% / 82.61%**. The fresh 40-frame
  benchmark is **86.67% Windows / 86.61% Android**, with **96.61% / 96.60%**
  mean color similarity. Physical-corpus capture tools also accept an optional
  `QC_CAPTURE_IDS` filter and report the actual capture count, making focused
  parity work deterministic without weakening full-corpus verification. The
  complete **85-state / 170-frame** dual-host smoke pack was regenerated after
  these changes and completed without a missing or mis-sized framebuffer.
- Embedded the exact Roboto face used by Preset MIDI Out instead of relying on
  the host operating system's font inventory, then matched its header, load-dot,
  footswitch, and expression-pedal geometry. Physical MIDI Out rises from
  **81.63% to 86.75% on Windows** and from **81.53% to 86.65% on Android**;
  the independent official reference reaches **86.88% / 86.78%**. A fresh
  all-screen rerun raises the complete physical benchmark to **86.47% / 86.41%**
  and the 36-frame official benchmark to **84.81% / 84.74%**, while retaining
  **96.57% / 96.52%** mean color similarity respectively. The font is scoped so
  the already-tuned TopBoost and Save As typography remains unchanged, and the
  85-state smoke pack again completes all **170/170** exact dual-host captures.
- Removed renderer-only row separators and matched sampled CorOS surfaces in
  Preset Directory, the plugin list, and Virtual Device preset browsers.
  Preset Directory rises from **79.37% to 85.49% Windows / 79.00% to 85.00%
  Android**; the plugin list reaches **85.87% / 85.84%**; Exotic Z Boost reaches
  **90.42% / 90.49%**; User presets reach **89.82% / 89.91%**; and preset
  actions reach **96.06% / 96.05%**. Reconstructed Ambience's actual two-row
  proportions, stepped Size control, filter angles, and value baselines raise it
  from **78.92% / 78.87%** to **87.31% / 87.26%**. Equivalent measured editor
  corrections raise Digital Flanger to **81.61% / 81.55%** and TopBoost to
  **86.27% / 86.22%**. Canonical Gig View mode glyphs and exact vertical tile
  gaps improve all four measured Gig states, while Scene prompt underlays now
  use the real STOMP mark and header geometry. The complete physical benchmark
  is now **86.35% Windows / 86.28% Android**, with **96.57%** color similarity.
  The independent 36-frame official benchmark also improves to **84.67% /
  84.60%**; its Virtual Device preset screen reaches **88.56% / 88.62%**.
- Fixed the focused capture utility so `preset-directory` opens and captures
  the actual Directory state rather than silently measuring Grid. The full
  dual-host rerun still captures all **40/40** physical states and reports no
  per-screen regressions against the preceding checkpoint.
- Rebuilt the UK C30 cabinet header around the physical control geometry and
  aligned its parameter-value cadence, speaker targets, and title treatment.
  The cabinet editor rises from **77.97% to 84.34% on Windows** and from
  **77.93% to 84.29% on Android**. Save As rises from **77.87% / 77.79%** to
  **84.10% / 84.05%** after reconstructing its folder/list rows and header.
  The Copy and Swap Scene prompts now include their actual Grid underlay state,
  normal dialog typography, preset-letter coloring, and header spacing; Copy is
  **78.99% / 78.87%** and Swap is **79.13% / 79.02%**. Together these changes
  raise the complete 40-frame physical benchmark to **84.78% Windows / 84.72%
  Android**, while retaining **96.46%** mean color similarity on both hosts.
- Reconstructed the Parametric-8 logarithmic graph from measured physical
  coordinates, including its full-width frequency grid, unequal active/inactive
  nodes, axis labels, stacked-EQ mark, and power glyph. Its structural match
  rises from **75.50% to 88.88% on Windows** and from **75.45% to 88.89% on
  Android**. Replacing the false white selected-block rectangle with CorOS's
  category-colored in-place border also improves Simple Gate, Chief DS1,
  TopBoost, and Ambience. Matching the two-row Flanger value cadence and its
  independent lower-row dial offset raises that editor from **75.29% / 75.24%**
  to **79.46% / 79.41%**. The complete 40-frame benchmark is now **84.41% /
  84.35%**, with **96.46%** color similarity on both hosts.
- Strengthened the executable coverage proof: all **103/103** canonical states
  now have a verified exact-size capture path on both Windows and Android. The
  general smoke pack covers 84 states; the remaining 19 are exercised by the
  physical-device or official-manual dual-host regression packs. This corrects
  the prior report's undercount without inflating authoritative evidence, which
  is now correctly counted as **58** states.
- Expanded the authoritative physical corpus from **39 to 40** frames with the
  Mixer editor and corrected the routing-state taxonomy against the official
  manual and a guarded physical probe. CorOS opens the temporary S/M placement
  handles inside the routing editor; it does not show the previously mocked
  instructional choice page. Replacing that mock and the generic Mixer renderer
  raises Mixer from **14.22% to 87.46% Windows / 87.37% Android**, while shared
  Grid and header corrections raise Splitter from **83.74% / 83.67%** to
  **85.42% / 85.34%**. The evidence ledger has **58** authoritative
  canonical states. Across the expanded 40-frame denominator, the physical
  benchmark is **83.95% / 83.89%** with **96.44%** color similarity on both
  hosts. The preset was recalled after the probe and its clean Grid framebuffer
  matched the pre-probe SHA-256 exactly.
- Aligned model-specific dial centers with the physical parameter editors and
  removed the false selection ring from the bypassed Flanger. TopBoost rises
  from **76.90% to 81.75%**, Ambience from **76.02% to 78.75%**, Chief DS1
  from **83.19% to 85.87%**, Simple Gate from **84.91% to 85.88%**, and
  Digital Flanger from **74.76% to 75.29%** on Windows, with equivalent
  Android gains. At that intermediate checkpoint, the physical benchmark was
  **83.82% Windows / 83.76% Android**.
- Removed frames that the physical ModelMenu does not draw around unselected
  category glyphs, raising its tipped/clean states from **76.05% / 75.00%** to
  **82.81% / 82.06%** on Windows (82.79% / 82.04% on Android). Matching the
  measured STOMP tile colors and icon/text geometry raises physical Gig View
  from **77.07% to 87.00%** and Live Tuner Gig View from **78.32% to 87.38%**.
  The complete physical benchmark is now **83.51% Windows / 83.45% Android**;
  the refreshed official benchmark is **84.51% / 84.44%**. A new focused
  capture utility makes individual 800x480 screen iterations reproducible on
  both hosts without regenerating the entire corpus.
- Matched the physical Virtual Device preset-browser header cadence and row
  controls, lifting Exotic Z Boost from **74.75% to 80.30%**, preset actions
  from **80.91% to 85.83%**, and User presets from **80.85% to 84.60%** on
  Windows, with equivalent Android gains. Rebuilding the Parametric-8 axis,
  mode offsets, completion control, and EQ dial arc raises it to **75.50%**;
  correcting the bypassed-editor hierarchy raises Digital Flanger to
  **74.76%**. That pass brought the physical benchmark to **82.65% Windows /
  82.59% Android**, with **96.25%** mean color similarity on both hosts.
- Separated the physical plugin-model browser from the unrelated Directory
  Plugin Folders renderer, closing a route alias that the freshly regenerated
  physical corpus exposed. The licensed and missing-license model screens now
  score **90.56%** and **90.58%** on Windows (90.53% / 90.56% on Android), and
  the then-current physical benchmark rose to **82.16% / 82.10%**. The shared smoke
  corpus now contains **85 states / 170 exact host captures**.
- Added an executable evidence ledger for all **103/103** canonical device
  states. It verifies exact inventory membership, shared renderer routing,
  reference IDs, and dual-host capture routes; **58** states currently have
  authoritative physical/manual image evidence and all **103** have verified
  Windows plus Android capture paths (84 through the general smoke pack and 19
  through the physical or official regression packs). Correcting full-width action columns raises Directory
  IRs from **78.25% to 88.68%** and removing false row separators raises Cloud
  Upload from **75.47% to 88.80%** on Windows. Adding USB channel selectors and
  combo-output geometry lifts USB I/O to **79.50%** and Analog I/O to
  **80.13%**. Together these changes move the complete official benchmark to
  **84.33% Windows / 84.26% Android**.
- Raised the complete official-reference benchmark from **82.40% to 83.60% on
  Windows** and from **82.33% to 83.54% on Android**. Favorites now reproduces
  its heart/recents toolbar, full-size row actions, and alphabet index and rises
  to **88.38%**; Nested Captures gains its true folder-tree view and reaches
  **87.22%**. Correcting the accumulating one-pixel Presets cadence raises it to
  **79.02%**, Cloud Upload's repeated action-column offset to **75.47%**, Capture
  Settings to **81.76%**, and Empty Slot to **82.99%**.
- Advanced the complete official-reference benchmark from **81.90% to 82.40%
  on Windows** and from **81.84% to 82.33% on Android**. Reconstructing the
  missing Latch Emulation column raises Expression Bypass to **80.16%**;
  rebuilding the Plugin Devices underlay header raises it to **79.28%**; and
  independently aligning the two Global Bypass device rows raises Device
  Settings to **82.59%**. Directory Search Results also improves from 83.43%
  to **85.21%** through shared row alignment.
- Raised the freshly rendered official-reference benchmark again, from
  **80.02% to 81.90% on Windows** and from **79.94% to 81.84% on Android**.
  Measured geometry corrections bring System Settings to **90.03%**, SCENE to
  **86.90%**, HYBRID to **86.62%**, STOMP to **84.79%**, the Amp browser to
  **80.85%**, Looper to **80.45%**, Global EQ to **80.04%**, Analog I/O to
  **79.01%**, and USB I/O to **78.11%** on Windows. Matching scene colors also
  raises the corpus-wide color similarity from 96.11% to **96.40%**.
- Raised the full official-reference benchmark from **77.77% to 80.02% on
  Windows** and from **77.70% to 79.94% on Android**, with every one of the 36
  mapped full-size frames freshly rendered at 800x480. Account Settings now
  reaches **93.09%**, Virtual Device presets **79.23%**, STOMP Gig View
  **78.53%**, Plugin folders **78.33%**, and Device Settings **75.48%** on
  Windows. The retained changes were selected by measured regression runs;
  geometry experiments that reduced the score were reverted.
- Raised the official 36-screen benchmark from **66.56% to 77.77% on
  Windows** and from **66.50% to 77.70% on Android**. MIDI Settings now reaches
  **96.08%**, PRESET Gig View **95.61%**, Capture Metadata **81.01%**, Plugin
  Presets **80.78%**, and Capture Settings **76.99%** on Windows.
- Added content-specific official variants where the manual intentionally shows
  a different preset or interaction state from the physical scratch corpus.
  Brit 2203 Grid reaches **83.33%**, Modes Configuration **82.58%**, and Virtual
  Device preset actions **86.45%**, while the physical fixtures remain separate.
- Corrected Directory bank sizing, upload-toolbar placement, Plugin Preset
  chrome, I/O port artwork, USB metering, and MIDI row geometry. Presets now
  measures **68.26%**, Cloud Upload **63.51%**, Plugin Presets **80.78%**,
  Analog/USB I/O **72.65% / 73.88%**, and MIDI Settings **96.08%** on Windows.

- Rebuilt seven Directory references with their actual two- and three-pane
  content instead of generic placeholder folders. Search reaches **83.43%**,
  Captures **82.68%**, IRs **77.70%**, Nested folders **77.31%**, Favorites
  **76.56%**, Plugin Presets **68.57%**, and Presets **49.80%**.
- Split official manual examples from physical scratch-preset fixtures where
  their content genuinely differs. Amp Browser rises from 27.65% to **72.93%**
  and Plugin Devices from 30.16% to **60.04%**, without changing the existing
  physical plugin regression states.
- Added content-accurate official Gig View variants while retaining the live
  physical PRESET/SCENE/STOMP renderers. The official modes now measure
  **66.62% PRESET, 79.13% SCENE, 70.36% STOMP, and 62.17% HYBRID**.
- Corrected the I/O port topology from ten flattened controls to twelve
  physical columns with paired jacks. Analog I/O rises to **55.06%** and USB
  I/O to **51.50%**. Further EQ and Looper tuning raises those screens to
  **44.60%** and **56.82%**, and Capture Calibration reaches **68.95%**.
- Across these changes, the official-manual benchmark advances from **37.78%**
  at import to **66.56% Windows / 66.50% Android**, with **95.24%** mean color
  similarity on both hosts.
- Reconstructed the four official Neural Capture V1 frames as their actual
  device layouts rather than a generic wizard. Calibration/Settings rises from
  20.24% to **40.22%**, Training from 16.79% to **82.97%**, A/B from 16.41% to
  **50.35%**, and Metadata from 13.33% to **56.82%** structural match.
- Rebuilt four additional low-scoring official states with screen-specific
  shared layouts: Expression Bypass rises from 11.12% to **76.72%**, Empty Slot
  from 11.89% to **51.47%**, MIDI Settings from 18.33% to **49.31%**, and Plugin
  Folders from 19.03% to **72.56%**. Together with the Settings and I/O work,
  the 36-screen official benchmark rises from 37.78% at import to **52.63%** on
  Windows and **52.59%** on Android.
- Imported every native 800x480 UI frame exposed by the official CorOS 4.1
  manual into a reproducible, checksummed corpus: 37 source frames, 36 mapped
  full-size Quad Cortex comparisons, and one explicitly separated Quad Cortex
  mini frame. Both applications render all 36 mapped screens at exact native
  size. This converts broad manual-only coverage into measurable visual debt.
- Rebuilt the Account, System/Brightness, and Device/Global Bypass Settings
  screens around their official geometry and content. Their Windows structural
  matches rose from 13.01%, 16.47%, and 19.60% to **60.51%, 76.50%, and
  71.40%** respectively (Android is effectively identical), lifting the whole
  36-screen official corpus from 38.39% to **42.81%** on Windows.
- Corrected I/O editor and Global EQ vertical geometry against native official
  frames. Analog I/O rose from 37.65% to **45.53%**, USB I/O from 37.44% to
  **43.43%**, and Global EQ from 28.71% to **36.59%** on Windows.
- Captured the Live Tuner preference enabled on the physical Tuner and the
  resulting Gig View state, then restored Live Tuner to No and verified the
  scratch preset remained clean. The shared renderer now switches the correct
  radio state and reproduces the otherwise easy-to-miss 16-pixel dormant live
  tuner band. The new states measure 90.92% / 90.67% and 78.32% / 78.27%
  structural match on Windows / Android. This expands the canonical inventory
  to 103 states, the physical corpus to 38, and the manual host corpus to 83
  states / 166 exact captures.
- Captured the physical Tempo & Metronome screen through the documented double
  Tap Tempo MIDI gesture, including its scene selector, beat indicators, two-row
  control panel, dial geometry, and exact transient BPM. Replacing the compact
  manual approximation raises structural match from 32.94% to 90.43% on Windows
  and from 32.90% to 90.33% on Android. The capture tool now supports immediate
  framebuffer draining and guards both preset identity and dirty state during
  touchscreen probes. The physical corpus expands from 35 to 36 states.
- Added the physical Virtual Device preset row-action menu and the empty User
  preset tab as ED-16 and ED-17. Their shared reconstructions measure 80.91% /
  80.93% and 80.85% / 80.94% structural match on Windows / Android. Matching
  the modal dim layer cut the action-menu mean pixel error from 7.00% to 3.20%.
  This expands the canonical inventory to 102 states, the physical corpus to 35,
  and the manual host corpus to 82 states / 164 exact 800x480 captures.
- Discovered and added DB-09 rather than freezing the inventory at 99 rows: the
  physical locked-plugin branch includes the license-not-found header, selected
  locked suite, Cory Wong model list, and per-model lock overlays. It measures
  71.78% on Windows and 71.76% on Android, expands the canonical inventory to
  100 states, and expands physical regression coverage from 32 to 33 states.
- Captured the physical Exotic Z Boost Virtual Device Preset browser without
  selecting a preset or adding a block. Replacing the generic manual fixture
  with its exact category, device, tab, and factory-preset data raises this
  screen from 45.08% to 74.75% on Windows and from 45.17% to 74.81% on Android,
  while physical regression coverage expands from 31 to 32 states.
- Opened the licensed Archetype: Plini X device folder without selecting or
  adding a model, captured its physical three-column browser, and reconstructed
  the exact plugin/model rows on both hosts. Reusing the verified CorOS block
  sprite raises the reconstruction to 72.23% Windows / 72.20% Android and
  expands physical coverage to 31 states.
- Captured the physical Neural DSP plugin-list drawer, including its dimmed Grid
  underlay, two-column navigation, exact licensed-device names, lock states, and
  row geometry. Replacing the prior manual-only approximation raises this screen
  from 17.84% to 79.89% on Windows and 79.87% on Android, and expands physical
  regression coverage from 29 to 30 states.
- Captured the physical Preset MIDI Out editor through a verified, reversible
  Grid-menu path and restored Grid afterward. The capture exposed a 40.62%
  manual-only reconstruction; measured panel, switch, message-target, and pedal
  geometry raise it to 81.63% on Windows and 81.53% on Android. Physical
  coverage expands from 28 to 29 states without modifying the preset.
- Corrected the physical 60-pixel folder-row cadence in Directory and Save As,
  replaced the remaining font-folder approximations with shared numbered SVGs,
  and aligned their overflow columns. Directory rises from 73.41% to 79.37%
  on Windows, while Save As rises from 70.63% to 77.87%.
- Rebuilt the dimmed Grid geometry behind Copy/Swap Scene: its four route rows
  now use the physical 94-pixel cadence and its preset heading has the measured
  size. Copy Scene rises from 72.46% to 77.93% and Swap Scene from 72.63% to
  78.09%, bringing the complete corpus to 81.55% Windows / 81.48% Android.
- Rebuilt the shared Grid header against the physical framebuffer, removed
  nonexistent cables from empty rows, restored empty-row plus controls, matched
  the active-slot target, corrected Simple Gate and overdrive colors, and
  removed Android's decorative bezel from the measured framebuffer. Grid rises
  from 71.82% to 88.26% on Windows and from 71.72% to 88.15% on Android; the
  complete 28-state corpus rises to 80.34% and 80.28% respectively.
- Matched STOMP Gig View's fixed eight-pixel tile grid, bypassed-device panel,
  device-specific colors, edit affordances, adaptive labels, and empty tile.
  Its structural score rises from 73.37% to 77.07% on Windows and from 73.31%
  to 77.02% on Android, lifting the complete corpus to 80.47% and 80.41%.
- Added a repeatable font-family sweep and used measured, screen-local choices
  for Save As and the editor families. Replaced Directory's approximate cloud
  and folder symbols with numbered vector icons and corrected its toolbar
  proportions. Directory rises to 73.41% on Windows and 73.08% on Android; the
  complete corpus reaches 80.63% and 80.58%.
- Aligned Digital Flanger's physical knob centers and header control groups,
  raising it from 71.75% to 72.70% on Windows. Tightened the Copy/Swap Scene
  prompt and button geometry as well; the complete corpus reaches 80.70% on
  Windows and 80.64% on Android.
- Reactivated dormant CorOS framebuffer sessions through a tested, reversible
  Gig View wake/restore handshake. This enabled real Copy Scene and Swap Scene
  destination captures, expanding physical coverage from 26 to 28 states. The
  inferred tile chooser was replaced with the physical footswitch-prompt modal;
  its new Windows matches are 72.04% and 72.21% respectively.
- Corrected three measured cross-screen geometry issues: Digital Flanger's
  two-page header, mono/stereo input-route grouping and scroll position, and
  right-aligned standard-editor dials. Directory tool spacing and typography
  now match the physical layout as well. Input routing rises from 66.98% to
  76.52%, Directory from 67.92% to 71.80%, and the original 26-state Windows
  subset from 74.63% to 75.82% (Android: 74.49% to 75.68%).
- Closed the remaining twelve canonical gaps with dedicated shared states for
  boot and shutdown, Copy/Swap Scene destinations, delete confirmation, global
  input gate/bypass, multi-page/Cab/Parametric EQ/Neural Capture editors, and
  clipping/DSP warnings. This brought renderer coverage to 99 of the now 100
  hosts; physical-reference coverage is separately reported above.
- Added both Recovery Mode states and four reusable system overlays: the
  on-screen keyboard, confirmation, error, and busy/progress states. All six
  have exact-size Windows and Android captures, bringing shared Built coverage
  to 87 of the now 100 states.
- Completed the seven-state Neural Capture V1 workflow on both hosts, including
  introduction, capture type, connection routing, calibration, capture progress,
  A/B comparison, and metadata/save. The state-driven shared renderer adds 14
  exact-size host captures and raised complete canonical coverage to 81 of 100.
- Completed the ten-state Settings family on both hosts. The shared reconstruction
  now covers Account, System, Device, Support, Wi-Fi, update progress, storage and
  factory reset, MIDI, device information, and diagnostics. These add 20 exact-size
  host captures and raised complete canonical coverage to 74 of 100 states without
  changing the separately measured physical-corpus similarity score.
- Completed the 16-row Directory family on both hosts. A single shared
  three-pane renderer now covers category selection, Presets, Neural Captures,
  IRs, Plugin Presets, Favorites/Recent, search entry/results, sort and filter,
  arrange/multiselect, copy destination, nested folders, folder/setlist naming,
  item actions, and Cortex Cloud upload. Fifteen new variants add 30 exact-size
  host captures and raised complete canonical coverage to 64 of 100 states.
- Added the official full-screen Looper X layout, two-column Virtual Device
  Preset browser, save editor, STOMP and Scene assignment views, both Expression
  assignment variants, and block contextual actions. The shared layouts retain
  every control inside the 800x480 framebuffer on both hosts and raise complete
  canonical coverage to 49 of 100 states per host.
- Reconstructed the five previously absent Device Browser states for search,
  Favorites/Recent, plugin folders, licensed/locked plugin devices, and license
  refresh. The plugin layouts are grounded in the official 800x480 CorOS
  screenshots; the refresh and lock behavior follows the 4.1.0 manual. All five
  now have exact-size Windows and Android smoke captures, raising complete
  canonical coverage to 41 of 100 states per host.
- Added four exact-size shared routing fixtures: empty-slot selection, documented
  long-press Splitter/Mixer placement, Splitter parameters, and Mixer parameters.
  They reproduce the official blue `S` and pink `M` tokens, parallel-path
  geometry, conditional Balance splitter controls, and the complete Mixer
  control set. All four are captured on Windows and Android, bringing complete
  canonical coverage to 36 of 100 states on each host at that stage.
- Added the Power & Locking Functions overlay and the Gig View Live Tuner strip
  from their manual references. The lock overlay and Live Tuner are complete;
  shutdown is conservatively Partial until its post-tap state is captured.
- Reconstructed the shared I/O Settings family from the official Analog, USB,
  and Global EQ screen references. The fixed port map is interactive and drives
  dedicated input, output, Send/Return, USB, and headphones editors; Global EQ
  opens from the same header. Seven inventory rows moved to Built on both hosts,
  while global input-gate/bypass behavior moved to Partial because the CPU
  screen exposes its status but not yet its complete editor.
- Added shared, dedicated Tempo & Metronome, Preset MIDI Out, and CPU Monitor
  reconstructions from the official CorOS 4.1.0 manual. All three are routed
  and rendered by both Windows and Android, increasing complete canonical
  coverage from 20 to 23 of 100 states on each host. These manual-reference
  screens are smoke-captured separately and do not inflate the 36-state
  physical-corpus score.
- Replaced the unrelated generic demo data in visual tests with a shared,
  versioned fixture matching `32H pyquadcortex scratch`, its seven blocks,
  STOMP assignments, active scene, routes, and bank 32 directory contents.
- Expanded Android automation from five hand-picked views to all 36 captured
  states, including selectors, menus, browsers, seven block editors, and all
  captured Gig View modes.
- Expanded Windows automation to the same 36 states and added an isolated
  native-size capture layout, eliminating chassis scaling from CorOS metrics.
- Added a whole-corpus comparator that emits per-screen overlays, differences,
  edge visualizations, JSON, Markdown, missing-render detection, and aggregate
  metrics.
- Corrected modal dimming and route-picker dimensions. This reduced whole-corpus
  Android MAE from 0.1084 to 0.0597 in one pass.
- Rebuilt the Parametric-8 graph geometry and control row, raising its Android
  edge score from 40.55% to 51.62%.
- Corrected Tuner scale and footer geometry, raising its Android edge score from
  46.48% to 90.52%.
- Corrected Directory bank/folder data and typography, raising its Android edge
  score from 50.64% to 67.65%.
- Corrected PRESET and SCENE Gig View content and placement. PRESET rose from
  56.52% to 81.99%; SCENE now measures 80.71%.
- Captured the physical Edit Details flow, identified its actual state as a
  preset-name keyboard editor, implemented it once in the shared renderer, and
  added it to both complete-host capture runs. Keyboard and header alignment now
  measure 84.4% on both hosts.
- Replaced generic parameter fixtures with the physical model-specific control
  sets, values, units, toggles, bypass state, and one/two-row layouts. Simple
  Gate now measures 80.3%, Chief DS1 76.7%, and Ambience 70.5% on Windows.
- Replaced browser text glyphs with shared vector category/preset icons and
  corrected its two physical surface colors. Browser root rose to 81.1%.
- Rebuilt the EQ frequency grid with its physical logarithmic line positions;
  Parametric-8 rose from 51.7% to 72.6%.
- Added the Cab parameter bars, mirrored microphone placement, phase and enable
  controls; Cab rose from 64.8% to 78.0%.
- Matched the contextual-menu row rhythm and the captured route-list scroll
  states. Grid menu rose from 64.0% to 74.7%, and output routing to 73.4%.

## Device synchronization

Tuner, Modes Configuration, and Save As have reversible physical commands with
graphics-tree readback. Tuner uses MIDI CC #45. Modes Configuration uses a
verified long press on the mode indicator. Save As opens through the physical
Grid menu and closes through its close control. The Windows reconstruction only
changes to those screens after the gateway confirms the corresponding graphics
tree marker.

The latest confirmed device tree is the Grid. A fresh connection can leave the
framebuffer broadcast dormant even while graphics-tree reads remain available;
the gateway now wakes that stream by briefly opening Gig View, captures a frame,
then restores Grid. This reversible handshake was verified on the device and is
covered by a gateway test. No preset content was changed.

## Remaining priorities

1. Expand physical references from 40 toward all 103 cataloged CorOS states.
2. Rebuild the remaining lowest-scoring official states: Directory upload,
   Account Settings, Directory presets, Virtual Device presets, STOMP/HYBRID
   Gig View, Global EQ, and plugin-device icon details.
3. Replace placeholder glyphs with traced or source-equivalent CorOS icons.
4. Deepen specialized EQ, Cab, splitter, mixer, Looper X, assignment, Directory,
   Settings, Neural Capture, lifecycle, and recovery interactions beyond their
   complete static screen compositions.
5. Add visual thresholds once deliberately variable content and font rendering
   have per-family tolerances.

## Reproduce

Run either host, capture its corpus, then compare:

```powershell
$env:CODEX_WORKSPACE_NODE_MODULES = '<bundled-or-installed-node-modules>'
$env:QC_BROWSER_EXECUTABLE = '<chromium-or-edge-executable>'
node tools/capture_android_ui.mjs http://127.0.0.1:5173/ .artifacts/ui-android-corpus
node tools/capture_windows_ui.mjs http://127.0.0.1:1420/ .artifacts/ui-windows-corpus
python tools/compare_qc_ui_corpus.py --coros 4.1.0 --renderer .artifacts/ui-android-corpus --output .artifacts/ui-diff/android-corpus --require-all
python tools/compare_qc_ui_corpus.py --coros 4.1.0 --renderer .artifacts/ui-windows-corpus --output .artifacts/ui-diff/windows-corpus --require-all
```

## Focused port onto the native shared architecture

The corpus renderer is now an optional, query-selected layer in the current
shared `@ndsp-qc/ui` surface. Normal Windows and Android launches retain the
Rust/native live-state and workflow ownership from `codex/parity-hardening`;
`?fixture=coros410&screen=<renderer>` selects deterministic reconstruction data
for capture and comparison only. Legacy layout rules and measured color
literals are isolated under `.qc-screen-fixture-root`, so they cannot override
the live Grid.

Fresh 800×480 captures from this port verified all 36 mapped official-manual
frames on both hosts. Windows measures 89.60% edge F1 and 97.04% color match
(MAE 0.0296); Android measures 88.54% edge F1 and 96.87% color match (MAE
0.0313). The general interaction harness also completes all 40 physical-corpus
captures on both hosts. Its current architecture-port baseline is 71.17% edge
F1 / 92.47% color on Windows and 69.96% / 92.37% on Android; the gap is
concentrated in the modern parameter editor, route picker, Directory, and Grid
menus, while the isolated screen fixtures remain close to the pass-131 corpus.
