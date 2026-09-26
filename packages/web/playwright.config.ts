import { existsSync } from "node:fs";
import { chromium, defineConfig, devices } from "@playwright/test";

// 端到端自带一套端口，免得撞上开发机上别的进程或真控制面。
const API_PORT = "3317";
const WEB_PORT = "5377";

const bundledChromium = ((): boolean => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/prewarm.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  // 优先用 playwright install 下下来的 chromium。没下成就退到机器上装着的 Chrome，引擎一样，
  // 免得一条端到端都跑不了。
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], ...(bundledChromium ? {} : { channel: "chrome" as const }) },
    },
  ],
  webServer: [
    {
      command: "pnpm mock",
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      env: { API_PORT },
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "pnpm dev",
      url: `http://127.0.0.1:${WEB_PORT}`,
      env: { API_PORT, WEB_PORT },
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
