import type { GridBlock } from "@ndsp-qc/client";

export type OfficialBlockVisualKey =
  | "plugin" | "amp" | "capture" | "cab" | "overdrive" | "delay" | "reverb"
  | "compressor" | "pitch" | "modulation" | "morph" | "synth" | "filter"
  | "equalizer" | "ir-loader" | "wah" | "fx-loop" | "looper" | "utility" | "gate";

export interface OfficialBlockVisual {
  key: OfficialBlockVisualKey;
  tile: [number, number];
  color: string;
  referenceAsset?: "delay" | "compressor";
}

export interface OfficialBlockCategory extends OfficialBlockVisual {
  label: string;
  meaning: string;
}

// CorOS 4.1 manual order. Tile coordinates point into Neural DSP's bundled
// qc-block-samples.svg; colors are the literal SVG border colors.
export const OFFICIAL_BLOCK_CATEGORIES: readonly OfficialBlockCategory[] = [
  { key: "plugin", label: "Plugins", tile: [560, 0], color: "#ff7000", meaning: "Compatible Neural DSP X plugin devices." },
  { key: "amp", label: "Amp", tile: [480, 0], color: "#ff2727", meaning: "Amplifier devices for guitar and bass." },
  { key: "capture", label: "Neural Capture", tile: [640, 0], color: "#959595", meaning: "Neural Capture devices." },
  { key: "cab", label: "Cab", tile: [80, 82], color: "#6954ff", meaning: "Mono and stereo cabinet simulations with selectable microphones." },
  { key: "overdrive", label: "Overdrive", tile: [400, 0], color: "#ffd236", meaning: "Boost, distortion, fuzz, and overdrive pedal devices." },
  { key: "delay", label: "Delay", tile: [240, 0], color: "#00ffdd", meaning: "Mono and stereo digital, analog, and tape delays." },
  { key: "reverb", label: "Reverb", tile: [240, 82], color: "#00ffdd", meaning: "Digital and analog reverbs." },
  { key: "compressor", label: "Compressor", tile: [400, 82], color: "#45f862", meaning: "Mono, stereo, and side-chain dynamics processors." },
  { key: "pitch", label: "Pitch", tile: [0, 82], color: "#ffd236", meaning: "Pitch shifter devices." },
  { key: "modulation", label: "Modulation", tile: [160, 0], color: "#3500f1", meaning: "Chorus, flanger, phaser, tremolo, and other modulation devices." },
  { key: "morph", label: "Morph", tile: [640, 82], color: "#959595", meaning: "Complex audio processor devices." },
  { key: "synth", label: "Synth", tile: [480, 82], color: "#e44a5d", meaning: "Devices that generate sounds by shaping and manipulating waveforms." },
  { key: "filter", label: "Filter", tile: [560, 82], color: "#87daff", meaning: "Dynamic and fixed filter devices." },
  { key: "equalizer", label: "EQ", tile: [80, 0], color: "#0a74e0", meaning: "Graphic and parametric equalizers." },
  { key: "ir-loader", label: "IR Loader", tile: [160, 82], color: "#6954ff", meaning: "Third-party impulse-response loaders." },
  { key: "wah", label: "Wah", tile: [320, 82], color: "#959595", meaning: "Wah pedal devices." },
  { key: "fx-loop", label: "FX Loop", tile: [0, 0], color: "#959595", meaning: "External-device integration through Send and Return ports." },
  { key: "looper", label: "Looper", tile: [320, 0], color: "#ff2727", meaning: "Real-time audio recording and layering." },
  { key: "utility", label: "Utility", tile: [400, 82], color: "#959595", meaning: "Routing, mixing, gain, and other audio tools." }
];

export const OFFICIAL_BLOCK_VISUALS = Object.fromEntries(
  OFFICIAL_BLOCK_CATEGORIES.map(({ key, tile, color }) => [key, { key, tile, color }])
) as Record<Exclude<OfficialBlockVisualKey, "gate">, OfficialBlockVisual> & { gate: OfficialBlockVisual };

// Adaptive Gate is a Utility device, but its Grid artwork is the yellow gate
// graph shown in Neural DSP's official Brit 2203 reference preset.
OFFICIAL_BLOCK_VISUALS.gate = { key: "gate", tile: [0, 82], color: "#ffd236" };

export function officialBlockVisual(block: GridBlock): OfficialBlockVisual {
  const category = `${block.category ?? ""} ${block.kind ?? ""}`.toLowerCase();
  const name = block.name.toLowerCase();
  if (name.includes("gate")) return OFFICIAL_BLOCK_VISUALS.gate;
  if (category.includes("plugin")) return OFFICIAL_BLOCK_VISUALS.plugin;
  if (category.includes("neural capture") || category.includes("capture")) return OFFICIAL_BLOCK_VISUALS.capture;
  if (category.includes("amplifier") || /(^|\s)amp(\s|$)/.test(category)) return OFFICIAL_BLOCK_VISUALS.amp;
  if (category.includes("looper")) return OFFICIAL_BLOCK_VISUALS.looper;
  if (category.includes("ir loader")) return OFFICIAL_BLOCK_VISUALS["ir-loader"];
  if (category.includes("cab") || category.includes("impulse response")) return OFFICIAL_BLOCK_VISUALS.cab;
  if (["overdrive", "distortion", "drive", "boost", "fuzz"].some((term) => category.includes(term))) return OFFICIAL_BLOCK_VISUALS.overdrive;
  if (category.includes("delay")) return OFFICIAL_BLOCK_VISUALS.delay;
  if (category.includes("reverb")) return OFFICIAL_BLOCK_VISUALS.reverb;
  if (category.includes("compressor")) return OFFICIAL_BLOCK_VISUALS.compressor;
  if (category.includes("pitch") || name.includes("octav")) return OFFICIAL_BLOCK_VISUALS.pitch;
  if (category.includes("modulation") || /(^|\s)mod(\s|$)/.test(category) || ["chorus", "flanger", "phaser", "tremolo", "vibrato"].some((term) => category.includes(term))) return OFFICIAL_BLOCK_VISUALS.modulation;
  if (category.includes("morph")) return OFFICIAL_BLOCK_VISUALS.morph;
  if (category.includes("synth")) return OFFICIAL_BLOCK_VISUALS.synth;
  if (category.includes("filter")) return OFFICIAL_BLOCK_VISUALS.filter;
  if (category.includes("equalizer") || /(^|\s)eq(\s|$)/.test(category)) return OFFICIAL_BLOCK_VISUALS.equalizer;
  if (category.includes("wah")) return OFFICIAL_BLOCK_VISUALS.wah;
  if (category.includes("fx loop") || category.includes("effects loop")) return OFFICIAL_BLOCK_VISUALS["fx-loop"];
  return OFFICIAL_BLOCK_VISUALS.utility;
}
