import { chromium, type FullConfig } from "@playwright/test";
import { stubExternalFonts } from "./fixtures";

// Vite 开发服务按需编译，谁先打开页面谁替全站付几秒冷编译，这笔账原来记在第一条用例头上，
// 让它的耗时和超时都不可信。开跑前先用浏览器把首页完整打开一次，编译算在这里。
const prewarm = async (config: FullConfig): Promise<void> => {
  const use = config.projects[0]?.use ?? {};
  const browser = await chromium.launch(use.channel === undefined ? {} : { channel: use.channel });
  try {
    const context = await browser.newContext();
    await stubExternalFonts(context);
    const page = await context.newPage();
    await page.goto(String(use.baseURL));
    await page.getByTestId("email-input").waitFor();
  } finally {
    await browser.close();
  }
};

export default prewarm;
