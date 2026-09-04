import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const playwrightModule = process.env.CODEX_WORKSPACE_NODE_MODULES
  ? pathToFileURL(join(process.env.CODEX_WORKSPACE_NODE_MODULES, "playwright", "index.mjs")).href
  : "playwright";
const { chromium } = await import(playwrightModule);
const windowsUrl = process.argv[2] ?? "http://127.0.0.1:1420/";
const androidUrl = process.argv[3] ?? "http://127.0.0.1:5173/";
const outputDirectory = process.argv[4] ?? ".artifacts/ui-manual-reference";
await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({ headless: true, executablePath: process.env.QC_BROWSER_EXECUTABLE });
const defaultViews = [
  "tempo", "midi-out", "cpu-monitor", "io-overview", "io-input", "io-output",
  "io-send-return", "io-usb", "io-headphones", "global-eq", "gig-live-tuner", "tuner-live-enabled", "power-overlay",
  "splitter-placement", "splitter-editor", "mixer-editor", "empty-slot",
  "device-search", "device-favorites", "plugin-folders", "plugin-list", "plugin-models", "plugin-locked", "plugin-refresh",
  "looper-editor", "device-presets", "device-presets-user", "device-preset-actions", "device-preset-save", "stomp-assignment",
  "scene-assignment", "expression-parameter", "expression-bypass", "block-context",
  "directory-presets", "directory-categories", "directory-captures", "directory-irs", "directory-plugins",
  "directory-favorites", "directory-search", "directory-search-results", "directory-sort",
  "directory-filter", "directory-arrange", "directory-copy", "directory-nested",
  "directory-new-folder", "directory-item-context", "directory-cloud-upload",
  "capture-intro", "capture-type", "capture-routing", "capture-calibration",
  "capture-progress", "capture-result", "capture-save",
  "recovery-entry", "recovery-options", "overlay-keyboard", "overlay-confirmation",
  "overlay-error", "overlay-busy",
  "fixture-boot", "fixture-shutdown", "fixture-copy-scene", "fixture-swap-scene",
  "fixture-delete", "fixture-input-gate", "fixture-editor-pages", "fixture-editor-cab",
  "fixture-editor-eq", "fixture-editor-capture", "fixture-warning-clip", "fixture-warning-dsp",
  "settings-account", "settings-system", "settings-device", "settings-support", "settings-wifi",
  "settings-update", "settings-storage", "settings-midi", "settings-info", "settings-diagnostics"
];
const views = process.env.QC_CAPTURE_VIEWS?.split(",").map((view) => view.trim()).filter(Boolean) ?? defaultViews;
const windowsCss = `
  html, body, #root, .app-content, .workspace { width: 802px !important; height: 482px !important; overflow: hidden !important; }
  .menu-bar, .status-strip, .chat-dock, .restore-chat, .dialog-backdrop { display: none !important; }
  .app-content, .workspace { display: block !important; min-height: 0 !important; padding: 0 !important; margin: 0 !important; }
  .qc-chassis { position: relative !important; width: 802px !important; min-width: 802px !important; max-width: 802px !important; height: 482px !important; min-height: 482px !important; max-height: 482px !important; aspect-ratio: auto !important; overflow: hidden !important; border: 1px solid transparent !important; border-radius: 0 !important; }
  .qc-chassis::before, .qc-chassis::after, .official-svg-viewport, .chassis-edge, .master-volume, .device-plate, .screen-nav-control, .footswitch-deck { display: none !important; }
  .qc-screen-bezel, .skin-official-svg .qc-screen-bezel { position: absolute !important; inset: 1px !important; width: 800px !important; height: 480px !important; padding: 0 !important; border: 0 !important; border-radius: 0 !important; background: #050506 !important; box-shadow: none !important; }
  .qc-screen-bezel::after { display: none !important; }
`;
const androidCss = `
  .mobile-screen { width: 802px !important; height: 482px !important; }
  .mobile-screen > .qc-chassis { width: 802px !important; min-width: 802px !important; max-width: 802px !important; height: 482px !important; min-height: 482px !important; max-height: 482px !important; aspect-ratio: auto !important; }
  .mobile-screen .qc-screen-bezel { position: absolute !important; inset: 1px !important; width: 800px !important; height: 480px !important; padding: 0 !important; border: 0 !important; border-radius: 0 !important; }
`;

async function capture(host, baseUrl, viewport, css) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1, isMobile: host === "android", hasTouch: host === "android" });
  for (const view of views) {
    const url = new URL(baseUrl);
    url.searchParams.set("fixture", "coros410");
    url.searchParams.set("screen", view);
    await page.goto(url.href, { waitUntil: "networkidle" });
    if (css) await page.addStyleTag({ content: css });
    await page.locator(".dialog-close").click({ timeout: 1000 }).catch(() => undefined);
    const screen = page.locator(".qc-screen-bezel");
    const box = await screen.boundingBox();
    if (!box || Math.round(box.width) !== 800 || Math.round(box.height) !== 480) throw new Error(`${host}/${view}: expected 800x480, got ${box?.width}x${box?.height}`);
    await screen.screenshot({ path: `${outputDirectory}/${host}-${view}.png`, animations: "disabled" });
    console.log(`Captured ${host} ${view}`);
  }
  await page.close();
}

await Promise.all([
  capture("windows", windowsUrl, { width: 802, height: 482 }, windowsCss),
  capture("android", androidUrl, { width: 822, height: 1280 }, androidCss)
]);
await browser.close();
