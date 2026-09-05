import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const playwrightModule = process.env.CODEX_WORKSPACE_NODE_MODULES
  ? pathToFileURL(join(process.env.CODEX_WORKSPACE_NODE_MODULES, "playwright", "index.mjs")).href
  : "playwright";
const { chromium } = await import(playwrightModule);
const baseUrl = process.argv[2] ?? "http://127.0.0.1:5173/";
const outputDirectory = process.argv[3] ?? ".artifacts/ui-android";
const requestedIds = new Set((process.env.QC_CAPTURE_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean));
let captureCount = 0;
await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({ headless: true, executablePath: process.env.QC_BROWSER_EXECUTABLE });
// 822px leaves an exact 800x480 CorOS framebuffer after the current shell padding and chassis borders.
const page = await browser.newPage({ viewport: { width: 822, height: 1280 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
page.setDefaultTimeout(10000);
const captureCss = `
  .mobile-screen { width: 802px !important; height: 482px !important; }
  .mobile-screen > .qc-chassis { width: 802px !important; min-width: 802px !important; max-width: 802px !important; height: 482px !important; min-height: 482px !important; max-height: 482px !important; aspect-ratio: auto !important; }
  .mobile-screen .qc-screen-bezel { position: absolute !important; inset: 1px !important; width: 800px !important; height: 480px !important; padding: 0 !important; border: 0 !important; border-radius: 0 !important; }
  .mobile-screen .qc-screen-bezel::after { display: none !important; }
  .mobile-screen .qc-screen { border-radius: 0 !important; box-shadow: none !important; }
`;

async function load(extra = {}) {
  const url = new URL(baseUrl);
  url.searchParams.set("fixture", "coros410");
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  await page.goto(url.href, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: captureCss });
}

async function capture(id) {
  if (requestedIds.size && !requestedIds.has(id)) return;
  const screen = page.locator(".qc-screen-bezel");
  const box = await screen.boundingBox();
  if (!box || Math.round(box.width) !== 800 || Math.round(box.height) !== 480) {
    throw new Error(`${id}: expected exact 800x480 framebuffer, got ${box?.width}x${box?.height}`);
  }
  const viewport = page.viewportSize();
  if (viewport) await page.mouse.move(viewport.width - 1, viewport.height - 1);
  await screen.screenshot({ path: `${outputDirectory}/${id}.png`, animations: "disabled", timeout: 15000 });
  captureCount += 1;
  console.log(`Captured Android ${id}`);
}

async function gridState(id, action) {
  await load();
  if (action) await action();
  await capture(id);
}

for (const id of ["grid-base", "grid-restored", "grid-scene-a-restored"]) await gridState(id);
await gridState("grid-scene-selector", async () => page.getByLabel("Select scene").click());
await gridState("grid-context-menu", async () => page.getByLabel("Open Grid menu").click());
await gridState("grid-scene-b", async () => {
  await page.getByLabel("Select scene").click();
  await page.getByRole("menuitem").nth(1).click();
});
for (const [id, screen] of [["copy-scene-destination", "fixture-copy-scene"], ["swap-scene-destination", "fixture-swap-scene"]]) {
  await load({ screen });
  await capture(id);
}
await gridState("preset-directory", async () => page.getByLabel(/Open preset Directory/).click());
await gridState("input-route-selector", async () => {
  await page.getByLabel("Edit row 1 input").click();
  await page.locator(".coros-route-options, .route-picker-list").evaluate((element) => { element.scrollTop = element.scrollHeight - element.clientHeight - 20; });
});
await gridState("output-route-selector", async () => {
  await page.getByLabel("Edit row 1 output").click();
  await page.locator(".coros-route-options, .route-picker-list").evaluate((element) => { element.scrollTop = element.scrollHeight; });
});
for (const [id, screen] of [["device-browser-root", "corpus-device-browser-root"], ["device-browser-models", "corpus-device-browser-models"], ["device-browser-models-clean", "corpus-device-browser-models-clean"]]) {
  await load({ screen });
  await capture(id);
}

const editors = [
  ["editor-simple-gate", "Simple Gate"],
  ["editor-chief-ds1", "Chief DS1"],
  ["editor-digital-flanger", "Digital Flanger"],
  ["editor-ukc30-topboost", "UK C30 TopBoost"],
  ["editor-ukc30-cab", "212 UK C30 65 (M)"],
  ["editor-parametric-8", "Parametric-8"],
  ["editor-ambience", "Ambience"]
];
for (const [id, name] of editors) {
  await load();
  await page.getByLabel(`Row 1, ${name}`).click();
  await page.locator(".coros-parameter-editor").waitFor({ state: "visible" });
  await capture(id);
}

for (const [id, mode] of [["gig-view", "STOMP"], ["gig-view-preset", "PRESET"], ["gig-view-scene", "SCENE"]]) {
  await load({ screen: "gig", mode });
  await capture(id);
}
for (const [id, view] of [["device-browser-plugin-list", "plugin-list"], ["device-browser-plugin-models", "plugin-models"], ["device-browser-plugin-locked", "plugin-locked"], ["device-presets-exotic-z-boost", "device-presets"], ["device-presets-user", "device-presets-user"], ["device-preset-actions", "device-preset-actions"], ["splitter-editor", "splitter-editor"], ["mixer-editor", "mixer-editor"], ["tempo-metronome", "tempo"], ["tuner", "tuner"], ["tuner-live-enabled", "tuner-live-enabled"], ["gig-view-live-tuner", "gig-live-tuner"], ["preset-midi-out", "midi-out"], ["modes-configuration", "modes"], ["save-as-editor", "save-as"], ["edit-details-editor", "edit-details"]]) {
  await load({ screen: view, ...(view === "tempo" ? { tempo: "56" } : {}) });
  await capture(id);
}

await browser.close();
console.log(`Captured ${captureCount} Android corpus states in ${outputDirectory}`);
