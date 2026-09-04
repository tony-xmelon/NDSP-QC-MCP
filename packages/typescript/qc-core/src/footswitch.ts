import { QC_SCENE_COLORS, QC_SCENE_COUNT, type GridBlock, type PresetSnapshot } from "@ndsp-qc/client";
import { QC_COLORS } from "@ndsp-qc/theme";
import { sceneLetter } from "./state.ts";

export interface FootswitchLed {
  active: boolean;
  assigned: boolean;
  color: string;
}

export type FootswitchIntent =
  | { kind: "select-scene"; scene: number }
  | { kind: "select-preset"; position: number }
  | { kind: "toggle-stomp"; index: number }
  | { kind: "none" };

function stompLedColor(blocks: GridBlock[]): string {
  if (blocks.length > 1) return QC_COLORS.hardware.whiteLed;
  const block = blocks[0];
  const category = `${block.category ?? ""} ${block.kind ?? ""}`.toLowerCase();
  const name = block.name.toLowerCase();
  if (category.includes("plugin")) return QC_COLORS.category.plugin;
  if (category.includes("capture")) return QC_COLORS.hardware.whiteLed;
  if (category.includes("amplifier") || /(^|\s)amp(\s|$)/.test(category)) return QC_COLORS.category.amp;
  if (category.includes("looper")) return QC_COLORS.category.looper;
  if (category.includes("ir loader") || category.includes("irloader")) return QC_COLORS.category.irLoader;
  if (category.includes("cab") || category.includes("impulse response")) return QC_COLORS.category.cab;
  if (["overdrive", "distortion", "drive", "boost", "fuzz"].some((term) => category.includes(term))) return QC_COLORS.category.overdrive;
  if (category.includes("delay")) return QC_COLORS.category.delay;
  if (category.includes("reverb")) return QC_COLORS.category.reverb;
  if (category.includes("compressor")) return QC_COLORS.category.compressor;
  if (category.includes("pitch") || name.includes("octav")) return QC_COLORS.category.pitch;
  if (category.includes("modulation") || /(^|\s)mod(\s|$)/.test(category)) return QC_COLORS.category.modulation;
  if (category.includes("morph")) return QC_COLORS.category.morph;
  if (category.includes("filter")) return QC_COLORS.category.filter;
  if (category.includes("synth")) return QC_COLORS.category.synth;
  if (category.includes("equalizer") || /(^|\s)eq(\s|$)/.test(category)) return QC_COLORS.category.equalizer;
  return QC_COLORS.hardware.whiteLed;
}

function stompLed(snapshot: PresetSnapshot, index: number): FootswitchLed {
  const reported = snapshot.footswitchStates?.find((state) => state.index === index);
  if (reported) return { active: reported.active, assigned: reported.assigned, color: reported.color };
  const assigned = snapshot.blocks
    .filter((block) => block.footswitch === index)
    .sort((left, right) => (left.footswitchOrder ?? Number.MAX_SAFE_INTEGER) - (right.footswitchOrder ?? Number.MAX_SAFE_INTEGER));
  if (!assigned.length) return { active: false, assigned: false, color: QC_COLORS.hardware.idleLed };
  return { active: !assigned[0].bypassed, assigned: true, color: stompLedColor(assigned) };
}

function sceneLed(snapshot: PresetSnapshot, index: number): FootswitchLed {
  return { active: snapshot.activeScene === index, assigned: true, color: snapshot.sceneColors?.[index] ?? QC_SCENE_COLORS[index] };
}

function presetLed(snapshot: PresetSnapshot, index: number): FootswitchLed {
  return {
    active: snapshot.presetPosition % 8 === index,
    assigned: true,
    color: snapshot.sceneColors?.[snapshot.activeScene] ?? QC_SCENE_COLORS[snapshot.activeScene] ?? QC_SCENE_COLORS[0]
  };
}

export function footswitchLeds(snapshot: PresetSnapshot): FootswitchLed[] {
  const fallbackMode = snapshot.mode === "HYBRID" ? "SCENE" : snapshot.mode;
  const rowModes = snapshot.footswitchModes ?? [fallbackMode, fallbackMode];
  return Array.from({ length: QC_SCENE_COUNT }, (_, index) => {
    const mode = rowModes[index < 4 ? 0 : 1];
    if (mode === "STOMP") return stompLed(snapshot, index);
    if (mode === "PRESET") return presetLed(snapshot, index);
    return sceneLed(snapshot, index);
  });
}

export function footswitchIntent(snapshot: PresetSnapshot, index: number): FootswitchIntent {
  if (!Number.isInteger(index) || index < 0 || index >= QC_SCENE_COUNT) return { kind: "none" };
  const fallbackMode = snapshot.mode === "HYBRID" ? "SCENE" : snapshot.mode;
  const mode = snapshot.footswitchModes?.[index < 4 ? 0 : 1] ?? fallbackMode;
  if (mode === "SCENE") return { kind: "select-scene", scene: index };
  if (mode === "PRESET") return { kind: "select-preset", position: Math.floor(snapshot.presetPosition / 8) * 8 + index };
  return snapshot.blocks.some((block) => block.footswitch === index)
    ? { kind: "toggle-stomp", index }
    : { kind: "none" };
}

export function applyFootswitchPreview(snapshot: PresetSnapshot, index: number): PresetSnapshot {
  const intent = footswitchIntent(snapshot, index);
  if (intent.kind === "select-scene") return { ...snapshot, activeScene: intent.scene };
  if (intent.kind === "select-preset") {
    const presetPosition = intent.position;
    return {
      ...snapshot,
      presetPosition,
      presetLocation: `${Math.floor(presetPosition / 8) + 1}${sceneLetter(presetPosition % 8)}`
    };
  }
  if (intent.kind === "toggle-stomp") return optimisticallyPressFootswitch(snapshot, intent.index);
  return snapshot;
}

export function optimisticallyPressFootswitch(snapshot: PresetSnapshot, index: number): PresetSnapshot {
  const fallbackMode = snapshot.mode === "HYBRID" ? "SCENE" : snapshot.mode;
  const rowModes = snapshot.footswitchModes ?? [fallbackMode, fallbackMode];
  if (rowModes[index < 4 ? 0 : 1] !== "STOMP") return snapshot;
  const assignedIds = new Set(snapshot.blocks.filter((block) => block.footswitch === index).map((block) => block.id));
  if (!assignedIds.size) return snapshot;
  return {
    ...snapshot,
    blocks: snapshot.blocks.map((block) => assignedIds.has(block.id) ? { ...block, bypassed: !block.bypassed } : block),
    footswitchStates: snapshot.footswitchStates?.map((state) => state.index === index ? { ...state, active: !state.active } : state)
  };
}
