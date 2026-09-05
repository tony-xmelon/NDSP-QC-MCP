import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const manifestPath = resolve(root, "contracts/app-parity.v1.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const failures = [];
const ids = new Set();

const verifyEvidence = async (feature, subject, entries = []) => {
  for (const entry of entries) {
    let content;
    try {
      content = await readFile(resolve(root, entry.path), "utf8");
    } catch {
      failures.push(`${feature.id}: ${subject} evidence file is missing: ${entry.path}`);
      continue;
    }
    if (!content.includes(entry.contains)) failures.push(`${feature.id}: ${subject} evidence is stale: ${entry.path} no longer contains ${JSON.stringify(entry.contains)}`);
  }
};

if (manifest.version !== 1 || !Array.isArray(manifest.features) || manifest.features.length === 0) failures.push("app parity manifest must be non-empty version 1");
if (!Array.isArray(manifest.owners) || manifest.owners.length === 0) failures.push("app parity manifest must define ownership categories");
for (const feature of manifest.features ?? []) {
  if (!feature.id || ids.has(feature.id)) failures.push(`duplicate or empty feature id: ${feature.id ?? "<empty>"}`);
  ids.add(feature.id);
  if (!feature.label || !["required", "platform-specific"].includes(feature.parity)) failures.push(`${feature.id}: invalid label or parity classification`);
  if (!manifest.owners?.includes(feature.owner)) failures.push(`${feature.id}: invalid ownership category`);
  if (feature.parity === "required" && (feature.windows?.status !== "implemented" || feature.android?.status !== "implemented")) {
    failures.push(`${feature.id}: parity-targeted capabilities must be implemented on both apps`);
  }
  if (feature.parity === "required" && !["shared", "native-equivalent"].includes(feature.owner)) failures.push(`${feature.id}: parity-targeted capability must have shared or native-equivalent ownership`);
  if (feature.parity === "platform-specific") {
    if (!feature.rationale) failures.push(`${feature.id}: platform-specific capability needs a rationale`);
    if (!["windows-shell", "android-shell"].includes(feature.owner)) failures.push(`${feature.id}: platform-specific capability must be owned by a native shell`);
    const statuses = [feature.windows?.status, feature.android?.status];
    if (statuses.filter((status) => status === "implemented").length !== 1 || statuses.filter((status) => status === "not-applicable").length !== 1) {
      failures.push(`${feature.id}: platform-specific capability must be implemented by exactly one app`);
    }
  }
  for (const platform of ["windows", "android"]) {
    const state = feature[platform];
    if (!state || !manifest.statuses.includes(state.status)) failures.push(`${feature.id}: invalid ${platform} status`);
    if (state?.status === "implemented" && (!Array.isArray(state.evidence) || state.evidence.length === 0)) failures.push(`${feature.id}: implemented ${platform} capability needs evidence`);
    await verifyEvidence(feature, platform, state?.evidence);
  }
  if (feature.owner === "shared" && (!Array.isArray(feature.sharedEvidence) || feature.sharedEvidence.length === 0)) failures.push(`${feature.id}: shared capability needs shared-package evidence`);
  await verifyEvidence(feature, "shared", feature.sharedEvidence);
}

const required = manifest.features.filter((feature) => feature.parity === "required");
const platformSpecific = manifest.features.filter((feature) => feature.parity === "platform-specific");
const report = {
  version: manifest.version,
  parityTargets: required.length,
  parityTargetsImplemented: required.filter((feature) => feature.windows.status === "implemented" && feature.android.status === "implemented").length,
  sharedOwners: manifest.features.filter((feature) => feature.owner === "shared").length,
  nativeEquivalentOwners: manifest.features.filter((feature) => feature.owner === "native-equivalent").length,
  platformSpecific: platformSpecific.length,
  failures
};

if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`App parity: ${report.parityTargetsImplemented}/${report.parityTargets} required capabilities implemented on Windows and Android.`);
  console.log(`Ownership: ${report.sharedOwners} shared, ${report.nativeEquivalentOwners} native-equivalent, ${report.platformSpecific} intentionally platform-specific.`);
  for (const failure of failures) console.error(`- ${failure}`);
}
if (failures.length) process.exitCode = 1;
