import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const androidUrl = `http://127.0.0.1:${process.env.QC_ANDROID_TEST_PORT ?? "4173"}`;
const windowsUrl = `http://127.0.0.1:${process.env.QC_WINDOWS_TEST_PORT ?? "1420"}`;
const surfaces = [
  { name: "Android portrait", url: androidUrl, width: 393, height: 851, touchTargets: true, sceneControl: "Footswitch C" },
  { name: "Android compact portrait", url: androidUrl, width: 360, height: 640, touchTargets: true, sceneControl: "Footswitch C" },
  { name: "Android landscape", url: androidUrl, width: 800, height: 480, touchTargets: true, sceneControl: "Footswitch C" },
  { name: "Windows minimum", url: windowsUrl, width: 920, height: 720, touchTargets: false, sceneControl: "C encoder footswitch; encoder 50 percent" },
  { name: "Windows standard", url: windowsUrl, width: 1280, height: 800, touchTargets: false, sceneControl: "C encoder footswitch; encoder 50 percent" }
] as const;

async function viewportMetrics(page: Page) {
  return page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    bodyWidth: document.body.getBoundingClientRect().width,
    bodyHeight: document.body.getBoundingClientRect().height
  }));
}

for (const surface of surfaces) {
  test(`${surface.name} fits and passes accessibility checks`, async ({ page }) => {
    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") runtimeErrors.push(`console: ${message.text()}`);
    });
    await page.setViewportSize({ width: surface.width, height: surface.height });
    await page.goto(surface.url);
    await page.locator("#root").waitFor({ state: "visible" });

    const metrics = await viewportMetrics(page);
    expect(metrics.scrollWidth, "page must not overflow horizontally").toBeLessThanOrEqual(metrics.width + 1);
    expect(metrics.scrollHeight, "page shell must fit its viewport").toBeLessThanOrEqual(metrics.height + 1);
    expect(metrics.bodyWidth).toBeGreaterThan(0);
    expect(metrics.bodyHeight).toBeGreaterThan(0);

    if (surface.touchTargets) {
      const undersized = await page.locator("button:visible, select:visible, input:visible").evaluateAll((controls) => controls.flatMap((control) => {
        const box = control.getBoundingClientRect();
        return box.width + 0.5 < 24 || box.height + 0.5 < 24 ? [`${control.tagName.toLowerCase()}[${control.getAttribute("aria-label") ?? control.textContent?.trim() ?? "unnamed"}] ${Math.round(box.width)}x${Math.round(box.height)}`] : [];
      }));
      expect(undersized, "interactive targets must meet the WCAG 2.2 24px minimum").toEqual([]);
    }

    // The CorOS canvas deliberately overlays a dense 800x480 hardware screen;
    // explicit geometry above verifies its targets after scaling. Axe checks
    // target spacing everywhere else and all other rules across the full UI.
    const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).disableRules(["target-size"]).analyze();
    const targetSpacing = await new AxeBuilder({ page }).withRules(["target-size"]).exclude(".coros-vector-actions").analyze();
    const materialViolations = [...accessibility.violations, ...targetSpacing.violations].filter((violation) => violation.impact === "serious" || violation.impact === "critical");
    expect(materialViolations, materialViolations.map((violation) => `${violation.id}: ${violation.help}`).join("\n")).toEqual([]);
    expect(runtimeErrors, "app must render without uncaught exceptions or console errors").toEqual([]);
  });

  test(`${surface.name} opens and closes the shared parameter editor`, async ({ page }) => {
    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") runtimeErrors.push(`console: ${message.text()}`);
    });
    await page.setViewportSize({ width: surface.width, height: surface.height });
    await page.goto(surface.url);
    const block = page.locator(".coros-vector-block-hit").first();
    await expect(block).toBeVisible();
    await block.click();
    const close = page.getByRole("button", { name: "Close parameter editor" });
    await expect(close).toBeVisible();
    await close.click();
    await expect(close).toBeHidden();
    await expect(block).toBeVisible();
    expect(runtimeErrors, "parameter workflow must not raise runtime errors").toEqual([]);
  });

  test(`${surface.name} reconciles a scene footswitch press`, async ({ page }) => {
    await page.setViewportSize({ width: surface.width, height: surface.height });
    await page.goto(surface.url);
    const scene = page.getByRole("button", { name: surface.sceneControl, exact: true });
    await expect(scene).toBeVisible();
    await expect(scene).toHaveAttribute("aria-pressed", "false");
    await scene.click();
    await expect(scene).toHaveAttribute("aria-pressed", "true");
  });

  test(`${surface.name} reconciles tap tempo`, async ({ page }) => {
    await page.setViewportSize({ width: surface.width, height: surface.height });
    await page.goto(surface.url);
    const tempo = surface.touchTargets
      ? page.getByRole("button", { name: /^Tap tempo,/ })
      : page.getByRole("button", { name: /^TEMPO encoder footswitch;/ });
    await expect(tempo).toBeVisible();
    const before = surface.touchTargets ? await tempo.getAttribute("aria-label") : await tempo.getAttribute("style");
    await tempo.click();
    await page.waitForTimeout(620);
    await tempo.click();
    await expect.poll(async () => surface.touchTargets ? tempo.getAttribute("aria-label") : tempo.getAttribute("style"))
      .not.toBe(before);
  });

  test(`${surface.name} preserves rapid consecutive bypass changes`, async ({ page }) => {
    await page.setViewportSize({ width: surface.width, height: surface.height });
    await page.goto(surface.url);
    await page.locator(".coros-vector-block-hit").first().click();
    const bypass = page.locator(".parameter-bypass");
    await expect(bypass).toBeVisible();
    const initial = await bypass.getAttribute("aria-pressed");
    await bypass.click();
    await expect(bypass).toHaveAttribute("aria-pressed", initial === "true" ? "false" : "true");
    await bypass.click();
    await expect(bypass).toHaveAttribute("aria-pressed", initial ?? "false");
  });

  test(`${surface.name} switches device mode through the shared screen menu`, async ({ page }) => {
    await page.setViewportSize({ width: surface.width, height: surface.height });
    await page.goto(surface.url);
    const mode = page.getByRole("button", { name: /^Open mode menu; current mode/ });
    await expect(mode).toBeVisible();
    await mode.click();
    await page.getByRole("menuitem", { name: "SCENE", exact: true }).click();
    await expect(mode).toHaveAttribute("aria-label", "Open mode menu; current mode SCENE");
  });

}
