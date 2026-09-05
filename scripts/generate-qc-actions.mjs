import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(resolve(root, "contracts/qc-actions.v1.json"), "utf8"));
const gatewayManifest = JSON.parse(await readFile(resolve(root, "contracts/gateway-methods.v1.json"), "utf8"));
const domain = JSON.parse(await readFile(resolve(root, "contracts/qc-domain.v1.json"), "utf8"));
const { gridRows, gridColumns, scenes, minimumTempoBpm, maximumTempoBpm } = domain.limits;
const accessModes = manifest.accessModes;
if (!Array.isArray(accessModes) || accessModes.join(",") !== "read-only,performance,modify,full") {
  throw new Error("QC access modes must define the cumulative read-only, performance, modify, full order");
}
const schemaType = (kind) => {
  if (kind === "string") return { type: "string", minLength: 1 };
  if (kind === "nullable-string") return { type: ["string", "null"] };
  if (kind === "nullable-integer") return { type: ["integer", "null"] };
  if (kind === "nullable-boolean") return { type: ["boolean", "null"] };
  if (kind === "nullable-normalized") return { type: ["number", "null"], minimum: 0, maximum: 1 };
  if (kind === "nullable-input-gain") return { type: ["number", "null"], minimum: -12, maximum: 60 };
  if (kind === "nullable-pan") return { type: ["number", "null"], minimum: -1, maximum: 1 };
  if (kind === "nullable-tempo-volume-db") return { type: ["number", "null"], minimum: -60, maximum: 9 };
  if (kind === "nullable-time-signature") return { type: ["string", "null"], enum: ["2/4", "3/4", "4/4", "5/4", "6/4", "7/4", "8/4", "9/4", "10/4", "11/4", "12/4", "13/4", "3/8", "6/8", "9/8", "12/8", "5/8 (3+2)", "5/8 (2+3)", "7/8 (3+2+2)", "7/8 (2+3+2)", "7/8 (2+2+3)", null] };
  if (kind === "nullable-tempo-subdivision") return { type: ["string", "null"], enum: ["1/4", "1/8", "1/8T", "1/16", null] };
  if (kind === "nullable-metronome-sound") return { type: ["string", "null"], enum: ["BLIP", "BLOCK", "COWBELL", "DIGITAL", "DRUM KIT", "SOFT KIT", null] };
  if (kind === "nullable-metronome-routing") return { type: ["string", "null"], enum: ["MULTI", "HP", "OUT 1/2", "OUT 3/4", "SEND 1/2", null] };
  if (kind === "nullable-metronome-beats") return { type: ["array", "null"], maxItems: 13, items: { type: "string", enum: ["OFF", "MUTE", "DOWN", "ON"] } };
  if (kind === "io-input-port") return { type: "integer", minimum: 1, maximum: 14 };
  if (kind === "io-output-port") return { type: "integer", minimum: 1, maximum: 22 };
  if (kind === "grid-row") return { type: "integer", minimum: 0, maximum: gridRows - 1 };
  if (kind === "grid-column") return { type: "integer", minimum: 0, maximum: gridColumns - 1 };
  if (kind === "parameter-column") return { type: "integer", minimum: 0, maximum: gridColumns + 1 };
  if (kind === "lane-control") return { type: "string", enum: ["inputGate", "laneOutput"] };
  if (kind === "general-integer-setting") return { type: "string", enum: ["screenBrightness", "ledBrightness", "dimmedLedBrightness", "holdTiming", "midiChannel"] };
  if (kind === "general-toggle-setting") return { type: "string", enum: ["midiOverUsb", "ignoreDuplicatePc", "stompModeAutoAssign", "swapTempoTunerAccess", "disableInternetConnectionCheck", "dynamicDelayCompensation", "presetDimmed", "midiClockIn", "gigViewStompAccess"] };
  if (kind === "scene-bypass-behavior") return { type: "string", enum: ["alwaysOverwrite", "nonstompOverwrite", "neverOverwrite"] };
  if (kind === "tempo-mode") return { type: "string", enum: ["PRESET", "GLOBAL"] };
  if (kind === "global-eq-filter") return { type: ["integer", "null"], minimum: 0, maximum: 4 };
  if (kind === "mode-cycle") return { type: "array", minItems: 1, maxItems: 3, uniqueItems: true, items: { type: "integer", minimum: 0, maximum: 8 } };
  if (kind === "looper-command") return { type: "string", enum: ["open", "close", "duplicate", "oneShot", "halfSpeed", "punch", "record", "play", "reverse", "undoRedo", "duplicateMode", "quantize", "midiClockStart", "performMode", "routingMode"] };
  if (kind === "nullable-looper-value") return { type: ["integer", "null"], minimum: 0, maximum: 13 };
  if (kind === "boolean-row-array") return { type: "array", minItems: 4, maxItems: 4, items: { type: "boolean" } };
  if (kind === "scene-index") return { type: "integer", minimum: 0, maximum: scenes - 1 };
  if (kind === "tempo") return { type: "integer", minimum: minimumTempoBpm, maximum: maximumTempoBpm };
  if (kind === "screen-x") return { type: "integer", minimum: 0, maximum: 799 };
  if (kind === "screen-y") return { type: "integer", minimum: 0, maximum: 479 };
  if (kind === "midi-message-array") return {
    type: "array", maxItems: 12, items: {
      type: "object", additionalProperties: false,
      properties: {
        type: { type: "integer", minimum: 1, maximum: 3 },
        channel: { type: "integer", minimum: 1, maximum: 16 },
        param1: { type: "integer", minimum: 0, maximum: 127 },
        param2: { type: "integer", minimum: 0, maximum: 127 },
        param3: { type: "integer", minimum: 0, maximum: 127 }
      },
      required: ["type", "channel", "param1", "param2", "param3"]
    }
  };
  if (kind === "pedal") return { type: "integer", minimum: 1, maximum: 2 };
  if (kind === "expression-switch-mode") return { type: "integer", minimum: 0, maximum: 2 };
  if (kind === "bypass-delay") return { type: "integer", minimum: 0, maximum: 5000 };
  return { type: kind };
};
const description = (value) => value
  .replaceAll("{maxScene}", String(scenes - 1))
  .replaceAll("{minTempo}", String(minimumTempoBpm))
  .replaceAll("{maxTempo}", String(maximumTempoBpm));
