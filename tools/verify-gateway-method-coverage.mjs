import { readFile } from "node:fs/promises";

const contract = JSON.parse(await readFile("contracts/gateway-methods.v1.json", "utf8"));
const broker = await readFile("services/device-broker/src/rpc.rs", "utf8");
const windowsHost = await readFile("apps/windows/src-tauri/src/lib.rs", "utf8");
const sharedRuntime = await readFile("packages/rust/qc-device-runtime/src/request.rs", "utf8");

// Every physical MIDI operation uses the app-owned persistent low-latency lane.
// The broker retains the same handlers for headless gateway deployments.
const hostMidiMethods = [
  "device.pressFootswitch",
  "device.tapTempo",
  "device.selectModeSlot",
  "device.showTuner",
  "device.showGigView",
  "device.controlLooper",
];

const missing = [];
for (const method of contract.methods) {
  if (broker.includes(`"${method.rpc}"`)) continue;
  missing.push(method.rpc);
}

for (const method of hostMidiMethods) {
  if (!sharedRuntime.includes(`"${method}"`)) missing.push(`${method} (shared MIDI plan)`);
}
if (!windowsHost.includes("is_host_midi_method")) missing.push("Windows shared MIDI dispatch");

if (missing.length > 0) {
  throw new Error(`Gateway contract methods without a native Rust implementation: ${missing.join(", ")}`);
}

console.log(JSON.stringify({ verified: true, methods: contract.methods.length, hostMidiMethods: hostMidiMethods.length }));
