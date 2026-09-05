import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const text = (path) => readFile(resolve(root, path), "utf8");
const contract = JSON.parse(await text("contracts/gateway-methods.v1.json"));

const [generatedRust, generatedAndroid, generatedPython, broker, android, pythonDevice, pythonService, windowsHost, sharedRuntime, actionContract] = await Promise.all([
  text("packages/rust/qc-device-runtime/src/generated_gateway.rs"),
  text("apps/android/android/app/src/main/java/com/qccontrol/mobile/GeneratedGatewayMethods.java"),
  text("services/device-gateway/src/qc_device_gateway/generated_gateway_dispatch.py"),
  text("services/device-broker/src/rpc.rs"),
  text("apps/android/android/app/src/main/java/com/qccontrol/mobile/QcUsbPlugin.java"),
  text("services/device-gateway/src/qc_device_gateway/device.py"),
  text("services/device-gateway/src/qc_device_gateway/service.py"),
  text("apps/windows/src-tauri/src/lib.rs"),
  text("packages/rust/qc-device-runtime/src/request.rs"),
  text("contracts/qc-actions.v1.json").then(JSON.parse),
]);

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rustVariant = (value) => value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join("");
const dispatchEntries = (name) => Object.entries(contract[name]).flatMap(
  ([kind, methods]) => methods.map((rpc) => ({ kind, rpc })),
);
const contractRpcs = contract.methods.map(({ rpc }) => rpc);

assert.equal(new Set(contractRpcs).size, contractRpcs.length, "gateway contract has duplicate RPCs");
assert.deepEqual(
  [...contractRpcs].sort(),
  ["system.status", ...actionContract.actions.map(({ rpc }) => rpc)].sort(),
  "canonical actions and gateway RPCs must have exact membership parity",
);

for (const dispatchName of ["androidDispatch", "brokerDispatch"]) {
  const entries = dispatchEntries(dispatchName);
  assert.equal(entries.length, contractRpcs.length, `${dispatchName} must classify every RPC once`);
  assert.deepEqual(
    [...new Set(entries.map(({ rpc }) => rpc))].sort(),
    [...contractRpcs].sort(),
    `${dispatchName} must classify exactly the canonical gateway surface`,
  );
}

for (const { kind, rpc } of dispatchEntries("brokerDispatch")) {
  const variant = rustVariant(kind);
  assert.match(generatedRust, new RegExp(`"${escape(rpc)}" => Some\\(BrokerDispatch::${variant}\\)`),
    `${rpc} is missing its generated broker route`);
  assert.match(broker, new RegExp(`Some\\(generated_gateway::BrokerDispatch::${variant}\\)`),
    `${rpc} resolves to broker route ${kind}, but that route has no concrete handler`);
  if (["GATEWAY_READ", "GATEWAY_OPERATION", "PARAMETER_ASSIGNMENT"].includes(kind)) {
    assert.match(sharedRuntime, new RegExp(`"${escape(rpc)}"`),
      `${rpc} reaches a generic broker route but is unsupported by the shared planner`);
  }
}
assert.match(broker, /generated_gateway::broker_dispatch\(&request\.method\)/,
  "the broker must route through generated metadata");
