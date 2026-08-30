export type ConnectionPhase =
  | "disconnected"
  | "discovering"
  | "opening"
  | "handshaking"
  | "syncing"
  | "ready"
  | "degraded"
  | "needs-attention";

export interface ConnectionState {
  phase: ConnectionPhase;
  detail: string;
  lastSync?: string;
  demo: boolean;
}

export type BlockKind = "input" | "utility" | "capture" | "amp" | "cab" | "mod" | "delay" | "reverb" | "output";
export type BlockGlyph = BlockKind | "cube" | "gate" | "compressor" | "capture-grid" | "wave" | "level";

export interface GridBlock {
  id: string;
  name: string;
  kind: BlockKind;
  row: number;
  column: number;
  bypassed?: boolean;
  color?: string;
  glyph?: BlockGlyph;
}

export interface PresetSnapshot {
  deviceName: string;
  presetName: string;
  presetLocation: string;
  mode: "PRESET" | "SCENE" | "STOMP" | "HYBRID";
  activeScene: number;
  scenes: string[];
  blocks: GridBlock[];
  tempo: number;
  dirty: boolean;
}

export const demoSnapshot: PresetSnapshot = {
  deviceName: "Quad Cortex",
  presetName: "Brit 2203",
  presetLocation: "1A",
  mode: "PRESET",
  activeScene: 0,
  scenes: ["Clean", "Edge", "Crunch", "Lead", "Ambient", "Octave", "Solo +", "Mute"],
  tempo: 120,
  dirty: false,
  blocks: [
    { id: "in-1", name: "IN 1", kind: "input", row: 0, column: -1 },
    { id: "gate", name: "Gate", kind: "utility", row: 0, column: 0, bypassed: true, glyph: "gate" },
    { id: "capture", name: "OD Capture", kind: "capture", row: 0, column: 1, bypassed: true, glyph: "compressor" },
    { id: "row-1-mod-a", name: "Vintage Chorus", kind: "mod", row: 0, column: 2, bypassed: true, glyph: "capture-grid" },
    { id: "row-1-mod-b", name: "Analog Flanger", kind: "mod", row: 0, column: 3, bypassed: true, glyph: "wave" },
    { id: "chorus", name: "Dimension", kind: "mod", row: 0, column: 4, bypassed: true, glyph: "wave" },
    { id: "cab", name: "4x12 UK V30", kind: "cab", row: 0, column: 5, glyph: "amp" },
    { id: "amp", name: "British 2203", kind: "amp", row: 0, column: 6, color: "#ededed", glyph: "capture" },
    { id: "delay", name: "Digital Delay", kind: "delay", row: 0, column: 7, color: "#625cff", glyph: "cab" },
    { id: "out-3", name: "OUT 3", kind: "output", row: 0, column: 8 },
    { id: "in-usb", name: "USB 5", kind: "input", row: 2, column: -1 },
    { id: "pitch", name: "Dual Octaver", kind: "mod", row: 2, column: 1, bypassed: true, glyph: "level" },
    { id: "row-3-mod-a", name: "Vintage Tremolo", kind: "mod", row: 2, column: 2, color: "#ededed", glyph: "capture" },
    { id: "row-3-mod-b", name: "Dimension B", kind: "mod", row: 2, column: 3, bypassed: true, glyph: "wave" },
    { id: "row-3-amp", name: "British Lead", kind: "amp", row: 2, column: 4, bypassed: true, glyph: "wave" },
    { id: "row-3-cab", name: "2x12 Cream", kind: "cab", row: 2, column: 5, color: "#26d6c6", glyph: "cube" },
    { id: "row-3-out", name: "Looper X", kind: "cab", row: 2, column: 7, glyph: "reverb" },
    { id: "out-usb", name: "USB 3/4", kind: "output", row: 2, column: 8 }
  ]
};

export interface RuntimeStatus {
  platform: string;
  gatewayAvailable: boolean;
  message: string;
}

export interface GatewayTransport {
  runtimeStatus(): Promise<RuntimeStatus>;
  reconnect(): Promise<ConnectionState>;
  resetSession(): Promise<ConnectionState>;
}
