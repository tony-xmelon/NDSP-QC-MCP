import assert from "node:assert/strict";
import test from "node:test";
import { buildSbom, npmComponents, parseCargoLock, sha256 } from "../tools/release-provenance.mjs";

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
