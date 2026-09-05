import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const coverage = JSON.parse(readFileSync(resolve(root, "references/qc-ui-coverage/coros-4.1.0/coverage.json"), "utf8"));
const plan = JSON.parse(readFileSync(resolve(root, "references/qc-ui-coverage/coros-4.1.0/physical-capture-plan.json"), "utf8"));

assert.equal(plan.schemaVersion, 1, "unsupported physical capture plan schema");
assert.equal(plan.corosVersion, coverage.corosVersion, "capture plan and coverage ledger target different CorOS versions");
assert.ok(Array.isArray(plan.invariants) && plan.invariants.length >= 5, "capture plan must retain the safety and restoration invariants");

const evidenceGapIds = coverage.states
  .filter((state) => !(state.physical?.length || state.official?.length || state.officialDetail?.length))
  .map((state) => state.id)
  .sort();
const plannedIds = plan.states.map((state) => state.id).sort();
assert.deepEqual(plannedIds, evidenceGapIds, "physical capture plan must cover exactly the authoritative evidence gaps");
assert.equal(new Set(plannedIds).size, plannedIds.length, "physical capture plan contains duplicate canonical IDs");

const tiers = new Set(["safe-navigation", "controlled-transient", "disruptive", "external-evidence"]);
const statuses = new Set(["ready", "requires-content", "requires-trigger", "requires-disposable-preset", "recipe-discovery", "requires-scheduled-session", "do-not-trigger"]);
for (const state of plan.states) {
  assert.ok(tiers.has(state.tier), `${state.id}: invalid capture tier`);
  assert.ok(statuses.has(state.status), `${state.id}: invalid capture status`);
  assert.ok(typeof state.route === "string" && state.route.length >= 12, `${state.id}: missing semantic route`);
  assert.ok(typeof state.capture === "string" && state.capture.length >= 12, `${state.id}: missing capture checkpoint`);
  assert.ok(typeof state.restore === "string" && state.restore.length >= 12, `${state.id}: missing restoration proof`);
  if (state.tier === "external-evidence") assert.equal(state.status, "do-not-trigger", `${state.id}: external evidence must not be induced`);
}

const counts = Object.fromEntries([...tiers].map((tier) => [tier, plan.states.filter((state) => state.tier === tier).length]));
console.log(`PASS ${plan.states.length}/${evidenceGapIds.length} evidence gaps have acquisition and restoration plans (${Object.entries(counts).map(([tier, count]) => `${tier}=${count}`).join(", ")})`);
