import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const appPackagePath = resolve(repositoryRoot, "apps/windows/package.json");
const packageLockPath = resolve(repositoryRoot, "package-lock.json");
const tauriConfigPath = resolve(repositoryRoot, "apps/windows/src-tauri/tauri.conf.json");
const cargoManifestPath = resolve(repositoryRoot, "apps/windows/src-tauri/Cargo.toml");
const cargoLockPath = resolve(repositoryRoot, "apps/windows/src-tauri/Cargo.lock");
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const writeJson = async (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

const appPackage = await readJson(appPackagePath);
const current = String(appPackage.version ?? "");
const match = semverPattern.exec(current);
if (!match) throw new Error(`The current Windows app version is not valid semantic versioning: ${current}`);

const request = process.argv[2] ?? "sync";
let version = current;
if (["patch", "minor", "major"].includes(request)) {
  let [, major, minor, patch] = match.map(Number);
  if (request === "patch") patch += 1;
  if (request === "minor") { minor += 1; patch = 0; }
  if (request === "major") { major += 1; minor = 0; patch = 0; }
  version = `${major}.${minor}.${patch}`;
} else if (request !== "sync") {
  if (!semverPattern.test(request)) throw new Error(`Use sync, patch, minor, major, or an explicit x.y.z version; received ${request}`);
  version = request;
}

appPackage.version = version;
await writeJson(appPackagePath, appPackage);

const packageLock = await readJson(packageLockPath);
if (!packageLock.packages?.["apps/windows"]) throw new Error("package-lock.json has no apps/windows workspace entry");
packageLock.packages["apps/windows"].version = version;
await writeJson(packageLockPath, packageLock);

const tauriConfig = await readJson(tauriConfigPath);
tauriConfig.version = version;
await writeJson(tauriConfigPath, tauriConfig);

const cargoManifest = await readFile(cargoManifestPath, "utf8");
const nextCargoManifest = cargoManifest.replace(
  /^(\[package\]\r?\nname = "qc-voice-control"\r?\nversion = ")[^"]+"/m,
  `$1${version}"`
);
if (nextCargoManifest === cargoManifest && !cargoManifest.includes(`version = "${version}"`)) throw new Error("Could not update the Rust package version");
await writeFile(cargoManifestPath, nextCargoManifest);

const cargoLock = await readFile(cargoLockPath, "utf8");
const nextCargoLock = cargoLock.replace(
  /^(\[\[package\]\]\r?\nname = "qc-voice-control"\r?\nversion = ")[^"]+"/m,
  `$1${version}"`
);
if (nextCargoLock === cargoLock && !cargoLock.includes(`name = "qc-voice-control"\nversion = "${version}"`)) throw new Error("Could not update the Rust lockfile version");
await writeFile(cargoLockPath, nextCargoLock);

console.log(request === "sync" ? `QC Control version ${version} is synchronized.` : `QC Control version ${current} → ${version}.`);
