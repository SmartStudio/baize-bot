import { expect, login, openBot, overlaps, test, type Page } from "./fixtures";
import type { Locator } from "@playwright/test";

const HEADER_BUTTONS = [
  ["bot-edit", "编辑"],
  ["bot-share", "分享"],
  ["bot-panel-toggle", "设置栏开关"],
] as const;

const expectHeaderClear = async (page: Page, notice: Locator) => {
  for (const [testId, name] of HEADER_BUTTONS) {
    const button = page.getByTestId(testId);
    await expect(button, `提示挂着时聊天头的「${name}」看得见`).toBeVisible();
    await expect(button).toBeEnabled();
    expect(await overlaps(notice, button), `提示不压在「${name}」上`).toBe(false);
  }
};

const expectEditOpens = async (page: Page, notice: Locator) => {
  await page.getByTestId("bot-edit").click({ timeout: 2_000 });
  await expect(page.getByTestId("edit-bot-dialog"), "提示挂着时点「编辑」直接打开编辑弹窗").toBeVisible();
  await expect(notice, "点开编辑时提示还在，不是等它收起才点上的").toBeVisible();
};

for (const width of [1440, 900]) {
  test.describe(`${width} 宽`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("新 Bot 建好的提示挂着时，聊天头的按钮不被盖住，「编辑」点得开", async ({ page }) => {
      await login(page);
      await page.getByTestId("team-nav").click();
      await page.getByTestId("new-bot").click();
      await expect(page).toHaveURL(/\/g\/[^/]+$/);
      const notice = page.getByTestId("bot-created-notice");
      await expect(notice).toBeVisible();
      await expect(notice.getByTestId("bot-created-undo"), "提示里的撤销还点得到").toBeEnabled();

      await expectHeaderClear(page, notice);
      await expectEditOpens(page, notice);
    });

    test("授权结果的提示挂着时进 Bot 单聊，聊天头的按钮不被盖住，「编辑」点得开", async ({ page }) => {
      await login(page);
      await page.goto("/?oauth=github&result=connected");
      const notice = page.getByTestId("oauth-notice");
      await expect(notice).toBeVisible();
      await openBot(page, "小销");
      await expect(notice, "授权结果的提示不自己收起，切到单聊还挂着").toBeVisible();

      await expectHeaderClear(page, notice);
      await expectEditOpens(page, notice);
    });
  });
}
