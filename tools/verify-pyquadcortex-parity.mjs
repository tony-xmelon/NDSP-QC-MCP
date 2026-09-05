import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("contracts/pyquadcortex-parity.v1.json", "utf8"));
const gateway = JSON.parse(await readFile("contracts/gateway-methods.v1.json", "utf8"));
const gatewayMethods = new Set(gateway.methods.map((entry) => entry.rpc));

const expected = new Set(manifest.upstreamMethods);
if (expected.size !== manifest.upstreamMethods.length) {
  throw new Error("The pyquadcortex baseline contains duplicate public method names.");
}

const covered = new Map();
for (const group of manifest.coverage) {
  if (!group.status || !Array.isArray(group.methods) || group.methods.length === 0) {
    throw new Error("Every parity group must have a status and at least one method.");
  }
  for (const method of group.methods) {
    if (covered.has(method)) throw new Error(`pyquadcortex method is covered twice: ${method}`);
    covered.set(method, group.status);
  }
  for (const rpc of group.rpcs ?? []) {
    if (!gatewayMethods.has(rpc)) throw new Error(`Parity evidence references an absent gateway RPC: ${rpc}`);
  }
  if (["expansion-backlog", "hazard-excluded", "upstream-incomplete", "upstream-no-op"].includes(group.status) && !group.reason) {
    throw new Error(`Non-native parity group requires an explicit reason: ${group.methods.join(", ")}`);
  }
}

if (manifest.requireNativeCoverage) {
  const nonNative = manifest.coverage.filter((group) => !group.status.startsWith("native"));
  if (nonNative.length) {
    throw new Error(
      `Native supersession is incomplete: ${nonNative
        .map((group) => `${group.methods.join(", ")} (${group.status})`)
        .join("; ")}`,
    );
  }
}

const missing = [...expected].filter((method) => !covered.has(method));
const unknown = [...covered.keys()].filter((method) => !expected.has(method));
if (missing.length || unknown.length) {
  throw new Error(`pyquadcortex parity drift; missing=[${missing}], unknown=[${unknown}]`);
}

const sourcePath = process.env.PYQUADCORTEX_CLIENT;
if (sourcePath) {
  const source = await readFile(sourcePath, "utf8");
  const canonicalSource = source.replace(/\r\n/g, "\n");
  const hash = createHash("sha256").update(canonicalSource).digest("hex");
  if (hash !== manifest.upstream.clientSha256) {
    throw new Error(`Pinned pyquadcortex client hash changed: ${hash}`);
  }
  const classStart = source.indexOf("class QuadCortex:");
  const nextClass = source.slice(classStart + 1).search(/^class /m);
  if (classStart < 0) throw new Error("Pinned source no longer defines QuadCortex.");
  const classSource = nextClass < 0
    ? source.slice(classStart)
    : source.slice(classStart, classStart + 1 + nextClass);
  const publicMethods = [...classSource.matchAll(/^    def ([a-zA-Z_][a-zA-Z0-9_]*)\(/gm)]
    .map((match) => match[1])
    .filter((name) => !name.startsWith("_"));
  const actual = [...new Set(publicMethods)];
  const sourceMissing = manifest.upstreamMethods.filter((method) => !actual.includes(method));
  const sourceAdded = actual.filter((method) => !expected.has(method));
  if (sourceMissing.length || sourceAdded.length) {
    throw new Error(`Pinned source/API mismatch; missing=[${sourceMissing}], added=[${sourceAdded}]`);
  }
}

const counts = Object.fromEntries(
  [...covered.values()].reduce((map, status) => map.set(status, (map.get(status) ?? 0) + 1), new Map()),
);
console.log(JSON.stringify({ verified: true, upstreamMethods: expected.size, counts, sourceVerified: Boolean(sourcePath) }));
