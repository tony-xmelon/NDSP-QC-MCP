import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { demoSnapshot, type GridBlock } from "../packages/typescript/qc-client/src/index.ts";
import { OFFICIAL_BLOCK_CATEGORIES, officialBlockVisual, type OfficialBlockVisualKey } from "../packages/typescript/qc-ui/src/block-visuals.ts";

const block = (name: string, category: string, kind = "utility"): GridBlock => ({ id: name, name, category, kind, row: 0, column: 0 });

const expectedCategories: Array<[OfficialBlockVisualKey, string, [number, number], string]> = [
  ["plugin", "Plugins", [560, 0], "#ff7000"],
  ["amp", "Amp", [480, 0], "#ff2727"],
  ["capture", "Neural Capture", [640, 0], "#959595"],
  ["cab", "Cab", [80, 82], "#6954ff"],
  ["overdrive", "Overdrive", [400, 0], "#ffd236"],
  ["delay", "Delay", [240, 0], "#00ffdd"],
  ["reverb", "Reverb", [240, 82], "#00ffdd"],
  ["compressor", "Compressor", [400, 82], "#45f862"],
  ["pitch", "Pitch", [0, 82], "#ffd236"],
  ["modulation", "Modulation", [160, 0], "#3500f1"],
  ["morph", "Morph", [640, 82], "#959595"],
  ["synth", "Synth", [480, 82], "#e44a5d"],
  ["filter", "Filter", [560, 82], "#87daff"],
  ["equalizer", "EQ", [80, 0], "#0a74e0"],
  ["ir-loader", "IR Loader", [160, 82], "#6954ff"],
  ["wah", "Wah", [320, 82], "#959595"],
  ["fx-loop", "FX Loop", [0, 0], "#959595"],
  ["looper", "Looper", [320, 0], "#ff2727"],
  ["utility", "Utility", [400, 82], "#959595"]
];

test("vendored block sprite remains byte-identical to the verified Neural DSP SVG", () => {
  const bytes = readFileSync("apps/windows/public/qc-block-samples.svg");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "24198023488bada41bffd5fbfe8c59b5f144fc1e3c762c57037ff07890bbccea");
});

test("category registry matches the complete CorOS manual order, icon, color, and meaning", () => {
  assert.equal(OFFICIAL_BLOCK_CATEGORIES.length, 19);
  assert.deepEqual(
    OFFICIAL_BLOCK_CATEGORIES.map(({ key, label, tile, color }) => [key, label, tile, color]),
    expectedCategories
  );
  for (const category of OFFICIAL_BLOCK_CATEGORIES) assert.ok(category.meaning.length > 12, `${category.label} needs a meaning`);
});

test("official category mapping covers every Quad Cortex virtual-device family", () => {
  const names = [
    "Plugin Device", "US DLX", "Capture", "112 US DLX", "Rodent Drive", "Analog Delay", "Mind Hall",
    "Jewel", "Poly Octaver", "Phaser", "Freeze", "Synth", "Envelope", "Parametric-8", "IR",
    "Crying Wah", "FX Loop 2", "Looper X", "Gain"
  ];
  expectedCategories.forEach(([expected, category], index) => {
    assert.equal(officialBlockVisual(block(names[index], category)).key, expected, `${category} should use ${expected}`);
  });
});

test("category aliases keep device-list terminology attached to the correct family", () => {
  const cases: Array<[string, string, OfficialBlockVisualKey]> = [
    ["Chief Fuzz", "Fuzz pedals", "overdrive"],
    ["Graphic-9", "Equalizer", "equalizer"],
    ["Vintage Tremolo", "Mod", "modulation"],
    ["Dual Octaver", "", "pitch"],
    ["Plugin Device", "Plugins", "plugin"],
    ["Looper X", "Looper", "looper"]
  ];
  for (const [name, category, expected] of cases) assert.equal(officialBlockVisual(block(name, category)).key, expected);
});

test("Adaptive Gate uses the yellow gate artwork shown in the official Brit 2203 reference", () => {
  const visual = officialBlockVisual(block("Adaptive Gate", "Utility"));
  assert.equal(visual.key, "gate");
  assert.deepEqual(visual.tile, [0, 82]);
  assert.equal(visual.color, "#ffd236");
});

test("demo presents all 19 official categories in order and all 11 Grid colors", () => {
  const visuals = demoSnapshot.blocks
    .filter((item) => item.kind !== "input" && item.kind !== "output")
    .map((item) => officialBlockVisual(item));
  assert.deepEqual(visuals.map(({ key }) => key), expectedCategories.map(([key]) => key));
  assert.deepEqual(new Set(visuals.map(({ color }) => color)), new Set([
    "#ff7000", "#ff2727", "#959595", "#6954ff", "#ffd236", "#00ffdd",
    "#45f862", "#3500f1", "#e44a5d", "#87daff", "#0a74e0"
  ]));
  assert.ok(demoSnapshot.blocks.every((item) => !item.bypassed), "reference colors must be shown at full intensity");
});
