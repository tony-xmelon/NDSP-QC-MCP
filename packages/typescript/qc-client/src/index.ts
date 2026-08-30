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
  categoryId?: number;
  name: string;
  kind: BlockKind;
  category?: string;
  row: number;
  column: number;
  bypassed?: boolean;
  color?: string;
  glyph?: BlockGlyph;
  footswitch?: number;
  footswitchOrder?: number;
}

export interface FootswitchState {
  index: number;
  active: boolean;
  assigned: boolean;
  color: string;
  momentary?: boolean;
  label?: string;
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
  footswitchModes?: ["PRESET" | "SCENE" | "STOMP", "PRESET" | "SCENE" | "STOMP"];
  activeScene: number;
  scenes: string[];
  sceneColors?: string[];
  footswitchStates?: FootswitchState[];
  blocks: GridBlock[];
  routes: GridRoute[];
  tempo: number;
  tempoLedEnabled?: boolean;
  masterVolume: number;
  dirty: boolean;
}

export const demoSnapshot: PresetSnapshot = {
  deviceName: "Quad Cortex",
  presetName: "QC Block Reference",
  presetLocation: "1A",
  presetPosition: 0,
  setlistKey: "demo",
  setlistName: "Demo Presets",
  mode: "PRESET",
  footswitchModes: ["PRESET", "PRESET"],
  activeScene: 0,
  scenes: ["Clean", "Edge", "Crunch", "Lead", "Ambient", "Octave", "Solo +", "Mute"],
  sceneColors: ["#ff2727", "#0a74e0", "#ffd236", "#ff02c2", "#45f862", "#ff7000", "#6954ff", "#00ffdd"],
  tempo: 120,
  tempoLedEnabled: true,
  masterVolume: 40,
  dirty: false,
  routes: [
    { row: 0, input: "In 1", output: "Out 1/2" },
    { row: 1, input: "In 2", output: "Out 3/4" },
    { row: 2, input: "Return 1", output: "Send 1" },
    { row: 3, input: "USB 5", output: "USB 3/4" }
  ],
  blocks: [
    { id: "in-1", name: "IN 1", kind: "input", row: 0, column: -1 },
    { id: "plugin", name: "Plugin Device", kind: "utility", category: "Plugins", row: 0, column: 0 },
    { id: "amp", name: "British 2203", kind: "amp", category: "Amp", row: 0, column: 1 },
    { id: "capture", name: "OD Capture", kind: "capture", category: "Neural Capture", row: 0, column: 2 },
    { id: "cab", name: "4x12 UK V30", kind: "cab", category: "Cab", row: 0, column: 3 },
    { id: "overdrive", name: "Rodent Drive", kind: "utility", category: "Overdrive", row: 0, column: 4 },
    { id: "delay", name: "Digital Delay", kind: "delay", category: "Delay", row: 0, column: 5 },
    { id: "reverb", name: "Plate Reverb", kind: "reverb", category: "Reverb", row: 0, column: 6 },
    { id: "compressor", name: "Jewel Comp", kind: "utility", category: "Compressor", row: 0, column: 7 },
    { id: "out-1", name: "OUT 1/2", kind: "output", row: 0, column: 8 },
    { id: "in-2", name: "IN 2", kind: "input", row: 1, column: -1 },
    { id: "pitch", name: "Dual Octaver", kind: "mod", category: "Pitch", row: 1, column: 0 },
    { id: "modulation", name: "Vintage Chorus", kind: "mod", category: "Modulation", row: 1, column: 1 },
    { id: "morph", name: "Freeze", kind: "utility", category: "Morph", row: 1, column: 2 },
    { id: "synth", name: "Synth", kind: "utility", category: "Synth", row: 1, column: 3 },
    { id: "filter", name: "Envelope Filter", kind: "utility", category: "Filter", row: 1, column: 4 },
    { id: "equalizer", name: "Parametric-8", kind: "utility", category: "EQ", row: 1, column: 5 },
    { id: "ir-loader", name: "Custom IR", kind: "cab", category: "IR Loader", row: 1, column: 6 },
    { id: "wah", name: "Crying Wah", kind: "utility", category: "Wah", row: 1, column: 7 },
    { id: "out-2", name: "OUT 3/4", kind: "output", row: 1, column: 8 },
    { id: "in-return", name: "RETURN 1", kind: "input", row: 2, column: -1 },
    { id: "fx-loop", name: "FX Loop 1", kind: "utility", category: "FX Loop", row: 2, column: 0 },
    { id: "looper", name: "Looper X", kind: "utility", category: "Looper", row: 2, column: 1 },
    { id: "utility", name: "Gain", kind: "utility", category: "Utility", row: 2, column: 2 },
    { id: "out-send", name: "SEND 1", kind: "output", row: 2, column: 8 }
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
  setMasterVolume(value: number, expectedValue: number): Promise<DeviceActionResult>;
  pressFootswitch(index: number, expectedMode: PresetSnapshot["mode"], expectedPresetName: string): Promise<DeviceActionResult>;
  listPresetSlots(): Promise<PresetSlotList>;
  savePresetAs(setlistKey: string, position: number, name: string, expectedPresetName: string, expectedPosition: number, confirmOverwrite: boolean): Promise<SavePresetResult>;
  showTuner(shown?: boolean): Promise<DeviceActionResult>;
  showGigView(shown?: boolean): Promise<DeviceActionResult>;
}
