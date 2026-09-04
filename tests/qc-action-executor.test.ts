import assert from "node:assert/strict";
import test from "node:test";
import { demoSnapshot, type GatewayTransport } from "../packages/typescript/qc-client/src/index.ts";
import { resolveAssistantParameterEdit } from "../packages/typescript/qc-ui/src/assistant-parameter-edit.ts";
import { executeQcAction } from "../packages/typescript/qc-ui/src/qc-action-executor.ts";

test("shared action execution rejects stale state before a write", async () => {
  let called = false;
  const gateway = { setTempo: async () => { called = true; return { detail: "sent" }; } } as unknown as GatewayTransport;
  await assert.rejects(() => executeQcAction({
    name: "set_tempo",
    arguments: { bpm: 96, expected_tempo: 119, expected_preset_name: demoSnapshot.presetName }
  }, { gateway, snapshot: demoSnapshot, connected: true }), /stale expected_tempo/);
  assert.equal(called, false);
});

test("shared parameter execution converts display units and returns reconciliation effects", async () => {
  let sentValue = -1;
  const block = {
    row: 0, column: 1, modelId: 1, name: "Amp", category: "Amp", scene: 0,
    parameters: [{ index: 0, name: "Gain", normalizedValue: .5, displayValue: "5.0", units: "", type: "float", minimum: 0, maximum: 10, steps: null, sceneMode: false, options: [], writable: true }]
  };
  const next = { ...demoSnapshot, dirty: true };
  const gateway = {
    blockDetails: async () => block,
    setParameter: async (_row: number, _column: number, _index: number, value: number) => {
      sentValue = value;
      return { detail: "verified", block: { ...block, parameters: [{ ...block.parameters[0], normalizedValue: value }] }, snapshot: next };
    }
  } as unknown as GatewayTransport;
  const result = await executeQcAction({
    name: "set_parameter",
    arguments: { row: 0, column: 1, parameter_index: 0, value: 7.5, expected_value: .5, expected_scene: 0, expected_preset_name: demoSnapshot.presetName }
  }, { gateway, snapshot: demoSnapshot, connected: true });
  assert.equal(sentValue, .75);
  assert.equal(result.detail, "verified");
  assert.equal(result.snapshot?.dirty, true);
  assert.equal(result.block?.parameters[0].normalizedValue, .75);
});

test("shared parameter assignments validate capabilities and preserve reversed EXP ranges", async () => {
  const calls: unknown[][] = [];
  const block = {
    row: 0, column: 1, modelId: 1, name: "Wah", category: "Wah", scene: 0,
    parameters: [{
      index: 0, name: "Position", normalizedValue: .5, displayValue: "50", units: "%",
      type: "float", minimum: 0, maximum: 100, steps: null, sceneMode: false,
      options: [], writable: true, expressionAssignable: true
    }]
  };
  const gateway = {
    blockDetails: async () => block,
    setParameterSceneMode: async (...args: unknown[]) => { calls.push(args); return { detail: "scene verified" }; },
    setParameterExpression: async (...args: unknown[]) => { calls.push(args); return { detail: "expression verified" }; }
  } as unknown as GatewayTransport;
  await executeQcAction({
    name: "set_parameter_scene_mode",
    arguments: { row: 0, column: 1, parameter_index: 0, enabled: true, expected_preset_name: demoSnapshot.presetName }
  }, { gateway, snapshot: demoSnapshot, connected: true });
  await executeQcAction({
    name: "set_parameter_expression",
    arguments: { row: 0, column: 1, parameter_index: 0, pedal: 2, minimum: .8, maximum: .2, expected_preset_name: demoSnapshot.presetName }
  }, { gateway, snapshot: demoSnapshot, connected: true });
  assert.deepEqual(calls, [
    [0, 1, 0, true, demoSnapshot.presetName],
    [0, 1, 0, 2, .8, .2, demoSnapshot.presetName]
  ]);
});

