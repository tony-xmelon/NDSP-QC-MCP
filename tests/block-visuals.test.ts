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

test("gate models use the official gate visual rather than generic Utility or Pitch", () => {
  const visual = officialBlockVisual(block("Adaptive Gate", "Utility"));
  assert.equal(visual.key, "gate");
  assert.deepEqual(visual.tile, [0, 82]);
  assert.equal(visual.color, "#ffd236");
});

test("live ICFTF models resolve to their distinct official symbols", () => {
  assert.deepEqual(officialBlockVisual(block("Analog Delay", "Delay")).tile, [160, 82]);
  assert.deepEqual(officialBlockVisual(block("Mind Hall", "Reverb")).tile, [240, 82]);
  assert.deepEqual(officialBlockVisual(block("US DLX 65 Reissue", "Amplifier")).tile, [480, 0]);
  assert.deepEqual(officialBlockVisual(block("112 US DLX Black C12K 00s (ST)", "Cab")).tile, [80, 82]);
});
