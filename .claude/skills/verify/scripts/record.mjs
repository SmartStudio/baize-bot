// 用 Playwright 的 recordVideo 录一段操作。Playwright MCP 录不了屏，要视频证据就跑这个。
// 用法：node record.mjs <网页地址> <输出.webm> [步骤模块.mjs]
// 步骤模块 default 导出 async (page, { login }) => {}；不给就只录登录进主窗口。
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const { chromium, expect } = createRequire(join(root, "packages/web/package.json"))("@playwright/test");

const [baseUrl, out, stepsPath] = process.argv.slice(2);
if (baseUrl === undefined || out === undefined) {
  console.error("用法：node record.mjs <网页地址> <输出.webm> [步骤模块.mjs]");
  process.exit(2);
}

const login = async (page) => {
  await page.goto(baseUrl);
  await page.getByTestId("workspace-input").fill("acme");
  await page.getByTestId("workspace-continue").click();
  await page.getByTestId("email-input").fill(process.env.BAIZE_EMAIL ?? "chen@baize.dev");
  await page.getByTestId("password-input").fill(process.env.BAIZE_PASSWORD ?? "baize-dev");
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("main-window")).toBeVisible({ timeout: 15_000 });
};

const steps =
  stepsPath === undefined
    ? async (page) => {
        await login(page);
        await page.waitForTimeout(1_500);
      }
    : (await import(pathToFileURL(resolve(stepsPath)).href)).default;

const target = resolve(out);
mkdirSync(dirname(target), { recursive: true });
mkdirSync(join(root, ".audit/verify-run"), { recursive: true });
const scratch = mkdtempSync(join(root, ".audit/verify-run/video-"));
const browser = await chromium.launch(existsSync(chromium.executablePath()) ? {} : { channel: "chrome" });
const size = { width: 1440, height: 900 };
const context = await browser.newContext({ viewport: size, recordVideo: { dir: scratch, size } });
const page = await context.newPage();
try {
  await steps(page, { login, baseUrl });
} finally {
  const video = page.video();
  await context.close();
  await video?.saveAs(target);
  await browser.close();
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`视频：${target}`);
