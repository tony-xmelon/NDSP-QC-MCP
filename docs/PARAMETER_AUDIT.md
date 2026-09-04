# Quad Cortex parameter-screen audit

The Windows client verifies its shared parameter renderer against the generated
pyquadcortex protocol registry and the connected QC's complete ModelRepo XML
rather than maintaining a handwritten checklist.
The audited fixture is `docs/reference/qc-parameter-catalog.json`; regenerate it
with `tools/parameter-audit/extract_catalog.py` from the source checkout recorded
in the fixture's provenance block.

## Audited coverage

- 272 mapped factory and legacy device models
- 279 distinct parameter sets
- 2,376 ordered parameters
- 18 device categories
- All 11 published catalog control kinds

The live scale baseline in `docs/reference/qc-live-parameter-scales.json` adds:

- 633 models currently installed on the reference QC, including plugins
- 8,851 resolved parameter records after ModelRepo clone inheritance; 6,903
  belong to visible effects and 4,570 are controls on their parameter screens
- Exact ModelRepo `displayPos` placement and declared control `type`
- Exact linear, numeric-skew, logarithmic, enum and dynamic-list classification
- Symbolic CorOS ranges, endpoint labels, precision hints and integer formatting
- 164 `toggleOn` and 122 `toggleOff` dependencies, including 14 effective
  multi-position `toggleStep` rules
- 37 explicit expression-assignment exclusions and 44 linked scene-mode pairs
- Zero unresolved scales, with five-point forward/inverse round-trip tests for
  every continuous parameter

Every model is checked for ordered and unique parameter indexes, non-empty names,
a type-correct control renderer, a valid display value and increment, complete
pagination without omissions or duplicates, no more than ten physical encoder
assignments per page, and matching visible tab counts.

The 4,570 parameter-screen controls use the eight ModelRepo types that are
directly positioned on the reference QC: 3,932 `float`, 152 `rotarySwitch`, 360 `switch`, 45 `comboBox`,
48 `fader`, 27 `grMeter`, two `floatWithLed`, and four `toggleButton` controls.
Each type has explicit handling:

- `float` — `parameterView` continuous knob, N30 inner face and category track
- `floatWithLed` — the same continuous knob plus its independent live indicator;
  the threshold value itself never lights that indicator
- `rotarySwitch` — stepped knob with one round scale point per option
- `switch` — the official vertical two- or three-position switch and labels
- `comboBox` — 140-by-32 compact, left-aligned `parameterComboBox`
- `string` — the same selector chrome, populated by the device's dynamic list
- `toggleButton` — 120-by-32 `outputMuteSoloTextButton` action control
- `fader` — 30-by-157 vertical `eqSlider`, with value above and name below
- `grMeter` — 90%-wide, 8-pixel read-only yellow gain-reduction meter

## Visual source verification

The following shared layouts and styles were read directly from the installed
Neural DSP Cortex Control resources and compared against the renderer. Percent
bounds are relative to one standard parameter cell.

| ModelRepo type | Official resource | Verified visual facts |
| --- | --- | --- |
| `float` | `parameterView.xml` / `parameterKnob` | knob x 56%, y 37%, 62x62; N30 face; three-pixel track; four-pixel marker |
| `floatWithLed` | `parameterView.xml` plus live `ledValue` | standard knob geometry; independent signal state, never inferred from the threshold setting |
| `rotarySwitch` | `parameterView.xml` stepped knob | standard knob footprint; discrete circular positions rather than a continuous arc |
| `switch` | `parameterView.xml` / `parameterSwitch` | x 6%, y 40%, width 13.5%, height 48%; labels begin x 25%; three-way variant y 30%, height 58% |
| `comboBox` | `parameterView.xml` / `parameterComboBox` | centered 140x32 selector; six-pixel corners; N20 background; left text; 16x16 white arrow |
| `string` | `comboBoxView.xml` / `parameterComboBox` | identical selector styling; device-provided dynamic item order |
| `toggleButton` | `parameterView.xml` / `outputMuteSoloTextButton` | centered 120x32 button; six-pixel corners; no border; N20 off and N40 on |
| `fader` | `sliderView.xml` / `eqSlider` | centered 30x157 vertical control; two-pixel black track; 24-pixel thumb; value y 3%, name y 87.5% |
| `grMeter` | `grMeterView.xml` / `gainReductionMeter` | name y 5%, value y 58%, meter x 5%, y 86%, width 90%, height 8px; N20 background and pitch yellow fill |

Palette values are also taken from the embedded official skin: N20 `#121212`,
N30 `#1e1e1e`, N40 `#2e2e2e`, N90 `#ababab`, white `#ffffff`, pitch
yellow `#ffd236`, and success green `#45f862`.

The generic control geometry is verified against Cortex Control's embedded
official layouts: `parameterView`, `switchView`, and `comboBoxView`. Two- and
three-position switches are vertical and expose clickable value labels;
`rotarySwitch` remains a stepped knob even when it has many labels; combo boxes
use the compact centered selector; and `toggleButton` uses the dedicated
rectangular action button rather than switch artwork.

Dependent controls are evaluated from the active scene's current controller
value. Binary and multi-position conditions combine as declared by ModelRepo;
disabled controls retain the normal cell background while their label, value,
and control artwork dim and cannot be edited. `rotarySwitch` controls use one
round scale mark per declared step rather than a continuous arc. For example,
Flangerish RATE is enabled only while SYNC is Off, and its 17-position SYNC NOTE
knob is enabled only while SYNC is On.

String-valued dynamic lists, including cab, microphone, IR and capture selectors,
are normalized for the UI and written back through `qc-protocol`'s native Rust
text-parameter path. The Python path remains a parity oracle for regression tests.

Dedicated full-screen coverage is audited separately from the shared ten-encoder
layout. Cab exposes both microphone channels and its HPF/LPF/output EQ tab. IR
Loader exposes each impulse's power, phase, dynamic IR selector, five channel
controls, and the room/global-output page. Looper X Params mode is kept as the
manual's three five-control pages. Parametric and Graphic EQ screens are checked
to ensure every band and auxiliary control remains reachable; this includes the
ten-control Plugin Parametric-4 layout.

## Authority and limits

The connected Quad Cortex remains authoritative for model availability, ranges,
skew curves, step counts, labels, dynamic option lists, plugin devices and
current values. The gateway now parses all of those fields from the same raw
ModelRepo XML used by CorOS/Cortex Control. It no longer reduces the XML to only
minimum and maximum values, and no unit-valued write falls back to a guessed
normalized value.

Neural DSP does not publish screenshots for every individual parameter screen.
Therefore this audit proves complete functional rendering coverage, but it does
not claim independent pixel comparison for screens for which no official image
or live-device capture exists. Officially documented special screens keep their
dedicated renderers; all other devices use the verified shared CorOS editor.
