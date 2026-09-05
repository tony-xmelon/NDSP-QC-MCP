import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function text(relativePath) {
  return readFile(join(root, relativePath), "utf8");
}

async function files(relativePath) {
  const directory = join(root, relativePath);
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const child = join(relativePath, entry.name);
    return entry.isDirectory() ? files(child) : [child];
  }));
  return nested.flat();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function rejectPatterns(relativePaths, patterns) {
  for (const relativePath of relativePaths) {
    const source = await text(relativePath);
    for (const [label, pattern] of patterns) {
      assert(!pattern.test(source), `${relativePath} contains forbidden ${label}`);
    }
  }
}

const tauri = JSON.parse(await text("apps/windows/src-tauri/tauri.conf.json"));
const externalBins = tauri.bundle?.externalBin ?? [];
assert(
  externalBins.some((entry) => basename(entry) === "qc-device-broker"),
  "The Windows bundle must include the native qc-device-broker sidecar.",
);
assert(
  externalBins.every((entry) => !/(?:python|pyquadcortex|qc-device-gateway)/i.test(entry)),
  "The Windows bundle must not include a Python or legacy device-gateway sidecar.",
);

const windowsRust = (await files("apps/windows/src-tauri/src"))
  .filter((path) => extname(path) === ".rs");
await rejectPatterns(
  ["apps/windows/src-tauri/Cargo.toml", "apps/windows/src-tauri/tauri.conf.json", ...windowsRust],
  [
    ["pyquadcortex runtime reference", /pyquadcortex/i],
    ["legacy Python gateway selection", /QC_GATEWAY_RUNTIME/i],
    ["legacy device gateway executable", /qc-device-gateway/i],
    ["embedded Python dependency", /(?:pyo3|pythonize|rustpython)/i],
    ["Python process launch", /Command::new\s*\(\s*["'](?:python|python3|py)(?:\.exe)?["']/i],
  ],
);

const androidMain = await files("apps/android/android/app/src/main");
assert(
  androidMain.every((path) => extname(path).toLowerCase() !== ".py"),
  "The Android application source set must not package Python modules.",
);
await rejectPatterns(
  ["apps/android/android/app/build.gradle", ...androidMain.filter((path) => /\.(?:java|kt|xml)$/i.test(path))],
  [
    ["pyquadcortex runtime reference", /pyquadcortex/i],
    ["legacy Python gateway", /qc[_-]device[_-]gateway/i],
    ["Android Python runtime", /(?:chaquopy|com\.chaquo|org\.python|Python\.getInstance)/i],
  ],
);

const androidBuild = await text("apps/android/android/app/build.gradle");
for (const nativeComponent of ["qc-protocol", "qc-device-runtime", "qc-android"]) {
  assert(androidBuild.includes(nativeComponent), `Android build is missing native ${nativeComponent}.`);
}
assert(androidBuild.includes("buildSharedQcRust"), "Android must build its shared Rust runtime.");
assert(androidBuild.includes("libqc_android.so"), "Android must package the Rust JNI library.");

for (const packagePath of ["apps/windows/package.json", "apps/android/package.json"]) {
  const manifest = JSON.parse(await text(packagePath));
  const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies };
  assert(
    Object.keys(dependencies).every((name) => !/(?:pyquadcortex|python)/i.test(name)),
    `${packagePath} declares a Python runtime dependency.`,
  );
}

console.log(JSON.stringify({
  verified: true,
  windowsRuntime: "Tauri + qc-device-broker + qc-device-runtime + qc-protocol",
  androidRuntime: "Capacitor + Java/JNI + qc-android + qc-device-runtime + qc-protocol",
  pythonPackaged: false,
}));
