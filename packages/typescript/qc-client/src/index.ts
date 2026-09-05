import { QC_SCENE_COLORS } from "./generated-domain.ts";
import type { BlockDetails, DeviceActionResult, GeneralSettings, GlobalEqSettings, IoSettings, LooperStatus, MidiOutMessage, ModeCycle, PresetSnapshot, TunerSettings } from "./generated-payloads.ts";
export * from "./generated-domain.ts";
export * from "./generated-gateway-methods.ts";
export * from "./generated-payloads.ts";

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

export interface TempoClockState {
  available: boolean;
  sequence?: number;
  receivedAtUnixMs?: number;
  currentBeat?: number;
  currentBar?: number;
  currentTick?: number;
}

export interface NativeStateFrame<TState = unknown> {
  sequence: number;
  observedAt: number;
  states: TState[];
  tempoClock?: Omit<TempoClockState, "available" | "sequence" | "receivedAtUnixMs">;
}

export interface NativeStateFrames<TState = unknown> {
  native: boolean;
  frames: NativeStateFrame<TState>[];
}

export const demoSnapshot: PresetSnapshot = {
  deviceName: "Quad Cortex",
  presetName: "Brit 2203",
  presetLocation: "1A",
  presetPosition: 0,
  setlistKey: "demo",
  setlistName: "Demo Presets",
  mode: "PRESET",
  modeSlots: [
    { slot: 0, label: "PRESET", mode: "PRESET" },
    { slot: 1, label: "SCENE", mode: "SCENE" },
    { slot: 2, label: "STOMP", mode: "STOMP" }
  ],
  footswitchModes: ["PRESET", "PRESET"],
  activeScene: 0,
  scenes: ["Clean", "Edge", "Crunch", "Lead", "Ambient", "Octave", "Solo +", "Mute"],
  sceneColors: [...QC_SCENE_COLORS],
  tempo: 120,
  tempoLedEnabled: true,
  masterVolume: 40,
  dirty: false,
  routes: [
    { row: 0, inputId: 1, outputId: 1, input: "In 1", output: "Out 1/2", splitMuted: false },
    { row: 1, inputId: 2, outputId: 2, input: "In 2", output: "Out 3/4", splitMuted: false },
    { row: 2, inputId: 4, outputId: 8, input: "Return 1", output: "Send 1", splitMuted: false },
    { row: 3, inputId: 8, outputId: 22, input: "USB 5", output: "USB 3/4", splitMuted: false }
  ],
  ioPorts: [{ kind: "input", id: 1, label: "In 1", plugged: true }],
  blocks: [
    { id: "in-1", name: "IN 1", kind: "input", row: 0, column: -1 },
    { id: "gate", name: "Adaptive Gate", kind: "utility", category: "Utility", row: 0, column: 0, bypassed: true },
    { id: "amp", name: "British 2203", kind: "amp", category: "Amp", row: 0, column: 1 },
    { id: "capture", name: "OD Capture", kind: "capture", category: "Neural Capture", row: 0, column: 2 },
    { id: "cab", name: "Plini Cab", kind: "cab", category: "Cab", row: 0, column: 3, plugin: true, pluginId: "plini-x" },
    { id: "overdrive", name: "Gojira OD", kind: "utility", category: "Overdrive", row: 0, column: 4, plugin: true, pluginId: "gojira-x" },
    { id: "delay", name: "SLO-100 Delay", kind: "delay", category: "Delay", row: 0, column: 5, plugin: true, pluginId: "slo100-x" },
    { id: "reverb", name: "Nolly Reverb", kind: "reverb", category: "Reverb", row: 0, column: 6, plugin: true, pluginId: "nolly-x" },
    { id: "compressor", name: "Cory Wong Compressor", kind: "utility", category: "Compressor", row: 0, column: 7, plugin: true, pluginId: "cory-x" },
    { id: "out-1", name: "OUT 1/2", kind: "output", row: 0, column: 8 },
    { id: "in-2", name: "IN 2", kind: "input", row: 1, column: -1 },
    { id: "pitch", name: "Dual Octaver", kind: "mod", category: "Pitch", row: 1, column: 0, plugin: true, pluginId: "misha-x" },
    { id: "modulation", name: "Harmonic Tremolo", kind: "mod", category: "Modulation", row: 1, column: 1, plugin: true, pluginId: "mayer-x" },
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
    { id: "plugin", name: "Rabea Device", kind: "utility", category: "Plugins", row: 2, column: 3, plugin: true, pluginId: "rabea-x" },
    { id: "out-send", name: "SEND 1", kind: "output", row: 2, column: 8 }
  ]
};

