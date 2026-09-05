# Android client

Capacitor/React Android composition root for QC Control. The portrait layout keeps the CorOS display and assistant visible, with five touch-friendly quick controls between them. Compact landscape uses a two-column screen/chat layout.

The CorOS screen and parameter editor come from `@ndsp-qc/ui`; device state,
footswitch semantics, surface commands, tempo, editor transitions, and chat
intent validation come from `@ndsp-qc/core`. This app owns only Android
lifecycle, permissions, Firebase/voice integration, and the Capacitor USB
adapter.

The Android shell does not import the Windows app or its desktop styles.
Parameter-editor state and disconnected demo metadata are shared too, so the
effect-screen controller and its preview behavior are implemented once.

The Android app is now a direct USB host for a Quad Cortex (`152a:880a`). It
detects the attached unit, requests Android USB permission, claims the HID
interface, performs the Cortex Control handshake, keeps the session alive, and
streams live preset, block, routing, scene, setlist, dirty-state, and master
volume updates into the UI. The Windows/LAN gateway remains a possible
secondary transport but is not required by the mobile app.

Realtime work is split into permanent native lanes: the HID reader, HID command
writer, performance-MIDI writer, and model-catalog parser cannot block one
another. Each QC frame is timestamped and delivered to JavaScript as one batch;
`@ndsp-qc/core` reconciles that batch with pending optimistic scene, preset,
mode, tempo, and bypass commands and applies one UI commit. The shared
`useQcController` binding also owns send/readback/rollback transactions, so an
older failure or USB echo cannot undo a newer tap. Raw packets are not copied across the Capacitor
bridge. This keeps rapid footswitch changes ordered while preset metadata is
being decoded.

The Capacitor-facing API is limited to Android USB lifecycle, typed commands,
and domain-state events. HID framing, receive-frame assembly, intent-to-wire
command selection, and complete protobuf frames are handled by the same Rust
`qc-protocol::state::StateDecoder` used by Windows, compiled into the APK as
`libqc_android.so` behind a narrow JNI facade. Raw packets never cross the
Capacitor bridge, while UI reconciliation and command policy remain in
`@ndsp-qc/core`. Transport constants and the realtime subscription order are
generated from `contracts/qc-usb-profile.v1.json`; Grid, scene, tempo, routing,
and IPC limits are generated from `contracts/qc-domain.v1.json`.

The QC deliberately stalls the status stage of each HID `SET_REPORT` after
accepting its data stage. Android therefore treats a negative control-transfer
result as expected and verifies connectivity from the correlated reset reply
and subsequent input traffic. During connection it adapts between the numbered
129-byte and body-only 128-byte representations used by different HID stacks,
then retains the representation that receives the QC reply.

Chat uses the native Firebase AI Logic SDK through the project's Gemini
Developer API provider; no personal Gemini key is stored in the APK. The
in-chat selector offers an allowlisted set of current Flash and Flash-Lite
models and remembers the choice on the device. Exact per-model session token
usage comes from Firebase response metadata. Firebase does not return remaining
project/model quota to mobile clients, so the app reports availability or a
confirmed quota-exhausted error without inventing a remaining percentage. The
microphone button uses Android's system speech recognizer and
automatically sends the visible transcript through the same Gemini/action
router as typed text. The guarded Android hardware allowlist covers scene and
preset navigation, mode/slot selection, tempo, selected-block bypass, parameter
changes with expected-value guards, master-volume reads/writes with expected-value
guards, tuner, and Gig View. Each remote write is followed by an authoritative USB
readback before success is returned. Unknown or malformed model actions are
discarded, and failed device writes are reported instead of being presented as
successful. Tap tempo uses the verified physical footswitch MIDI control while
live tempo state is reconciled from USB events.

Remote control uses a separately paired, Keystore-protected device credential.
The foreground service maintains an outbound-only authenticated `wss://` session,
reports USB readiness as devices attach or detach, reconnects with bounded jittered
backoff, rejects replayed request IDs, and never accepts inbound LAN connections.
The Assistant and remote access selector defaults to **Full control** and also
offers **Read-only**, **Performance**, and **Modify**. The native foreground
service independently enforces the generated action tier for every relay call;
manual on-screen controls remain available in every mode. No tier bypasses
expected-state, readback, or explicit confirmation checks.
Library and persistent preset mutations use the shared Rust workflow planner and
preset cache, with explicit confirmation and authoritative post-write verification.
The local Capacitor dispatcher and outbound relay expose the same 45-method
`gateway.v1` contract as Windows. Android lifecycle calls adapt to its USB
permission model, state-event cursors are backed by the native frame journal,
and tempo projection, parameter preview, backup assembly, and backup validation
reuse the shared Rust implementation.

The Firebase app registers the stable distribution certificate used by tester
APKs. App Check is not yet activated in the project. If Play Integrity is
enabled for Firebase AI Logic, configure it for Firebase App Distribution's
off-Play installs before enforcing it: do not require `PLAY_RECOGNIZED` or
`LICENSED`, and retain the Device integrity minimum. This lets eligible tester
devices attest without copying a per-device debug token while avoiding a policy
that only Google Play installations can satisfy.

## Run in a browser

```powershell
npm run dev:android
```

## Build and sync Android

```powershell
npm run android:sync
npm run android:open
```

Build a debug APK from the command line:

```powershell
npm run android:build:debug
```

Android builds invoke `scripts/build-android-rust.ps1` automatically. Local
build machines therefore need Rust's `aarch64-linux-android` and
`x86_64-linux-android` targets, `cargo-ndk`, and an Android NDK installed.

The APK is written under `apps/android/android/app/build/outputs/apk/debug/`.

For physical-device verification, connect the phone to the Quad Cortex with a
USB-C data/OTG cable, accept the Android permission prompt, and confirm the
header changes to **USB**. Only one host can own the QC HID interface at a time,
so close Cortex Control or the Windows gateway first.

Type `USB diagnostics` in chat to see privacy-safe transport counters, the last
message type, latest state age, performance-MIDI queue delay, decode-error
count, and model-catalog status. No QC payload or preset content is included in
this diagnostic summary.

## Publish to Firebase App Distribution

The Firebase Android app is registered as `com.qccontrol.mobile` in the `qc-control-xmelon` project. Build and upload a new development release with:

```powershell
npm run android:publish:firebase -- -ReleaseNotes "Describe this build" -Testers "tester@example.com"
```

Packaging stages the exact APK under `artifacts/android` with source-commit and
SHA-256 metadata. If a Windows installer from the same clean commit has also
been staged, the generated release manifest and SBOM cover both applications.
Artifacts from an older commit or with changed bytes are excluded automatically.
Run `android:prepare:firebase` first, test that staged APK, and collect both
hardware reports. The publish command verifies and uploads those same bytes; it
does not rebuild the APK after physical validation.

Every staged APK is rejected unless its signing certificate matches the
Firebase-registered SHA-256 in the shared branding contract. Local development
uses the machine's standard debug keystore. CI restores the same stable identity
from `QC_ANDROID_KEYSTORE_BASE64`, `QC_ANDROID_STORE_PASSWORD`,
`QC_ANDROID_KEY_ALIAS`, and `QC_ANDROID_KEY_PASSWORD` repository secrets; it
never publishes an APK signed by an ephemeral runner key.

`apps/android/package.json` is the Android version source. Increment it with
`npm run version:android:patch` (or `:minor` / `:major`), or set an explicit
version with `npm run version:android:set -- 1.2.3`. The shared version tool
updates Gradle's `versionName`, increments `versionCode` for a new version, and
synchronizes the workspace lockfile. Android builds verify that synchronization
before packaging.
