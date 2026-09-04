import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { QC_COLORS, QC_GEOMETRY, QC_GLYPH_FAMILIES, QC_TYPOGRAPHY, QC_VISUAL_ASSETS } from "../packages/typescript/qc-theme/src/index.ts";

const read = (path: string) => readFileSync(path, "utf8");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("shared theme retains every measured native QC color", () => {
  assert.deepEqual(QC_COLORS.captured, {
    screen: "#000000",
    routePill: "#101010",
    unsaved: "#313031",
    routeRail: "#c6c3c6",
    routeText: "#dedfde",
    utilityMark: "#949694",
    primaryText: "#ffffff",
    sceneBadge: "#ffd331"
  });
  assert.equal(QC_GEOMETRY.screen.width, 800);
  assert.equal(QC_GEOMETRY.screen.height, 480);
  assert.equal(QC_GEOMETRY.grid.rows, 4);
  assert.equal(QC_GEOMETRY.grid.columns, 6);
  assert.match(QC_TYPOGRAPHY.device, /Arial Narrow/);
});

test("theme CSS mirrors the typed tokens and is loaded by both apps", () => {
  const css = read("packages/typescript/qc-theme/src/theme.css");
  for (const color of Object.values(QC_COLORS.captured)) assert.ok(css.toLowerCase().includes(color), "CSS theme needs " + color);
  for (const entry of ["--qc-screen", "--qc-route-pill", "--qc-unsaved", "--qc-route-rail", "--qc-route-text", "--qc-utility-mark", "--qc-font-device", "--qc-font-app"]) assert.ok(css.includes(entry), "CSS theme needs " + entry);
  for (const entry of ["apps/windows/src/main.tsx", "apps/android/src/main.tsx"]) assert.match(read(entry), /@ndsp-qc\/theme\/theme\.css/, entry + " must load the shared theme");
});

test("core behavior and UI artwork consume one category palette", () => {
  assert.match(read("packages/typescript/qc-core/src/footswitch.ts"), /QC_COLORS\.category/);
  assert.match(read("packages/typescript/qc-ui/src/block-visuals.ts"), /QC_COLORS\.category/);
  assert.doesNotMatch(read("packages/typescript/qc-core/src/footswitch.ts"), /return "#(?:ff7000|ff2727|ffd236|00ffdd|45f862|3500f1|87daff|e44a5d|0a74e0)"/);
  for (const file of [
    "packages/typescript/qc-ui/src/quad-cortex-surface.tsx",
    "packages/typescript/qc-ui/src/parameter-editor.tsx",
    "packages/typescript/qc-ui/src/parameter-model.ts",
    "packages/typescript/qc-ui/src/qc-parameter-editor-bindings.ts",
    "packages/typescript/qc-ui/src/theme-icons.tsx"
  ]) assert.doesNotMatch(read(file), /#[0-9a-f]{3,8}\b/i, file + " must use shared theme colors");
});

test("shared glyph registry covers hardware, routing, directory, editing, and communication", () => {
  assert.deepEqual(Object.keys(QC_GLYPH_FAMILIES), ["hardware", "routing", "directory", "editing", "communication"]);
  for (const family of Object.values(QC_GLYPH_FAMILIES)) assert.ok(family.length >= 4);
  const icons = read("packages/typescript/qc-ui/src/theme-icons.tsx");
  for (const component of ["QcRouteGlyph", "QcModeGlyph", "QcDirectoryIcon", "QcEditorIcon"]) assert.ok(icons.includes("export function " + component));
  assert.doesNotMatch(read("packages/typescript/qc-ui/src/quad-cortex-surface.tsx"), /function (?:RoutePickerGlyph|DirectoryIcon|ModeGlyph)/);
  assert.doesNotMatch(read("packages/typescript/qc-ui/src/parameter-editor.tsx"), /function ParameterMenuIcon/);
});

test("all deployed visual assets match the theme's canonical fingerprints", () => {
  const pairs = [
    [QC_VISUAL_ASSETS.blockSprite.sha256, "apps/windows/public/qc-block-samples.svg", "apps/android/public/qc-block-samples.svg"],
    [QC_VISUAL_ASSETS.chassisOverlay.sha256, "apps/windows/public/qc-overview-001.svg", "apps/android/public/qc-overview-001.svg"],
    [QC_VISUAL_ASSETS.appIcon.sha256, "apps/windows/app-icon.svg", "apps/android/public/app-icon.svg"]
  ] as const;
  for (const [expected, ...files] of pairs) for (const file of files) assert.equal(sha256(file), expected, file);
});

test("device capture comparison covers every checked screenshot and visual family", () => {
  const manifest = JSON.parse(read("tests/fixtures/qc-theme-reference.json")) as { screenshots: string[]; commonPalette: Array<{ name: string }>; regions: Array<{ name: string }> };
  assert.equal(manifest.screenshots.length, 8);
  assert.deepEqual(manifest.commonPalette.map((entry) => entry.name), ["screen", "routePill", "routeRail", "utilityMark", "primaryText"]);
  for (const region of ["undoGlyph", "sceneBadge", "saveGlyph", "menuGlyph", "modeGlyph", "inputPill", "addBlock", "routeRail", "unsavedTitle"]) assert.ok(manifest.regions.some((entry) => entry.name === region), "capture comparison needs " + region);
});
