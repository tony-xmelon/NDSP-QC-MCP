import type { GridBlock, PresetSnapshot } from "@ndsp-qc/client";

export type CorOsScreenView = "grid" | "grid-official-brit" | "corpus-device-browser-root" | "corpus-device-browser-models" | "corpus-device-browser-models-clean" | "gig" | "gig-live-tuner" | "gig-official-preset" | "gig-official-scene" | "gig-official-stomp" | "gig-official-hybrid" | "tuner" | "tuner-live-enabled" | "tempo" | "midi-out" | "cpu-monitor" | "io-overview" | "io-input" | "io-output" | "io-send-return" | "io-usb" | "io-headphones" | "global-eq" | "power-overlay" | "splitter-placement" | "splitter-editor" | "mixer-editor" | "empty-slot" | "device-search" | "device-favorites" | "device-browser-amp-official" | "plugin-devices-official" | "plugin-folders" | "plugin-list" | "plugin-models" | "plugin-locked" | "plugin-refresh" | "looper-editor" | "device-presets" | "device-presets-user" | "device-presets-official" | "device-preset-actions" | "device-preset-actions-official" | "device-preset-save" | "stomp-assignment" | "scene-assignment" | "expression-parameter" | "expression-bypass" | "block-context" | "directory-presets" | "directory-categories" | "directory-captures" | "directory-irs" | "directory-plugins" | "directory-favorites" | "directory-search" | "directory-search-results" | "directory-sort" | "directory-filter" | "directory-arrange" | "directory-copy" | "directory-nested" | "directory-new-folder" | "directory-item-context" | "directory-cloud-upload" | "capture-intro" | "capture-type" | "capture-routing" | "capture-calibration" | "capture-progress" | "capture-result" | "capture-save" | "settings-account" | "settings-system" | "settings-device" | "settings-support" | "settings-wifi" | "settings-update" | "settings-storage" | "settings-midi" | "settings-info" | "settings-diagnostics" | "recovery-entry" | "recovery-options" | "overlay-keyboard" | "overlay-confirmation" | "overlay-error" | "overlay-busy" | "fixture-boot" | "fixture-shutdown" | "fixture-copy-scene" | "fixture-swap-scene" | "fixture-delete" | "fixture-input-gate" | "fixture-editor-pages" | "fixture-editor-cab" | "fixture-editor-eq" | "fixture-editor-capture" | "fixture-warning-clip" | "fixture-warning-dsp" | "modes" | "modes-official" | "save-as" | "edit-details";

function officialBrit2203Snapshot(base: PresetSnapshot): PresetSnapshot {
  const blocks: GridBlock[] = [
    { id: "brit-gate", name: "Adaptive Gate", kind: "utility", category: "Gate", row: 0, column: 0, bypassed: true },
    { id: "brit-wah", name: "Wah", kind: "utility", category: "Wah", row: 0, column: 1, bypassed: true },
    { id: "brit-plugin", name: "Plugin Drive", kind: "utility", category: "Plugin", row: 0, column: 2, bypassed: true },
    { id: "brit-drive-a", name: "Drive", kind: "utility", category: "Overdrive", row: 0, column: 3, bypassed: true },
    { id: "brit-drive-b", name: "Boost", kind: "utility", category: "Overdrive", row: 0, column: 4, bypassed: true },
    { id: "brit-amp", name: "Brit 2203", kind: "amp", category: "Amp", row: 0, column: 5 },
    { id: "brit-utility", name: "Utility", kind: "utility", category: "Utility", row: 0, column: 6 },
    { id: "brit-cab", name: "412 Brit", kind: "cab", category: "Cab", row: 0, column: 7 },
    { id: "brit-row3-ir", name: "IR Loader", kind: "utility", category: "IR Loader", row: 2, column: 1, bypassed: true },
    { id: "brit-row3-utility", name: "Utility", kind: "utility", category: "Utility", row: 2, column: 2 },
    { id: "brit-delay-a", name: "Reference Delay A", kind: "delay", category: "Delay", row: 2, column: 3, bypassed: true },
    { id: "brit-delay-b", name: "Reference Delay B", kind: "delay", category: "Delay", row: 2, column: 4, bypassed: true },
    { id: "brit-row3-reverb", name: "Reverb", kind: "utility", category: "Reverb", row: 2, column: 5 },
    { id: "brit-looper", name: "Looper X", kind: "utility", category: "Looper", row: 2, column: 7 }
  ];
  return { ...base, presetLocation: "1A", presetPosition: 0, presetName: "Brit 2203", mode: "PRESET", activeScene: 0, dirty: false, blocks, routes: [{ row: 0, input: "In 1", output: "Row 3", splitMuted: false }, { row: 1, input: "", output: "", splitMuted: false }, { row: 2, input: "Prev. Row", output: "Multi Out", splitMuted: false }, { row: 3, input: "", output: "", splitMuted: false }] };
}

