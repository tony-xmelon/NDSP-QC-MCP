import { createHash } from "node:crypto";

export const MUTATION_ACK = "I_ACCEPT_QC_HARDWARE_MUTATIONS";

export const CASES = Object.freeze({
  reconnect_device: { phase: "system", hazard: "system" },
  reset_device_session: { phase: "system", hazard: "system" },
  disconnect_device: { phase: "system", hazard: "system" },
  get_current_preset: { phase: "read", hazard: "read" },
  get_state_events: { phase: "read", hazard: "read" },
  get_tempo_clock: { phase: "read", hazard: "read" },
  get_block_details: { phase: "read", hazard: "read" },
  get_lane_control_details: { phase: "read", hazard: "read" },
  list_models: { phase: "read", hazard: "read" },
  list_presets: { phase: "read", hazard: "read" },
  list_preset_folders: { phase: "read", hazard: "read" },
  list_preset_slots: { phase: "read", hazard: "read" },
  get_master_volume: { phase: "read", hazard: "read" },
  get_device_identity: { phase: "read", hazard: "read" },
  get_inhibited_modules: { phase: "read", hazard: "read" },
  get_tuner_settings: { phase: "read", hazard: "read" },
  get_general_settings: { phase: "read", hazard: "read" },
  get_preset_screenshot: { phase: "read", hazard: "read" },
  capture_screen: { phase: "read", hazard: "read" },
  preview_parameter: { phase: "modify", hazard: "live" },
  preview_lane_control_parameter: { phase: "modify", hazard: "live" },
  create_device_backup: { phase: "persistent", hazard: "persistent" },
  set_device_name: { phase: "system", hazard: "system" },
  undo_device: { phase: "modify", hazard: "live" },
  redo_device: { phase: "modify", hazard: "live" },
  tap_screen: { phase: "system", hazard: "screen" },
  select_scene: { phase: "performance", hazard: "live" },
  copy_scene: { phase: "modify", hazard: "live" },
  set_scene_label: { phase: "modify", hazard: "live" },
  set_scene_color: { phase: "modify", hazard: "live" },
  press_footswitch: { phase: "performance", hazard: "live" },
  tap_tempo: { phase: "performance", hazard: "live" },
  navigate_bank: { phase: "performance", hazard: "live" },
  show_tuner: { phase: "performance", hazard: "live" },
  show_gig_view: { phase: "performance", hazard: "live" },
  select_mode_slot: { phase: "performance", hazard: "live" },
  set_master_volume: { phase: "performance", hazard: "live" },
  recall_preset: { phase: "modify", hazard: "live" },
  reload_preset: { phase: "modify", hazard: "live" },
  set_tempo: { phase: "performance", hazard: "live" },
  set_bypass: { phase: "modify", hazard: "live" },
  set_parameter: { phase: "modify", hazard: "live" },
  set_parameter_scene_mode: { phase: "modify", hazard: "live" },
  set_parameter_expression: { phase: "modify", hazard: "live" },
  set_lane_control_parameter: { phase: "modify", hazard: "live" },
  set_lane_control_scene_mode: { phase: "modify", hazard: "live" },
  set_expression_bypass: { phase: "modify", hazard: "live" },
  move_block: { phase: "modify", hazard: "live" },
  add_block: { phase: "modify", hazard: "live" },
  remove_block: { phase: "modify", hazard: "live" },
  set_block_footswitch: { phase: "modify", hazard: "live" },
  set_stomp_momentary: { phase: "modify", hazard: "live" },
  set_stomp_label: { phase: "modify", hazard: "live" },
  set_midi_out: { phase: "modify", hazard: "live" },
  set_preset_load_midi_out: { phase: "modify", hazard: "live" },
  set_chain_input: { phase: "modify", hazard: "live" },
  set_chain_output: { phase: "modify", hazard: "live" },
  set_chain_split: { phase: "modify", hazard: "live" },
  save_preset_as: { phase: "persistent", hazard: "persistent" },
  rename_current_preset: { phase: "persistent", hazard: "persistent" },
  copy_preset: { phase: "persistent", hazard: "persistent" },
  set_general_integer: { phase: "persistent", hazard: "persistent" },
  set_general_toggle: { phase: "persistent", hazard: "persistent" },
  set_scene_bypass_behavior: { phase: "persistent", hazard: "persistent" },
  set_master_volume_assignment: { phase: "persistent", hazard: "persistent" },
  set_global_bypass: { phase: "persistent", hazard: "persistent" }
});

const requiredFixturePaths = [
  "target",
  "safety.expectedSerialSuffix",
  "scratchPreset.setlistKey",
  "scratchPreset.position",
  "scratchPreset.requiredNamePrefix",
  "presetScreenshot.folderName",
  "presetScreenshot.position",
  "parameter.row",
  "parameter.column",
  "parameter.index",
  "parameter.testValue",
  "temporaryBlock.modelId",
  "temporaryBlock.row",
  "temporaryBlock.addColumn",
  "temporaryBlock.moveColumn",
  "temporaryBlock.footswitch",
  "routing.row",
  "routing.testInputId",
  "routing.testOutputId",
  "routing.testSplitColumn",
  "routing.testMixColumn",
  "performance.scene",
  "performance.sceneCopyDestination",
  "performance.sceneTestLabel",
  "performance.sceneTestColor",
  "performance.footswitchIndex",
  "performance.modeSlot",
  "performance.restoreModeSlot",
  "performance.tempo",
  "performance.masterVolume",
  "persistent.slotA.setlistKey",
  "persistent.slotA.position",
  "persistent.slotB.setlistKey",
  "persistent.slotB.position",
  "persistent.namePrefix",
  "system.temporaryDeviceName",
  "screenTap.x",
  "screenTap.y",
  "screenTap.restoreX",
  "screenTap.restoreY"
];

function atPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

export function validateCoverage(contract) {
  const names = contract.actions.map((action) => action.name);
  const missing = names.filter((name) => !CASES[name]);
  const stale = Object.keys(CASES).filter((name) => !names.includes(name));
  if (missing.length || stale.length) {
    throw new Error(`Hardware case drift. Missing: ${missing.join(", ") || "none"}; stale: ${stale.join(", ") || "none"}.`);
  }
  return names;
}

export function validateConfig(config, { requireAll = false } = {}) {
  if (!config || typeof config !== "object") throw new Error("A hardware conformance config object is required.");
  if (!config.transport || !["gateway-stdio", "mcp-http"].includes(config.transport.kind)) {
    throw new Error("transport.kind must be gateway-stdio or mcp-http.");
  }
  if (!config.target || !["windows", "android"].includes(config.target)) throw new Error("target must be windows or android.");
  if (config.transport.kind === "gateway-stdio" && !config.transport.command) throw new Error("gateway-stdio requires transport.command.");
  if (config.transport.kind === "mcp-http" && !config.transport.endpoint) throw new Error("mcp-http requires transport.endpoint.");
  const missing = requiredFixturePaths.filter((path) => atPath(config, path) === undefined || atPath(config, path) === "");
  if (requireAll && missing.length) throw new Error(`Full physical coverage requires config values: ${missing.join(", ")}`);
  return missing;
}

export function contractDigest(contract) {
  return createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}

export function validateReleaseReports(contract, reports) {
  const expectedNames = validateCoverage(contract);
  const expectedDigest = contractDigest(contract);
  const byTarget = new Map(reports.map((report) => [report.target, report]));
  const errors = [];
  for (const target of ["windows", "android"]) {
    const report = byTarget.get(target);
    if (!report) { errors.push(`missing ${target} report`); continue; }
    if (report.contractSha256 !== expectedDigest) errors.push(`${target} contract digest does not match`);
    if (report.summary?.complete !== true) errors.push(`${target} report is incomplete`);
    const passed = new Set(report.results?.filter((result) => result.status === "passed").map((result) => result.name));
    for (const name of ["system.status", ...expectedNames]) if (!passed.has(name)) errors.push(`${target} did not pass ${name}`);
    if (report.restoration?.some((item) => item.status !== "passed")) errors.push(`${target} restoration failed`);
  }
  if (errors.length) throw new Error(`Hardware release gate failed: ${errors.join("; ")}.`);
  return { targets: ["windows", "android"], contractSha256: expectedDigest, actionsPerTarget: expectedNames.length };
}

export function snakeToCamel(value) {
  return value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

export function gatewayArguments(actionName, args) {
  const output = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (key === "confirm_risky_operation" || key === "confirm_persistent_write") continue;
    if ((actionName === "preview_parameter" || actionName === "preview_lane_control_parameter") && key === "expected_value") continue;
    const target = actionName === "rename_current_preset" && key === "new_name" ? "name" : snakeToCamel(key);
    output[target] = value;
  }
  if (actionName === "rename_current_preset") output.confirmRename = true;
  return output;
}

export function redactEvidence(value) {
  if (Array.isArray(value)) return value.map(redactEvidence);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/serial|credential|token|authorization/i.test(key)) {
      output[key] = typeof item === "string" && item ? `sha256:${createHash("sha256").update(item).digest("hex").slice(0, 12)}` : "[redacted]";
    } else if (/pngBase64|data|payloadBase64/i.test(key) && typeof item === "string") {
      output[key] = `[binary ${Buffer.byteLength(item, "base64")} bytes]`;
    } else {
      output[key] = redactEvidence(item);
    }
  }
  return output;
}

export function actionPlan(contract, enabledHazards = new Set(["read"])) {
  return validateCoverage(contract).map((name) => ({
    name,
    ...CASES[name],
    enabled: enabledHazards.has(CASES[name].hazard)
  }));
}

export function assertMutationAcknowledged(environment = process.env) {
  if (environment.QC_HARDWARE_TEST_ACK !== MUTATION_ACK) {
    throw new Error(`Mutation execution requires QC_HARDWARE_TEST_ACK=${MUTATION_ACK}.`);
  }
}

export function assertDisposableSlots(config, slots) {
  const seen = new Set();
  for (const slot of slots) {
    const key = `${slot.setlistKey}:${slot.position}`;
    if (seen.has(key)) throw new Error("Persistent-test slots A and B must be distinct.");
    seen.add(key);
    if (slot.setlistKey === config.scratchPreset.setlistKey && slot.position === config.scratchPreset.position) {
      throw new Error("A disposable persistent-test slot cannot be the source scratch preset.");
    }
  }
}

export function resultSnapshot(result) {
  return result?.snapshot && typeof result.snapshot === "object" ? result.snapshot : undefined;
}

export function pngSignatureIsValid(image, expectedWidth, expectedHeight) {
  if (image?.width !== expectedWidth || image?.height !== expectedHeight || typeof image?.pngBase64 !== "string") return false;
  return Buffer.from(image.pngBase64, "base64").subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
}