export interface RuntimeStatus {
  platform: string;
  gatewayAvailable: boolean;
  gatewayApiVersion?: number;
  capabilities?: string[];
  message: string;
}

export interface ModelEntry {
  id: number;
  name: string;
  category: string;
  basedOn: string;
}

export interface ModelCatalogAuditException {
  modelId: number;
  modelName: string;
  parameterIndex: number;
  issue: string;
}

export interface ModelCatalogAudit {
  modelCount: number;
  parameterCount: number;
  categoryCount: number;
  exceptions: ModelCatalogAuditException[];
}

export interface ModelList {
  models: ModelEntry[];
  audit: ModelCatalogAudit;
}

export interface DeviceIdentity {
  serial: string;
  appFwVersion?: string;
  customName?: string;
  deviceType?: number;
}

export interface InhibitedModules {
  globalGate: boolean;
  globalEq: boolean;
}

export interface DeviceImage {
  pngBase64: string;
  width: number;
  height: number;
}

export interface PresetEntry {
  position: number;
  location: string;
  name: string;
  instrument: number;
}

export interface PresetFolder {
  key: string;
  name: string;
  isFactory: boolean;
}

export interface PresetFolderList {
  folders: PresetFolder[];
  loading?: boolean;
}

export interface PresetList {
  setlistKey: string;
  setlistName: string;
  currentPosition: number;
  presets: PresetEntry[];
  folders: PresetFolder[];
  loading?: boolean;
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

export interface MasterVolumeState {
  value: number;
}

export interface LibraryEntry {
  name: string;
  key: string;
  folderKey?: string;
  folderName?: string;
  position?: number;
  instrument?: number;
  isFactory: boolean;
  isPlugin: boolean;
}

export interface LibraryEntries { entries: LibraryEntry[]; }
export interface PinnedModels { models: number[]; captures: string[]; }

export type LaneControl = "inputGate" | "laneOutput";

export interface GatewayTransport {
  runtimeStatus(): Promise<RuntimeStatus>;
  reconnect(): Promise<ConnectionState>;
  resetSession(): Promise<ConnectionState>;
  disconnect(): Promise<ConnectionState>;
  currentSnapshot(): Promise<PresetSnapshot>;
  currentStateEvents(afterSequence: number, limit?: number): Promise<NativeStateFrames>;
  currentTempoClock(): Promise<TempoClockState>;
  currentMasterVolume(): Promise<MasterVolumeState>;
  listModels(): Promise<ModelList>;
  identity(): Promise<DeviceIdentity>;
  setDeviceName(name: string): Promise<DeviceActionResult & { identity: DeviceIdentity }>;
  undo(): Promise<DeviceActionResult>;
  redo(): Promise<DeviceActionResult>;
  inhibitedModules(): Promise<InhibitedModules>;
  tunerSettings(): Promise<TunerSettings>;
  generalSettings(): Promise<GeneralSettings>;
  ioSettings(): Promise<IoSettings>;
  setInputPort(inputPortId: number, levelDb: number | null, impedance: number | null, inputType: number | null, groundLift: number | null): Promise<DeviceActionResult>;
  setOutputPort(outputPortId: number, level: number | null, groundLift: number | null, mute: boolean | null): Promise<DeviceActionResult>;
  setUsbPort(level: number | null, headphonesSource: number | null, dryWet: number | null): Promise<DeviceActionResult>;
  setMidiThru(enabled: boolean): Promise<DeviceActionResult>;
  setOutputPairing(xlr12Linked: boolean | null, out34Linked: boolean | null): Promise<DeviceActionResult>;
  globalEq(): Promise<GlobalEqSettings>;
  setGlobalEqBypassed(bypassed: boolean): Promise<DeviceActionResult>;
  setGlobalEqBand(band: number, gain: number | null, frequency: number | null, q: number | null, filterType: number | null, enabled: boolean | null): Promise<DeviceActionResult>;
  setGlobalEqOutput(level: number | null, out12: boolean | null, out34: boolean | null): Promise<DeviceActionResult>;
  modeCycle(): Promise<ModeCycle>;
  setModeCycle(slots: number[]): Promise<DeviceActionResult>;
  looperStatus(): Promise<LooperStatus>;
  controlLooper(command: string, value: number | null): Promise<DeviceActionResult>;
  recents(): Promise<LibraryEntries>;
  favorites(): Promise<LibraryEntries>;
  setFavorite(name: string, folderKey: string, folderName: string, isFactory: boolean, favorite: boolean): Promise<DeviceActionResult>;
  pinnedModels(): Promise<PinnedModels>;
  setModelPinned(modelId: number, pinned: boolean): Promise<DeviceActionResult>;
  captures(): Promise<LibraryEntries>;
  loadCapture(row: number, column: number, key: string, name: string, modelId: number | null): Promise<DeviceActionResult>;
  irs(folder: string | null): Promise<LibraryEntries>;
  loadIr(row: number, column: number, key: string, name: string, slot: number, modelId: number | null): Promise<DeviceActionResult>;
  createSetlist(name: string): Promise<DeviceActionResult>;
  deleteSetlist(name: string): Promise<DeviceActionResult>;
  duplicateSetlist(sourceSetlistKey: string, destinationName: string, limit: number | null, expectedPresetName: string, expectedPosition: number): Promise<DeviceActionResult>;
  deletePreset(setlistKey: string, name: string): Promise<DeviceActionResult>;
  movePreset(setlistKey: string, name: string, position: number): Promise<DeviceActionResult>;
  setGeneralInteger(setting: "screenBrightness" | "ledBrightness" | "dimmedLedBrightness" | "holdTiming" | "midiChannel", value: number): Promise<DeviceActionResult>;
  setGeneralToggle(setting: "midiOverUsb" | "ignoreDuplicatePc" | "stompModeAutoAssign" | "swapTempoTunerAccess" | "disableInternetConnectionCheck" | "dynamicDelayCompensation" | "presetDimmed" | "midiClockIn" | "gigViewStompAccess", enabled: boolean): Promise<DeviceActionResult>;
  setSceneBypassBehavior(behavior: "alwaysOverwrite" | "nonstompOverwrite" | "neverOverwrite"): Promise<DeviceActionResult>;
  setMasterVolumeAssignment(out12: boolean, out34: boolean, send12: boolean, headphones: boolean): Promise<DeviceActionResult>;
  setGlobalBypass(cab: [boolean, boolean, boolean, boolean], ir: [boolean, boolean, boolean, boolean]): Promise<DeviceActionResult>;
  presetScreenshot(folderName: string, position: number, isFactory?: boolean): Promise<DeviceImage>;
  captureScreen(): Promise<DeviceImage>;
  tapScreen(x: number, y: number): Promise<DeviceActionResult>;
  selectScene(scene: number, expectedPresetName: string): Promise<DeviceActionResult>;
  copyScene(fromScene: number, toScene: number, swap: boolean, expectedPresetName: string): Promise<DeviceActionResult>;
  setSceneLabel(scene: number, label: string | null, expectedPresetName: string): Promise<DeviceActionResult>;
  setSceneColor(scene: number, color: number, expectedPresetName: string): Promise<DeviceActionResult>;
  toggleBypass(row: number, column: number, expectedScene: number, expectedBypassed: boolean, desiredBypassed: boolean, expectedPresetName: string): Promise<DeviceActionResult>;
  moveBlock(row: number, fromColumn: number, toColumn: number, expectedModelId: number, expectedPresetName: string): Promise<DeviceActionResult>;
  addBlock(row: number, column: number, modelId: number, expectedPresetName: string): Promise<DeviceActionResult>;
  removeBlock(row: number, column: number, expectedModelId: number, expectedPresetName: string): Promise<DeviceActionResult>;
  setBlockFootswitch(row: number, column: number, footswitch: number | null, expectedFootswitch: number | null, expectedModelId: number, expectedPresetName: string): Promise<DeviceActionResult>;
  setStompMomentary(footswitch: number, momentary: boolean, expectedPresetName: string): Promise<DeviceActionResult>;
  setStompLabel(footswitch: number, label: string, expectedPresetName: string): Promise<DeviceActionResult>;
  setMidiOut(source: number, messages: MidiOutMessage[], expectedPresetName: string): Promise<DeviceActionResult>;
  setPresetLoadMidiOut(messages: MidiOutMessage[], expectedPresetName: string): Promise<DeviceActionResult>;
  setChainInput(row: number, inputId: number, expectedInputId: number, expectedPresetName: string): Promise<DeviceActionResult>;
  setChainOutput(row: number, outputId: number, expectedOutputId: number, expectedPresetName: string): Promise<DeviceActionResult>;
  setChainSplit(row: number, splitColumn: number | null, mixColumn: number | null, expectedSplitColumn: number | null, expectedMixColumn: number | null, expectedPresetName: string): Promise<DeviceActionResult>;
  setSplitMute(row: number, muted: boolean, expectedMuted: boolean, expectedPresetName: string): Promise<DeviceActionResult>;
  listPresets(refresh?: boolean, setlistKey?: string): Promise<PresetList>;
  listPresetFolders(refresh?: boolean): Promise<PresetFolderList>;
  navigateBank(direction: -1 | 1, expectedPresetName: string, expectedPosition: number): Promise<DeviceActionResult>;
  recallPreset(setlistKey: string, position: number, expectedPresetName: string, expectedPosition: number): Promise<DeviceActionResult>;
  reloadPreset(expectedPresetName: string, expectedPosition: number): Promise<DeviceActionResult>;
  blockDetails(row: number, column: number, expectedPresetName: string): Promise<BlockDetails>;
  laneControlDetails(row: number, control: LaneControl, expectedPresetName: string): Promise<BlockDetails>;
  previewParameter(row: number, column: number, parameterIndex: number, value: number, expectedScene: number, expectedPresetName: string): Promise<{ detail: string; acceptedValue: number }>;
  previewLaneControlParameter(row: number, control: LaneControl, parameterIndex: number, value: number, expectedPresetName: string): Promise<{ detail: string; acceptedValue: number }>;
  setParameter(row: number, column: number, parameterIndex: number, value: number, expectedValue: number, expectedScene: number, expectedPresetName: string): Promise<ParameterActionResult>;
  setLaneControlParameter(row: number, control: LaneControl, parameterIndex: number, value: number, expectedValue: number, expectedPresetName: string): Promise<ParameterActionResult>;
  setLaneControlSceneMode(row: number, control: LaneControl, parameterIndex: number, enabled: boolean, expectedPresetName: string): Promise<DeviceActionResult>;
  setParameterSceneMode(row: number, column: number, parameterIndex: number, enabled: boolean, expectedPresetName: string): Promise<DeviceActionResult>;
  setParameterExpression(row: number, column: number, parameterIndex: number, pedal: 0 | 1 | 2, minimum: number, maximum: number, expectedPresetName: string): Promise<DeviceActionResult>;
  setExpressionBypass(row: number, column: number, pedal: 1 | 2, mode: 0 | 1 | 2, invert: boolean, delayMs: number, latchEmulation: boolean, expectedPresetName: string): Promise<DeviceActionResult>;
  setTempo(bpm: number, expectedTempo: number, expectedPresetName: string): Promise<DeviceActionResult>;
  setMasterVolume(value: number, expectedValue: number): Promise<DeviceActionResult>;
  pressFootswitch(index: number, expectedMode: PresetSnapshot["mode"], expectedPresetName: string): Promise<DeviceActionResult>;
  tapTempo(expectedMode: PresetSnapshot["mode"], expectedPresetName: string): Promise<DeviceActionResult>;
  selectModeSlot(slot: 0 | 1 | 2, expectedPresetName: string): Promise<DeviceActionResult>;
  listPresetSlots(): Promise<PresetSlotList>;
  savePresetAs(setlistKey: string, position: number, name: string, expectedPresetName: string, expectedPosition: number, confirmOverwrite: boolean): Promise<SavePresetResult>;
  copyPreset(sourceSetlistKey: string, sourcePosition: number, sourceName: string, destinationSetlistKey: string, destinationPosition: number, expectedPresetName: string, expectedPosition: number, confirmOverwrite: boolean): Promise<SavePresetResult>;
  renameCurrentPreset(name: string, expectedPresetName: string, expectedPosition: number, confirmRename: boolean): Promise<SavePresetResult>;
  showTuner(shown?: boolean): Promise<DeviceActionResult>;
  showGigView(shown?: boolean): Promise<DeviceActionResult>;
  createDeviceBackup(name: string): Promise<WorkspaceFileResult>;
}
