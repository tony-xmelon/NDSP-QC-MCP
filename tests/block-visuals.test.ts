import assert from "node:assert/strict";
import test from "node:test";
import type { GridBlock } from "../packages/typescript/qc-client/src/index.ts";
import { officialBlockVisual, type OfficialBlockVisualKey } from "../packages/typescript/qc-ui/src/block-visuals.ts";

const block = (name: string, category: string, kind = "utility"): GridBlock => ({ id: name, name, category, kind, row: 0, column: 0 });

test("official category mapping covers every Quad Cortex virtual-device family", () => {
  const cases: Array<[string, string, OfficialBlockVisualKey]> = [
    ["Plugin Device", "Plugins", "plugin"], ["US DLX", "Amplifier", "amp"], ["Capture", "Neural Capture", "capture"],
    ["112 US DLX", "Cab", "cab"], ["Rodent Drive", "Guitar Overdrive", "overdrive"],
    ["Analog Delay", "Delay", "delay"], ["Mind Hall", "Reverb", "reverb"],
    ["Jewel", "Compressor", "compressor"], ["Poly Octaver", "Pitch", "pitch"],
    ["Phaser", "Modulation", "modulation"], ["Freeze", "Morph", "morph"],
    ["Synth", "Synth", "synth"], ["Envelope", "Filter", "filter"],
    ["Parametric-8", "Equalizer", "equalizer"], ["IR", "IR Loader", "ir-loader"],
    ["Crying Wah", "Wah", "wah"], ["FX Loop 2", "FX Loop", "fx-loop"],
    ["Looper X", "Looper", "looper"], ["Gain", "Utility", "utility"]
  ];
  for (const [name, category, expected] of cases) assert.equal(officialBlockVisual(block(name, category)).key, expected, `${name} should use ${expected}`);
});

test("Adaptive Gate uses the white Utility visual reported on the device", () => {
  const visual = officialBlockVisual(block("Adaptive Gate", "Utility"));
  assert.equal(visual.key, "gate");
  assert.deepEqual(visual.tile, [400, 82]);
  assert.equal(visual.color, "#959595");
});

test("every family resolves to its named official glyph and device color", () => {
  const cases: Array<[string, string, [number, number], string, string | undefined]> = [
    ["Plugin Device", "Plugins", [560, 0], "#ff7000", undefined],
    ["US DLX 65 Reissue", "Amplifier", [480, 0], "#ff2727", undefined],
    ["Capture", "Neural Capture", [640, 0], "#959595", undefined],
    ["112 US DLX Black C12K 00s (ST)", "Cab", [80, 82], "#6954ff", undefined],
    ["Rodent Drive", "Guitar Overdrive", [400, 0], "#ffd236", undefined],
    ["Analog Delay", "Delay", [160, 0], "#00ffdd", "delay"],
    ["Mind Hall", "Reverb", [240, 82], "#00ffdd", undefined],
    ["Jewel", "Compressor", [400, 82], "#45f862", "compressor"],
    ["Poly Octaver", "Pitch", [0, 82], "#ffd236", undefined],
    ["Phaser", "Modulation", [160, 0], "#3500f1", undefined],
    ["Freeze", "Morph", [640, 82], "#959595", undefined],
    ["Synth", "Synth", [480, 82], "#e44a5d", undefined],
    ["Envelope", "Filter", [240, 0], "#87daff", undefined],
    ["Parametric-8", "Equalizer", [80, 0], "#0a74e0", undefined],
    ["IR", "IR Loader", [160, 82], "#6954ff", undefined],
    ["Crying Wah", "Wah", [320, 82], "#959595", undefined],
    ["FX Loop 2", "FX Loop", [0, 0], "#959595", undefined],
    ["Looper X", "Looper", [320, 0], "#ff2727", undefined],
    ["Gain", "Utility", [400, 82], "#959595", undefined]
  ];
  for (const [name, category, tile, color, glyph] of cases) {
    const visual = officialBlockVisual(block(name, category));
    assert.deepEqual(visual.tile, tile, `${name} tile`);
    assert.equal(visual.color, color, `${name} color`);
    assert.equal(visual.glyph, glyph, `${name} glyph`);
  }
});
