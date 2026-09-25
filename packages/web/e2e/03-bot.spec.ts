import { expect, test, login, openBot, SHOT } from "./fixtures";

test("点加号建的新 Bot 进侧栏并直接进入它的对话", async ({ page }) => {
  await login(page);
  const items = page.locator("[data-testid=bot-item]");
  const before = await items.count();

  await page.getByTestId("new-menu").click();
  await page.getByTestId("new-bot").click();

  await expect(items).toHaveCount(before + 1);
  const created = await page.getByTestId("chat-title").textContent();
  expect(created).toMatch(/^新 Bot/);
  await expect(page.locator(`[data-testid=bot-item][data-bot-name="${created}"]`)).toHaveClass(/is-selected/);
  await expect(page.getByTestId("message-list").getByTestId("message")).toHaveCount(0);
  await expect(page.getByTestId("bot-name-input")).toHaveValue(String(created));
  await page.screenshot({ path: `${SHOT}/2b.png` });
});

test("改完描述刷新页面还在", async ({ page }) => {
  await login(page);
  await openBot(page, "小采");
  const description = "只比价和询价，下单和付钱先找我点头。";

  const saved = page.waitForResponse((res) => res.url().includes("/api/bots/") && res.request().method() === "PATCH");
  await page.getByTestId("bot-description-input").fill(description);
  await page.getByTestId("bot-name-input").click();
  await saved;

  await page.reload();
  await openBot(page, "小采");
  await expect(page.getByTestId("bot-description-input")).toHaveValue(description);
});
