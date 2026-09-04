# Quad Cortex UI reconstruction inventory

Baseline: CorOS 4.1.0 / Cortex Control 4.1.0
Inventory date: 2026-09-04

This is the canonical coverage ledger for the reconstruction project. The
40-image physical corpus is a measured working subset, not the complete list of
Quad Cortex screens. The inventory is derived from every UI-bearing section and
figure in the official 4.1.0 user manual. Hardware diagrams, cable diagrams,
logos, and purely explanatory illustrations are excluded.

The executable companion ledger at
`references/qc-ui-coverage/coros-4.1.0/coverage.json` maps every row below to
its shared renderer and exact physical, official-manual, or dual-host smoke
evidence. Run `npm run verify:coverage` to reject missing, duplicate, stale, or
unrouted entries.

Status vocabulary:

- **Built**: a dedicated in-screen reconstruction exists.
- **Partial**: the family exists, but an important mode, control, or state is
  absent or approximate.
- **Shell**: the app exposes the operation in its own UI, but does not reproduce
  the CorOS screen.
- **Missing**: no reconstruction exists.
- **Capture**: a physical 800x480 reference exists in the local corpus.
- **Official**: a native 800x480 Quad Cortex frame from the official 4.1.0
  manual exists in the local, checksummed reference corpus. `Capture + Official`
  means both independent references exist.

Android refers to the buildable responsive React application in this checkout,
which embeds the same `@ndsp-qc/ui` surface as Windows. Its rows are verified
from that shared renderer and the Android build rather than inferred from a
placeholder or a separate prototype.

## Device screen and interaction states

