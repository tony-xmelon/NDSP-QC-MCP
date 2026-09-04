import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { boundaryViolations, importedSpecifiers, verifyPackageBoundaries } from "../tools/verify-package-boundaries.mjs";

test("current workspace obeys shared-package and app-host boundaries", () => {
  assert.deepEqual(verifyPackageBoundaries(), []);
});

test("boundary checker recognizes static, side-effect, and dynamic imports", () => {
  assert.deepEqual(importedSpecifiers(`import type { X } from "one"; import "two"; export { y } from "three"; void import("four");`), ["one", "two", "three", "four"]);
});

test("shared core cannot acquire native APIs or depend upward on UI", () => {
  const coreFile = resolve("packages/typescript/qc-core/src/example.ts");
  assert.ok(boundaryViolations(coreFile, "@capacitor/core").length);
  assert.ok(boundaryViolations(coreFile, "@ndsp-qc/ui").length);
  assert.deepEqual(boundaryViolations(coreFile, "@ndsp-qc/client"), []);
});

test("application composition roots cannot import one another", () => {
  assert.ok(boundaryViolations(resolve("apps/android/src/example.ts"), "../../windows/src/App").length);
  assert.ok(boundaryViolations(resolve("apps/windows/src/example.ts"), "../../android/src/App").length);
});
