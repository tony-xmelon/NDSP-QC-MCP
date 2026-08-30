import assert from "node:assert/strict";
import test from "node:test";
import type { PresetSnapshot } from "../packages/typescript/qc-client/src/index.ts";
import { footswitchLeds } from "../packages/typescript/qc-ui/src/footswitch-leds.ts";

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
  assert.deepEqual(leds[0], { active: true, color: "#ffd236" });
  assert.deepEqual(leds[7], { active: false, color: "#6954ff" });
  assert.deepEqual(leds[1], { active: false, color: "#626367" });
});

test("multi-block STOMP assignments use white and light when any target is active", () => {
  const leds = footswitchLeds(snapshot({ blocks: [
    { id: "pitch", name: "Transpose", kind: "mod", category: "Pitch", row: 0, column: 4, footswitch: 4, bypassed: false },
    { id: "drive", name: "Rodent Drive", kind: "utility", category: "Guitar Overdrive", row: 2, column: 2, footswitch: 4, bypassed: true }
  ] }));
  assert.deepEqual(leds[4], { active: true, color: "#f4f4f4" });
});

test("SCENE and PRESET modes use colors reported by the preset", () => {
  const scene = footswitchLeds(snapshot({ mode: "SCENE", footswitchModes: ["SCENE", "SCENE"], activeScene: 3 }));
  assert.deepEqual(scene[3], { active: true, color: "#ff02c2" });
  const preset = footswitchLeds(snapshot({ mode: "PRESET", footswitchModes: ["PRESET", "PRESET"], activeScene: 4 }));
  assert.deepEqual(preset[1], { active: true, color: "#45f862" });
});