| ID | Family | Canonical screen or state | Reference | Windows | Android |
| --- | --- | --- | --- | --- | --- |
| GL-01 | Lifecycle | Power-on / boot progress | Manual | Built | Built |
| GL-02 | Lifecycle | Power-off confirmation | Manual | Built | Built |
| GL-03 | Lifecycle | Screen lock / power overlay | Manual | Built | Built |
| GL-04 | Grid | Clean preset Grid | Capture | Built | Built |
| GL-05 | Grid | Modified preset Grid | Capture | Built | Built |
| GL-06 | Grid | Alternate active scene | Capture | Built | Built |
| GL-07 | Grid | Scene selector | Capture | Built | Built |
| GL-08 | Grid | Grid contextual menu | Capture | Built | Built |
| GL-09 | Preset | Save As editor | Capture | Built | Built |
| GL-10 | Preset | Edit Details / preset name editor | Capture | Built | Built |
| GL-11 | Preset | Copy Scene destination | Capture | Built | Built |
| GL-12 | Preset | Swap Scene destination | Capture | Built | Built |
| GL-13 | MIDI | Preset MIDI Out | Capture + Official | Built | Built |
| GL-14 | Preset | Delete confirmation | Manual | Built | Built |
| GL-15 | Performance | Tuner | Capture + Official | Built | Built |
| GL-16 | Performance | Live tuner / Gig View tuner | Capture | Built | Built |
| GL-17 | Performance | Tempo & Metronome | Capture + Official | Built | Built |
| GL-18 | Performance | Modes Configuration | Capture + Official | Built | Built |
| GL-19 | Gig View | PRESET mode | Capture + Official | Built | Built |
| GL-20 | Gig View | SCENE mode | Capture + Official | Built | Built |
| GL-21 | Gig View | STOMP mode | Capture + Official | Built | Built |
| GL-22 | Gig View | HYBRID mode | Official | Built | Built |
| GL-23 | Monitoring | CPU Monitor | Manual | Built | Built |
| GL-24 | Performance | Tuner with Live Tuner enabled | Capture | Built | Built |
| IO-01 | I/O | I/O Settings overview | Manual | Built | Built |
| IO-02 | I/O | Analog input detail | Official | Built | Built |
| IO-03 | I/O | Analog output detail | Manual | Built | Built |
| IO-04 | I/O | Send/Return detail | Manual | Built | Built |
| IO-05 | I/O | USB I/O detail | Official | Built | Built |
| IO-06 | I/O | Headphones detail | Manual | Built | Built |
| IO-07 | I/O | Global EQ | Official | Built | Built |
| IO-08 | I/O | Global input gate and bypass | Manual | Built | Built |
| GR-01 | Routing | Input route selector | Capture | Built | Built |
| GR-02 | Routing | Output route selector | Capture | Built | Built |
| GR-03 | Routing | Splitter/Mixer placement handles | Capture + Manual | Built | Built |
| GR-04 | Routing | Splitter parameter editor | Capture + Manual | Built | Built |
| GR-05 | Routing | Mixer parameter editor | Capture + Manual | Built | Built |
| GR-06 | Grid | Empty-slot target | Official | Built | Built |
| DB-01 | Device browser | Category root | Capture | Built | Built |
| DB-02 | Device browser | Guitar/Bass model list | Capture | Built | Built |
| DB-03 | Device browser | First-use device-preset tooltip | Capture | Built | Built |
| DB-04 | Device browser | Search results | Official | Built | Built |
| DB-05 | Device browser | Favorites / Recent models | Manual | Built | Built |
| DB-06 | Device browser | Plugin device folders | Capture | Built | Built |
| DB-07 | Device browser | Plugin device list / license state | Capture | Built | Built |
| DB-08 | Device browser | Plugin refresh state | Manual | Built | Built |
| DB-09 | Device browser | Locked plugin / license-not-found models | Capture | Built | Built |
| ED-01 | Editor | Standard rotary parameter editor | Capture | Built | Built |
| ED-02 | Editor | Multi-page parameter editor | Manual | Built | Built |
| ED-03 | Editor | Cab editor | Capture | Built | Built |
| ED-04 | Editor | Parametric EQ editor | Capture | Built | Built |
| ED-05 | Editor | Neural Capture block editor | Manual | Built | Built |
| ED-06 | Editor | Looper X editor | Official | Built | Built |
| ED-07 | Editor | Virtual Device preset browser | Capture + Official | Built | Built |
| ED-08 | Editor | Save Virtual Device preset | Manual | Built | Built |
| ED-09 | Assignment | STOMP assignment | Manual | Built | Built |
| ED-10 | Assignment | Scene assignment / scene-safe controls | Manual | Built | Built |
| ED-11 | Assignment | Expression parameter assignment | Manual | Built | Built |
| ED-12 | Assignment | Expression bypass assignment | Official | Built | Built |
| ED-13 | Editor | Block contextual actions | Manual | Built | Built |
| ED-14 | Grid | I/O clipping warning | Manual | Built | Built |
| ED-15 | Grid | DSP/side-chain limit warning | Manual | Built | Built |
| ED-16 | Virtual Device preset | Factory preset row actions | Capture + Official | Built | Built |
| ED-17 | Virtual Device preset | Empty User preset tab | Capture | Built | Built |
| DR-01 | Directory | Category chooser | Manual | Built | Built |
| DR-02 | Directory | Presets browser | Capture + Official | Built | Built |
| DR-03 | Directory | Neural Captures browser | Official | Built | Built |
| DR-04 | Directory | Impulse Responses browser | Official | Built | Built |
| DR-05 | Directory | Plugin Presets browser | Official | Built | Built |
| DR-06 | Directory | Favorites and Recent | Official | Built | Built |
| DR-07 | Directory | Search entry | Manual | Built | Built |
| DR-08 | Directory | Search results | Official | Built | Built |
| DR-09 | Directory | Sort menu | Manual | Built | Built |
| DR-10 | Directory | Filter menu | Manual | Built | Built |
| DR-11 | Directory | Arrange / multiselect mode | Manual | Built | Built |
| DR-12 | Directory | Multiselect copy destination | Manual | Built | Built |
| DR-13 | Directory | Nested folder browser | Official | Built | Built |
| DR-14 | Directory | New folder / setlist editor | Manual | Built | Built |
| DR-15 | Directory | Item contextual menu | Manual | Built | Built |
| DR-16 | Directory | Cortex Cloud upload mode | Official | Built | Built |
| NC-01 | Capture V1 | Capture introduction | Manual | Built | Built |
| NC-02 | Capture V1 | Capture type selection | Manual | Built | Built |
| NC-03 | Capture V1 | Connection and routing | Manual | Built | Built |
| NC-04 | Capture V1 | Calibration settings | Official | Built | Built |
| NC-05 | Capture V1 | Capture process / progress | Official | Built | Built |
| NC-06 | Capture V1 | A/B result | Official | Built | Built |
| NC-07 | Capture V1 | Metadata and save | Official | Built | Built |
| ST-01 | Settings | Account settings | Official | Built | Built |
| ST-02 | Settings | System settings | Official | Built | Built |
| ST-03 | Settings | Device settings | Official | Built | Built |
| ST-04 | Settings | Support settings | Manual | Built | Built |
| ST-05 | Settings | Wi-Fi/network chooser | Manual | Built | Built |
| ST-06 | Settings | Update availability/progress | Manual | Built | Built |
| ST-07 | Settings | Storage and factory reset | Manual | Built | Built |
| ST-08 | Settings | MIDI settings | Official | Built | Built |
| ST-09 | Settings | Device information | Manual | Built | Built |
| ST-10 | Settings | Diagnostics/report flow | Manual | Built | Built |
| RC-01 | Recovery | Recovery Mode entry | Manual | Built | Built |
| RC-02 | Recovery | Recovery options | Manual | Built | Built |
| OV-01 | System overlay | On-screen keyboard / text entry | Manual | Built | Built |
| OV-02 | System overlay | Generic confirmation | Manual | Built | Built |
| OV-03 | System overlay | Error / unavailable state | Manual | Built | Built |
| OV-04 | System overlay | Busy / progress state | Manual | Built | Built |

