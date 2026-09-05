import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { PresetSnapshot } from "../packages/typescript/qc-client/src/index.ts";
import { footswitchLeds, optimisticallyPressFootswitch } from "../packages/typescript/qc-core/src/footswitch.ts";

const snapshot = (overrides: Partial<PresetSnapshot>): PresetSnapshot => ({
  deviceName: "Quad Cortex", presetName: "Test", presetLocation: "6B", presetPosition: 41,
  setlistKey: "test", setlistName: "Test", mode: "STOMP", footswitchModes: ["STOMP", "STOMP"],
  activeScene: 0, scenes: Array.from({ length: 8 }, (_, index) => `Scene ${index}`),
  sceneColors: ["#ff2727", "#0a74e0", "#ffd236", "#ff02c2", "#45f862", "#ff7000", "#6954ff", "#00ffdd"],
  blocks: [], routes: [], tempo: 45, dirty: false, ...overrides
});

test("STOMP LEDs follow assignments and bypass state", () => {
  const leds = footswitchLeds(snapshot({ blocks: [
    { id: "gate", name: "Adaptive Gate", kind: "utility", category: "Utility", row: 0, column: 0, footswitch: 0, bypassed: false },
    { id: "delay", name: "Analog Delay", kind: "delay", category: "Delay", row: 3, column: 6, footswitch: 7, bypassed: true }
  ] }));
  assert.deepEqual(leds[0], { active: true, assigned: true, color: "#f4f4f4" });
  assert.deepEqual(leds[7], { active: false, assigned: true, color: "#00ffdd" });
  assert.deepEqual(leds[1], { active: false, assigned: false, color: "#626367" });
});

test("multi-block STOMP LEDs follow the first assigned block for inverted groups", () => {
  const leds = footswitchLeds(snapshot({ blocks: [
    { id: "pitch", name: "Transpose", kind: "mod", category: "Pitch", row: 0, column: 4, footswitch: 4, footswitchOrder: 0, bypassed: true },
    { id: "drive", name: "Rodent Drive", kind: "utility", category: "Guitar Overdrive", row: 2, column: 2, footswitch: 4, footswitchOrder: 1, bypassed: false }
  ] }));
  assert.deepEqual(leds[4], { active: false, assigned: true, color: "#f4f4f4" });
});

test("single Pitch assignments use the yellow physical lamp", () => {
  const leds = footswitchLeds(snapshot({ blocks: [
    { id: "pitch", name: "Poly Octaver", kind: "mod", category: "Pitch", row: 2, column: 5, footswitch: 5, bypassed: false }
  ] }));
  assert.deepEqual(leds[5], { active: true, assigned: true, color: "#ffd236" });
});

test("single Drive assignments use the yellow physical lamp", () => {
  const leds = footswitchLeds(snapshot({ blocks: [
    { id: "drive", name: "Rodent Drive", kind: "utility", category: "Guitar Overdrive", row: 0, column: 2, footswitch: 2, bypassed: false }
  ] }));
  assert.deepEqual(leds[2], { active: true, assigned: true, color: "#ffd236" });
});

test("every CorOS 4.1 device category uses its official physical STOMP color", () => {
  const categories: Array<[string, string, string]> = [
    ["Plugins", "Plugin Device", "#ff7000"],
    ["Guitar Amplifier", "Amp", "#ff2727"],
    ["Neural Capture", "Capture", "#f4f4f4"],
    ["Guitar Cabinet", "Cab", "#6954ff"],
    ["Guitar Overdrive", "Drive", "#ffd236"],
    ["Delay", "Delay", "#00ffdd"],
    ["Reverb", "Reverb", "#00ffdd"],
    ["Compressor", "Compressor", "#45f862"],
    ["Pitch", "Pitch", "#ffd236"],
    ["Modulation", "Modulation", "#3500f1"],
    ["Morph", "Morph", "#87daff"],
    ["Synth", "Synth", "#e44a5d"],
    ["Filter", "Filter", "#87daff"],
    ["Equalizer", "EQ", "#0a74e0"],
    ["IRLoaders", "IR Loader", "#6954ff"],
    ["Wah", "Crying Wah", "#f4f4f4"],
    ["FX Loop", "FX Loop 1", "#f4f4f4"],
    ["Loopers", "Looper X", "#ff2727"],
    ["Utility", "Adaptive Gate", "#f4f4f4"]
  ];
  for (const [category, name, color] of categories) {
    const [led] = footswitchLeds(snapshot({ blocks: [
      { id: category, name, kind: "utility", category, row: 0, column: 0, footswitch: 0, bypassed: false }
    ] }));
    assert.deepEqual(led, { active: true, assigned: true, color }, `${category} should use ${color}`);
  }
});

