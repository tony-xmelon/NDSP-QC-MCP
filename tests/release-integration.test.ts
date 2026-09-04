import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = (name: string) => readFileSync(new URL(`../scripts/${name}`, import.meta.url), "utf8");

test("Android preparation emits provenance and Firebase publishes the verified staged APK", () => {
  const build = script("build-android-debug.ps1");
  const publish = script("publish-android-firebase.ps1");
  assert.match(build, /release-candidates\.mjs"\) finalize android \$builtApkPath/);
  assert.match(build, /lib\/arm64-v8a\/libqc_android\.so/);
  assert.match(build, /lib\/x86_64\/libqc_android\.so/);
  assert.match(build, /assembleDebug lintDebug/);
  assert.ok(build.indexOf("lib/arm64-v8a/libqc_android.so") < build.indexOf("release-candidates.mjs"));
  assert.match(publish, /if \(\$PrepareOnly\)[\s\S]*npm run android:build:debug/);
  assert.match(publish, /release-candidates\.mjs"\) verify/);
  assert.doesNotMatch(publish, /release-candidates\.mjs"\) stage/);
  assert.doesNotMatch(publish, /release-provenance\.mjs/);
  assert.match(publish, /\[string\]\$Testers = "prezimir@gmail\.com"/);
  assert.match(publish, /google-services\.json/);
  assert.match(publish, /qc-theme\\src\\brand\.json/);
  assert.match(publish, /\$brandContract\.androidPackage/);
  assert.match(publish, /package_name -eq \$androidAppId/);
  assert.match(publish, /client_info\.mobilesdk_app_id/);
  assert.doesNotMatch(publish, /\$firebaseAppId = "1:/);
  assert.match(publish, /\[switch\]\$PrepareOnly/);
  assert.match(publish, /verify-hardware-release\.mjs/);
  assert.ok(publish.indexOf("release-candidates.mjs\") verify") < publish.indexOf("verify-hardware-release.mjs"));
  assert.ok(publish.indexOf("verify-hardware-release.mjs") < publish.indexOf("appdistribution:distribute"));
  const rootPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(rootPackage.scripts["android:prepare:firebase"], /-PrepareOnly/);
  const hardwareRunner = readFileSync(new URL("../tools/hardware-conformance.mjs", import.meta.url), "utf8");
  assert.match(hardwareRunner, /--release-candidate/);
  assert.match(hardwareRunner, /\.source\.json/);
  const hardwareGate = readFileSync(new URL("../tools/verify-hardware-release.mjs", import.meta.url), "utf8");
  assert.match(hardwareGate, /artifacts\/release-manifest\.json/);
});

test("release provenance fingerprints the executable app parity contract", () => {
  const provenance = readFileSync(new URL("../tools/release-provenance.mjs", import.meta.url), "utf8");
  assert.match(provenance, /contracts\/app-parity\.v1\.json/);
});

test("Windows installer builds checksum their external Cargo target artifact", () => {
  const build = script("build-windows-installer.ps1");
  assert.match(build, /release\\bundle\\nsis/);
  assert.match(build, /release-candidates\.mjs"\) finalize windows \$windowsInstallers\[0\]/);
  assert.match(build, /tauri\.conf\.json/);
  assert.match(build, /\$tauriConfig\.productName/);
  assert.match(build, /\$tauriConfig\.version/);
  assert.match(build, /without its exact current-version NSIS artifact/);
  assert.doesNotMatch(build, /-Filter "\*\.exe"/);
});

test("one shared finalizer preserves only same-source staged release candidates", () => {
  const candidates = readFileSync(new URL("../tools/release-candidates.mjs", import.meta.url), "utf8");
  assert.match(candidates, /gitOutput\(\["rev-parse", "HEAD"\]\)/);
  assert.match(candidates, /gitOutput\(\["status", "--porcelain"\]\)/);
  assert.match(candidates, /sourceDirty === false/);
  assert.match(candidates, /metadata\.sourceCommit === expected\.sourceCommit/);
  assert.match(candidates, /metadata\.sha256 === expected\.sha256/);
  assert.match(candidates, /export function finalizeReleaseCandidate/);
  assert.match(candidates, /generateReleaseProvenance\(\{ artifacts: candidates \}\)/);
  assert.match(script("build-android-debug.ps1"), /release-candidates\.mjs"\) finalize android/);
  assert.match(script("build-windows-installer.ps1"), /release-candidates\.mjs"\) finalize windows/);
  assert.match(script("publish-android-firebase.ps1"), /release-candidates\.mjs"\) verify/);
});

test("packaged Windows gateway verification follows the generated contract", () => {
  const verifier = readFileSync(new URL("../tools/verify-packaged-gateway.mjs", import.meta.url), "utf8");
  assert.match(verifier, /contracts\/gateway-methods\.v1\.json/);
  assert.match(verifier, /gatewayContract\.apiVersion/);
  assert.match(verifier, /gatewayContract\.capabilities/);
  assert.doesNotMatch(verifier, /expectedApiVersion\s*=\s*\d/);
});

test("Windows installer verifies every downloaded executable dependency", () => {
  const build = script("build-windows-installer.ps1");
  const contract = JSON.parse(readFileSync(new URL("../contracts/windows-sidecars.v1.json", import.meta.url), "utf8"));
  assert.match(build, /function Get-VerifiedDownload/);
  assert.match(build, /System\.Security\.Cryptography\.SHA256\]::Create\(\)/);
  assert.match(build, /System\.IO\.File\]::OpenRead\(\$Path\)/);
  assert.match(build, /\$hashAlgorithm\.ComputeHash\(\$downloadStream\)/);
  assert.doesNotMatch(build, /\$sha256\s*=/i);
  assert.equal((build.match(/Get-VerifiedDownload -Uri/g) ?? []).length, 3);
  assert.equal(contract.components.length, 3);
  assert.ok(contract.components.every((component: { sha256: string }) => /^[a-f0-9]{64}$/.test(component.sha256)));
  assert.doesNotMatch(build, /https:\/\/github\.com/);
  assert.equal((build.match(/Invoke-WebRequest/g) ?? []).length, 1, "downloads must only occur inside the checksum-enforcing helper");
});

test("both distribution paths require a clean full software parity preflight", () => {
  const installer = script("build-windows-installer.ps1");
  const publish = script("publish-android-firebase.ps1");
  assert.match(installer, /verify-software-parity\.ps1"\) -BuildApps -RequireClean/);
  assert.ok(installer.indexOf("verify-software-parity.ps1") < installer.indexOf("release-candidates.mjs\") finalize"));
  assert.match(publish, /verify-software-parity\.ps1"\) -BuildApps -RequireClean/);
  assert.ok(publish.indexOf("verify-software-parity.ps1") < publish.indexOf("release-candidates.mjs\") verify"));
});

test("Firebase publishing never rebuilds the hardware-tested candidate", () => {
  const publish = script("publish-android-firebase.ps1");
  const prepareBranch = publish.slice(publish.indexOf("if ($PrepareOnly)"), publish.indexOf("else {", publish.indexOf("if ($PrepareOnly)")));
  const publishBranch = publish.slice(publish.indexOf("else {", publish.indexOf("if ($PrepareOnly)")));
  assert.match(prepareBranch, /android:build:debug/);
  assert.doesNotMatch(publishBranch, /android:build:debug|assembleDebug|Copy-Item/);
  assert.ok(publishBranch.indexOf("release-candidates.mjs\") verify") < publishBranch.indexOf("verify-hardware-release.mjs"));
  assert.ok(publishBranch.indexOf("verify-hardware-release.mjs") < publishBranch.indexOf("appdistribution:distribute"));
});

test("software parity lint-checks all Rust targets without release sidecars", () => {
  const parity = script("verify-software-parity.ps1");
  assert.match(parity, /Rust lints: \$manifest/);
  assert.match(parity, /Windows native shell lint/);
  assert.match(parity, /TAURI_CONFIG = '\{"bundle":\{"externalBin":\[\]\}\}'/);
  assert.match(parity, /cargo clippy --locked --all-targets --manifest-path "apps\/windows\/src-tauri\/Cargo\.toml" -- -D warnings/);
  assert.match(parity, /cargo test --locked --manifest-path \$manifest/);
  assert.match(parity, /cargo clippy --locked --all-targets --manifest-path \$manifest -- -D warnings/);
  assert.match(parity, /LOCALAPPDATA.*QCControlBuild\\software-parity-target/s);
  assert.match(parity, /\$env:CARGO_TARGET_DIR = \$previousCargoTargetDirectory/);
  assert.match(readFileSync(new URL("../packages/rust/qc-windows-midi/Cargo.lock", import.meta.url), "utf8"), /name = "qc-windows-midi"/);
});

test("CI packages the Android app with pinned native prerequisites and provenance", () => {
  const workflow = readFileSync(new URL("../.github/workflows/software-parity.yml", import.meta.url), "utf8");
  assert.match(workflow, /android-package:/);
  assert.match(workflow, /java-version: 21/);
  assert.match(workflow, /ndk;27\.2\.12479018/);
  assert.match(workflow, /cargo install cargo-ndk --version 4\.1\.2 --locked/);
  assert.match(workflow, /npm run android:build:debug/);
  assert.match(workflow, /artifacts\/android\/QC-Control-Android-\*\.apk/);
  assert.match(workflow, /QC-Control-Android-\*\.apk\.source\.json/);
  assert.match(workflow, /artifacts\/release-manifest\.json/);
  assert.match(workflow, /artifacts\/sbom\.cdx\.json/);
});

test("Android package, Gradle, and lockfile share one release version", () => {
  const appPackage = JSON.parse(readFileSync(new URL("../apps/android/package.json", import.meta.url), "utf8"));
  const packageLock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const gradle = readFileSync(new URL("../apps/android/android/app/build.gradle", import.meta.url), "utf8");
  assert.match(gradle, new RegExp(`^\\s*versionName "${appPackage.version.replaceAll(".", "[.]")}"$`, "m"));
  assert.match(gradle, /^\s*versionCode\s+[1-9]\d*$/m);
  assert.equal(packageLock.packages["apps/android"].version, appPackage.version);
  assert.match(script("build-android-debug.ps1"), /version-app\.mjs"\) android sync/);
});
