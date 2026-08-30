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
  modelId?: number;
  name: string;
  kind: BlockKind;
  row: number;
  column: number;
  bypassed?: boolean;
  color?: string;
  glyph?: BlockGlyph;
  footswitch?: number;
}

export interface GridRoute {
  row: number;
  inputId?: number;
  outputId?: number;
  input: string;
  output: string;
  splitColumn?: number;
  mixColumn?: number;
}

export interface PresetSnapshot {
  deviceName: string;
  presetName: string;
  presetLocation: string;
  presetPosition: number;
  setlistKey: string;
  setlistName: string;
  mode: "PRESET" | "SCENE" | "STOMP" | "HYBRID";
  activeScene: number;
  scenes: string[];
  blocks: GridBlock[];
  routes: GridRoute[];
  tempo: number;
  dirty: boolean;
}

export const demoSnapshot: PresetSnapshot = {
  deviceName: "Quad Cortex",
  presetName: "Brit 2203",
  presetLocation: "1A",
  presetPosition: 0,
  setlistKey: "demo",
  setlistName: "Demo Presets",
  mode: "PRESET",
  activeScene: 0,
  scenes: ["Clean", "Edge", "Crunch", "Lead", "Ambient", "Octave", "Solo +", "Mute"],
  tempo: 120,
  dirty: false,
  routes: [
    { row: 0, input: "In 1", output: "Row 3", splitColumn: 5, mixColumn: 7 },
    { row: 1, input: "Internal", output: "Internal" },
    { row: 2, input: "Prev. Row", output: "Internal", splitColumn: 1, mixColumn: -1 },
    { row: 3, input: "Internal", output: "Multi Out" }
  ],
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
    { id: "upper-lane-delay", name: "Tape Echo", kind: "delay", row: 1, column: 6, color: "#625cff", glyph: "wave" },
    { id: "out-3", name: "OUT 3", kind: "output", row: 0, column: 8 },
    { id: "in-usb", name: "USB 5", kind: "input", row: 2, column: -1 },
    { id: "pitch", name: "Dual Octaver", kind: "mod", row: 2, column: 1, bypassed: true, glyph: "level" },
    { id: "row-3-mod-a", name: "Vintage Tremolo", kind: "mod", row: 2, column: 2, color: "#ededed", glyph: "capture" },
    { id: "row-3-mod-b", name: "Dimension B", kind: "mod", row: 2, column: 3, bypassed: true, glyph: "wave" },
    { id: "row-3-amp", name: "British Lead", kind: "amp", row: 2, column: 4, bypassed: true, glyph: "wave" },
    { id: "row-3-cab", name: "2x12 Cream", kind: "cab", row: 2, column: 5, color: "#26d6c6", glyph: "cube" },
    { id: "row-3-out", name: "Looper X", kind: "cab", row: 2, column: 7, glyph: "reverb" },
    { id: "lower-lane-reverb", name: "Plate Reverb", kind: "reverb", row: 3, column: 6, glyph: "reverb" },
    { id: "out-usb", name: "USB 3/4", kind: "output", row: 2, column: 8 }
  ]
};

export interface RuntimeStatus {
  platform: string;
  gatewayAvailable: boolean;
  message: string;
}

export interface DeviceActionResult {
  detail: string;
  snapshot?: PresetSnapshot;
}

export interface ModelEntry {
  id: number;
  name: string;
  category: string;
  basedOn: string;
}

export interface ModelList {
  models: ModelEntry[];
}

export interface PresetEntry {
  position: number;
  location: string;
  name: string;
  instrument: number;
}

export interface PresetList {
  setlistKey: string;
  setlistName: string;
  currentPosition: number;
  presets: PresetEntry[];
}

export interface BlockParameter {
  index: number;
  name: string;
  normalizedValue: number | null;
  displayValue: string;
  units: string;
  type: string;
  minimum: number;
  maximum: number;
  steps: number | null;
  sceneMode: boolean;
  options: string[];
  writable: boolean;
}

export interface BlockDetails {
  row: number;
  column: number;
  modelId: number;
  name: string;
  category: string;
  scene: number;
  parameters: BlockParameter[];
}

export interface ParameterActionResult extends DeviceActionResult {
  block: BlockDetails;
}

