import type { GridBlock } from "@ndsp-qc/client";

export type OfficialBlockVisualKey =
  | "plugin" | "amp" | "capture" | "cab" | "overdrive" | "delay" | "reverb"
  | "compressor" | "pitch" | "modulation" | "morph" | "synth" | "filter"
  | "equalizer" | "ir-loader" | "wah" | "fx-loop" | "looper" | "utility" | "gate";

export interface OfficialBlockVisual {
  key: OfficialBlockVisualKey;
  tile: [number, number];
  color: string;
}

// Coordinates are taken from Neural DSP's current official QC Block Samples
// sheet. The sheet is a collection of examples, not a category-ordered atlas.
export const OFFICIAL_BLOCK_VISUALS: Record<OfficialBlockVisualKey, OfficialBlockVisual> = {
  plugin: { key: "plugin", tile: [0, 0], color: "#959595" },
  amp: { key: "amp", tile: [480, 0], color: "#ff2727" },
  capture: { key: "capture", tile: [560, 0], color: "#ff7000" },
  cab: { key: "cab", tile: [80, 82], color: "#6954ff" },
  overdrive: { key: "overdrive", tile: [400, 0], color: "#ff7000" },
  delay: { key: "delay", tile: [160, 82], color: "#00ffdd" },
  reverb: { key: "reverb", tile: [240, 82], color: "#00ffdd" },
  compressor: { key: "compressor", tile: [640, 82], color: "#45f862" },
  pitch: { key: "pitch", tile: [480, 82], color: "#e44a5d" },
  modulation: { key: "modulation", tile: [160, 0], color: "#3500f1" },
  morph: { key: "morph", tile: [560, 82], color: "#87daff" },
  synth: { key: "synth", tile: [640, 0], color: "#959595" },
  filter: { key: "filter", tile: [0, 82], color: "#ffd236" },
  equalizer: { key: "equalizer", tile: [80, 0], color: "#0a74e0" },
  "ir-loader": { key: "ir-loader", tile: [240, 0], color: "#87daff" },
  wah: { key: "wah", tile: [400, 82], color: "#959595" },
  "fx-loop": { key: "fx-loop", tile: [0, 0], color: "#00ffdd" },
  looper: { key: "looper", tile: [320, 0], color: "#ff2727" },
  utility: { key: "utility", tile: [0, 0], color: "#959595" },
  gate: { key: "gate", tile: [0, 82], color: "#ffd236" }
};

export function officialBlockVisual(block: GridBlock): OfficialBlockVisual {
  const category = `${block.category ?? ""} ${block.kind ?? ""}`.toLowerCase();
  const name = block.name.toLowerCase();
  if (name.includes("gate")) return OFFICIAL_BLOCK_VISUALS.gate;
  if (category.includes("neural capture") || category.includes("capture")) return OFFICIAL_BLOCK_VISUALS.capture;
  if (category.includes("amplifier") || /(^|\s)amp(\s|$)/.test(category)) return OFFICIAL_BLOCK_VISUALS.amp;
  if (category.includes("ir loader")) return OFFICIAL_BLOCK_VISUALS["ir-loader"];
  if (category.includes("cab") || category.includes("impulse response")) return OFFICIAL_BLOCK_VISUALS.cab;
  if (category.includes("overdrive") || category.includes("distortion") || category.includes("drive")) return OFFICIAL_BLOCK_VISUALS.overdrive;
  if (category.includes("delay")) return OFFICIAL_BLOCK_VISUALS.delay;
  if (category.includes("reverb")) return OFFICIAL_BLOCK_VISUALS.reverb;
  if (category.includes("compressor")) return OFFICIAL_BLOCK_VISUALS.compressor;
  if (category.includes("pitch")) return OFFICIAL_BLOCK_VISUALS.pitch;
  if (category.includes("modulation") || category.includes("chorus") || category.includes("flanger") || category.includes("phaser")) return OFFICIAL_BLOCK_VISUALS.modulation;
  if (category.includes("morph")) return OFFICIAL_BLOCK_VISUALS.morph;
  if (category.includes("synth")) return OFFICIAL_BLOCK_VISUALS.synth;
  if (category.includes("filter")) return OFFICIAL_BLOCK_VISUALS.filter;
  if (category.includes("equalizer") || /(^|\s)eq(\s|$)/.test(category)) return OFFICIAL_BLOCK_VISUALS.equalizer;
  if (category.includes("wah")) return OFFICIAL_BLOCK_VISUALS.wah;
  if (category.includes("fx loop") || category.includes("effects loop")) return OFFICIAL_BLOCK_VISUALS["fx-loop"];
  if (category.includes("looper")) return OFFICIAL_BLOCK_VISUALS.looper;
  if (category.includes("plugin")) return OFFICIAL_BLOCK_VISUALS.plugin;
  return OFFICIAL_BLOCK_VISUALS.utility;
}
