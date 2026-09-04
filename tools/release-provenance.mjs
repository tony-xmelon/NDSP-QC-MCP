import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractFiles = [
  "contracts/gateway-methods.v1.json",
  "contracts/gateway.v1.schema.json",
  "contracts/native-broker.v1.schema.json",
  "contracts/qc-actions.v1.json",
  "contracts/qc-domain.v1.json",
  "contracts/qc-payloads.v1.schema.json",
  "contracts/qc-usb-profile.v1.json"
];

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function commandVersion(command, args = ["--version"]) {
  const executable = process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
  try { return execFileSync(executable, args, { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return "unavailable"; }
}

function packageNameFromPath(path, record) {
  if (record.name) return record.name;
  const marker = "node_modules/";
  const normalized = path.replaceAll("\\", "/");
  const tail = normalized.slice(normalized.lastIndexOf(marker) + marker.length);
  const parts = tail.split("/");
  return parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

const npmPurl = (name, version) => `pkg:npm/${name.startsWith("@") ? `${name.slice(1).replace("/", "%2F")}` : name}@${version}`;

export function npmComponents(packageLock) {
  const components = new Map();
  for (const [path, record] of Object.entries(packageLock.packages ?? {})) {
    if (!path.includes("node_modules/") || !record.version) continue;
    const name = packageNameFromPath(path, record);
    if (!name) continue;
    const key = `${name}@${record.version}`;
    components.set(key, {
      type: "library",
      name,
      version: record.version,
      purl: npmPurl(name, record.version),
      properties: [{ name: "qc:ecosystem", value: "npm" }]
    });
  }
  return [...components.values()].sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
}

export function parseCargoLock(source) {
  const packages = [];
  for (const block of source.split(/\r?\n\[\[package\]\]\r?\n/).slice(1)) {
    const field = (name) => block.match(new RegExp(`^${name} = "([^"]+)"`, "m"))?.[1];
    const name = field("name");
    const version = field("version");
    if (name && version) packages.push({ name, version, source: field("source"), checksum: field("checksum") });
  }
  return packages;
}

function rustComponents(lockFiles) {
  const components = new Map();
  for (const lockFile of lockFiles) {
    for (const item of parseCargoLock(readFileSync(lockFile, "utf8"))) {
      const key = `${item.name}@${item.version}`;
      const hashes = item.checksum ? [{ alg: "SHA-256", content: item.checksum }] : undefined;
      components.set(key, {
        type: "library",
        name: item.name,
        version: item.version,
        purl: `pkg:cargo/${encodeURIComponent(item.name)}@${item.version}`,
        ...(hashes ? { hashes } : {}),
        properties: [{ name: "qc:ecosystem", value: "cargo" }]
      });
    }
  }
  return [...components.values()].sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    if ([".git", "node_modules", "target"].includes(entry) && statSync(path).isDirectory()) return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function defaultArtifacts() {
  const roots = [
    "apps/android/android/app/build/outputs/apk",
    "apps/windows/src-tauri/target/release/bundle"
  ];
  return roots.flatMap((root) => walk(resolve(repositoryRoot, root)))
    .filter((path) => [".apk", ".exe", ".msi"].includes(extname(path).toLowerCase()));
}

function gitOutput(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function contractFingerprint() {
  const entries = contractFiles.map((path) => ({ path, sha256: sha256(readFileSync(resolve(repositoryRoot, path))) }));
  return { sha256: sha256(entries.map((entry) => `${entry.path}\0${entry.sha256}\n`).join("")), files: entries };
}

function uuidFromDigest(digest) {
  const chars = digest.slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16], 16) & 3) | 8).toString(16);
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function buildSbom(packageLock, cargoLocks, metadata = {}) {
  const components = [...npmComponents(packageLock), ...rustComponents(cargoLocks)];
  const componentDigest = sha256(JSON.stringify(components));
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${uuidFromDigest(componentDigest)}`,
    version: 1,
    metadata: { component: { type: "application", name: "QC Control", ...metadata } },
    components
  };
}

export function generateReleaseProvenance({ artifacts = defaultArtifacts(), outputDirectory = resolve(repositoryRoot, "artifacts") } = {}) {
  const windowsPackage = JSON.parse(readFileSync(resolve(repositoryRoot, "apps/windows/package.json"), "utf8"));
  const androidPackage = JSON.parse(readFileSync(resolve(repositoryRoot, "apps/android/package.json"), "utf8"));
  const commit = gitOutput(["rev-parse", "HEAD"]);
  const dirty = Boolean(gitOutput(["status", "--porcelain"]));
  const contracts = contractFingerprint();
  const artifactRecords = artifacts.filter(existsSync).map((path) => {
    const absolute = resolve(path);
    return { path: relative(repositoryRoot, absolute).split(sep).join("/"), size: statSync(absolute).size, sha256: sha256(readFileSync(absolute)) };
  });
  const cargoLocks = walk(repositoryRoot).filter((path) => basename(path) === "Cargo.lock");
  const packageLock = JSON.parse(readFileSync(resolve(repositoryRoot, "package-lock.json"), "utf8"));
  const generatedAt = new Date().toISOString();
  const sbom = buildSbom(packageLock, cargoLocks, { version: windowsPackage.version });
  const manifest = {
    schemaVersion: 1,
    product: "QC Control",
    generatedAt,
    source: { commit, dirty },
    applications: { windows: windowsPackage.version, android: androidPackage.version },
    contracts,
    tools: { node: process.version, npm: commandVersion("npm"), rustc: commandVersion("rustc"), cargo: commandVersion("cargo") },
    artifacts: artifactRecords,
    sbom: { format: "CycloneDX", specVersion: sbom.specVersion, componentCount: sbom.components.length, file: "sbom.cdx.json", sha256: sha256(JSON.stringify(sbom, null, 2) + "\n") }
  };
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(resolve(outputDirectory, "sbom.cdx.json"), JSON.stringify(sbom, null, 2) + "\n");
  writeFileSync(resolve(outputDirectory, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { manifest, sbom };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const artifactArgs = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
  const { manifest } = generateReleaseProvenance({ artifacts: artifactArgs.length ? artifactArgs : undefined });
  console.log(`Wrote release provenance for ${manifest.artifacts.length} artifact(s) at source ${manifest.source.commit.slice(0, 12)}.`);
}
