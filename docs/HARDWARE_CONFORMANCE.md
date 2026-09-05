# Physical-device MCP conformance

`tools/hardware-conformance.mjs` is the release gate for the complete public MCP
device-action surface. It reads `contracts/qc-actions.v1.json`; adding or removing
an action without updating the physical case registry fails the ordinary test
suite.

Run it twice before distributing an MCP release: once while the Windows app is
the paired device owner and once while the Android app is the paired device
owner. The `mcp-http` transport exercises OAuth, the public MCP server, relay,
platform adapter, shared Rust planner/protocol, USB device, and authoritative
readback. `gateway-stdio` is available to isolate the Windows broker locally.

## Safety model

The command is a dry run by default. It cannot mutate hardware unless both a
mutation flag and the exact environment acknowledgement are supplied. Persistent
tests additionally require two explicitly disposable preset slots distinct from
the source scratch preset. They overwrite those two slots and record them in the
evidence report; the suite cannot restore their previous contents because the
public contract intentionally has no arbitrary preset-import operation.

Create a dedicated stored preset whose name begins with `QC MCP TEST`. Give it:

- a writable parameter with a reversible normalized test value;
- two empty Grid cells for add/move/remove testing;
- a signal row whose alternate input, output, split, and mixer routes are safe;
- no valuable unsaved edits.

Choose a harmless touchscreen coordinate and its explicit recovery coordinate.
Disconnect Cortex Control before either app claims the QC USB interfaces.

Copy `tools/hardware-conformance.example.json` outside source control, fill in
the serial suffix and fixtures, and keep OAuth tokens only in the named
environment variable.

## Commands

Validate coverage and print the plan without connecting:

```powershell
node tools/hardware-conformance.mjs --config C:\secure\qc-hardware-windows.json
```

Discover the attached QC and fixture candidates without writes:

```powershell
node tools/hardware-conformance.mjs --config C:\secure\qc-hardware-windows.json --execute --discover
```

Clone a named source preset into a verified empty scratch slot and print
suggested reversible fixtures. This is a persistent write and refuses to
overwrite an occupied destination:

```powershell
$env:QC_HARDWARE_TEST_ACK = "I_ACCEPT_QC_HARDWARE_MUTATIONS"
node tools/hardware-conformance.mjs --config C:\secure\qc-hardware-windows.json --execute --prepare
```

Execute reads only:

```powershell
node tools/hardware-conformance.mjs --config C:\secure\qc-hardware-windows.json --execute
```

Execute every action after reviewing the configured scratch resources:

```powershell
$env:QC_HARDWARE_TEST_ACK = "I_ACCEPT_QC_HARDWARE_MUTATIONS"
$env:QC_MCP_BEARER_TOKEN = "<short-lived test token>"
node tools/hardware-conformance.mjs --config C:\secure\qc-hardware-windows.json --execute --all --require-all
```

For release evidence, identify the exact staged artifact under test. The full
suite refuses to run without this argument and verifies the adjacent immutable
source/SHA-256 metadata before touching the device:

```powershell
$windowsCandidate = node tools/release-candidates.mjs list | Where-Object { $_ -match '\\windows\\' }
node tools/hardware-conformance.mjs --config C:\secure\qc-hardware-windows.json --execute --all --require-all --release-candidate $windowsCandidate
```

Omit `--execute` first to validate the complete 94-action plan and exact
candidate metadata without connecting to or mutating the QC.

Repeat with the Android device paired and a separate output target. Evidence is
written under `artifacts/hardware-conformance/` unless `--output` is supplied.
Serials, tokens, credentials, and binary payloads are redacted or hashed.

`--persistent`, `--system`, and `--screen-tap` require `--live`, because the
suite uses live preset recall for safe scratch entry and failure restoration.
`--tuner` enables the guarded tuner-setting group. These writes invisibly engage
the tuner, so the harness restores its preferences and still requires a person
to open and close the physical tuner once afterward. `--all` enables all five
mutation groups together.

Finally, gate the release against both immutable reports:

```powershell
node tools/verify-hardware-release.mjs artifacts\hardware-conformance\windows.json artifacts\hardware-conformance\android.json
```

The gate rejects missing platforms, stale action-contract digests, skipped or
failed actions, failed restoration checks, and evidence that does not identify
the exact Windows and Android artifacts in the clean-commit release manifest.

A distributable release requires both reports to show every contract action as
`passed`, no `failed`, `skipped`, or `not-run` action, and `complete: true`.

## Windows backup transport

The Windows broker owns all normal QC traffic through the shared Rust protocol
and runtime, including firmware backup. The native Windows transport keeps one
exclusive HID handle with a permanent read lane and an independent serialized
write lane. Keepalives continue while the QC emits the roughly 1.8 MB
`LocalBackup` response, so the same session remains ready after the transfer.

Current firmware does not echo `request_id` on backup chunks. The collector
therefore synchronizes at the JSON-object boundary, ignores stale leading
fragments and terminators from an earlier client, and validates `type: backup`
and `creator: quad` before accepting the result. A request may be retried only
before the first document chunk arrives. Once collection starts, a stall fails
the transfer and discards it in full; chunks from separate attempts are never
combined.