const pyLiteral = (value) => value === null ? "None"
  : value === true ? "True"
  : value === false ? "False"
  : typeof value === "string" ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(pyLiteral).join(", ")}]`
  : typeof value === "object" ? `{${Object.entries(value).map(([key, child]) => `${JSON.stringify(key)}: ${pyLiteral(child)}`).join(", ")}}`
  : String(value);
const accessByName = new Map();
for (const [tier, names] of Object.entries(manifest.accessTiers)) {
  for (const name of names) {
    if (accessByName.has(name)) throw new Error(`Action ${name} occurs in more than one access tier`);
    accessByName.set(name, tier);
  }
}
const actions = manifest.actions.map((action) => ({
  ...action,
  access: action.classification === "read" ? "read-only" : accessByName.get(action.name),
  description: description(action.description),
  inputSchema: {
    type: "object",
    properties: Object.fromEntries(Object.entries(action.properties).map(([name, kind]) => [name, schemaType(kind)])),
    required: action.required,
    additionalProperties: false
  }
}));
const snakeName = (value) => value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const gatewaySchemas = Object.fromEntries(actions.map((action) => {
  const method = gatewayManifest.methods.find((candidate) => candidate.rpc === action.rpc);
  if (!method) throw new Error(`Action ${action.name} has no gateway method`);
  const properties = Object.fromEntries((method.args ?? []).map((argument) => {
    const name = typeof argument === "string" ? argument : argument.name;
    const actionName = action.rpc === "device.renameCurrentPreset" && name === "name" ? "new_name" : snakeName(name);
    const schema = name === "confirmRename" ? { type: "boolean" } : action.inputSchema.properties[actionName];
    if (!schema) throw new Error(`Gateway argument ${action.rpc}.${name} has no MCP schema`);
    return [name, schema];
  }));
  return [action.name, properties];
}));
for (const action of actions) {
  if (!action.access) throw new Error(`Write action ${action.name} has no access tier`);
  const confirmationFields = Object.keys(action.properties).filter((name) => name.startsWith("confirm_"));
  if (confirmationFields.some((name) => action.properties[name] !== "boolean" || !action.required.includes(name))) {
    throw new Error(`Action ${action.name} has an optional or non-boolean confirmation field`);
  }
  if (action.classification === "risky-write" && !confirmationFields.includes("confirm_risky_operation")) {
    throw new Error(`Risky action ${action.name} must require confirm_risky_operation`);
  }
  if (action.classification === "persistent-write" && !confirmationFields.includes("confirm_persistent_write")) {
    throw new Error(`Persistent action ${action.name} must require confirm_persistent_write`);
  }
  if (["read", "live-write"].includes(action.classification) && confirmationFields.length) {
    throw new Error(`Non-confirmed action ${action.name} unexpectedly declares confirmation fields`);
  }
}
for (const name of accessByName.keys()) {
  const action = actions.find((candidate) => candidate.name === name);
  if (!action || action.classification === "read") throw new Error(`Invalid write access-tier action ${name}`);
}
const typescript = `// Generated by scripts/generate-qc-actions.mjs. Do not edit by hand.
export const SHARED_QC_ACCESS_MODES = ${JSON.stringify(accessModes)} as const;
export type SharedQcAccessMode = typeof SHARED_QC_ACCESS_MODES[number];
export const SHARED_QC_ACTIONS = ${JSON.stringify(actions, null, 2)} as const;
export type SharedQcActionName = typeof SHARED_QC_ACTIONS[number]["name"];
`;
const python = `# Generated by scripts/generate-qc-actions.mjs. Do not edit by hand.
MCP_INSTRUCTIONS = ${JSON.stringify(manifest.mcpInstructions)}
MCP_GATEWAY_ARGUMENTS = ${JSON.stringify(Object.fromEntries(actions.map((action) => {
  const method = gatewayManifest.methods.find((candidate) => candidate.rpc === action.rpc);
  if (!method) throw new Error(`Action ${action.name} has no gateway method`);
  return [action.name, (method.args ?? []).map((argument) => typeof argument === "string" ? argument : argument.name)];
})), null, 2)}
MCP_GATEWAY_SCHEMAS = ${pyLiteral(gatewaySchemas)}
SHARED_QC_ACTIONS = ${JSON.stringify(Object.fromEntries(actions.map(({ name, rpc, classification, access, description }) => [name, { rpc, classification, access, description }])), null, 2)
  .replaceAll("true", "True").replaceAll("false", "False").replaceAll("null", "None")}
