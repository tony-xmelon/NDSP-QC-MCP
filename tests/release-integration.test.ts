import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = (name: string) => readFileSync(new URL(`../scripts/${name}`, import.meta.url), "utf8");

test("Android builds and Firebase publishing emit provenance for the exact APK", () => {
  const build = script("build-android-debug.ps1");
  const publish = script("publish-android-firebase.ps1");
  assert.match(build, /release-provenance\.mjs"\) \$builtApkPath/);
  assert.match(build, /lib\/arm64-v8a\/libqc_android\.so/);
  assert.match(build, /lib\/x86_64\/libqc_android\.so/);
  assert.ok(build.indexOf("lib/arm64-v8a/libqc_android.so") < build.indexOf("release-provenance.mjs"));
  assert.match(publish, /release-provenance\.mjs"\) \$apkPath/);
  assert.match(publish, /\[string\]\$Testers = "prezimir@gmail\.com"/);
  assert.match(publish, /google-services\.json/);
  assert.match(publish, /capacitor\.config\.ts/);
  assert.match(publish, /package_name -eq \$androidAppId/);
  assert.match(publish, /client_info\.mobilesdk_app_id/);
  assert.doesNotMatch(publish, /\$firebaseAppId = "1:/);
  assert.ok(publish.indexOf("release-provenance.mjs") < publish.indexOf("appdistribution:distribute"));
});

test("release provenance fingerprints the executable app parity contract", () => {
  const provenance = readFileSync(new URL("../tools/release-provenance.mjs", import.meta.url), "utf8");
  assert.match(provenance, /contracts\/app-parity\.v1\.json/);
});

test("Windows installer builds checksum their external Cargo target artifact", () => {
  const build = script("build-windows-installer.ps1");
  assert.match(build, /release\\bundle\\nsis/);
  assert.match(build, /release-provenance\.mjs"\) @windowsInstallers/);
  assert.match(build, /without an NSIS artifact/);
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
  for (const build of [script("build-windows-installer.ps1"), script("publish-android-firebase.ps1")]) {
    assert.match(build, /verify-software-parity\.ps1"\) -BuildApps -RequireClean/);
    assert.ok(build.indexOf("verify-software-parity.ps1") < build.indexOf("release-provenance.mjs"));
  }
});

test("software parity compile-checks the Windows shell without release sidecars", () => {
  const parity = script("verify-software-parity.ps1");
  assert.match(parity, /Windows native shell check/);
  assert.match(parity, /TAURI_CONFIG = '\{"bundle":\{"externalBin":\[\]\}\}'/);
  assert.match(parity, /cargo check --locked --manifest-path "apps\/windows\/src-tauri\/Cargo\.toml"/);
  assert.match(parity, /cargo test --locked --manifest-path \$manifest/);
  assert.match(parity, /artifacts\\software-parity-target/);
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
  assert.match(workflow, /app-debug\.apk/);
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
