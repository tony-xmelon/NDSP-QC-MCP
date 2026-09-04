import assert from "node:assert/strict";
import test from "node:test";
import { demoSnapshot, type BlockDetails, type ConnectionState, type SavePresetResult } from "../packages/typescript/qc-client/src/index.ts";
import { reconcileQcActionOutcome } from "../packages/typescript/qc-ui/src/qc-action-outcome.ts";

test("tool outcomes reconcile through one ordered cross-platform path", () => {
  const events: string[] = [];
  const connection: ConnectionState = { phase: "ready", detail: "connected", demo: false };
  const saved: SavePresetResult = { detail: "saved", savedName: "Clean", snapshot: { ...demoSnapshot, presetName: "Clean" } };
  const block: BlockDetails = { row: 0, column: 1, modelId: 2, name: "Amp", category: "Amplifier", scene: 0, parameters: [] };
  const attachment = reconcileQcActionOutcome({
    detail: "done", connection, savedPreset: saved, snapshot: demoSnapshot, block, clearSelection: true,
    image: { pngBase64: "aGVsbG8=" }
  }, {
    setConnection: () => events.push("connection"),
    commitSavedPreset: () => events.push("saved"),
    commitSnapshot: () => events.push("snapshot"),
    currentBlock: { row: 0, column: 1 },
    updateBlock: () => events.push("block"),
    clearSelection: () => events.push("clear"),
    now: () => 42
  });
  assert.deepEqual(events, ["connection", "saved", "block", "clear"]);
  assert.deepEqual(attachment, { name: "qc-screen-42.png", mediaType: "image/png", data: "aGVsbG8=" });
});

test("unrelated open block details are not replaced", () => {
  const events: string[] = [];
  reconcileQcActionOutcome({ detail: "done", block: { row: 1, column: 1, modelId: 2, name: "Amp", category: "Amplifier", scene: 0, parameters: [] } }, {
    setConnection: () => undefined,
    commitSavedPreset: () => undefined,
    commitSnapshot: () => undefined,
    currentBlock: { row: 0, column: 1 },
    updateBlock: () => events.push("block"),
    clearSelection: () => undefined
  });
  assert.deepEqual(events, []);
});
