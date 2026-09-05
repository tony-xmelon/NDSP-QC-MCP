import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CASES,
  FULL_RUN_MINIMUM_TRANSPORT_TIMEOUT_MS,
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
  assert.equal(example.transport.timeoutMs, 240_000);
  assert.ok(example.transport.timeoutMs >= FULL_RUN_MINIMUM_TRANSPORT_TIMEOUT_MS);
  assert.throws(
    () => validateConfig({ ...example, transport: { ...example.transport, timeoutMs: 60_000 } }, { requireAll: true }),
    /shared 180-second native backup window/
  );
  assert.doesNotThrow(() => assertDisposableSlots(example, [example.persistent.slotA, example.persistent.slotB]));
  assert.throws(() => assertDisposableSlots(example, [example.persistent.slotA, example.persistent.slotA]), /distinct/);
});

test("partial configs expose missing physical fixtures without weakening the full gate", () => {
  const partial = structuredClone(example);
  delete partial.library.ir;
  assert.deepEqual(validateConfig(partial), [
    "library.ir.key", "library.ir.name", "library.ir.modelId", "library.ir.slot"
  ]);
  assert.throws(() => validateConfig(partial, { requireAll: true }), /library\.ir\.key/);
});

test("full dry run validates and identifies the exact staged candidate", () => {
  const directory = mkdtempSync(join(tmpdir(), "qc-hardware-candidate-"));
  try {
    const candidate = join(directory, "QC-Control-Windows-test.exe");
    const bytes = Buffer.from("immutable release candidate");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(candidate, bytes);
    writeFileSync(`${candidate}.source.json`, JSON.stringify({
      schemaVersion: 1,
      platform: "windows",
      sourceCommit: "candidate-source",
      sourceDirty: false,
      size: bytes.length,
      sha256
    }));
    const runner = fileURLToPath(new URL("../tools/hardware-conformance.mjs", import.meta.url));
    const args = [runner, "--all", "--require-all", "--release-candidate", candidate];
    const accepted = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(accepted.status, 0, accepted.stderr);
    const plan = JSON.parse(accepted.stdout);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.releaseCandidate.sha256, sha256);
    assert.equal(plan.plan.filter((item: { enabled: boolean }) => item.enabled).length, contract.actions.length);

    writeFileSync(candidate, Buffer.from("tampered release candidate"));
    const rejected = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /size|SHA-256/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
  const manifest = {
    source: { commit: "abc123", dirty: false },
    artifacts: [
      { path: "artifacts/windows/QC-Control-Windows.exe", size: 10, sha256: "win" },
      { path: "artifacts/android/QC-Control-Android.apk", size: 20, sha256: "android" }
    ]
  };
  const base = { contractSha256: contractDigest(contract), results, restoration: [{ name: "starting-preset", status: "passed" }], summary: { complete: true } };
  const windows = { ...base, target: "windows", releaseCandidate: { platform: "windows", sourceCommit: "abc123", size: 10, sha256: "win" } };
  const android = { ...base, target: "android", releaseCandidate: { platform: "android", sourceCommit: "abc123", size: 20, sha256: "android" } };
  const result = validateReleaseReports(contract, [windows, android], manifest);
  assert.equal(result.actionsPerTarget, contract.actions.length);
  assert.equal(result.sourceCommit, "abc123");
  assert.throws(() => validateReleaseReports(contract, [windows], manifest), /missing android report/);
  assert.throws(() => validateReleaseReports(contract, [windows, { ...android, summary: { complete: false } }], manifest), /android report is incomplete/);
  assert.throws(() => validateReleaseReports(contract, [windows, { ...android, releaseCandidate: { ...android.releaseCandidate, sha256: "stale" } }], manifest), /android report candidate digest does not match/);
  assert.throws(() => validateReleaseReports(contract, [windows, android], { ...manifest, source: { commit: "abc123", dirty: true } }), /clean source commit/);
});
