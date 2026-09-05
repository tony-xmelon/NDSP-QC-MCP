import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const text = (path) => readFile(resolve(root, path), "utf8");
const json = async (path) => JSON.parse(await text(path));

const [actionsContract, gatewayContract, androidActions, relayActions, rustMcpActions, windowsApp, windowsModelChat, androidApp] = await Promise.all([
  json("contracts/qc-actions.v1.json"),
  json("contracts/gateway-methods.v1.json"),
  text("apps/android/android/app/src/main/java/com/qccontrol/mobile/GeneratedRemoteActions.java"),
  text("services/qc-relay/src/generated_actions.rs"),
  text("services/rust-mcp/src/actions.rs"),
  text("apps/windows/src/App.tsx"),
  text("apps/windows/src/model-chat.ts"),
  text("apps/android/src/App.tsx"),
]);

const contractPairs = actionsContract.actions.map(({ name, rpc }) => [name, rpc]);
const contractNames = contractPairs.map(([name]) => name);
const contractRpcs = contractPairs.map(([, rpc]) => rpc);
assert.equal(new Set(contractNames).size, contractNames.length, "MCP action contract contains duplicate names");
assert.equal(new Set(contractRpcs).size, contractRpcs.length, "MCP action contract contains duplicate RPC mappings");
const sorted = (values) => [...values].sort();

const stringArray = (source, declaration) => {
  const match = source.match(new RegExp(`private static final String\\[\\] ${declaration} = \\{([\\s\\S]*?)\\n    \\};`));
  assert.ok(match, `Android generated action array ${declaration} is missing`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
};

const rustPairs = (source, structure) => [...source.matchAll(
  new RegExp(`${structure} \\{\\s*name: "([^"]+)",\\s*rpc: "([^"]+)"`, "g")
)].map((match) => [match[1], match[2]]);

const expectedGatewayRpcs = ["system.status", ...contractRpcs];
assert.deepEqual(
  sorted(gatewayContract.methods.map(({ rpc }) => rpc)),
  sorted(expectedGatewayRpcs),
  "gateway RPC membership must exactly match the shared MCP action contract",
);
assert.deepEqual(
  sorted(stringArray(androidActions, "ALLOWED")),
  sorted(expectedGatewayRpcs),
  "Android relay allowlist drifted from the shared MCP action contract",
);
assert.deepEqual(
  rustPairs(relayActions, "ActionPolicy"),
  [["get_status", "system.status"], ...contractPairs],
  "public relay action policy drifted from the shared MCP action contract",
);
assert.deepEqual(
  rustPairs(rustMcpActions, "ActionSpec"),
  contractPairs,
  "Rust MCP tools drifted from the shared MCP action contract",
);

for (const [platform, source] of [["Windows", windowsApp], ["Android", androidApp]]) {
  assert.match(source, /executeAndReconcileQcAction/, `${platform} must execute model tools through the shared reconciler`);
  assert.match(source, /runToolConversation</, `${platform} must use the shared bounded model tool loop`);
}
assert.match(windowsModelChat, /SHARED_QC_ASSISTANT_TOOLS/, "Windows must publish the generated shared tools to its model provider");
assert.match(androidApp, /assistantToolActionPrompt/, "Android must serialize the generated shared tools for its text-only provider");

console.log(JSON.stringify({
  verified: true,
  actions: contractPairs.length,
  gatewayMethods: expectedGatewayRpcs.length,
  windows: "shared generated tools + shared executor",
  android: "shared generated tools + shared executor + exact relay allowlist",
  remoteMcp: "exact Rust MCP and relay action maps",
}));
