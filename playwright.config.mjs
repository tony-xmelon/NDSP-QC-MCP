import { defineConfig } from "@playwright/test";
import { createServer } from "node:net";

async function availablePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate an isolated UI-test port."));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(String(address.port)));
    });
  });
}

const androidPort = process.env.QC_ANDROID_TEST_PORT ?? await availablePort();
const windowsPort = process.env.QC_WINDOWS_TEST_PORT ?? await availablePort();
process.env.QC_ANDROID_TEST_PORT = androidPort;
process.env.QC_WINDOWS_TEST_PORT = windowsPort;

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
      command: `npm run dev --workspace @ndsp-qc/android -- --host 127.0.0.1 --port ${androidPort} --strictPort`,
      url: `http://127.0.0.1:${androidPort}`,
      reuseExistingServer: false
    },
    {
      command: `npm run dev --workspace @ndsp-qc/windows -- --port ${windowsPort} --strictPort`,
      url: `http://127.0.0.1:${windowsPort}`,
      reuseExistingServer: false
    }
  ]
});
