import { readFile, mkdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const playwrightModule = process.env.CODEX_WORKSPACE_NODE_MODULES
  ? pathToFileURL(join(process.env.CODEX_WORKSPACE_NODE_MODULES, "playwright", "index.mjs")).href
  : "playwright";
const { chromium } = await import(playwrightModule);

const manifestPath = resolve(process.argv[2] ?? "references/qc-ui-official-details/coros-4.1.0/manifest.json");
const outputDirectory = resolve(process.argv[3] ?? ".artifacts/qc-official-detail-renders");
const requestedIds = new Set(process.argv.slice(4));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const assets = manifest.assets.filter((asset) => requestedIds.size === 0 || requestedIds.has(asset.id));
if (requestedIds.size && assets.length !== requestedIds.size) {
  const found = new Set(assets.map((asset) => asset.id));
  throw new Error(`Unknown detail ids: ${[...requestedIds].filter((id) => !found.has(id)).join(", ")}`);
}

await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.QC_BROWSER_EXECUTABLE });
for (const asset of assets) {
  const page = await browser.newPage({ viewport: { width: asset.width, height: asset.height }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(resolve(dirname(manifestPath), asset.image)).href, { waitUntil: "load" });
  await page.screenshot({ path: join(outputDirectory, `${asset.id}.png`), omitBackground: true });
  await page.close();
  console.log(`Rendered ${asset.id} (${asset.width}x${asset.height})`);
}
await browser.close();