test("shared lane-control actions use the same guarded read, preview, write, and scene-mode path", async () => {
  const calls: unknown[][] = [];
  const details = {
    row: 1, column: -1, modelId: 28_000, name: "Input Gate", category: "Utility", scene: 0,
    parameters: [{
      index: 2, name: "Threshold", normalizedValue: .5, displayValue: "-40", units: "dB",
      type: "float", minimum: -80, maximum: 0, steps: null, sceneMode: false,
      options: [], writable: true, scaleKnown: true
    }]
  };
  const gateway = {
    laneControlDetails: async (...args: unknown[]) => { calls.push(["read", ...args]); return details; },
    previewLaneControlParameter: async (...args: unknown[]) => { calls.push(["preview", ...args]); return { detail: "previewed", acceptedValue: .25 }; },
    setLaneControlParameter: async (...args: unknown[]) => { calls.push(["write", ...args]); return { detail: "verified", block: details, snapshot: demoSnapshot }; },
    setLaneControlSceneMode: async (...args: unknown[]) => { calls.push(["scene", ...args]); return { detail: "scene verified" }; }
  } as unknown as GatewayTransport;
  const context = { gateway, snapshot: demoSnapshot, connected: true };

  const read = await executeQcAction({
    name: "get_lane_control_details",
    arguments: { row: 1, control: "inputGate", expected_preset_name: demoSnapshot.presetName }
  }, context);
  assert.equal(read.block?.name, "Input Gate");
  await executeQcAction({
    name: "preview_lane_control_parameter",
    arguments: { row: 1, control: "inputGate", parameter_index: 2, value: .25, expected_value: .5, expected_preset_name: demoSnapshot.presetName }
  }, context);
  await executeQcAction({
    name: "set_lane_control_parameter",
    arguments: { row: 1, control: "inputGate", parameter_index: 2, value: -20, expected_value: .5, expected_preset_name: demoSnapshot.presetName }
  }, context);
  await executeQcAction({
    name: "set_lane_control_scene_mode",
    arguments: { row: 1, control: "inputGate", parameter_index: 2, enabled: true, expected_preset_name: demoSnapshot.presetName }
  }, context);

  assert.deepEqual(calls, [
    ["read", 1, "inputGate", demoSnapshot.presetName],
    ["read", 1, "inputGate", demoSnapshot.presetName],
    ["preview", 1, "inputGate", 2, .25, demoSnapshot.presetName],
    ["read", 1, "inputGate", demoSnapshot.presetName],
    ["write", 1, "inputGate", 2, .75, .5, demoSnapshot.presetName],
    ["read", 1, "inputGate", demoSnapshot.presetName],
    ["scene", 1, "inputGate", 2, true, demoSnapshot.presetName]
  ]);
});

test("persistent shared actions require the generated confirmation field", async () => {
  let called = false;
  const gateway = { renameCurrentPreset: async () => { called = true; return { detail: "renamed", savedName: "New" }; } } as unknown as GatewayTransport;
  await assert.rejects(() => executeQcAction({
    name: "rename_current_preset",
    arguments: { new_name: "New", expected_preset_name: demoSnapshot.presetName, expected_position: demoSnapshot.presetPosition, confirm_persistent_write: false }
  }, { gateway, snapshot: demoSnapshot, connected: true }), /explicit user confirmation/);
  assert.equal(called, false);
});

