import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { demoSnapshot, type GridBlock } from "../packages/typescript/qc-client/src/index.ts";
import { blockUsesActiveFill, OFFICIAL_BLOCK_CATEGORIES, officialBlockVisual, pluginBadge, PUBLISHED_PLUGIN_BADGES, type OfficialBlockVisualKey } from "../packages/typescript/qc-ui/src/block-visuals.ts";
import { REFERENCE_BLOCK_ICONS } from "../packages/typescript/qc-ui/src/reference-block-icons.ts";

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
  ["morph", "Morph", [560, 82], "#87daff"],
  ["synth", "Synth", [480, 82], "#e44a5d"],
  ["filter", "Filter", [240, 0], "#87daff"],
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

test("isolated reference assets cannot silently fall back to unrelated sprite tiles", () => {
  const hashes = {
    delay: "dee665d53bfd3f7ed33c5f0185424390d5b9639087881c5dd8624c7018c5283e",
    compressor: "ca7d1c3842f5cc3784e34c23c4567c788fa597ad9db6bd05647cf54d3dec2faa"
  } as const;
  for (const [name, source] of Object.entries(REFERENCE_BLOCK_ICONS).filter(([name]) => name === "delay" || name === "compressor")) {
    const bytes = Buffer.from(source.slice(source.indexOf(",") + 1), "base64");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), hashes[name as keyof typeof hashes]);
  }
  assert.equal(officialBlockVisual(block("Digital Delay", "Delay")).referenceAsset, "delay");
  assert.equal(officialBlockVisual(block("Jewel Comp", "Compressor")).referenceAsset, "compressor");
  assert.equal(officialBlockVisual(block("Transpose", "Pitch")).referenceAsset, "pitch");
});

test("Morph, Filter, Utility Gate, and Pitch remain attached to their verified vector glyphs", () => {
  assert.deepEqual(officialBlockVisual(block("Freeze", "Morph")).tile, [560, 82]);
  assert.deepEqual(officialBlockVisual(block("Envelope Filter", "Filter")).tile, [240, 0]);
  assert.deepEqual(officialBlockVisual(block("Adaptive Gate", "Utility")).tile, [400, 82]);
  assert.equal(officialBlockVisual(block("Adaptive Gate", "Utility")).referenceAsset, undefined);
  assert.equal(officialBlockVisual(block("Dual Octaver", "Pitch")).referenceAsset, "pitch");
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

test("Adaptive Gate uses official gray Utility artwork rather than the yellow Pitch glyph", () => {
  const visual = officialBlockVisual(block("Adaptive Gate", "Utility"));
  assert.equal(visual.key, "utility");
  assert.deepEqual(visual.tile, [400, 82]);
  assert.equal(visual.referenceAsset, undefined);
  assert.equal(visual.color, "#959595");
});

test("only enabled plugin devices use Cortex Control's colored interior fill", () => {
  assert.equal(blockUsesActiveFill({ ...block("British 2203", "Amp", "amp"), plugin: false }), false);
  assert.equal(blockUsesActiveFill({ ...block("Plugin Amp", "Amp", "amp"), plugin: true }), true);
  assert.equal(blockUsesActiveFill({ ...block("Plugin Device", "Plugins"), bypassed: false }), true);
  assert.equal(blockUsesActiveFill({ ...block("Plugin Device", "Plugins"), plugin: true, bypassed: true }), false);
});

test("all published CorOS 4.1 plugins use Cortex Control's exact Grid abbreviations", () => {
  const expected = new Map([
    ["plini-x", "PLI"], ["gojira-x", "GOJ"], ["slo100-x", "SLO"], ["nameless-x", "NAM"],
    ["cory-x", "WON"], ["nolly-x", "NLY"], ["parallax-x", "PLX"], ["mayer-x", "MAY"],
    ["petrucci-x", "PET"], ["misha-x", "MSH"], ["rabea-x", "RAB"], ["henson-x", "HEN"]
  ]);
  assert.equal(PUBLISHED_PLUGIN_BADGES.length, expected.size);
  for (const [pluginId, abbreviation] of expected) {
    assert.equal(pluginBadge({ ...block("Generic plugin device", "Amp", "amp"), plugin: true, pluginId }), abbreviation);
  }
  assert.equal(pluginBadge({ ...block("Plini Drive", "Overdrive"), plugin: false, pluginId: "plini-x" }), undefined);
});

test("the reference registry includes all 19 categories and all official Grid colors", () => {
  assert.deepEqual(OFFICIAL_BLOCK_CATEGORIES.map(({ key }) => key), expectedCategories.map(([key]) => key));
  assert.deepEqual(new Set(OFFICIAL_BLOCK_CATEGORIES.map(({ color }) => color)), new Set([
    "#ff7000", "#ff2727", "#959595", "#6954ff", "#ffd236", "#00ffdd",
    "#45f862", "#3500f1", "#e44a5d", "#87daff", "#0a74e0"
  ]));
});

test("the startup reference preset begins with the Gate shown first in Brit 2203", () => {
  const firstEffect = demoSnapshot.blocks.find((item) => item.kind !== "input" && item.kind !== "output");
  assert.equal(firstEffect?.name, "Adaptive Gate");
  assert.equal(firstEffect && officialBlockVisual(firstEffect).key, "utility");
});

test("all 272 catalog devices resolve to their official category artwork", () => {
  const audit = JSON.parse(readFileSync("docs/reference/qc-parameter-catalog.json", "utf8")) as {
    models: Array<{ id: number; name: string; category: string }>;
  };
  const categoryKeys: Record<string, OfficialBlockVisualKey> = {
    "Bass Amplifier": "amp",
    "Bass Overdrive": "overdrive",
    Compressor: "compressor",
    Delay: "delay",
    Equalizer: "equalizer",
    Filter: "filter",
    "FX Loop": "fx-loop",
    "Guitar Amplifier": "amp",
    "Guitar Overdrive": "overdrive",
    IRLoaders: "ir-loader",
    Loopers: "looper",
    Modulation: "modulation",
    Morph: "morph",
    Pitch: "pitch",
    Reverb: "reverb",
    Synth: "synth",
    Utility: "utility",
    Wah: "wah"
  };
  assert.equal(audit.models.length, 272);
  for (const model of audit.models) {
    const expected = categoryKeys[model.category];
    assert.ok(expected, `catalog category ${model.category} needs an explicit visual mapping`);
    assert.equal(officialBlockVisual(block(model.name, model.category)).key, expected, `${model.id} ${model.name}`);
  }
});
