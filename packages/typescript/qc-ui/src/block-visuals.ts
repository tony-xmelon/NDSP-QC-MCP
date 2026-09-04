import type { GridBlock } from "@ndsp-qc/client";

export type OfficialBlockVisualKey =
  | "plugin" | "amp" | "capture" | "cab" | "overdrive" | "delay" | "reverb"
  | "compressor" | "pitch" | "modulation" | "morph" | "synth" | "filter"
  | "equalizer" | "ir-loader" | "wah" | "fx-loop" | "looper" | "utility";

export interface OfficialBlockVisual {
  key: OfficialBlockVisualKey;
  tile: [number, number];
  color: string;
  referenceAsset?: "pitch" | "delay" | "compressor";
}

export interface OfficialBlockCategory extends OfficialBlockVisual {
  label: string;
  meaning: string;
}

// CorOS 4.1 manual order. The official block-samples sheet is deliberately
// *not* category ordered: coordinates below are matched by glyph. Delay and
// Compressor are taken from verified Neural DSP Grid references because that
// sheet does not contain their device glyphs.
export const OFFICIAL_BLOCK_CATEGORIES: readonly OfficialBlockCategory[] = [
  { key: "plugin", label: "Plugins", tile: [560, 0], color: "#ff7000", meaning: "Compatible Neural DSP X plugin devices." },
  { key: "amp", label: "Amp", tile: [480, 0], color: "#ff2727", meaning: "Amplifier devices for guitar and bass." },
  { key: "capture", label: "Neural Capture", tile: [640, 0], color: "#959595", meaning: "Neural Capture devices." },
  { key: "cab", label: "Cab", tile: [80, 82], color: "#6954ff", meaning: "Mono and stereo cabinet simulations with selectable microphones." },
  { key: "overdrive", label: "Overdrive", tile: [400, 0], color: "#ffd236", meaning: "Boost, distortion, fuzz, and overdrive pedal devices." },
  { key: "delay", label: "Delay", tile: [240, 0], color: "#00ffdd", referenceAsset: "delay", meaning: "Mono and stereo digital, analog, and tape delays." },
  { key: "reverb", label: "Reverb", tile: [240, 82], color: "#00ffdd", meaning: "Digital and analog reverbs." },
  { key: "compressor", label: "Compressor", tile: [400, 82], color: "#45f862", referenceAsset: "compressor", meaning: "Mono, stereo, and side-chain dynamics processors." },
  { key: "pitch", label: "Pitch", tile: [0, 82], color: "#ffd236", referenceAsset: "pitch", meaning: "Pitch shifter devices." },
  { key: "modulation", label: "Modulation", tile: [160, 0], color: "#3500f1", meaning: "Chorus, flanger, phaser, tremolo, and other modulation devices." },
  { key: "morph", label: "Morph", tile: [560, 82], color: "#87daff", meaning: "Complex audio processor devices." },
  { key: "synth", label: "Synth", tile: [480, 82], color: "#e44a5d", meaning: "Devices that generate sounds by shaping and manipulating waveforms." },
  { key: "filter", label: "Filter", tile: [240, 0], color: "#87daff", meaning: "Dynamic and fixed filter devices." },
  { key: "equalizer", label: "EQ", tile: [80, 0], color: "#0a74e0", meaning: "Graphic and parametric equalizers." },
  { key: "ir-loader", label: "IR Loader", tile: [160, 82], color: "#6954ff", meaning: "Third-party impulse-response loaders." },
  { key: "wah", label: "Wah", tile: [320, 82], color: "#959595", meaning: "Wah pedal devices." },
  { key: "fx-loop", label: "FX Loop", tile: [0, 0], color: "#959595", meaning: "External-device integration through Send and Return ports." },
  { key: "looper", label: "Looper", tile: [320, 0], color: "#ff2727", meaning: "Real-time audio recording and layering." },
  { key: "utility", label: "Utility", tile: [400, 82], color: "#959595", meaning: "Routing, mixing, gain, and other audio tools." }
];

export const OFFICIAL_BLOCK_VISUALS = Object.fromEntries(
  OFFICIAL_BLOCK_CATEGORIES.map(({ key, tile, color, referenceAsset }) => [key, { key, tile, color, referenceAsset }])
) as Record<OfficialBlockVisualKey, OfficialBlockVisual>;