`;
const javaValues = (values) => values.map((value) => `        ${JSON.stringify(value)}`).join(",\n");
const remoteMethods = ["system.status", ...new Set(actions.map(({ rpc }) => rpc))];
const readOnlyMethods = ["system.status", ...new Set(actions.filter(({ classification }) => classification === "read").map(({ rpc }) => rpc))];
const performanceMethods = [...new Set(actions.filter(({ access }) => access === "performance").map(({ rpc }) => rpc))];
const modifyMethods = [...new Set(actions.filter(({ access }) => access === "modify").map(({ rpc }) => rpc))];
const confirmationMethods = [...new Set(actions.filter(({ classification }) =>
  classification === "persistent-write" || classification === "risky-write"
).map(({ rpc }) => rpc))];
const java = `// Generated by scripts/generate-qc-actions.mjs. Do not edit by hand.
package com.qccontrol.mobile;

final class GeneratedRemoteActions {
    private GeneratedRemoteActions() {}

    static final String ACCESS_READ_ONLY = ${JSON.stringify(accessModes[0])};
    static final String ACCESS_PERFORMANCE = ${JSON.stringify(accessModes[1])};
    static final String ACCESS_MODIFY = ${JSON.stringify(accessModes[2])};
    static final String ACCESS_FULL = ${JSON.stringify(accessModes[3])};

    static boolean isAccessMode(String mode) {
        return ACCESS_READ_ONLY.equals(mode) || ACCESS_PERFORMANCE.equals(mode)
            || ACCESS_MODIFY.equals(mode) || ACCESS_FULL.equals(mode);
    }

    private static final String[] ALLOWED = {
${javaValues(remoteMethods)}
    };

    private static final String[] READ_ONLY = {
${javaValues(readOnlyMethods)}
    };

    private static final String[] PERFORMANCE = {
${javaValues(performanceMethods)}
    };

    private static final String[] MODIFY = {
${javaValues(modifyMethods)}
    };

    private static final String[] REQUIRES_CONFIRMATION = {
${javaValues(confirmationMethods)}
    };

    static boolean contains(String method) { return contains(ALLOWED, method); }
    static boolean isReadOnly(String method) { return contains(READ_ONLY, method); }
    static boolean isPerformance(String method) { return contains(PERFORMANCE, method); }
    static boolean isModify(String method) { return contains(MODIFY, method); }
    static boolean requiresConfirmation(String method) { return contains(REQUIRES_CONFIRMATION, method); }

