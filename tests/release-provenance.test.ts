import assert from "node:assert/strict";
import test from "node:test";
import { buildSbom, npmComponents, parseCargoLock, parseGradleDeclarations, parseGradleDependencyReport, sha256, sidecarComponents } from "../tools/release-provenance.mjs";

test("release hashes are stable SHA-256 values", () => {
  assert.equal(sha256("QC Control"), "908fe6920dbb1fe6c417dbf1dd500de708a852925329c0291964b01982209f07");
});

test("npm SBOM components are de-duplicated and preserve scoped names", () => {
  const components = npmComponents({ packages: {
    "node_modules/@scope/tool": { version: "1.2.3" },
    "node_modules/nested/node_modules/@scope/tool": { version: "1.2.3" }
  } });
  assert.equal(components.length, 1);
  assert.equal(components[0].name, "@scope/tool");
  assert.match(components[0].purl, /scope%2Ftool@1\.2\.3/);
});

test("Cargo lock parser retains versions and checksums without project data", () => {
  const packages = parseCargoLock(`version = 4\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "registry+https://example.invalid"\nchecksum = "abc"\n`);
  assert.deepEqual(packages, [{ name: "serde", version: "1.0.0", source: "registry+https://example.invalid", checksum: "abc" }]);
});

test("CycloneDX output combines npm and Cargo inventories", () => {
  const sbom = buildSbom({ packages: { "node_modules/react": { name: "react", version: "19.2.0" } } }, []);
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.specVersion, "1.5");
  assert.equal(sbom.components.length, 1);
  assert.match(sbom.serialNumber, /^urn:uuid:/);
});

test("Gradle report parser records selected Android runtime versions", () => {
  const components = parseGradleDependencyReport(`releaseRuntimeClasspath\n+--- com.google.firebase:firebase-ai -> 17.6.0\n|    +--- com.google.firebase:firebase-common:22.0.0\n\\--- com.squareup.okhttp3:okhttp:4.11.0 -> 4.12.0 (*)\n`);
  assert.deepEqual(components.map(({ group, name, version }) => ({ group, name, version })), [
    { group: "com.google.firebase", name: "firebase-ai", version: "17.6.0" },
    { group: "com.google.firebase", name: "firebase-common", version: "22.0.0" },
    { group: "com.squareup.okhttp3", name: "okhttp", version: "4.12.0" }
  ]);
  const sbom = buildSbom({ packages: {} }, [], {}, components);
  assert.equal(sbom.components.length, 3);
  assert.ok(sbom.components.every((component) => component.purl.startsWith("pkg:maven/")));
});

test("Gradle declaration parser preserves Android dependencies when resolution is unavailable", () => {
  const components = parseGradleDeclarations(`
implementation "androidx.appcompat:appcompat:$androidxAppCompatVersion"
implementation platform('com.google.firebase:firebase-bom:34.18.0')
implementation 'com.google.firebase:firebase-ai'
implementation project(':capacitor-android')
`, "androidxAppCompatVersion = '1.7.1'");
  assert.deepEqual(components.map(({ group, name, version }) => ({ group, name, version })), [
    { group: "androidx.appcompat", name: "appcompat", version: "1.7.1" },
    { group: "com.google.firebase", name: "firebase-ai", version: undefined },
    { group: "com.google.firebase", name: "firebase-bom", version: "34.18.0" }
  ]);
  assert.equal(components.find((component) => component.name === "firebase-ai")?.properties.at(-1)?.value, "com.google.firebase:firebase-bom:34.18.0");
});

test("Windows sidecars retain their release identity and verified archive hash", () => {
  const [component] = sidecarComponents({ components: [{
    name: "Tool",
    version: "1.2.3",
    purl: "pkg:github/example/tool@1.2.3",
    url: "https://example.invalid/tool.zip",
    sha256: "a".repeat(64)
  }] });
  assert.equal(component.type, "application");
  assert.equal(component.hashes[0].content, "a".repeat(64));
  assert.equal(component.externalReferences[0].type, "distribution");
  assert.equal(component.properties[0].value, "windows-sidecar");
});