export function officialBlockVisual(block: GridBlock): OfficialBlockVisual {
  const category = `${block.category ?? ""} ${block.kind ?? ""}`.toLowerCase();
  const name = block.name.toLowerCase();
  if (category.includes("plugin")) return OFFICIAL_BLOCK_VISUALS.plugin;
  if (category.includes("neural capture") || category.includes("capture")) return OFFICIAL_BLOCK_VISUALS.capture;
  if (category.includes("amplifier") || /(^|\s)amp(\s|$)/.test(category)) return OFFICIAL_BLOCK_VISUALS.amp;
  if (category.includes("looper")) return OFFICIAL_BLOCK_VISUALS.looper;
  if (category.includes("ir loader") || category.includes("irloader")) return OFFICIAL_BLOCK_VISUALS["ir-loader"];
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

/** Cortex Control's *NormalPlugin SVGs use a 30% category-color interior fill. */
export function blockUsesActiveFill(block: GridBlock): boolean {
  const category = `${block.category ?? ""}`.toLowerCase();
  return block.bypassed !== true && (block.plugin === true || category.includes("plugin"));
}

export interface PublishedPluginBadge {
  abbreviation: string;
  name: string;
  aliases: readonly string[];
}

/** CorOS 4.1 / Cortex Control 4.1 published PCOM badge vocabulary. */
export const PUBLISHED_PLUGIN_BADGES: readonly PublishedPluginBadge[] = [
  { abbreviation: "PLI", name: "Archetype: Plini X", aliases: ["plini-x", "plinix", "plini"] },
  { abbreviation: "GOJ", name: "Archetype: Gojira X", aliases: ["gojira-x", "gojirax", "gojira"] },
  { abbreviation: "SLO", name: "Soldano SLO-100 X", aliases: ["slo100-x", "slo100x", "soldano", "slo-100"] },
  { abbreviation: "NAM", name: "Fortin Nameless Suite X", aliases: ["nameless-x", "namelessx", "nameless"] },
  { abbreviation: "WON", name: "Archetype: Cory Wong X", aliases: ["cory-x", "coryx", "cory-wong", "cory wong", "neural_dsp_cory_wong"] },
  { abbreviation: "NLY", name: "Archetype: Nolly X", aliases: ["nolly-x", "nollyx", "nolly"] },
  { abbreviation: "PLX", name: "Parallax X", aliases: ["parallax-x", "parallaxx", "parallax"] },
  { abbreviation: "MAY", name: "Archetype: John Mayer X", aliases: ["mayer-x", "mayerx", "john-mayer", "john mayer", "neural_dsp_mayer"] },
  { abbreviation: "PET", name: "Archetype: Petrucci X", aliases: ["petrucci-x", "petruccix", "petrucci"] },
  { abbreviation: "MSH", name: "Archetype: Misha Mansoor X", aliases: ["misha-x", "mishax", "misha-mansoor", "misha mansoor"] },
  { abbreviation: "RAB", name: "Archetype: Rabea X", aliases: ["rabea-x", "rabeax", "rabea"] },
  { abbreviation: "HEN", name: "Archetype: Tim Henson X", aliases: ["henson-x", "hensonx", "tim-henson", "tim henson"] }
] as const;

const normalizedPluginIdentity = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Returns the exact three-letter QC badge for a published plugin device. */
export function pluginBadge(block: GridBlock): string | undefined {
  if (block.plugin !== true && !`${block.category ?? ""}`.toLowerCase().includes("plugin")) return undefined;
  const identities = [block.pluginId, block.name].filter((value): value is string => Boolean(value)).map(normalizedPluginIdentity);
  for (const published of PUBLISHED_PLUGIN_BADGES) {
    if (published.aliases.some((alias) => {
      const normalizedAlias = normalizedPluginIdentity(alias);
      return identities.some((identity) => identity === normalizedAlias || identity.includes(normalizedAlias));
    })) return published.abbreviation;
  }
  // Keep future catalog additions visible until their official code is added.
  const fallback = normalizedPluginIdentity(block.pluginId ?? "").replace(/(?:archetype|neuraldsp|suite|plugin|x)$/g, "");
  return fallback ? fallback.slice(0, 3).toUpperCase() : undefined;
}
