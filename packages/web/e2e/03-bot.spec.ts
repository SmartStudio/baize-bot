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

test("点新 Bot 建完顶上给一条可撤销的提示，撤销就把它删掉回团队页", async ({ page }) => {
  await login(page);
  await page.getByTestId("team-nav").click();
  const items = page.getByTestId("team-bot");
  await expect(items).toHaveCount(3);

  await page.getByTestId("new-bot").click();
  await expect(page).toHaveURL(/\/g\/[^/]+$/);
  const created = String(await page.getByTestId("chat-title").textContent());
  await expect(page.getByTestId("bot-panel"), "新 Bot 的单聊开着设置栏").toHaveCount(1);
  const notice = page.getByTestId("bot-created-notice");
  await expect(notice, "建好的提示写出系统起的名字").toContainText(`建好了 ${created}`);

  const deleted = page.waitForResponse(
    (res) => res.url().includes("/api/bots/") && res.request().method() === "DELETE",
  );
  await notice.getByTestId("bot-created-undo").click();
  expect((await deleted).status(), "撤销走删 Bot 的接口").toBe(204);
  await expect(notice, "撤销完提示收起").toHaveCount(0);
  await expect(page.getByTestId("bot-panel"), "删掉的 Bot 的设置栏跟着收起").toHaveCount(0);
  await expect(page, "撤销后回团队页").toHaveURL(/\/team$/);
  await expect(items, "团队里不再有它").toHaveCount(3);
  await expect(teamCard(page, created)).toHaveCount(0);
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
