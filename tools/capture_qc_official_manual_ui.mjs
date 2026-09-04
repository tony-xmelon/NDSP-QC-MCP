import { readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const playwrightModule = process.env.CODEX_WORKSPACE_NODE_MODULES
  ? pathToFileURL(join(process.env.CODEX_WORKSPACE_NODE_MODULES, "playwright", "index.mjs")).href
  : "playwright";
const { chromium } = await import(playwrightModule);
const manifestPath = process.argv[2] ?? "references/qc-ui-official-manual/coros-4.1.0/manifest.json";
const windowsUrl = process.argv[3] ?? "http://127.0.0.1:1420/";
const androidUrl = process.argv[4] ?? "http://127.0.0.1:5173/";
const outputRoot = process.argv[5] ?? ".artifacts/ui-official-manual";
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const requestedIds = new Set((process.env.QC_CAPTURE_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean));
const captures = manifest.captures.filter((capture) => capture.renderer && (!requestedIds.size || requestedIds.has(capture.id)));

const browser = await chromium.launch({ headless: true, executablePath: process.env.QC_BROWSER_EXECUTABLE });
const windowsCss = `
  html, body, #root { width: 802px !important; height: 482px !important; overflow: hidden !important; }
  .menu-bar, .status-strip, .chat-dock, .restore-chat, .dialog-backdrop { display: none !important; }
  .app-content, .workspace { display: block !important; width: 802px !important; height: 482px !important; min-height: 0 !important; padding: 0 !important; margin: 0 !important; }
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

async function captureHost(host, baseUrl, viewport, css) {
  const output = join(outputRoot, host);
  await mkdir(output, { recursive: true });
  const emulateMobile = host === "android" && !process.env.QC_CAPTURE_DESKTOP_RASTER;
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1, isMobile: emulateMobile, hasTouch: emulateMobile });
  page.setDefaultTimeout(10000);
  for (const capture of captures) {
    const url = new URL(baseUrl);
    url.searchParams.set("fixture", "coros410");
    url.searchParams.set("screen", capture.renderer.screen);
    for (const [key, value] of Object.entries(capture.renderer)) {
      if (key !== "screen") url.searchParams.set(key, value);
    }
    await page.goto(url.href, { waitUntil: "networkidle" });
    if (css) await page.addStyleTag({ content: css });
    if (process.env.QC_CAPTURE_DEBUG_STYLES) {
      const styles = await page.evaluate(() => Object.fromEntries([".qc-screen-bezel", ".qc-screen-fixture-root", ".qc-screen", ".coros-device-browser-official"].map((selector) => {
        const element = document.querySelector(selector);
        if (!element) return [selector, null];
        const style = getComputedStyle(element);
        return [selector, { x: element.getBoundingClientRect().x, y: element.getBoundingClientRect().y, width: style.width, height: style.height, font: style.fontFamily, fontSize: style.fontSize, borderRadius: style.borderRadius, transform: style.transform }];
      })));
      console.log(`${host}/${capture.id} styles ${JSON.stringify(styles)}`);
    }
    await page.locator(".dialog-close").click({ timeout: 1000 }).catch(() => undefined);
    const screen = page.locator(".qc-screen-bezel");
    const box = await screen.boundingBox();
    if (process.env.QC_CAPTURE_DEBUG_BOX) console.log(`${host}/${capture.id} box ${JSON.stringify(box)}`);
    if (!box || Math.round(box.width) !== 800 || Math.round(box.height) !== 480) {
      throw new Error(`${host}/${capture.id}: expected 800x480, got ${box?.width}x${box?.height}`);
    }
    await screen.screenshot({ path: join(output, `${capture.id}.png`), animations: "disabled", timeout: 15000 });
    console.log(`Captured ${host} ${capture.id}`);
  }
  await page.close();
}

await Promise.all([
  captureHost("windows", windowsUrl, { width: 802, height: 482 }, windowsCss),
  captureHost("android", androidUrl, { width: 822, height: 1280 }, androidCss),
]);
await browser.close();
console.log(`Captured ${captures.length} official-manual states per host in ${outputRoot}`);
