# pyquadcortex coverage and deferred OpenCortex research

Status snapshot: 2026-09-04

Sources reviewed:

- `stokes-audio/pyquadcortex` main at `a4f2d9be7da86053e0f03619c645d59180fe4e8c`
  (2026-08-28), including its CorOS 4.x manual coverage audit.
- `VanIseghemThomas/OpenCortex` main at
  `c9f9f983881ba908a45d2087ed64d434f97ed5d5` (2026-08-13).
- Neural DSP's Quad Cortex manual for the user-visible product surface.

This is a point-in-time boundary document. The QC protocol is private and
firmware-sensitive, so claims must be rechecked when CorOS or pyquadcortex is
updated.

## Decision

Keep pyquadcortex as a source-level differential oracle and future protocol
reference, not as a deployed implementation. The shared `qc-protocol` and
`qc-device-runtime` Rust crates are authoritative at runtime on Windows and
Android. Do not merge OpenCortex code into the normal Windows, Android, gateway,
or MCP runtime.

There is no immediate product benefit that justifies integrating OpenCortex.
Record its potentially useful work for later:

| OpenCortex area | Possible future value | Decision and constraints |
|---|---|---|
| Legacy VNC/root screen capture | An alternative to the native CorOS 4.1 USB screen messages now implemented in Rust | Deferred. The known OpenCortex route requires root/SSH and old on-device binaries; the normal product uses the non-root USB protocol. |
| Capture decryption and `Capture.proto` | Offline capture inspection, metadata, validation, and comparison | Deferred. Existing decryptor declares GPLv3, uses the device serial for user content, and has not been validated against current CorOS. Keep any future implementation isolated and review licensing first. |
| Direct stomp/rotary input and LED bridge | True press/release, encoder, and LED events | Deferred. Requires software installed on a rooted QC and relies on old internal Linux input formats. Never make it a consumer default. |
| Historical ModelRepo XML, presets and setlists | Regression fixtures and legacy-import testing | May be copied into a test-only fixture set after provenance/licensing review. Never use as the current device catalog or preset schema. |
| Root access, firmware tools, model renaming, old backup paths and CorOS build environment | Homebrew research | Out of scope for the normal product because of security, warranty, compatibility and bricking risk. Current live USB operations take precedence. |

## pyquadcortex coverage baseline

The upstream manual audit contains 105 feature rows:

- 65 fully supported and verified on hardware;
- 8 partially supported;
- 21 unsupported;
- 11 not applicable to a host controller.

Of 93 features that a host might plausibly drive, 65 are complete, 8 are partial,
and 20 remain untouched. This measures pyquadcortex itself, not how much of its
API QC Control currently exposes through its contracts, gateway, MCP tools and
clients.

The covered core is already broad: live preset and scene state, grid topology,
block placement/removal/movement, block and lane parameters, bypass and scene
mode, splitter/mixer routing, stomp and expression assignments, preset MIDI Out,
tempo/metronome settings, modes and Gig View, I/O controls, Global EQ, master
volume, setlists/folders/favourites/recents, preset save/move/delete/copy,
catalog/model pinning, capture listing/loading, and IR listing/loading.

## Surface not fully covered by pyquadcortex

### High-value local-control gaps

| Surface | Current boundary | Practical route or next investigation |
|---|---|---|
| Looper transport | Status and parameters are readable; play/record/overdub/undo transport is not driven over HID | Use the documented MIDI CC 48-61 route for now. Investigate the observed `Looper` button pushes only if HID parity is valuable. |
| Undo/redo | Native Rust commands and gateway methods are implemented with byte-level protocol tests; connected-device verification remains required for each supported CorOS release | Keep app-local history distinct from the QC's own undo stack. |
| Set Parameters as Defaults | `DefaultParameters` is decoded/subscribed but has never been written | Capture, replay and read back the device action. |
| Expression calibration | Start/finish state is observable through `IOSettings`; the host cannot start or drive calibration | Capture the complete device flow. Physical pedal movement will still be required. |
| Expression assignment to lane MUTE/SOLO | Readable, but the device silently refuses the host write; other expression targets work | No safe HID route is known. Do not pretend success. |
| Tap tempo over HID | No attributed `GlobalTempo` parameter performs a tap | Use documented MIDI CC 44 or the physical-control/native MIDI bridge. |
| Live tuner needle | Open/close and tuner settings work; the unit refuses the meter-enable write and never streams the needle | Deliberately unsupported upstream. A host-side audio tuner would be a separate implementation. |
| DSP headroom prediction | Placement refusal is detected after the attempt; `CPULoad` does not arrive | Surface `BlockRefused`. Do not predict capacity until a reliable signal is found. |
| Compiler-inhibited Global EQ/Input Gate | Read and decode are exposed by the native Rust gateway | Keep the state read-only until safe mutation semantics are known. |
| USB audio routing | On-device USB level/headphone source/dry-wet work; detailed DI-versus-processed channel mapping is unexplored | Investigate the remaining `IOSettings` fields; host driver/DAW setup belongs outside pyquadcortex. |
| Internal MIDI clock flag | Most MIDI settings are writable; `internal_midi_clock_enabled` is refused | Keep the refusal until a verified route exists. |
| Device name | Native Rust identity read and device-name write are implemented with correlated readback | Revalidate field limits and persistence on each supported CorOS release. |