    private static boolean contains(String[] values, String method) {
        for (String candidate : values) if (candidate.equals(method)) return true;
        return false;
    }
}
`;
const rustValues = (values) => `${values.map((value) => `    ${JSON.stringify(value)}`).join(",\n")},`;
const rust = `// Generated by scripts/generate-qc-actions.mjs. Do not edit by hand.
pub(crate) const ACCESS_READ_ONLY: &str = ${JSON.stringify(accessModes[0])};
pub(crate) const ACCESS_PERFORMANCE: &str = ${JSON.stringify(accessModes[1])};
pub(crate) const ACCESS_MODIFY: &str = ${JSON.stringify(accessModes[2])};
pub(crate) const ACCESS_FULL: &str = ${JSON.stringify(accessModes[3])};

const ALLOWED: &[&str] = &[
${rustValues(remoteMethods)}
];

const READ_ONLY: &[&str] = &[
${rustValues(readOnlyMethods)}
];

const PERFORMANCE: &[&str] = &[
${rustValues(performanceMethods)}
];

const MODIFY: &[&str] = &[
${rustValues(modifyMethods)}
];

pub(crate) fn contains(method: &str) -> bool {
    ALLOWED.contains(&method)
}
pub(crate) fn is_read_only(method: &str) -> bool {
    READ_ONLY.contains(&method)
}
pub(crate) fn is_performance(method: &str) -> bool {
    PERFORMANCE.contains(&method)
}
pub(crate) fn is_modify(method: &str) -> bool {
    MODIFY.contains(&method)
}
`;
const rustKind = (action, name, kind) => {
  const enums = {
    "lane-control": '["inputGate", "laneOutput"]',
    "general-integer-setting": '["screenBrightness", "ledBrightness", "dimmedLedBrightness", "holdTiming", "midiChannel"]',
    "general-toggle-setting": '["midiOverUsb", "ignoreDuplicatePc", "stompModeAutoAssign", "swapTempoTunerAccess", "disableInternetConnectionCheck", "dynamicDelayCompensation", "presetDimmed", "midiClockIn", "gigViewStompAccess"]',
    "scene-bypass-behavior": '["alwaysOverwrite", "nonstompOverwrite", "neverOverwrite"]',
    "tempo-mode": '["PRESET", "GLOBAL"]',
    "looper-command": '["open", "close", "duplicate", "oneShot", "halfSpeed", "punch", "record", "play", "reverse", "undoRedo", "duplicateMode", "quantize", "midiClockStart", "performMode", "routingMode"]'
  };
  if (enums[kind]) return `Kind::StringEnum(&${enums[kind]})`;
  const nullableEnums = {
    "nullable-time-signature": '["2/4", "3/4", "4/4", "5/4", "6/4", "7/4", "8/4", "9/4", "10/4", "11/4", "12/4", "13/4", "3/8", "6/8", "9/8", "12/8", "5/8 (3+2)", "5/8 (2+3)", "7/8 (3+2+2)", "7/8 (2+3+2)", "7/8 (2+2+3)"]',
    "nullable-tempo-subdivision": '["1/4", "1/8", "1/8T", "1/16"]',
    "nullable-metronome-sound": '["BLIP", "BLOCK", "COWBELL", "DIGITAL", "DRUM KIT", "SOFT KIT"]',
    "nullable-metronome-routing": '["MULTI", "HP", "OUT 1/2", "OUT 3/4", "SEND 1/2"]'
  };
  if (nullableEnums[kind]) return `Kind::NullableStringEnum(&${nullableEnums[kind]})`;
  const direct = {
    boolean: "BOOL", "boolean-row-array": "Kind::BooleanRows", "bypass-delay": "BYPASS_DELAY",
    "expression-switch-mode": "EXPRESSION_SWITCH_MODE", "grid-column": "GRID_COLUMN",
    "grid-row": "GRID_ROW", "parameter-column": "PARAMETER_COLUMN", "scene-index": "SCENE",
    tempo: "TEMPO", pedal: "PEDAL", "midi-message-array": "Kind::MidiMessages",
    "nullable-string": "Kind::NullableString", "nullable-boolean": "Kind::NullableBoolean",
    "nullable-looper-value": "Kind::NullableInteger { min: 0, max: Some(13) }",
    "nullable-normalized": "Kind::NullableNumber { min: 0.0, max: Some(1.0) }",
    "nullable-input-gain": "Kind::NullableNumber { min: -12.0, max: Some(60.0) }",
    "nullable-pan": "Kind::NullableNumber { min: -1.0, max: Some(1.0) }",
    "nullable-tempo-volume-db": "Kind::NullableNumber { min: -60.0, max: Some(9.0) }",
    "global-eq-filter": "Kind::NullableInteger { min: 0, max: Some(4) }",
    "io-input-port": "Kind::Integer { min: 1, max: Some(14) }",
    "io-output-port": "Kind::Integer { min: 1, max: Some(22) }",
    "mode-cycle": "Kind::IntegerArray { min: 0, max: 8, min_items: 1, max_items: 3, unique: true }",
    "nullable-metronome-beats": "Kind::NullableStringArray { max_items: 13, values: &[\"OFF\", \"MUTE\", \"DOWN\", \"ON\"] }"
  };
  if (direct[kind]) return direct[kind];
  if (kind === "number") return action.name === "set_tuner_reference"
    ? "Kind::Number { min: -f64::MAX, max: Some(f64::MAX) }" : "NORMALIZED";
  if (kind === "string") {
    if (action.name === "set_stomp_label" && name === "label") return "Kind::VisibleString { max_chars: 32 }";
    if (["create_device_backup", "set_device_name", "create_setlist", "delete_setlist"].includes(action.name) && name === "name") return "Kind::VisibleString { max_chars: 64 }";
    if (action.name === "duplicate_setlist" && name === "destination_name") return "Kind::VisibleString { max_chars: 64 }";
    return "TEXT";
  }
  if (kind === "screen-x") return "Kind::Integer { min: 0, max: Some(799) }";
  if (kind === "screen-y") return "Kind::Integer { min: 0, max: Some(479) }";
  if (kind === "integer") {
    if (name === "color") return "Kind::Integer { min: 0, max: Some(u32::MAX as i64) }";
    if (action.name === "press_footswitch" && name === "index") return "Kind::Integer { min: 0, max: Some(10) }";
    if (action.name === "navigate_bank" && name === "direction") return "Kind::Integer { min: -1, max: Some(1) }";
    if (action.name === "select_mode_slot" && name === "slot") return "Kind::Integer { min: 0, max: Some(2) }";
    if (action.name === "set_parameter_expression" && name === "pedal") return "Kind::Integer { min: 0, max: Some(2) }";
    if (action.name === "set_midi_out" && name === "source") return "Kind::Integer { min: 0, max: Some(9) }";
    if (action.name === "set_global_eq_band" && name === "band") return "Kind::Integer { min: 1, max: Some(5) }";
    if (action.name === "load_ir" && name === "slot") return "Kind::Integer { min: 0, max: Some(1) }";
    if ((action.name === "duplicate_setlist" && name === "expected_position") || (action.name === "move_preset" && name === "position")) return "Kind::Integer { min: 0, max: Some(255) }";
    if (name === "value" && action.name === "set_master_volume") return "PERCENT";
    if (name === "expected_value" && action.name === "set_master_volume") return "PERCENT";
    if (name === "model_id" && ["add_block", "set_model_pinned"].includes(action.name)) return "Kind::Integer { min: 1, max: None }";
    if (action.name === "set_tuner_input" && name === "input_port_id") return "Kind::Integer { min: 1, max: Some(9) }";
    if (action.name === "set_general_integer" && name === "value") return "PERCENT";
    return "UINT";
  }
  if (kind === "nullable-integer") {
    if (["footswitch", "expected_footswitch"].includes(name)) return "Kind::NullableInteger { min: 0, max: Some(7) }";
    if (["split_column", "mix_column", "expected_split_column", "expected_mix_column"].includes(name)) return "Kind::NullableInteger { min: -1, max: Some(7) }";
    if (name === "model_id") return "Kind::NullableInteger { min: 1, max: None }";
    if (name === "limit") return "Kind::NullableInteger { min: 0, max: Some(256) }";
    return "Kind::NullableInteger { min: 0, max: None }";
  }
  throw new Error(`No Rust MCP kind mapping for ${action.name}.${name}: ${kind}`);
};
const rustClassification = {
  read: "Read", "live-write": "LiveWrite", "persistent-write": "PersistentWrite", "risky-write": "RiskyWrite"
};
const rustMcpActionsRaw = `// Generated by scripts/generate-qc-actions.mjs. Do not edit by hand.\n\
pub static ACTIONS: &[ActionSpec] = &[\n${actions.map((action) => `    ActionSpec {\n\
        name: ${JSON.stringify(action.name)},\n\
        rpc: ${JSON.stringify(action.rpc)},\n\
        classification: Classification::${rustClassification[action.classification]},\n\
        description: ${JSON.stringify(action.description)},\n\
        properties: &[${Object.entries(action.properties).map(([name, kind]) => `${action.required.includes(name) ? "p!" : "p!"}(${action.required.includes(name) ? "" : "? "}${JSON.stringify(name)}, ${rustKind(action, name, kind)})`).join(", ")}],\n\
    }`).join(",\n")}\n];\n`;
const rustMcpActions = execFileSync("rustfmt", ["--edition", "2024"], {
  input: rustMcpActionsRaw,
  encoding: "utf8"
});
const rustMcpInstructions = `// Generated by scripts/generate-qc-actions.mjs. Do not edit by hand.
pub const MCP_INSTRUCTIONS: &str = ${JSON.stringify(manifest.mcpInstructions)};
`;
const relayClass = {
  read: "Read",
  "live-write": "LiveWrite",
  "risky-write": "RiskyWrite",
  "persistent-write": "PersistentWrite"
};
const snakeToCamel = (value) => value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
const relayRust = `// Generated by scripts/generate-qc-actions.mjs. Do not edit by hand.
use crate::protocol::{ActionClass, ActionPolicy};