test("library actions share exact read, guarded load, and persistent workflow arguments", async () => {
  const calls: unknown[][] = [];
  const gateway = {
    recents: async () => ({ entries: [{ name: "Recent" }] }),
    favorites: async () => ({ entries: [{ name: "Favorite" }] }),
    pinnedModels: async () => ({ models: [42], captures: [] }),
    captures: async () => ({ folderKey: "captures", entries: [{ key: "capture/", name: "Crunch" }] }),
    irs: async (...args: unknown[]) => { calls.push(["irs", ...args]); return { folderKey: "irs", entries: [] }; },
    setFavorite: async (...args: unknown[]) => { calls.push(["favorite", ...args]); return { detail: "favorite sent" }; },
    setModelPinned: async (...args: unknown[]) => { calls.push(["pin", ...args]); return { detail: "pin sent" }; },
    duplicateSetlist: async (...args: unknown[]) => { calls.push(["duplicate", ...args]); return { detail: "duplicated" }; },
    loadCapture: async (...args: unknown[]) => { calls.push(["capture", ...args]); return { detail: "capture loaded" }; },
    loadIr: async (...args: unknown[]) => { calls.push(["ir", ...args]); return { detail: "ir loaded" }; }
  } as unknown as GatewayTransport;
  const context = { gateway, snapshot: demoSnapshot, connected: true };

  assert.ok((await executeQcAction({ name: "list_recents", arguments: {} }, context)).data);
  assert.ok((await executeQcAction({ name: "list_favorites", arguments: {} }, context)).data);
  assert.ok((await executeQcAction({ name: "list_pinned_models", arguments: {} }, context)).data);
  assert.ok((await executeQcAction({ name: "list_captures", arguments: {} }, context)).data);
  await executeQcAction({ name: "list_irs", arguments: { folder: null } }, context);
  await executeQcAction({
    name: "set_favorite",
    arguments: { name: "Stage", folder_key: "/media/p4/Presets/Live", folder_name: "Live", is_factory: false, favorite: true, confirm_persistent_write: true }
  }, context);
  await executeQcAction({
    name: "set_model_pinned", arguments: { model_id: 42, pinned: true, confirm_persistent_write: true }
  }, context);
  await executeQcAction({
    name: "duplicate_setlist",
    arguments: {
      source_setlist_key: "/media/p4/Presets/Live", destination_name: "Live Copy", limit: null,
      expected_preset_name: demoSnapshot.presetName, expected_position: demoSnapshot.presetPosition,
      confirm_persistent_write: true
    }
  }, context);
  await executeQcAction({
    name: "load_capture",
    arguments: { row: 1, column: 2, key: "capture/", name: "Crunch", model_id: null, expected_preset_name: demoSnapshot.presetName }
  }, context);
  await executeQcAction({
    name: "load_ir",
    arguments: { row: 2, column: 3, key: "ir/key", name: "Room", slot: 1, model_id: 29_001, expected_preset_name: demoSnapshot.presetName }
  }, context);

  assert.deepEqual(calls, [
    ["irs", null],
    ["favorite", "Stage", "/media/p4/Presets/Live", "Live", false, true],
    ["pin", 42, true],
    ["duplicate", "/media/p4/Presets/Live", "Live Copy", null, demoSnapshot.presetName, demoSnapshot.presetPosition],
    ["capture", 1, 2, "capture/", "Crunch", null],
    ["ir", 2, 3, "ir/key", "Room", 1, 29_001]
  ]);

  await assert.rejects(() => executeQcAction({
    name: "duplicate_setlist",
    arguments: {
      source_setlist_key: "/media/p4/Presets/Live", destination_name: "Nope", limit: 1,
      expected_preset_name: demoSnapshot.presetName, expected_position: demoSnapshot.presetPosition,
      confirm_persistent_write: false
    }
  }, context), /explicit user confirmation/);
  await assert.rejects(() => executeQcAction({
    name: "load_capture",
    arguments: { row: 1, column: 2, key: "capture/", name: "Crunch", model_id: null, expected_preset_name: "stale" }
  }, context), /prepared for.*stale/);
});

test("general settings actions share one confirmed app execution path", async () => {
  const calls: unknown[][] = [];
  const gateway = {
    generalSettings: async () => ({ holdTimingIndex: 3, holdTimingMs: 800 }),
    setGeneralInteger: async (...args: unknown[]) => { calls.push(["integer", ...args]); return { detail: "sent" }; },
    setGeneralToggle: async (...args: unknown[]) => { calls.push(["toggle", ...args]); return { detail: "sent" }; },
    setSceneBypassBehavior: async (...args: unknown[]) => { calls.push(["scene", ...args]); return { detail: "sent" }; },
    setMasterVolumeAssignment: async (...args: unknown[]) => { calls.push(["assignment", ...args]); return { detail: "sent" }; },
    setGlobalBypass: async (...args: unknown[]) => { calls.push(["bypass", ...args]); return { detail: "sent" }; }
  } as unknown as GatewayTransport;
  const context = { gateway, snapshot: demoSnapshot, connected: true };
  const read = await executeQcAction({ name: "get_general_settings", arguments: {} }, context);
  assert.deepEqual(read.data, { holdTimingIndex: 3, holdTimingMs: 800 });

  const confirmed = { confirm_persistent_write: true };
  await executeQcAction({ name: "set_general_integer", arguments: { setting: "holdTiming", value: 4, ...confirmed } }, context);
  await executeQcAction({ name: "set_general_toggle", arguments: { setting: "stompModeAutoAssign", enabled: false, ...confirmed } }, context);
  await executeQcAction({ name: "set_scene_bypass_behavior", arguments: { behavior: "neverOverwrite", ...confirmed } }, context);
  await executeQcAction({ name: "set_master_volume_assignment", arguments: { out12: true, out34: false, send12: true, headphones: false, ...confirmed } }, context);
  await executeQcAction({ name: "set_global_bypass", arguments: { cab: [true, false, true, false], ir: [false, true, false, true], ...confirmed } }, context);
  assert.deepEqual(calls, [
    ["integer", "holdTiming", 4],
    ["toggle", "stompModeAutoAssign", false],
    ["scene", "neverOverwrite"],
    ["assignment", true, false, true, false],
    ["bypass", [true, false, true, false], [false, true, false, true]]
  ]);

  await assert.rejects(() => executeQcAction({
    name: "set_general_integer", arguments: { setting: "holdTiming", value: 4, confirm_persistent_write: false }
  }, context), /explicit user confirmation/);
});

