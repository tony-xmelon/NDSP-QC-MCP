import { defineConfig } from "@playwright/test";

const androidPort = process.env.QC_ANDROID_TEST_PORT ?? "4173";
const windowsPort = process.env.QC_WINDOWS_TEST_PORT ?? "1420";

export default defineConfig({
  testDir: "./tests",
  testMatch: "ui-conformance.spec.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "line",
  use: {
    colorScheme: "dark",
    locale: "en-US",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  webServer: [
    {
      command: `npm run dev --workspace @ndsp-qc/android -- --host 127.0.0.1 --port ${androidPort}`,
      url: `http://127.0.0.1:${androidPort}`,
      reuseExistingServer: false
    },
    {
      command: `npm run dev --workspace @ndsp-qc/windows -- --port ${windowsPort}`,
      url: `http://127.0.0.1:${windowsPort}`,
      reuseExistingServer: false
    }
  ]
});
