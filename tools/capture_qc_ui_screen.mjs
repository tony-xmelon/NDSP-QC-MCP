import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const playwrightModule = process.env.CODEX_WORKSPACE_NODE_MODULES
  ? pathToFileURL(join(process.env.CODEX_WORKSPACE_NODE_MODULES, "playwright", "index.mjs")).href
  : "playwright";
const { chromium } = await import(playwrightModule);

let [baseUrl, output, screen = "grid", mode, host = "windows"] = process.argv.slice(2);
if (!baseUrl || !output) throw new Error("usage: capture_qc_ui_screen.mjs <url> <output.png> [screen] [mode] [windows|android]");
if ((mode === "windows" || mode === "android") && host === "windows") {
  host = mode;
  mode = undefined;
}

await mkdir(dirname(output), { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.QC_BROWSER_EXECUTABLE });
const android = host === "android";
const presetDirectory = screen === "preset-directory";
const editorNames = {
  "editor-simple-gate": "Simple Gate",
  "editor-chief-ds1": "Chief DS1",
  "editor-digital-flanger": "Digital Flanger",
  "editor-ukc30-topboost": "UK C30 TopBoost",
  "editor-ukc30-cab": "212 UK C30 65 (M)",
  "editor-parametric-8": "Parametric-8",
  "editor-ambience": "Ambience",
};
const page = await browser.newPage(android
  ? { viewport: { width: 822, height: 1280 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true }
  : { viewport: { width: 802, height: 482 }, deviceScaleFactor: 1 });
const url = new URL(baseUrl);
url.searchParams.set("fixture", "coros410");
if (screen !== "grid" && !(screen in editorNames) && !presetDirectory) url.searchParams.set("screen", screen);
if (mode) url.searchParams.set("mode", mode);
await page.goto(url.href, { waitUntil: "networkidle" });
if (!android) await page.addStyleTag({ content: `
  html, body, #root { width: 802px !important; height: 482px !important; overflow: hidden !important; }
  .menu-bar, .status-strip, .chat-dock, .restore-chat, .dialog-backdrop { display: none !important; }
  .app-content, .workspace { display: block !important; width: 802px !important; height: 482px !important; min-height: 0 !important; padding: 0 !important; margin: 0 !important; }
  .qc-chassis { position: relative !important; width: 802px !important; min-width: 802px !important; max-width: 802px !important; height: 482px !important; min-height: 482px !important; max-height: 482px !important; aspect-ratio: auto !important; overflow: hidden !important; border: 1px solid transparent !important; border-radius: 0 !important; }
  .qc-chassis::before, .qc-chassis::after, .official-svg-viewport, .chassis-edge, .master-volume, .device-plate, .screen-nav-control, .footswitch-deck { display: none !important; }
  .qc-screen-bezel, .skin-official-svg .qc-screen-bezel { position: absolute !important; inset: 1px !important; width: 800px !important; height: 480px !important; padding: 0 !important; border: 0 !important; border-radius: 0 !important; background: #050506 !important; box-shadow: none !important; }
  .qc-screen-bezel::after { display: none !important; }
` });
if (android) await page.addStyleTag({ content: `
  .mobile-screen { width: 802px !important; height: 482px !important; }
  .mobile-screen > .qc-chassis { width: 802px !important; min-width: 802px !important; max-width: 802px !important; height: 482px !important; min-height: 482px !important; max-height: 482px !important; aspect-ratio: auto !important; }
  .mobile-screen .qc-screen-bezel { position: absolute !important; inset: 1px !important; width: 800px !important; height: 480px !important; padding: 0 !important; border: 0 !important; border-radius: 0 !important; }
` });
await page.locator(".dialog-close").click({ timeout: 1000 }).catch(() => undefined);
if (presetDirectory) await page.getByLabel(/Open preset Directory/).click();
if (screen in editorNames) {
  await page.getByLabel(`Row 1, ${editorNames[screen]}`).click();
  await page.locator(".coros-parameter-editor").waitFor({ state: "visible" });
}
const target = page.locator(".qc-screen-bezel");
const box = await target.boundingBox();
if (!box || Math.round(box.width) !== 800 || Math.round(box.height) !== 480) throw new Error(`expected 800x480, got ${box?.width}x${box?.height}`);
await target.screenshot({ path: output, animations: "disabled" });
await browser.close();
console.log(`Captured ${screen}${mode ? `/${mode}` : ""} to ${output}`);
