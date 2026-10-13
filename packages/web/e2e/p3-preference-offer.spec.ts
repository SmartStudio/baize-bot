import { expect, test, login, openBot, sendText, type Page } from "./fixtures";

const OFFER_TEXT = "以后报价单先写总价，再写明细";

const offerCard = (page: Page) => page.getByTestId("preference-offer");

const openKnow = async (page: Page) => {
  const toggle = page.getByTestId("bot-know-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
};

test("单聊里教一句先出确认卡，点之前偏好页没有这句", async ({ page }) => {
  await login(page);
  await openBot(page, "小服");
  await sendText(page, OFFER_TEXT);

  await expect(offerCard(page)).toHaveAttribute("data-status", "offered");
  await expect(page.getByTestId("preference-offer-text")).toHaveText(OFFER_TEXT);
  await expect(page.getByTestId("preference-offer-save")).toHaveText("记住");
  await expect(page.getByTestId("preference-offer-dismiss")).toHaveText("不用");
  await expect(page.getByTestId("preference-offer-private"), "默认不是私人偏好").toHaveCount(0);

  await expect(page.getByTestId("bot-know-toggle")).toContainText("记住 5 条");
  await openKnow(page);
  await expect(page.getByTestId("bot-pref").filter({ hasText: OFFER_TEXT })).toHaveCount(0);
});

test("点记住后卡变已记住，偏好页多出这一句，刷新后仍在", async ({ page }) => {
  await login(page);
  await openBot(page, "小服");
  await sendText(page, OFFER_TEXT);
  await offerCard(page).getByTestId("preference-offer-save").click();

  await expect(offerCard(page)).toHaveAttribute("data-status", "saved");
  await expect(offerCard(page).getByTestId("preference-offer-decided")).toHaveText("已记住");
  await expect(offerCard(page).getByTestId("preference-offer-save")).toHaveCount(0);
  await expect(offerCard(page).getByTestId("preference-offer-dismiss")).toHaveCount(0);

  await expect(page.getByTestId("bot-know-toggle")).toContainText("记住 6 条");
  await openKnow(page);
  await expect(page.getByTestId("bot-pref").filter({ hasText: OFFER_TEXT })).toHaveCount(1);

  await page.reload();
  await openBot(page, "小服");
  await expect(offerCard(page), "结论随消息正文存着，刷新后卡还是已记住").toHaveAttribute("data-status", "saved");
  await expect(page.getByTestId("bot-know-toggle")).toContainText("记住 6 条");
});

test("点不用后卡关上，偏好页没有这句", async ({ page }) => {
  await login(page);
  await openBot(page, "小服");
  await sendText(page, OFFER_TEXT);
  await offerCard(page).getByTestId("preference-offer-dismiss").click();

  await expect(offerCard(page)).toHaveAttribute("data-status", "dismissed");
  await expect(offerCard(page).getByTestId("preference-offer-decided")).toHaveText("没记");
  await expect(offerCard(page).getByTestId("preference-offer-save")).toHaveCount(0);
  await expect(offerCard(page).getByTestId("preference-offer-dismiss")).toHaveCount(0);

  await expect(page.getByTestId("bot-know-toggle")).toContainText("记住 5 条");
  await openKnow(page);
  await expect(page.getByTestId("bot-pref").filter({ hasText: OFFER_TEXT })).toHaveCount(0);
});

test("私人偏好的卡上多一句分享时不带这条", async ({ page }) => {
  await login(page);
  await openBot(page, "小服");
  const posted = await page.request.post("/api/test/preference-offer", {
    data: { groupId: "grp_service", botId: "bot_service", text: "Lisa 的单子先给我看", private: true },
  });
  expect(posted.status()).toBe(204);

  await expect(offerCard(page)).toHaveAttribute("data-status", "offered");
  await expect(page.getByTestId("preference-offer-private")).toHaveText("分享 Bot 时默认不带这条");

  await offerCard(page).getByTestId("preference-offer-save").click();
  await expect(offerCard(page)).toHaveAttribute("data-status", "saved");
  await expect(page.getByTestId("preference-offer-private"), "已决后这句仍在卡上").toHaveCount(1);
  await openKnow(page);
  await expect(page.getByTestId("bot-pref").filter({ hasText: "Lisa 的单子先给我看" })).toHaveCount(1);
});
