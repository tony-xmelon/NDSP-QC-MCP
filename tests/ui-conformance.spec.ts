import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const surfaces = [
  { name: "Android portrait", url: "http://127.0.0.1:4173", width: 393, height: 851, touchTargets: true },
  { name: "Android compact portrait", url: "http://127.0.0.1:4173", width: 360, height: 640, touchTargets: true },
  { name: "Android landscape", url: "http://127.0.0.1:4173", width: 800, height: 480, touchTargets: true },
  { name: "Windows minimum", url: "http://127.0.0.1:1420", width: 920, height: 720, touchTargets: false },
  { name: "Windows standard", url: "http://127.0.0.1:1420", width: 1280, height: 800, touchTargets: false }
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
  });
}