test("I/O settings actions preserve sparse nulls through one confirmed app path", async () => {
  const calls: unknown[][] = [];
  const state = { inputs: [{ inputPortId: 1, level: .5, levelDb: 24 }], outputs: [], expressions: [] };
  const gateway = {
    ioSettings: async () => state,
    setInputPort: async (...args: unknown[]) => { calls.push(["input", ...args]); return { detail: "sent" }; },
    setOutputPort: async (...args: unknown[]) => { calls.push(["output", ...args]); return { detail: "sent" }; },
    setUsbPort: async (...args: unknown[]) => { calls.push(["usb", ...args]); return { detail: "sent" }; },
    setMidiThru: async (...args: unknown[]) => { calls.push(["midi", ...args]); return { detail: "sent" }; },
    setOutputPairing: async (...args: unknown[]) => { calls.push(["pairing", ...args]); return { detail: "sent" }; }
  } as unknown as GatewayTransport;
  const context = { gateway, snapshot: demoSnapshot, connected: true };
  const read = await executeQcAction({ name: "get_io_settings", arguments: {} }, context);
  assert.equal(read.data, state);
  const confirmed = { confirm_persistent_write: true };
  await executeQcAction({ name: "set_input_port", arguments: { input_port_id: 1, level_db: 12, impedance: null, input_type: 1, ground_lift: null, ...confirmed } }, context);
  await executeQcAction({ name: "set_output_port", arguments: { output_port_id: 4, level: null, ground_lift: null, mute: false, ...confirmed } }, context);
  await executeQcAction({ name: "set_usb_port", arguments: { level: .25, headphones_source: null, dry_wet: 1, ...confirmed } }, context);
  await executeQcAction({ name: "set_midi_thru", arguments: { enabled: true, ...confirmed } }, context);
  await executeQcAction({ name: "set_output_pairing", arguments: { xlr12_linked: true, out34_linked: null, ...confirmed } }, context);
  assert.deepEqual(calls, [
    ["input", 1, 12, null, 1, null],
    ["output", 4, null, null, false],
    ["usb", .25, null, 1],
    ["midi", true],
    ["pairing", true, null]
  ]);
});

test("device-global actions do not require an unrelated preset guard", async () => {
  const calls: string[] = [];
  const gateway = {
    showTuner: async () => { calls.push("tuner"); return { detail: "tuner shown" }; },
    setMasterVolume: async () => { calls.push("volume"); return { detail: "volume set" }; }
  } as unknown as GatewayTransport;
  await executeQcAction({ name: "show_tuner", arguments: { shown: true } }, {
    gateway, snapshot: demoSnapshot, connected: true
  });
  await executeQcAction({
    name: "set_master_volume",
    arguments: { value: 75, expected_value: demoSnapshot.masterVolume, confirm_risky_operation: true }
  }, { gateway, snapshot: demoSnapshot, connected: true });
  assert.deepEqual(calls, ["tuner", "volume"]);
});

test("offline parameter phrases resolve identically for both app hosts", () => {
  const details = {
    row: 0, column: 0, modelId: 1, name: "Amp", category: "Amp", scene: 0,
    parameters: [{ index: 0, name: "Gain", normalizedValue: .4, displayValue: "4.0", units: "", type: "float", minimum: 0, maximum: 10, steps: null, sceneMode: false, options: [], writable: true }]
  };
  const edit = resolveAssistantParameterEdit(details, "gain", "55%");
  assert.equal(edit.parameter.name, "Gain");
  assert.equal(edit.normalized, .55);
  assert.equal(edit.display, "55%");
});
