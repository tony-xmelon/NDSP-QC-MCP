import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { QC_BRAND, QC_COLORS, QC_GEOMETRY, QC_GLYPH_FAMILIES, QC_NATIVE_THEME, QC_TYPOGRAPHY, QC_VISUAL_ASSETS } from "../packages/typescript/qc-theme/src/index.ts";

const read = (path: string) => readFileSync(path, "utf8");
const sha256 = (path: string) => createHash("sha256").update(path.endsWith(".svg")
  ? readFileSync(path, "utf8").replaceAll("\r\n", "\n")
  : readFileSync(path)).digest("hex");

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
  assert.deepEqual(Object.keys(QC_GLYPH_FAMILIES), ["hardware", "routing", "directory", "editing", "communication", "interface"]);
  for (const family of Object.values(QC_GLYPH_FAMILIES)) assert.ok(family.length >= 4);
  const icons = read("packages/typescript/qc-ui/src/theme-icons.tsx");
  for (const component of ["QcRouteGlyph", "QcModeGlyph", "QcDirectoryIcon", "QcEditorIcon", "QcUiIcon", "MicrophoneIcon"]) assert.ok(icons.includes("export function " + component));
  assert.equal(readdirSync("packages/typescript/qc-ui/src").filter((entry) => /icon/i.test(entry)).join(","), "theme-icons.tsx");
  assert.doesNotMatch(read("packages/typescript/qc-ui/src/quad-cortex-surface.tsx"), /function (?:RoutePickerGlyph|DirectoryIcon|ModeGlyph)/);
  assert.doesNotMatch(read("packages/typescript/qc-ui/src/parameter-editor.tsx"), /function ParameterMenuIcon/);
});

test("all deployed visual assets match the theme's canonical fingerprints", () => {
  for (const [name, asset] of Object.entries(QC_VISUAL_ASSETS)) {
    for (const file of [asset.sourcePath, ...asset.deployedPaths]) assert.equal(sha256(file), asset.sha256, `${name}: ${file}`);
  }
});

test("every tracked visual, font, audio, or video asset is owned by the theme manifest", () => {
  const visualFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.png", "*.svg", "*.ico", "*.webp", "*.jpg", "*.jpeg", "*.gif", "*.avif", "*.woff", "*.woff2", "*.ttf", "*.otf", "*.mp3", "*.wav", "*.ogg", "*.mp4", "*.webm"], { encoding: "utf8" })
    .trim().split(/\r?\n/).filter(Boolean).map((file) => file.replaceAll("\\", "/"));
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const asset of Object.values(QC_VISUAL_ASSETS)) {
    exact.add(asset.sourcePath);
    for (const file of asset.deployedPaths) exact.add(file);
    if ("derivedPathPrefixes" in asset) prefixes.push(...asset.derivedPathPrefixes);
  }
  for (const file of visualFiles) assert.ok(file.startsWith("references/") || exact.has(file) || prefixes.some((prefix) => file.startsWith(prefix)), `${file} is not owned by qc-theme/src/assets.json`);
});

