import type { GridBlock, PresetSnapshot } from "@ndsp-qc/client";

export interface FootswitchLed {
  active: boolean;
  assigned: boolean;
  color: string;
}

const QC_SCENE_COLORS = ["#ff2727", "#0a74e0", "#ffd236", "#ff02c2", "#45f862", "#ff7000", "#6954ff", "#00ffdd"];

function blockLedColor(block: GridBlock): string {
  if (block.color) return block.color;
  const category = (block.category ?? block.kind).toLowerCase();
  const name = block.name.toLowerCase();
  if (name.includes("gate")) return "#ffd236";
  if (category.includes("equalizer")) return "#0a74e0";
  if (category.includes("pitch") || category.includes("modulation") || block.kind === "mod") return "#3500f1";
  if (category.includes("overdrive") || category.includes("drive") || category.includes("capture") || block.kind === "capture") return "#ff7000";
  if (category.includes("amplifier") || block.kind === "amp") return "#ff2727";
  if (category.includes("cab") || category.includes("delay") || category.includes("reverb") || ["cab", "delay", "reverb"].includes(block.kind)) return "#6954ff";
  if (category.includes("wah")) return "#ffd236";
  if (category.includes("loop")) return "#00ffdd";
  return "#959595";
}

function stompLed(snapshot: PresetSnapshot, index: number): FootswitchLed {
  const reported = snapshot.footswitchStates?.find((state) => state.index === index);
  if (reported) return { active: reported.active, assigned: reported.assigned, color: reported.color };
  const assigned = snapshot.blocks
    .filter((block) => block.footswitch === index)
    .sort((left, right) => (left.footswitchOrder ?? Number.MAX_SAFE_INTEGER) - (right.footswitchOrder ?? Number.MAX_SAFE_INTEGER));
  if (!assigned.length) return { active: false, assigned: false, color: "#626367" };
  const leader = assigned[0];
  return {
    active: !leader.bypassed,
    assigned: true,
    color: blockLedColor(leader)
  };
}

function sceneLed(snapshot: PresetSnapshot, index: number): FootswitchLed {
  return {
    active: snapshot.activeScene === index,
    assigned: true,
    color: snapshot.sceneColors?.[index] ?? QC_SCENE_COLORS[index]
  };
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
  return Array.from({ length: 8 }, (_, index) => {
    const mode = rowModes[index < 4 ? 0 : 1];
    if (mode === "STOMP") return stompLed(snapshot, index);
    if (mode === "PRESET") return presetLed(snapshot, index);
    return sceneLed(snapshot, index);
  });
}