assert.doesNotMatch(broker, /(?:todo|unimplemented)!\(/,
  "the broker must not ship placeholder canonical handlers");

for (const { kind, rpc } of dispatchEntries("androidDispatch")) {
  assert.match(generatedAndroid, new RegExp(`case "${escape(rpc)}": return "${kind}"`),
    `${rpc} is missing its generated Android route`);
  assert.match(android, new RegExp(`(?:case "${kind}"|"${kind}"\\.equals\\(dispatch\\))`),
    `${rpc} resolves to Android route ${kind}, but that route has no concrete handler`);
  if (["CORRELATED_READ", "PLANNED_WRITE", "PRESET_WRITE", "PERSISTENT_WRITE"].includes(kind)) {
    assert.match(sharedRuntime, new RegExp(`"${escape(rpc)}"`),
      `${rpc} reaches a generic Android route but is unsupported by the shared planner`);
  }
}
assert.match(android, /stateDecoder\.gatewayPlan\(method,/,
  "Android planned writes must enter the shared Rust planner");
assert.match(android, /for \(QcNativeStateDecoder\.EncodedMessage message : plan\.messages\) writeMessage\(message\)/,
  "Android planned writes must emit every encoded native message");
assert.doesNotMatch(android, /completedFuture\(new JSObject\(\)\.put\("(?:accepted|success)", true\)\)/,
  "Android must not report unconditional mock-only write success");
for (const source of [broker, android]) {
  for (const field of ["accepted", "verified", "verification", "detail"]) {
    assert.match(source, new RegExp(`"${field}"`),
      `native write responses must retain the shared ${field} field`);
  }
}

for (const method of contract.methods) {
  if (method.rpc === "system.status" || method.python === false) continue;
  assert.ok(method.target, `${method.rpc} needs a Python target or python:false`);
  assert.match(generatedPython, new RegExp(`return device\\.${escape(method.target)}\\(`),
    `${method.rpc} does not invoke its generated Python gateway target`);
  assert.match(pythonDevice, new RegExp(`^[ \\t]+def ${escape(method.target)}\\(`, "m"),
    `${method.rpc} targets missing Python implementation ${method.target}`);
  const start = pythonDevice.search(new RegExp(`^[ \\t]+def ${escape(method.target)}\\(`, "m"));
  const remainder = pythonDevice.slice(start);
  const next = remainder.slice(1).search(/^    def |^class /m);
  const implementation = next < 0 ? remainder : remainder.slice(0, next + 1);
  assert.match(implementation, /\b(?:return|raise)\b/,
    `${method.rpc} Python target ${method.target} has no observable result or failure`);
  assert.doesNotMatch(pythonDevice, new RegExp(
    `def ${escape(method.target)}\\([^\\n]*\\):[ \\t]*(?:pass|return (?:None|\\{\\}|\\[\\]))[ \\t]*$`, "m"),
    `${method.rpc} Python target ${method.target} is a silent placeholder`);
}
assert.doesNotMatch(generatedPython, /return None(?:\s|$)/,
  "generated Python gateway routes must not silently return None");

for (const [name, source] of [["Rust broker", broker], ["Python gateway", pythonService]]) {
  for (const code of [-32600, -32602, -32601, -32010]) {
    assert.match(source, new RegExp(String(code)),
      `${name} must preserve JSON-RPC error code ${code}`);
  }
  assert.match(source, /"jsonrpc"\s*:\s*"2\.0"/,
    `${name} must return JSON-RPC 2.0 envelopes`);
}

assert.match(windowsHost, /generated_gateway::METHODS\.contains\(&method\.as_str\(\)\)/,
  "Windows must reject RPCs outside the generated contract");
assert.match(windowsHost, /if nonblocking_read[\s\S]*\.try_lock\(\)[\s\S]*\.request_detailed\(&method, params\)/,
  "Windows nonblocking reads must enter the canonical gateway transport");
assert.match(windowsHost, /if nonblocking_read[\s\S]*else[\s\S]*\.lock\(\)[\s\S]*\.request_detailed\(&method, params\)/,
  "Windows canonical RPCs must enter the canonical gateway transport");
assert.match(windowsHost, /GatewayRequestFailure::Remote/,
  "Windows must preserve native broker failures instead of treating them as success");

for (const method of [
  "device.pressFootswitch", "device.tapTempo", "device.selectModeSlot",
  "device.showTuner", "device.showGigView", "device.controlLooper",
]) {
  assert.match(sharedRuntime, new RegExp(`"${escape(method)}"`),
    `${method} is missing its shared low-latency MIDI plan`);
}
assert.match(broker, /gateway_performance_midi\(/,
  "Windows broker must execute performance RPCs through the shared MIDI classification");

console.log(JSON.stringify({
  verified: true,
  actions: actionContract.actions.length,
  methods: contract.methods.length,
  brokerRoutes: Object.keys(contract.brokerDispatch).length,
  androidRoutes: Object.keys(contract.androidDispatch).length,
  pythonTargets: contract.methods.filter((method) => method.rpc !== "system.status" && method.python !== false).length,
}));
