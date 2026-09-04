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
