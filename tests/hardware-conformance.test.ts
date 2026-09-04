import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CASES,
  MUTATION_ACK,
  actionPlan,
  assertDisposableSlots,
  assertMutationAcknowledged,
  contractDigest,
  gatewayArguments,
  pngSignatureIsValid,
  redactEvidence,
  validateConfig,
  validateCoverage,
  validateReleaseReports
} from "../tools/hardware-conformance-lib.mjs";

const contract = JSON.parse(readFileSync(new URL("../contracts/qc-actions.v1.json", import.meta.url), "utf8"));
const example = JSON.parse(readFileSync(new URL("../tools/hardware-conformance.example.json", import.meta.url), "utf8"));

test("physical suite has exactly one case for every MCP device action", () => {
  assert.deepEqual(new Set(validateCoverage(contract)), new Set(Object.keys(CASES)));
  assert.equal(actionPlan(contract, new Set(["read"])).filter((item) => item.enabled).length, contract.actions.filter((action: { classification: string }) => action.classification === "read").length);
});

test("full execution requires explicit fixtures and distinct disposable slots", () => {
  assert.deepEqual(validateConfig(example, { requireAll: true }), []);
  assert.doesNotThrow(() => assertDisposableSlots(example, [example.persistent.slotA, example.persistent.slotB]));
  assert.throws(() => assertDisposableSlots(example, [example.persistent.slotA, example.persistent.slotA]), /distinct/);
});

test("mutations require an exact out-of-band acknowledgement", () => {
  assert.throws(() => assertMutationAcknowledged({}), /QC_HARDWARE_TEST_ACK/);
  assert.doesNotThrow(() => assertMutationAcknowledged({ QC_HARDWARE_TEST_ACK: MUTATION_ACK }));
});

test("direct gateway argument mapping matches the MCP adapter boundary", () => {
  assert.deepEqual(gatewayArguments("set_parameter", { parameter_index: 2, expected_value: 0.4, confirm_risky_operation: true }), { parameterIndex: 2, expectedValue: 0.4 });
  assert.deepEqual(gatewayArguments("preview_parameter", { parameter_index: 2, expected_value: 0.4 }), { parameterIndex: 2 });
  assert.deepEqual(gatewayArguments("rename_current_preset", { new_name: "Test", confirm_persistent_write: true }), { name: "Test", confirmRename: true });
});

test("evidence redacts identities and binary payloads", () => {
  const redacted = redactEvidence({ serial: "secret", pngBase64: Buffer.from("hello").toString("base64"), nested: { token: "bearer" } });
  assert.match(redacted.serial, /^sha256:/);
  assert.equal(redacted.pngBase64, "[binary 5 bytes]");
  assert.match(redacted.nested.token, /^sha256:/);
  assert.equal(pngSignatureIsValid({ width: 800, height: 480, pngBase64: "iVBORw0KGgo=" }, 800, 480), true);
});

test("release gate requires complete Windows and Android evidence for the current contract", () => {
  const results = ["system.status", ...contract.actions.map((action: { name: string }) => action.name)].map((name) => ({ name, status: "passed" }));
  const base = { contractSha256: contractDigest(contract), results, restoration: [{ name: "starting-preset", status: "passed" }], summary: { complete: true } };
  assert.deepEqual(validateReleaseReports(contract, [{ ...base, target: "windows" }, { ...base, target: "android" }]).actionsPerTarget, contract.actions.length);
  assert.throws(() => validateReleaseReports(contract, [{ ...base, target: "windows" }]), /missing android report/);
  assert.throws(() => validateReleaseReports(contract, [{ ...base, target: "windows" }, { ...base, target: "android", summary: { complete: false } }]), /android report is incomplete/);
});
