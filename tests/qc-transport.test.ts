import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayClientTransport, demoSnapshot, type GatewayTransport } from "../packages/typescript/qc-client/src/index.ts";
import { createQcGatewayTransport } from "../packages/typescript/qc-core/src/index.ts";
import { createWindowsQcTransport } from "../apps/windows/src/qc-transport.ts";

test("Windows adapts gateway.v1 expected-state guards to the shared device port", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const result = { detail: "verified", snapshot: demoSnapshot };
  const gateway = {
    selectScene: async (...args: unknown[]) => { calls.push({ method: "selectScene", args }); return result; },
    toggleBypass: async (...args: unknown[]) => { calls.push({ method: "toggleBypass", args }); return result; },
    setTempo: async (...args: unknown[]) => { calls.push({ method: "setTempo", args }); return result; },
    pressFootswitch: async (...args: unknown[]) => { calls.push({ method: "pressFootswitch", args }); return result; },
    showTuner: async (...args: unknown[]) => { calls.push({ method: "showTuner", args }); return result; },
    showGigView: async (...args: unknown[]) => { calls.push({ method: "showGigView", args }); return result; }
  } as unknown as GatewayTransport;
  const transport = createWindowsQcTransport(gateway, () => demoSnapshot);

  await transport.selectScene(2, demoSnapshot);
  await transport.setBypass(0, 1, true, demoSnapshot);
  await transport.setTempo(96, demoSnapshot);
  await transport.pressFootswitch(3, demoSnapshot);
  await transport.tapTempo(demoSnapshot);
  await transport.setTuner(true);

  assert.deepEqual(calls, [
    { method: "selectScene", args: [2, "Brit 2203"] },
    { method: "toggleBypass", args: [0, 1, 0, false, true, "Brit 2203"] },
    { method: "setTempo", args: [96, 120, "Brit 2203"] },
    { method: "pressFootswitch", args: [3, "PRESET", "Brit 2203"] },
    { method: "pressFootswitch", args: [9, "PRESET", "Brit 2203"] },
    { method: "showTuner", args: [true] }
  ]);

  const rpcCalls: string[] = [];
  const rpcGateway = createGatewayClientTransport<GatewayTransport>(async (method) => {
    rpcCalls.push(method);
    return { detail: "accepted" } as never;
  }, "rpc");
  await rpcGateway.showTuner(true);
  assert.deepEqual(rpcCalls, ["device.showTuner"]);
});

test("shared preset navigation uses one guarded adjacent recall on every host", async () => {
  const calls: unknown[][] = [];
  const gateway = {
    recallPreset: async (...args: unknown[]) => { calls.push(args); return { detail: "recalled" }; }
  } as unknown as GatewayTransport;
  const state = { ...demoSnapshot, presetPosition: 4 };
  const transports = [
    createWindowsQcTransport(gateway, () => state),
    createQcGatewayTransport(gateway, () => state)
  ];
  for (const transport of transports) await transport.movePreset(1);
  assert.deepEqual(calls, [
    ["demo", 5, "", 4],
    ["demo", 5, "", 4]
  ]);
});

test("generated gateway client maps positional calls to native contract arguments", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const gateway = createGatewayClientTransport<GatewayTransport>(async (command, args) => {
    calls.push({ command, args });
    return { detail: "accepted" } as never;
  });

  await gateway.toggleBypass(1, 3, 2, false, true, "Live preset");
  await gateway.listPresetFolders(true);

  assert.deepEqual(calls, [
    {
      command: "toggle_bypass",
      args: { row: 1, column: 3, expectedScene: 2, expectedBypassed: false, desiredBypassed: true, expectedPresetName: "Live preset" }
    },
    { command: "list_preset_folders", args: { refresh: true } }
  ]);
});