## Cortex Control-only companion screens

These belong in the Windows reconstruction but are not physical-device CorOS
screens. They are tracked separately so they do not distort physical-screen
coverage.

| ID | Screen | Windows | Android |
| --- | --- | --- | --- |
| CC-01 | Startup / connect device | Built | Built (USB status) |
| CC-02 | Multiple-device chooser | Missing | Not applicable |
| CC-03 | Main Grid workspace | Built | Adapted mobile surface |
| CC-04 | Main Directory workspace | Built | Missing |
| CC-05 | Desktop parameter editor | Built | Adapted in-screen editor |
| CC-06 | Utility bar | Built | Adapted controls |
| CC-07 | Master-volume mismatch | Missing | Missing |
| CC-08 | Device rename | Missing | Missing |
| CC-09 | Neural Capture V2 introduction | Missing | Missing |
| CC-10 | Neural Capture V2 metadata | Missing | Missing |
| CC-11 | Neural Capture V2 calibration | Missing | Missing |
| CC-12 | Neural Capture V2 cloud process | Missing | Missing |
| CC-13 | Neural Capture V2 A/B result | Missing | Missing |
| CC-14 | User-content import | Partial | Missing |
| CC-15 | Local backups | Missing | Missing |
| CC-16 | USB CorOS update | Missing | Missing |

## Totals and interpretation

- **103** canonical device screen/state rows are tracked (GL through OV).
- **16** Cortex Control-only companion rows are tracked separately.
- **40** physical framebuffer captures currently exist; they are the first
  regression pack, not the denominator for total product coverage.
- **37** official native-size manual frames are checksummed locally: 36 full-size
  Quad Cortex screens map to the shared renderer and one Quad Cortex mini frame
  is tracked separately rather than compared to the full-size device.
- **58** canonical states currently have full-frame physical or official-manual
  image evidence, and **78** have either full-frame or scoped official-detail
  evidence. All **103** have a verified exact-size capture path on both
  hosts: 84 through the general smoke pack and the remaining 19 through their
  physical or official-reference regression packs. These sets overlap and are
  checked by the executable coverage ledger.
- Parameter-model permutations are not each counted as separate screens. They
  are test fixtures within ED-01/ED-02 unless their layout is specialized (Cab,
  EQ, Looper X, splitter, or mixer).
- Visual fidelity percentages are only valid after an app frame and physical
  frame are captured at the same 800x480 content state. Audit estimates must be
  labeled as estimates, never mixed with measured similarity.

## Capture priority

The next physical-corpus expansion should close complete high-value families:

1. I/O overview plus the remaining output, Send/Return, and headphones panels.
2. The remaining Directory category, search-entry, sorting, filtering, and
   multiselect states not represented by an official full frame.
3. Splitter, mixer, remaining Virtual Device preset and assignment states.
4. Remaining Settings tabs, recovery screens, and Capture V1 workflow states.
5. Lifecycle overlays and warning/error variants.
