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

export interface GridBlock {
  id: string;
  name: string;
  kind: BlockKind;
  row: number;
  column: number;
  bypassed?: boolean;
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
  presetName: "Studio Wide Lead",
  presetLocation: "3C",
  mode: "SCENE",
  activeScene: 1,
  scenes: ["Clean", "Edge", "Crunch", "Lead", "Ambient", "Octave", "Solo +", "Mute"],
  tempo: 120,
  dirty: false,
  blocks: [
    { id: "in-1", name: "IN 1", kind: "input", row: 0, column: 0 },
    { id: "gate", name: "Gate", kind: "utility", row: 0, column: 1 },
    { id: "capture", name: "OD Capture", kind: "capture", row: 0, column: 2 },
    { id: "amp", name: "British 2203", kind: "amp", row: 0, column: 3 },
    { id: "cab", name: "4x12 UK V30", kind: "cab", row: 0, column: 4 },
    { id: "chorus", name: "Dimension", kind: "mod", row: 0, column: 5, bypassed: true },
    { id: "delay", name: "Digital Delay", kind: "delay", row: 0, column: 6 },
    { id: "out-3", name: "OUT 3", kind: "output", row: 0, column: 7 },
    { id: "in-usb", name: "USB 5", kind: "input", row: 1, column: 0 },
    { id: "pitch", name: "Dual Octaver", kind: "mod", row: 1, column: 2, bypassed: true },
    { id: "reverb", name: "Mind Hall", kind: "reverb", row: 1, column: 5 },
    { id: "out-usb", name: "USB 3/4", kind: "output", row: 1, column: 7 }
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