test("product branding has one shared owner across web and native hosts", () => {
  assert.equal(QC_BRAND.appName, "QC Control");
  assert.equal(QC_BRAND.deviceName, "Quad Cortex");
  for (const file of ["apps/windows/src/main.tsx", "apps/android/src/main.tsx", "apps/android/src/App.tsx", "apps/android/capacitor.config.ts", "packages/typescript/qc-ui/src/quad-cortex-surface.tsx"]) {
    assert.match(read(file), /QC_BRAND/, `${file} must consume shared branding`);
    assert.doesNotMatch(read(file), /["'>]QC Control(?:[<"']|\ssettings)/, `${file} must not duplicate the app name`);
  }
  for (const file of ["apps/windows/index.html", "apps/android/index.html"]) assert.match(read(file), /<title><\/title>/);
  const tauri = JSON.parse(read("apps/windows/src-tauri/tauri.conf.json"));
  assert.equal(tauri.productName, QC_BRAND.appName);
  assert.equal(tauri.identifier, QC_BRAND.windowsIdentifier);
  assert.ok(tauri.app.windows.every((window: { title: string }) => window.title === QC_BRAND.appName));
  const strings = read("apps/android/android/app/src/main/res/values/strings.xml");
  assert.match(strings, /Generated by scripts\/sync-theme-assets\.mjs/);
  assert.ok(strings.includes(`<string name="app_name">${QC_BRAND.appName}</string>`));
  assert.ok(strings.includes(`<string name="app_font_family">${QC_NATIVE_THEME.android.appFontFamily}</string>`));
  assert.match(read("apps/android/android/app/src/main/res/values/styles.xml"), /android:fontFamily">@string\/app_font_family/);
  assert.match(read("scripts/generate-android-branding.ps1"), /brand\.appWordmark/);
});

test("authored app and device sources cannot bypass the shared visual contract", () => {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).trim().split(/\r?\n/)
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => /^(?:apps|packages|services|scripts|tools|contracts)\//.test(file))
    .filter((file) => existsSync(file))
    .filter((file) => /\.(?:css|html|java|json|mjs|ps1|py|rs|ts|tsx|xml)$/.test(file))
    .filter((file) => !file.startsWith("packages/typescript/qc-theme/"))
    .filter((file) => !file.startsWith("packages/typescript/qc-ui/src/official-") && !file.startsWith("packages/typescript/qc-ui/src/remaining-fixtures") && !file.endsWith("/coros-screen-fixtures.tsx") && !file.endsWith("/fixture-live-surface.css") && !file.endsWith("/reference-parameter-editor.css"))
    .filter((file) => !/^tools\/capture_.*\.mjs$/.test(file))
    .filter((file) => file !== "tools/sweep_qc_font.mjs")
    .filter((file) => !file.includes("/tests/") && !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"))
    .filter((file) => !/generated[-_]/i.test(file) && !file.endsWith("package-lock.json"));
  const colorLiteral = /#[0-9a-f]{3,8}\b|rgba?\s*\(|hsla?\s*\(/i;
  const deployedAssetUrl = /url\([^)]*\.(?:svg|png|webp|jpe?g|ico)\b/i;
  const literalFontStack = /["'](?:Arial Narrow|Arial|Helvetica Neue|Helvetica|Roboto Condensed|Roboto|DM Mono|Cascadia Mono|IBM Plex Sans|Segoe UI Variable|Segoe UI|Inter|Consolas)["']|fontFamily=["']|android:fontFamily">\s*(?!@(?:string|font)\/)[^<]+/mi;
  const iconCharacter = /[▲▼►▶◀◁▷‹›⌄⌃⋮＋✕✓✔✚⏵⏴■↵⇥✎☆⌫◇♩▥⚙▤↑↓]/u;
  for (const file of files) {
    const fullSource = read(file);
    if (/Generated by scripts\//.test(fullSource.slice(0, 300))) continue;
    const source = file.endsWith(".rs") ? fullSource.split("#[cfg(test)]")[0] : fullSource;
    assert.doesNotMatch(source, colorLiteral, `${file} must use @ndsp-qc/theme colors`);
    assert.doesNotMatch(source, deployedAssetUrl, `${file} must use @ndsp-qc/theme asset tokens`);
    assert.doesNotMatch(source, literalFontStack, `${file} must use @ndsp-qc/theme typography`);
    if (file.endsWith(".css")) assert.doesNotMatch(source.replaceAll("--qc-transparent", ""), /\btransparent\b/i, `${file} must use the shared transparent token`);
    if (/\.tsx?$/.test(file) && !file.endsWith("theme-icons.tsx")) assert.doesNotMatch(source, iconCharacter, `${file} must reference a shared vector glyph instead of an icon character literal`);
  }
  assert.match(read("scripts/sync-theme-assets.mjs"), /assets\.json/);
  assert.match(read("scripts/generate-qc-domain.mjs"), /colors\.json/);
});

test("device capture comparison covers every checked screenshot and visual family", () => {
  const manifest = JSON.parse(read("tests/fixtures/qc-theme-reference.json")) as { screenshots: string[]; commonPalette: Array<{ name: string }>; regions: Array<{ name: string }> };
  assert.equal(manifest.screenshots.length, 8);
  assert.deepEqual(manifest.commonPalette.map((entry) => entry.name), ["screen", "routePill", "routeRail", "utilityMark", "primaryText"]);
  for (const region of ["undoGlyph", "sceneBadge", "saveGlyph", "menuGlyph", "modeGlyph", "inputPill", "addBlock", "routeRail", "unsavedTitle"]) assert.ok(manifest.regions.some((entry) => entry.name === region), "capture comparison needs " + region);
});
