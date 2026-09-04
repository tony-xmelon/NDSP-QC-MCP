import assert from "node:assert/strict";
import test from "node:test";
import { qcConnectionPresentation } from "../packages/typescript/qc-ui/src/use-qc-connection-workflow.ts";

test("connection presentation is identical for native hosts", () => {
  assert.deepEqual(qcConnectionPresentation({ phase: "ready", detail: "ready", demo: false }), {
    connected: true, busy: false, label: "USB", appearance: "connected"
  });
  assert.deepEqual(qcConnectionPresentation({ phase: "syncing", detail: "syncing", demo: false }), {
    connected: false, busy: true, label: "SYNC", appearance: "syncing"
  });
  assert.equal(qcConnectionPresentation({ phase: "opening", detail: "opening", demo: true }).label, "WAIT");
  assert.equal(qcConnectionPresentation({ phase: "needs-attention", detail: "failed", demo: true }).appearance, "error");
  assert.equal(qcConnectionPresentation({ phase: "disconnected", detail: "absent", demo: true }).appearance, "absent");
});
