import { expect, test, login, openBot, teamCard, SHOT } from "./fixtures";

test("团队页点新 Bot 建的 Bot 进团队并直接进入它的对话", async ({ page }) => {
  await login(page);
  await page.getByTestId("team-nav").click();
  const items = page.getByTestId("team-bot");
  await expect(items).toHaveCount(3);
  const before = await items.count();

  await page.getByTestId("new-bot").click();

  await expect(page).toHaveURL(/\/g\/[^/]+$/);
  await expect(page.getByTestId("chat-title")).toHaveText(/^新 Bot/);
  const created = await page.getByTestId("chat-title").textContent();
  await expect(page.getByTestId("team-nav"), "新 Bot 的单聊算在团队底下").toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("message-list").getByTestId("message")).toHaveCount(0);
  await page.getByTestId("bot-edit").click();
  await expect(page.getByTestId("edit-bot-name"), "编辑弹窗带着系统起的名字").toHaveValue(String(created));
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${SHOT}/2b.png` });

  await page.getByTestId("team-nav").click();
  await expect(items).toHaveCount(before + 1);
  await expect(teamCard(page, String(created))).toHaveCount(1);
});

test("改完描述刷新页面还在", async ({ page }) => {
  await login(page);
  await openBot(page, "小采");
  const description = "只比价和询价，下单和付钱先找我点头。";

  const saved = page.waitForResponse((res) => res.url().includes("/api/bots/") && res.request().method() === "PATCH");
  await page.getByTestId("bot-edit").click();
  await page.getByTestId("edit-bot-description").fill(description);
  await page.getByTestId("edit-bot-save").click();
  await saved;
  await expect(page.getByTestId("bot-header-description")).toHaveText(description);

  await page.reload();
  await openBot(page, "小采");
  await expect(page.getByTestId("bot-header-description")).toHaveText(description);
});
