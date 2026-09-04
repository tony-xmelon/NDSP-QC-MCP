import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const packageLockPath = resolve(repositoryRoot, "package-lock.json");
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const writeJson = async (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

const platformArgument = process.argv[2];
const platform = ["windows", "android"].includes(platformArgument) ? platformArgument : "windows";
const request = platform === platformArgument ? process.argv[3] ?? "sync" : platformArgument ?? "sync";
const appPackagePath = resolve(repositoryRoot, `apps/${platform}/package.json`);
const appPackage = await readJson(appPackagePath);
const current = String(appPackage.version ?? "");
const match = semverPattern.exec(current);
if (!match) throw new Error(`The current ${platform} app version is not valid semantic versioning: ${current}`);

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
if (version !== current) await writeJson(appPackagePath, appPackage);

const packageLock = await readJson(packageLockPath);
const workspacePath = `apps/${platform}`;
if (!packageLock.packages?.[workspacePath]) throw new Error(`package-lock.json has no ${workspacePath} workspace entry`);
if (packageLock.packages[workspacePath].version !== version) {
  packageLock.packages[workspacePath].version = version;
  await writeJson(packageLockPath, packageLock);
}

if (platform === "android") {
  const gradlePath = resolve(repositoryRoot, "apps/android/android/app/build.gradle");
  const gradle = await readFile(gradlePath, "utf8");
  const versionCode = Number(gradle.match(/^\s*versionCode\s+(\d+)/m)?.[1]);
  if (!Number.isSafeInteger(versionCode) || versionCode < 1) throw new Error("Could not read a positive Android versionCode");
  const nextVersionCode = request === "sync" || version === current ? versionCode : versionCode + 1;
  let nextGradle = gradle.replace(/^(\s*versionCode\s+)\d+/m, `$1${nextVersionCode}`);
  nextGradle = nextGradle.replace(/^(\s*versionName\s+")[^"]+"/m, `$1${version}"`);
  if (!nextGradle.includes(`versionName "${version}"`)) throw new Error("Could not update the Android versionName");
  if (nextGradle !== gradle) await writeFile(gradlePath, nextGradle);
} else {
  const tauriConfigPath = resolve(repositoryRoot, "apps/windows/src-tauri/tauri.conf.json");
  const cargoManifestPath = resolve(repositoryRoot, "apps/windows/src-tauri/Cargo.toml");
  const cargoLockPath = resolve(repositoryRoot, "apps/windows/src-tauri/Cargo.lock");
  const tauriConfig = await readJson(tauriConfigPath);
  if (tauriConfig.version !== version) {
    tauriConfig.version = version;
    await writeJson(tauriConfigPath, tauriConfig);
  }

  const cargoManifest = await readFile(cargoManifestPath, "utf8");
  const nextCargoManifest = cargoManifest.replace(
    /^(\[package\]\r?\nname = "qc-voice-control"\r?\nversion = ")[^"]+"/m,
    `$1${version}"`
  );
  if (!new RegExp(`^version = "${version.replaceAll(".", "\\.")}"$`, "m").test(nextCargoManifest)) throw new Error("Could not update the Rust package version");
  if (nextCargoManifest !== cargoManifest) await writeFile(cargoManifestPath, nextCargoManifest);

  const cargoLock = await readFile(cargoLockPath, "utf8");
  const nextCargoLock = cargoLock.replace(
    /^(\[\[package\]\]\r?\nname = "qc-voice-control"\r?\nversion = ")[^"]+"/m,
    `$1${version}"`
  );
  if (!new RegExp(`name = "qc-voice-control"\\r?\\nversion = "${version.replaceAll(".", "\\.")}"`).test(nextCargoLock)) throw new Error("Could not update the Rust lockfile version");
  if (nextCargoLock !== cargoLock) await writeFile(cargoLockPath, nextCargoLock);
}

console.log(request === "sync" ? `QC Control ${platform} version ${version} is synchronized.` : `QC Control ${platform} version ${current} → ${version}.`);