export interface WorkspaceDocument {
  version: 1;
  savedAt: string;
  source: {
    deviceName: string;
    setlistKey: string;
    setlistName: string;
    presetPosition: number;
    presetLocation: string;
    presetName: string;
  };
  snapshot: PresetSnapshot;
  selectedBlock?: BlockDetails;
  ui: {
    selectedBlockId: string;
    formFactorId: string;
    skinId: string;
  };
}

export interface WorkspaceFileResult {
  cancelled: boolean;
  path?: string;
  name?: string;
  document?: WorkspaceDocument;
}

export interface DiagnosticsReport {
  generatedAt: string;
  appVersion: string;
  runtime: { platform: string; gatewayAvailable: boolean };
  connection: { phase: ConnectionPhase; demo: boolean };
  device: {
    presetLocation: string;
    presetPosition: number;
    mode: PresetSnapshot["mode"];
    activeScene: number;
    tempo: number;
    dirty: boolean;
    blockCount: number;
  };
  events: Array<{ at: string; event: string }>;
}

export interface PresetSlot extends PresetEntry {
  occupied: boolean;
}

export interface PresetSlotList {
  setlistKey: string;
  setlistName: string;
  currentPosition: number;
  slots: PresetSlot[];
}

export interface SavePresetResult extends DeviceActionResult {
  savedName: string;
}

export interface GatewayTransport {
  runtimeStatus(): Promise<RuntimeStatus>;
  reconnect(): Promise<ConnectionState>;
  resetSession(): Promise<ConnectionState>;
  disconnect(): Promise<ConnectionState>;
  currentSnapshot(): Promise<PresetSnapshot>;
  listModels(): Promise<ModelList>;
  selectScene(scene: number, expectedPresetName: string): Promise<DeviceActionResult>;
  toggleBypass(row: number, column: number, expectedScene: number, expectedBypassed: boolean, desiredBypassed: boolean, expectedPresetName: string): Promise<DeviceActionResult>;
  moveBlock(row: number, fromColumn: number, toColumn: number, expectedModelId: number, expectedPresetName: string): Promise<DeviceActionResult>;
  addBlock(row: number, column: number, modelId: number, expectedPresetName: string): Promise<DeviceActionResult>;
  removeBlock(row: number, column: number, expectedModelId: number, expectedPresetName: string): Promise<DeviceActionResult>;
  setBlockFootswitch(row: number, column: number, footswitch: number | null, expectedFootswitch: number | null, expectedModelId: number, expectedPresetName: string): Promise<DeviceActionResult>;
  setChainInput(row: number, inputId: number, expectedInputId: number, expectedPresetName: string): Promise<DeviceActionResult>;
  setChainOutput(row: number, outputId: number, expectedOutputId: number, expectedPresetName: string): Promise<DeviceActionResult>;
  setChainSplit(row: number, splitColumn: number | null, mixColumn: number | null, expectedSplitColumn: number | null, expectedMixColumn: number | null, expectedPresetName: string): Promise<DeviceActionResult>;
  listPresets(refresh?: boolean): Promise<PresetList>;
  navigateBank(direction: -1 | 1, expectedPresetName: string, expectedPosition: number): Promise<DeviceActionResult>;
  recallPreset(setlistKey: string, position: number, expectedPresetName: string, expectedPosition: number): Promise<DeviceActionResult>;
  reloadPreset(expectedPresetName: string, expectedPosition: number): Promise<DeviceActionResult>;
  blockDetails(row: number, column: number, expectedPresetName: string): Promise<BlockDetails>;
  setParameter(row: number, column: number, parameterIndex: number, value: number, expectedValue: number, expectedScene: number, expectedPresetName: string): Promise<ParameterActionResult>;
  setTempo(bpm: number, expectedTempo: number, expectedPresetName: string): Promise<DeviceActionResult>;
  pressFootswitch(index: number, expectedMode: PresetSnapshot["mode"], expectedPresetName: string): Promise<DeviceActionResult>;
  listPresetSlots(): Promise<PresetSlotList>;
  savePresetAs(setlistKey: string, position: number, name: string, expectedPresetName: string, expectedPosition: number, confirmOverwrite: boolean): Promise<SavePresetResult>;
  showTuner(shown?: boolean): Promise<DeviceActionResult>;
  showGigView(shown?: boolean): Promise<DeviceActionResult>;
}