export function coros410FixtureSnapshot(base: PresetSnapshot, overrides: Partial<Pick<PresetSnapshot, "tempo" | "mode">> = {}): PresetSnapshot {
  return {
    ...base,
    presetName: "pyquadcortex scratch",
    presetLocation: "32H",
    presetPosition: 255,
    setlistKey: "coros-4.1.0-corpus",
    setlistName: "My Presets",
    mode: "STOMP",
    footswitchModes: ["STOMP", "STOMP"],
    activeScene: 0,
    scenes: ["Default scene", "Scene B", "Scene C", "Scene D", "Scene E", "Scene F", "Scene G", "Scene H"],
    tempo: 120,
    tempoLedEnabled: true,
    masterVolume: 40,
    dirty: false,
    routes: [
      { row: 0, inputId: 1, outputId: 0, input: "In 1", output: "Multi Out", splitMuted: false },
      { row: 1, inputId: 0, outputId: 0, input: "", output: "", splitMuted: false },
      { row: 2, inputId: 0, outputId: 0, input: "", output: "", splitMuted: false },
      { row: 3, inputId: 0, outputId: 0, input: "", output: "", splitMuted: false }
    ],
    ioPorts: [{ kind: "input", id: 1, label: "In 1", plugged: false }],
    blocks: [
      { id: "simple-gate", modelId: 1, name: "Simple Gate", kind: "utility", category: "Utility", row: 0, column: 0, footswitch: 0 },
      { id: "chief-ds1", modelId: 2, name: "Chief DS1", kind: "utility", category: "Guitar Overdrive", row: 0, column: 1, footswitch: 1 },
      { id: "digital-flanger", modelId: 3, name: "Digital Flanger", kind: "mod", category: "Modulation", row: 0, column: 2, footswitch: 2, bypassed: true },
      { id: "ukc30-topboost", modelId: 4, name: "UK C30 TopBoost", kind: "amp", category: "Amp", row: 0, column: 3, footswitch: 3 },
      { id: "ukc30-cab", modelId: 5, name: "212 UK C30 65 (M)", kind: "cab", category: "Cab", row: 0, column: 4, footswitch: 4 },
      { id: "parametric-8", modelId: 6, name: "Parametric-8", kind: "utility", category: "EQ", row: 0, column: 5, footswitch: 5 },
      { id: "ambience", modelId: 7, name: "Ambience", kind: "reverb", category: "Reverb", row: 0, column: 6, footswitch: 6 }
    ],
    ...overrides
  };
}

export interface CorOsFixtureConfiguration {
  enabled: boolean;
  initialSnapshot: PresetSnapshot;
  screenView: CorOsScreenView | null;
}

/** Resolve the visual-conformance URL once so every host captures identical state. */
export function corosFixtureConfiguration(search: string, base: PresetSnapshot): CorOsFixtureConfiguration {
  const params = new URLSearchParams(search);
  const enabled = params.get("fixture") === "coros410";
  const mode = params.get("mode");
  const tempo = Number(params.get("tempo"));
  const overrides: Partial<Pick<PresetSnapshot, "tempo" | "mode">> = {
    ...(Number.isFinite(tempo) && tempo > 0 ? { tempo } : {}),
    ...(["PRESET", "SCENE", "STOMP", "HYBRID"].includes(mode ?? "")
      ? { mode: mode as PresetSnapshot["mode"] }
      : {})
  };
  return {
    enabled,
    initialSnapshot: enabled ? coros410FixtureSnapshot(base, overrides) : base,
    screenView: params.get("screen") as CorOsScreenView | null
  };
}

export function fixtureSnapshot(view: CorOsScreenView, snapshot: PresetSnapshot): PresetSnapshot {
  return view === "grid-official-brit" ? officialBrit2203Snapshot(snapshot) : snapshot;
}
