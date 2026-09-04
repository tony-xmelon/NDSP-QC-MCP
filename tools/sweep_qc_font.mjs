import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const playwrightModule = process.env.CODEX_WORKSPACE_NODE_MODULES
  ? pathToFileURL(join(process.env.CODEX_WORKSPACE_NODE_MODULES, "playwright", "index.mjs")).href
  : "playwright";
const { chromium } = await import(playwrightModule);

const baseUrl = process.argv[2] ?? "http://127.0.0.1:1420/";
const screen = process.argv[3] ?? "save-as";
const selector = process.argv[4] ?? ".coros-save-as";
const outputDirectory = process.argv[5] ?? ".artifacts/font-sweep";
const fonts = ["Arial", "Roboto", "Noto Sans", "Segoe UI", "Inter", "DejaVu Sans"];
const captureCss = `
  html, body, #root { width: 802px !important; height: 482px !important; overflow: hidden !important; }
  .menu-bar, .status-strip, .chat-dock, .restore-chat, .dialog-backdrop { display: none !important; }
  .app-content, .workspace { display: block !important; width: 802px !important; height: 482px !important; min-height: 0 !important; padding: 0 !important; margin: 0 !important; }
  .qc-chassis { position: relative !important; width: 802px !important; min-width: 802px !important; max-width: 802px !important; height: 482px !important; min-height: 482px !important; max-height: 482px !important; aspect-ratio: auto !important; overflow: hidden !important; border: 1px solid transparent !important; border-radius: 0 !important; }
  .qc-chassis::before, .qc-chassis::after, .official-svg-viewport, .chassis-edge, .master-volume, .device-plate, .screen-nav-control, .footswitch-deck { display: none !important; }
  .qc-screen-bezel, .skin-official-svg .qc-screen-bezel { position: absolute !important; inset: 1px !important; width: 800px !important; height: 480px !important; padding: 0 !important; border: 0 !important; border-radius: 0 !important; background: #050506 !important; box-shadow: none !important; }
  .qc-screen-bezel::after { display: none !important; }
`;

await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.QC_BROWSER_EXECUTABLE });
for (const font of fonts) {
  const page = await browser.newPage({ viewport: { width: 802, height: 482 }, deviceScaleFactor: 1 });
  const url = new URL(baseUrl);
  url.searchParams.set("fixture", "coros410");
  url.searchParams.set("screen", screen);
  await page.goto(url.href, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: `${captureCss}\n${selector}, ${selector} * { font-family: ${JSON.stringify(font)} !important; }` });
  await page.locator(".dialog-close").click({ timeout: 1000 }).catch(() => undefined);
  if (screen === "preset-directory") await page.getByLabel(/Open preset Directory/).click();
  if (screen.startsWith("editor-")) {
    const editorNames = {
      "editor-simple-gate": "Simple Gate",
      "editor-chief-ds1": "Chief DS1",
      "editor-digital-flanger": "Digital Flanger",
      "editor-ukc30-topboost": "UK C30 TopBoost",
      "editor-ukc30-cab": "212 UK C30 65 (M)",
      "editor-parametric-8": "Parametric-8",
      "editor-ambience": "Ambience",
    };
    await page.getByLabel(`Row 1, ${editorNames[screen]}`).click();
  }
  const target = page.locator(".qc-screen-bezel");
  const box = await target.boundingBox();
  if (!box || Math.round(box.width) !== 800 || Math.round(box.height) !== 480) throw new Error(`Expected 800x480, got ${box?.width}x${box?.height}`);
  const slug = font.toLowerCase().replaceAll(" ", "-");
  await target.screenshot({ path: `${outputDirectory}/${slug}.png`, animations: "disabled" });
  await page.close();
}
await browser.close();