### Library and file-management gaps

| Surface | Current boundary |
|---|---|
| On-device search | No search operation; `RecentSearches` is only a candidate. Client-side search over complete listings is available. |
| Native bulk copy | `BulkOperation` reports progress but is not driven. pyquadcortex emulates copies with recall-and-save, which is slower. |
| Capture management | Captures can be listed and loaded, but not renamed, deleted, moved or otherwise managed. |
| IR import | Existing IRs can be listed and loaded. Host-to-device import payload encoding remains unsolved and prior probing destabilized the USB connection. |
| Preset/plugin-preset import | Native host import is unsolved. Ordinary device preset save/list operations are supported. |
| Plugin preset browsing | `License` and `CloudProduct` are candidates; no complete plugin-preset API exists. |
| Preset cloud metadata | Description, author and cloud ID cannot be set through the verified grid/save path; the device supplies author information from its account. |

### Neural Capture and account/cloud gaps

| Surface | Current boundary |
|---|---|
| Neural Capture v1 creation | Initial host-dialog handshake is understood; recorder/trainer/refiner workflow is unexplored. |
| Neural Capture v2 creation | Message decodes, but the workflow is unexplored. |
| Capture calibration, A/B testing and save metadata | Candidate fields are known, but the end-to-end flow is not implemented. |
| Plugin licences/entitlements | `License` is decoded and subscribed but not interpreted. Catalog entries expose some plugin identifiers. |
| Cortex Cloud sign-in, products, upload and sharing | Candidate messages are decoded; no supported authenticated workflow exists. |
| Cloud backups | Candidate messages exist but have not been driven. |
| Local backups | The native Rust broker implements chunked current-firmware device backup; this is project functionality, not an upstream pyquadcortex claim. |

### Diagnostics and intentionally excluded operations

- Detailed DSP, footswitch and USB diagnostics are not covered. `ModuleStats` is
  decoded, while deeper diagnostic families have no public high-level behavior.
- CorOS firmware update is intentionally not driven. A failed experiment can
  brick the unit and is outside this project's control scope.
- Power off, reboot, Be Right Back, screen lock, recovery-mode entry, cabling,
  encoders and footswitch mechanics remain physical or intentionally excluded
  operations. CorOS 4.1 screen capture and coordinate taps are implemented over
  the native USB RemoteControl messages; they do not require root access.
- Wi-Fi/network control has no usable non-root route. USB-HID remains the local
  transport; MIDI is appropriate for documented performance controls.
- The upstream baseline did not expose native screen pixels. This project now
  implements the CorOS 4.1 RemoteControl screenshot and tap messages directly in
  Rust, separately from the legacy pyquadcortex high-level API.

## Schema visibility is not functional support

The vendored protobuf schema names many more messages and fields than the
high-level API can safely drive. Decoding a message, subscribing to it, or seeing
a candidate field does not mean its operation, units, sequencing, side effects or
failure behavior are understood. QC Control must expose only verified behavior
through typed contracts and keep unsupported operations explicit.

Likewise, several ModelRepo parameter attributes remain unexplained or only
partially used, including display ordering, parameter hiding/replacement,
footswitch toggle metadata, tooltips, and middle labels. These are useful future
UI-fidelity investigations, not permission to infer behavior.

## Revisit triggers

Revisit this document when any of the following happens:

1. pyquadcortex adds or changes a capability in its manual-coverage audit;
2. a CorOS release changes the protocol or introduces an official remote API;
3. Neural DSP provides a non-root screen-mirroring or remote-control route;
4. QC Control needs capture creation, file import, library management, cloud, or
   diagnostics as an immediate product feature;
5. an OpenCortex component is considered for distribution, which requires a
   fresh compatibility, security and licence review.

## References

- <https://github.com/stokes-audio/pyquadcortex>
- <https://github.com/stokes-audio/pyquadcortex/blob/main/docs/manual-coverage.md>
- <https://github.com/stokes-audio/pyquadcortex/blob/main/docs/roadmap.md>
- <https://github.com/VanIseghemThomas/OpenCortex>
- <https://github.com/VanIseghemThomas/OpenCortex/blob/main/Stomps/README.md>
- <https://github.com/VanIseghemThomas/OpenCortex/blob/main/File-decryption/README.md>
- <https://github.com/VanIseghemThomas/OpenCortex/blob/main/File-decryption/Capture.proto>
- <https://neuraldsp.com/manual/quad-cortex>
