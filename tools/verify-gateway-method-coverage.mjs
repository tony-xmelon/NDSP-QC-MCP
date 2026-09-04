import { readFile } from "node:fs/promises";

const contract = JSON.parse(await readFile("contracts/gateway-methods.v1.json", "utf8"));
const broker = await readFile("services/device-broker/src/rpc.rs", "utf8");
const windowsHost = await readFile("apps/windows/src-tauri/src/lib.rs", "utf8");

// These operations intentionally remain in the Tauri MIDI host because
// Windows already owns its persistent MIDI port. Every USB operation must be
// dispatched by the native Rust broker.
const hostMidiMethods = new Map([
  ["device.pressFootswitch", "press_footswitch"],
  ["device.tapTempo", "tap_tempo"],
  ["device.selectModeSlot", "select_mode_slot"],
]);

const missing = [];
for (const method of contract.methods) {
  if (broker.includes(`"${method.rpc}"`)) continue;
  const hostCommand = hostMidiMethods.get(method.rpc);
  if (hostCommand && windowsHost.includes(`fn ${hostCommand}`)) continue;
  missing.push(method.rpc);
}

if (missing.length > 0) {
  throw new Error(`Gateway contract methods without a native Rust implementation: ${missing.join(", ")}`);
}

console.log(JSON.stringify({ verified: true, methods: contract.methods.length, hostMidiMethods: hostMidiMethods.size }));