const NONE: &[&str] = &[];
pub static ACTIONS: &[ActionPolicy] = &[
    ActionPolicy {
        name: "get_status",
        rpc: "system.status",
        class: ActionClass::Read,
        required_argument_confirmations: NONE,
        allowed_arguments: NONE,
        required_arguments: NONE,
        gateway_arguments: &[],
        gateway_true_arguments: NONE,
    },
${actions.map((action) => {
  const confirmations = action.required.filter((name) => name.startsWith("confirm_"));
  const required = confirmations.length
    ? `&[${confirmations.map((name) => JSON.stringify(name)).join(", ")}]`
    : "NONE";
  const gatewayMethod = gatewayManifest.methods.find((candidate) => candidate.rpc === action.rpc);
  if (!gatewayMethod) throw new Error(`Action ${action.name} has no gateway method`);
  const gatewayNames = new Set((gatewayMethod.args ?? []).map((argument) =>
    typeof argument === "string" ? argument : argument.name));
  const mappings = Object.keys(action.properties).flatMap((name) => {
    const target = action.name === "rename_current_preset" && name === "new_name"
      ? "name" : snakeToCamel(name);
    return gatewayNames.has(target) ? [[name, target]] : [];
  });
  const mappedTargets = new Set(mappings.map(([, target]) => target));
  const gatewayTrueArguments = [...gatewayNames].filter((name) =>
    name.startsWith("confirm") && !mappedTargets.has(name));
  return `    ActionPolicy {
        name: ${JSON.stringify(action.name)},
        rpc: ${JSON.stringify(action.rpc)},
        class: ActionClass::${relayClass[action.classification]},
        required_argument_confirmations: ${required},
        allowed_arguments: &[${Object.keys(action.properties).map((name) => JSON.stringify(name)).join(", ")}],
        required_arguments: &[${action.required.map((name) => JSON.stringify(name)).join(", ")}],
        gateway_arguments: &[${mappings.map(([source, target]) => `(${JSON.stringify(source)}, ${JSON.stringify(target)})`).join(", ")}],
        gateway_true_arguments: &[${gatewayTrueArguments.map((name) => JSON.stringify(name)).join(", ")}],
    },`;
}).join("\n")}
];
`;
const outputs = [
  [resolve(root, "packages/typescript/qc-core/src/generated-actions.ts"), typescript],
  [resolve(root, "services/mcp-server/src/qc_mcp_server/generated_actions.py"), python],
  [resolve(root, "services/rust-mcp/src/generated_instructions.rs"), rustMcpInstructions],
  [resolve(root, "services/rust-mcp/src/generated_actions.rs"), rustMcpActions],
  [resolve(root, "apps/android/android/app/src/main/java/com/qccontrol/mobile/GeneratedRemoteActions.java"), java],
  [resolve(root, "packages/rust/qc-relay-client/src/generated_actions.rs"), rust],
  [resolve(root, "services/qc-relay/src/generated_actions.rs"), relayRust]
];
let stale = false;
for (const [path, content] of outputs) {
  if (process.argv.includes("--check")) {
    const current = await readFile(path, "utf8").catch(() => "");
    if (current.replaceAll("\r\n", "\n") !== content) {
      console.error(`${path} is not generated from contracts/qc-actions.v1.json`);
      stale = true;
    }
  } else await writeFile(path, content);
}
if (stale) process.exitCode = 1;