test("STOMP presses update the lamp and assigned blocks optimistically", () => {
  const before = snapshot({
    footswitchStates: [{ index: 0, active: false, assigned: true, color: "#f4f4f4" }],
    blocks: [{ id: "gate", name: "Adaptive Gate", kind: "utility", category: "Utility", row: 0, column: 0, footswitch: 0, bypassed: true }]
  });
  const after = optimisticallyPressFootswitch(before, 0);
  assert.equal(after.footswitchStates?.[0].active, true);
  assert.equal(after.blocks[0].bypassed, false);
});

test("Windows footswitches use a persistent immediate MIDI lane and reconcile stale USB snapshots", () => {
  const appSource = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");
  const frameSource = readFileSync(new URL("../apps/windows/src/use-windows-device-frames.ts", import.meta.url), "utf8");
  const nativeFrameSource = readFileSync(new URL("../packages/typescript/qc-ui/src/qc-native-state-frame.ts", import.meta.url), "utf8");
  const liveStateSource = readFileSync(new URL("../packages/typescript/qc-ui/src/use-qc-live-state.ts", import.meta.url), "utf8");
  const controllerSource = readFileSync(new URL("../packages/typescript/qc-ui/src/use-qc-controller.ts", import.meta.url), "utf8");
  const workflowSource = readFileSync(new URL("../packages/typescript/qc-ui/src/use-performance-workflow.ts", import.meta.url), "utf8");
  const rustSource = readFileSync(new URL("../apps/windows/src-tauri/src/lib.rs", import.meta.url), "utf8");
  const midiSource = readFileSync(new URL("../packages/rust/qc-windows-midi/src/lib.rs", import.meta.url), "utf8");
  const pressFlow = workflowSource.slice(workflowSource.indexOf("const pressFootswitch"), workflowSource.indexOf("const movePreset"));
  const nativeCommand = rustSource.slice(rustSource.indexOf("async fn press_footswitch"), rustSource.indexOf("async fn select_mode_slot"));

  assert.doesNotMatch(pressFlow, /commandPending/, "a second tap must not be discarded while the first MIDI send is pending");
  assert.match(pressFlow, /snapshotRef\.current/);
  assert.match(pressFlow, /beginFootswitch/);
  assert.match(pressFlow, /runFootswitch/);
  assert.match(controllerSource, /coordinatorRef\.current!\.fail/);
  assert.match(frameSource, /consumeQcNativeStateFrame/);
  assert.match(nativeFrameSource, /consumer\.consume\(frame\.states, frame\.observedAt\)/);
  assert.match(liveStateSource, /reconcileFrame\(states, observedAt\)/);
  assert.match(nativeCommand, /state::<Mutex<PerformanceMidi>>/);
  assert.match(nativeCommand, /plan_host_midi\("device\.pressFootswitch"/);
  assert.match(nativeCommand, /\.send\(plan\.controller, plan\.value\)/);
  assert.doesNotMatch(nativeCommand, /background_gateway_request|with_gateway/, "performance MIDI must not queue behind the USB snapshot gateway");
  assert.match(rustSource, /use qc_windows_midi::PerformanceMidi/);
  assert.match(midiSource, /handle: Option<usize>/, "the shared Windows MIDI endpoint remains open between taps");
  assert.match(midiSource, /impl Drop for PerformanceMidi/);
});

test("Windows mode-slot changes share the immediate persistent MIDI lane", () => {
  const rustSource = readFileSync(new URL("../apps/windows/src-tauri/src/lib.rs", import.meta.url), "utf8");
  const command = rustSource.slice(rustSource.indexOf("async fn select_mode_slot"), rustSource.indexOf("async fn list_preset_slots"));
  assert.match(command, /state::<Mutex<PerformanceMidi>>/);
  assert.match(command, /plan_host_midi\("device\.selectModeSlot"/);
  assert.match(command, /\.send\(plan\.controller, plan\.value\)/);
  assert.doesNotMatch(command, /background_gateway_request|with_gateway/);
});

test("Windows Tap Tempo uses explicit CC44 on the persistent MIDI lane", () => {
  const rustSource = readFileSync(new URL("../apps/windows/src-tauri/src/lib.rs", import.meta.url), "utf8");
  const command = rustSource.slice(rustSource.indexOf("async fn tap_tempo"), rustSource.indexOf("async fn select_mode_slot"));
  assert.match(command, /state::<Mutex<PerformanceMidi>>/);
  assert.match(command, /plan_host_midi\("device\.tapTempo"/);
  assert.match(command, /\.send\(plan\.controller, plan\.value\)/);
  assert.doesNotMatch(command, /press_footswitch|background_gateway_request|with_gateway/);
});

test("device-reported STOMP LED state is authoritative", () => {
  const leds = footswitchLeds(snapshot({
    footswitchStates: [{ index: 4, active: true, assigned: true, color: "#123456" }],
    blocks: [{ id: "pitch", name: "Transpose", kind: "mod", row: 0, column: 4, footswitch: 4, bypassed: true }]
  }));
  assert.deepEqual(leds[4], { active: true, assigned: true, color: "#123456" });
});

test("SCENE and PRESET modes use colors reported by the preset", () => {
  const scene = footswitchLeds(snapshot({ mode: "SCENE", footswitchModes: ["SCENE", "SCENE"], activeScene: 3 }));
  assert.deepEqual(scene[3], { active: true, assigned: true, color: "#ff02c2" });
  const preset = footswitchLeds(snapshot({ mode: "PRESET", footswitchModes: ["PRESET", "PRESET"], activeScene: 4 }));
  assert.deepEqual(preset[1], { active: true, assigned: true, color: "#45f862" });
});

test("the TEMPO pulse animates only the colored fill and preserves the shared LED housing", () => {
  const pulseCss = readFileSync(new URL("../packages/typescript/qc-ui/src/live-surface.css", import.meta.url), "utf8");
  const chassisCss = readFileSync(new URL("../packages/typescript/qc-ui/src/surface-shell.css", import.meta.url), "utf8");
  assert.match(pulseCss, /\.hardware-switch\.is-tempo-pulse\.is-active \.switch-led::before\s*\{/);
  assert.doesNotMatch(pulseCss, /\.hardware-switch\.is-tempo-pulse\.is-active \.switch-led\s*\{[^}]*animation:/s);
  assert.match(chassisCss, /\.skin-official-svg \.switch-led::before\s*\{[^}]*background: var\(--switch-accent\);[^}]*opacity: 0;/s);
  assert.match(chassisCss, /\.skin-official-svg \.hardware-switch\.is-active \.switch-led::before,\s*\.skin-official-svg \.hardware-switch\.is-pressed \.switch-led::before\s*\{\s*opacity: 1;/);
});

test("hardware switches, including BANK UP and BANK DOWN, show momentary LED feedback", () => {
  const surface = readFileSync(new URL("../packages/typescript/qc-ui/src/quad-cortex-surface.tsx", import.meta.url), "utf8");
  const chassisCss = readFileSync(new URL("../packages/typescript/qc-ui/src/surface-shell.css", import.meta.url), "utf8");
  assert.match(surface, /pressed \? " is-pressed"/);
  assert.match(surface, /role=\{bankUp\.role\} label="BANK UP"/);
  assert.match(surface, /role=\{bankDown\.role\} label="BANK DOWN"/);
  assert.match(chassisCss, /\.hardware-switch\.is-pressed \.switch-led/);
  assert.match(chassisCss, /\.skin-official-svg \.hardware-switch\.is-pressed \.switch-led::before\s*\{\s*opacity: 1;/);
});

test("UP and DOWN use the white navigation LEDs shown by the QC reference", () => {
  const surface = readFileSync(new URL("../packages/typescript/qc-ui/src/quad-cortex-surface.tsx", import.meta.url), "utf8");
  const theme = readFileSync(new URL("../packages/typescript/qc-theme/src/colors.json", import.meta.url), "utf8");
  const reference = readFileSync(new URL("../apps/windows/public/qc-overview-001.svg", import.meta.url), "utf8");
  assert.match(reference, /upper arcs/, "the saved QC reference must continue to identify the navigation lamp geometry");
  assert.match(reference, /stroke: white;/, "the saved QC reference must continue to identify the navigation lamps as white");
  assert.match(theme, /"whiteLed": "#f4f4f4"/);
  assert.match(surface, /const navigationLedColor = QC_COLORS\.hardware\.whiteLed/);
  assert.match(surface, /label="BANK UP" compact active=\{Boolean\(parameterEditor\)\} assigned=\{Boolean\(parameterEditor\)\} accent=\{navigationLedColor\}/);
  assert.match(surface, /bankDownLed = parameterLed\(4, \{ active: false, assigned: false, color: navigationLedColor \}\)/);
  assert.match(surface, /label="BANK DOWN" active=\{bankDownLed\.active\} assigned=\{bankDownLed\.assigned\} accent=\{bankDownLed\.color\}/);
  assert.doesNotMatch(surface, /accent="#83ddfa"/);
  assert.doesNotMatch(surface, /color: "#d8dde0"/);
});

test("parameter screen turns DOWN into the fifth colored parameter encoder and keeps UP white and lit", () => {
  const surface = readFileSync(new URL("../packages/typescript/qc-ui/src/quad-cortex-surface.tsx", import.meta.url), "utf8");
  assert.match(surface, /bankDownLed = parameterLed\(4,/);
  assert.match(surface, /label="BANK DOWN" active=\{bankDownLed\.active\} assigned=\{bankDownLed\.assigned\} accent=\{bankDownLed\.color\}/);
  assert.match(surface, /label="BANK UP" compact active=\{Boolean\(parameterEditor\)\} assigned=\{Boolean\(parameterEditor\)\} accent=\{navigationLedColor\}/);
});

test("UP uses the same physical switch diameter as the other QC switches", () => {
  const chassisCss = readFileSync(new URL("../packages/typescript/qc-ui/src/surface-shell.css", import.meta.url), "utf8");
  assert.match(chassisCss, /\.footswitch-deck \.switch-ring,\s*\.screen-nav-control \.switch-ring \{ width: clamp\(46px, 4\.7vw, 60px\); \}/);
  assert.match(chassisCss, /\.skin-official-svg \.footswitch-deck \.switch-ring,\s*\.skin-official-svg \.screen-nav-control \.switch-ring \{\s*width: clamp\(46px, 4\.7vw, 60px\);\s*\}/);
  assert.doesNotMatch(chassisCss, /\.screen-nav-control \.switch-ring \{[^}]*width: clamp\(28px, 3\.5vw, 38px\)/s);
});

test("footswitch LED spacing changes without moving any physical switch", () => {
  const chassisCss = readFileSync(new URL("../packages/typescript/qc-ui/src/surface-shell.css", import.meta.url), "utf8");
  assert.match(chassisCss, /--qc-footswitch-led-lift: clamp\(6px, \.55vw, 8px\)/);
  const officialSkin = chassisCss.slice(chassisCss.indexOf(".skin-official-svg {"), chassisCss.indexOf("/* CorOS reference canvas"));
  assert.doesNotMatch(officialSkin, /\.hardware-switch\s*\{[^}]*display:\s*flex/s, "LED spacing must not relayout or move the switches");
  assert.match(officialSkin, /\.footswitch-row:first-child \.switch-ring \{\s*top: 8px;/);
  assert.match(officialSkin, /\.footswitch-row:nth-child\(3\) \.switch-ring \{\s*top: 4px;/);
  assert.match(officialSkin, /\.footswitch-row:first-child \.switch-led \{\s*top: calc\(5px - var\(--qc-footswitch-led-lift\)\);/);
  assert.match(officialSkin, /\.footswitch-row:nth-child\(3\) \.switch-led \{\s*top: calc\(2px - var\(--qc-footswitch-led-lift\)\);/);
  assert.match(officialSkin, /\.screen-nav-control \.switch-led\s*\{[^}]*top: clamp\(8px, \.96vw, 11px\);/s, "UP must remain at its verified position");
});
