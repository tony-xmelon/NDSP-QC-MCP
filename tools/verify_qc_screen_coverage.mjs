import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const coverage = readJson("references/qc-ui-coverage/coros-4.1.0/coverage.json");
const physical = readJson("references/qc-ui-corpus/coros-4.1.0/manifest.json");
const official = readJson("references/qc-ui-official-manual/coros-4.1.0/manifest.json");
const officialDetails = readJson("references/qc-ui-official-details/coros-4.1.0/manifest.json");
const inventory = readFileSync("docs/qc-screen-inventory.md", "utf8");
const surface = [
  "packages/typescript/qc-ui/src/quad-cortex-surface.tsx",
  "packages/typescript/qc-ui/src/coros-screen-fixtures.tsx"
].map((path) => readFileSync(path, "utf8")).join("\n");
const smokeCapture = readFileSync("tools/capture_qc_manual_reference_ui.mjs", "utf8");
const windowsPhysicalCapture = readFileSync("tools/capture_windows_ui.mjs", "utf8");
const androidPhysicalCapture = readFileSync("tools/capture_android_ui.mjs", "utf8");
const officialCapture = readFileSync("tools/capture_qc_official_manual_ui.mjs", "utf8");

const inventoryIds = [...inventory.matchAll(/^\| ((?:GL|IO|GR|DB|ED|DR|NC|ST|RC|OV)-\d+) /gm)].map((match) => match[1]);
const coverageIds = coverage.states.map((state) => state.id);
assert.equal(inventoryIds.length, 103, "canonical inventory must contain 103 states");
assert.equal(new Set(coverageIds).size, coverageIds.length, "coverage state IDs must be unique");
assert.deepEqual([...coverageIds].sort(), [...inventoryIds].sort(), "coverage ledger must map every canonical inventory state exactly once");

const physicalIds = new Set(physical.captures.map((capture) => capture.id));
const officialIds = new Set(official.captures.map((capture) => capture.id));
const officialById = new Map(official.captures.map((capture) => [capture.id, capture]));
const officialDetailIds = new Set(officialDetails.assets.map((asset) => asset.id));
const officialDetailById = new Map(officialDetails.assets.map((asset) => [asset.id, asset]));
const directStates = new Set();
const detailedStates = new Set();
const smokeStates = new Set();
const dualHostStates = new Set();
const referencedPhysicalIds = new Set();
const referencedOfficialIds = new Set();
const referencedOfficialDetailIds = new Set();
const rendererIsRouted = (renderer) => surface.includes(`"${renderer}"`) || (renderer.startsWith("gig-official-") && surface.includes('startsWith("gig-official-")'));

for (const state of coverage.states) {
  assert.equal(typeof state.renderer, "string", `${state.id}: renderer is required`);
  assert.ok(rendererIsRouted(state.renderer), `${state.id}: renderer ${state.renderer} is not routed by the shared surface`);
  const evidenceCount = (state.physical?.length ?? 0) + (state.official?.length ?? 0) + (state.officialDetail?.length ?? 0) + (state.smoke?.length ?? 0);
  assert.ok(evidenceCount > 0, `${state.id}: at least one evidence path is required`);
  for (const id of state.physical ?? []) {
    assert.ok(physicalIds.has(id), `${state.id}: unknown physical reference ${id}`);
    assert.ok(windowsPhysicalCapture.includes(`"${id}"`), `${state.id}: physical reference ${id} is not captured on Windows`);
    assert.ok(androidPhysicalCapture.includes(`"${id}"`), `${state.id}: physical reference ${id} is not captured on Android`);
    referencedPhysicalIds.add(id);
    directStates.add(state.id);
    dualHostStates.add(state.id);
  }
  for (const id of state.official ?? []) {
    assert.ok(officialIds.has(id), `${state.id}: unknown official reference ${id}`);
    assert.ok(officialById.get(id)?.renderer, `${state.id}: official reference ${id} has no shared renderer mapping`);
    referencedOfficialIds.add(id);
    directStates.add(state.id);
    dualHostStates.add(state.id);
  }
  for (const id of state.officialDetail ?? []) {
    assert.ok(officialDetailIds.has(id), `${state.id}: unknown official detail ${id}`);
    assert.ok(officialDetailById.get(id)?.states?.includes(state.id), `${state.id}: official detail ${id} does not map back to this state`);
    referencedOfficialDetailIds.add(id);
    detailedStates.add(state.id);
  }
  for (const view of state.smoke ?? []) {
    assert.ok(smokeCapture.includes(`"${view}"`), `${state.id}: smoke view ${view} is not in the dual-host capture script`);
    smokeStates.add(state.id);
    dualHostStates.add(state.id);
  }
}

assert.match(smokeCapture, /capture\("windows"/);
assert.match(smokeCapture, /capture\("android"/);
assert.match(officialCapture, /captureHost\("windows"/);
assert.match(officialCapture, /captureHost\("android"/);
const comparableOfficialIds = new Set(official.captures.filter((capture) => capture.deviceVariant === "quad-cortex" && capture.renderer).map((capture) => capture.id));
assert.deepEqual([...referencedPhysicalIds].sort(), [...physicalIds].sort(), "every physical corpus image must be attached to at least one canonical state");
assert.deepEqual([...referencedOfficialIds].sort(), [...comparableOfficialIds].sort(), "every comparable official image must be attached to exactly one or more canonical states");
assert.deepEqual([...referencedOfficialDetailIds].sort(), [...officialDetailIds].sort(), "every official detail asset must be attached to one or more canonical states");
assert.equal(dualHostStates.size, coverage.states.length, "every canonical state must have a verified dual-host capture path");
const authoritativeStates = new Set([...directStates, ...detailedStates]);
console.log(`PASS ${coverage.states.length}/103 canonical states mapped; ${directStates.size} have full-frame authoritative evidence; ${authoritativeStates.size} have full-frame or official-detail evidence; ${dualHostStates.size} have verified dual-host capture paths (${smokeStates.size} through the general smoke pack)`);