Run repeated physical verification without printing backup contents:

```powershell
$env:QC_EXPECTED_SERIAL_SUFFIX = "<last serial characters>"
.venv\Scripts\python.exe tools\verify_native_backup.py 5
```

Focused transport regressions can exercise backup after both session restart
paths, or after a synthesized touchscreen tap. The latter guards the required
PRESS-then-RELEASE ordering; leaving the remote pointer pressed causes the QC to
refuse a LocalBackup stream.

```powershell
.venv\Scripts\python.exe tools\verify_native_backup.py 1 --reset-session --disconnect-reconnect
.venv\Scripts\python.exe tools\verify_native_backup.py 1 --screen-tap-roundtrip
```

## Full hardware verification plan

The physical release run is intentionally staged. Each stage is completed on
Windows first and then repeated on Android with the same prepared preset. A
failure stops that platform's run; it does not turn into a retry loop that can
hide stale or queued commands.

### Acceptance gates

- Every one of the 102 public device actions has an authoritative response from
  the QC, not merely a successful send from the app.
- UI feedback is immediate and the later device event agrees with it. A stale
  event may never move a control back during a drag or rapid double press.
- For direct performance controls, click-to-send must be at most 20 ms and the
  observed QC state event must be median 50 ms or less and p95 100 ms or less.
  Preset recall, save, backup, and initial connection are measured separately
  because the QC itself performs longer work.
- Repeatable controls are exercised at least 20 times, including five rapid
  pairs: A-H, UP, DOWN, Mode, Scene, Tempo, and Master Volume.
- The app screen and `capture_screen` device image agree after every stateful
  case: preset and scene, mode, LED state/color, Grid, routing, parameter value,
  tempo, volume, dirty state, and Undo/Redo availability.
- No ordinary ready-state test may produce periodic snapshot traffic.
  Full-snapshot reads are permitted only for startup or explicit recovery.

### Stage 0 — preparation and baseline

1. Close Cortex Control, connect the QC directly by USB, mute or lower the
   monitored audio path, and create a device backup.
2. Select the dedicated `QC MCP TEST` preset and confirm the two disposable
   destination slots are safe to overwrite.
3. Record QC firmware, app build, USB identity, platform, starting preset,
   scene, mode, tempo, volume, and an app/device screenshot pair.
4. Run `--discover`, resolve every fixture, and retain the generated immutable
   configuration with the report.

### Stage 1 — connection, reads, and event transport

Run all read cases, confirm the 256-slot directory and every custom folder, and
compare Grid/block details with the device screen. Then make changes on the QC
itself—scene, bypass, parameter knob, tempo, and volume—and verify that each
arrives as a pushed event without an app request. Disconnect/reconnect USB,
restart the app, and power-cycle the QC once; each recovery must establish a
single fresh session with no orphaned command.

The power switch is observational only: QC Control does not synthesize a power
press. The test covers detection and recovery from a real device power cycle.

### Stage 2 — physical performance controls

Test A-H in STOMP, SCENE, and PRESET modes, including assigned, unassigned,
enabled, bypassed, momentary, and alternating states. Test UP and DOWN across
slot and bank boundaries, including two rapid presses in the same direction
and an immediate reversal. Test Mode, Tap Tempo, tuner, Gig View, scene select,
and Master Volume in both directions: app to QC and QC to app. Capture the QC
screen after each navigation boundary and record LED color/state before and
after each footswitch operation.

### Stage 3 — parameters, Grid, and routing

For every parameter primitive represented in ModelRepo—continuous, logarithmic,
stepped rotary, toggle, selector, expression-linked, dependent/disabled, and
dedicated full-screen controls—compare label, order, unit, displayed value, and
encoded round trip. Exercise slow drags, fast drags, and A-B-A changes. Then use
the disposable Grid cells to add, move, bypass, assign, and remove a block and
to change IN, OUT, Split, and Mixer routing. Every operation is restored before
the next case.

This stage samples at least one model in every effect category and runs the
generated scale round-trip suite for every ModelRepo parameter. A visual sample
alone is not sufficient for scale verification.

### Stage 4 — persistent and failure paths

Run Save As, Rename, Copy, and device backup only in the reserved slots. Verify
dirty title, Save, Undo, and Redo transitions on both screens. During separate
scratch runs, interrupt USB once during a read and once immediately after a
write; the app must either receive the authoritative result or show one bounded
failure, never silently replay the mutation. Finish by recalling the original
scratch preset and confirming all reversible settings were restored.

### Evidence and release decision

Each case records app build, contract digest, start/end timestamps, duration,
arguments with secrets redacted, authoritative returned state, and restoration
result. Stateful cases also retain paired app/device screenshots and the raw
event sequence number used for confirmation. The two platform reports are then
checked with `test:hardware:release`; release is blocked by a missing action,
wrong platform, stale contract, latency-gate failure, screenshot mismatch,
failed restoration, or any skipped case.
