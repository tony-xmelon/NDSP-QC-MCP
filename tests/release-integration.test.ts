import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = (name: string) => readFileSync(new URL(`../scripts/${name}`, import.meta.url), "utf8");

test("Android builds and Firebase publishing emit provenance for the exact APK", () => {
  const build = script("build-android-debug.ps1");
  const publish = script("publish-android-firebase.ps1");
  assert.match(build, /release-provenance\.mjs"\) \$builtApkPath/);
  assert.match(publish, /release-provenance\.mjs"\) \$apkPath/);
  assert.match(publish, /\[string\]\$Testers = "prezimir@gmail\.com"/);
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

test("Windows installer verifies every downloaded executable dependency", () => {
  const build = script("build-windows-installer.ps1");
  assert.match(build, /function Get-VerifiedDownload/);
  assert.match(build, /Get-FileHash -LiteralPath \$Path -Algorithm SHA256/);
  assert.equal((build.match(/Get-VerifiedDownload -Uri/g) ?? []).length, 3);
  assert.equal((build.match(/-Sha256 "[a-f0-9]{64}"/g) ?? []).length, 3);
  assert.equal((build.match(/Invoke-WebRequest/g) ?? []).length, 1, "downloads must only occur inside the checksum-enforcing helper");
});
