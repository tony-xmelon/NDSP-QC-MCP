import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const contract = JSON.parse(readFileSync(new URL("../contracts/qc-actions.v1.json", import.meta.url), "utf8"));
const generatedRust = readFileSync(new URL("../packages/rust/qc-relay-client/src/generated_actions.rs", import.meta.url), "utf8");
const client = readFileSync(new URL("../packages/rust/qc-relay-client/src/lib.rs", import.meta.url), "utf8");
const windowsRelay = readFileSync(new URL("../apps/windows/src-tauri/src/relay.rs", import.meta.url), "utf8");
const windowsRoot = readFileSync(new URL("../apps/windows/src-tauri/src/lib.rs", import.meta.url), "utf8");
const windowsApp = readFileSync(new URL("../apps/windows/src/App.tsx", import.meta.url), "utf8");

test("shared contract assigns every write to exactly one cumulative access tier", () => {
  const assigned = new Map<string, string>();
  for (const [tier, names] of Object.entries(contract.accessTiers as Record<string, string[]>)) {
    for (const name of names) {
      assert.equal(assigned.has(name), false, `${name} is assigned more than once`);
      assigned.set(name, tier);
    }
  }
  for (const action of contract.actions) {
    if (action.classification !== "read") assert.ok(assigned.has(action.name), `${action.name} has no access tier`);
  }
  assert.equal(assigned.get("set_tempo"), "performance");
  assert.equal(assigned.get("set_parameter"), "modify");
  assert.equal(assigned.get("set_device_name"), "full");
});

test("Windows outbound relay shares the generated MCP action boundary", () => {
  for (const action of contract.actions) {
    assert.match(generatedRust, new RegExp(`"${action.rpc.replace(".", "\\.")}"`));
  }
  assert.match(client, /generated_actions::contains\(&method\)/);
  assert.match(client, /Self::Performance/);
  assert.match(client, /generated_actions::is_performance/);
  assert.match(client, /Self::Modify/);
  assert.match(client, /generated_actions::is_modify/);
  assert.match(client, /REPLAYED_REQUEST/);
  assert.match(client, /MAX_REQUEST_FRAME_BYTES/);
  assert.match(client, /MAX_RESULT_FRAME_BYTES/);
});

test("Windows exposes pairing and native relay access policy in Settings", () => {
  assert.match(windowsApp, /Public MCP relay/);
  assert.match(windowsApp, /publicRelay\.pair\(relayEndpoint, relayPairingCode\)/);
  assert.match(windowsApp, /publicRelay\.setAccessMode\(assistantAccessMode\)/);
  assert.match(windowsApp, /No listening port is opened/);
});

test("Windows relay is an outbound adapter over the existing broker", () => {
  assert.match(windowsRoot, /impl DeviceAdapter for WindowsRelayAdapter/);
  assert.match(windowsRoot, /state::<Mutex<Gateway>>\(\)/);
  assert.match(windowsRoot, /state::<Mutex<PerformanceMidi>>\(\)/);
  assert.match(windowsRelay, /Windows Credential Manager/);
  assert.match(windowsRelay, /AccessMode::Full/);
  assert.doesNotMatch(windowsRoot, /TcpListener|axum::Server|\.bind\(/);
});
