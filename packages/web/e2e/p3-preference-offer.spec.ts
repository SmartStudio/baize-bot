import { expect, test, login, openBot, sendText, type Page } from "./fixtures";

const SERVER_PREFS = "/api/bots/bot_service/preferences";

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

// 第二个页面共用同一个账号和 mock 状态，只是服务端的推送到不了它：卡和偏好计数都只能靠 409 后的补读追上。
const secondPageMissingPushes = async (page: Page) => {
  await login(page);
  await openBot(page, "小服");
  await sendText(page, OFFER_TEXT);
  await expect(offerCard(page)).toHaveAttribute("data-status", "offered");

  const other = await page.context().newPage();
  let blocked = false;
  let dropped = 0;
  await other.routeWebSocket("**/api/ws", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((frame) => server.send(frame));
    server.onMessage((frame) => {
      if (blocked) dropped += 1;
      else socket.send(frame);
    });
  });
  await other.goto("/");
  await expect(other.getByTestId("main-window")).toBeVisible();
  await openBot(other, "小服");
  await expect(offerCard(other)).toHaveAttribute("data-status", "offered");
  await expect(other.getByTestId("bot-know-toggle")).toContainText("记住 5 条");
  blocked = true;
  return { other, dropped: () => dropped };
};

const conflictOn = async (other: Page, button: "save" | "dismiss") => {
  const rejection = other.waitForResponse(
    (response) => response.url().includes("/preference-offer") && response.request().method() === "POST",
  );
  await offerCard(other).getByTestId(`preference-offer-${button}`).click();
  expect((await rejection).status(), "卡在别处已经有结论，服务端回 409").toBe(409);
};

test("另一端点了记住而推送没到，这一端点不用得 409 后卡收敛到已记住，偏好数是服务端的", async ({ page }) => {
  const { other, dropped } = await secondPageMissingPushes(page);

  await offerCard(page).getByTestId("preference-offer-save").click();
  await expect(offerCard(page)).toHaveAttribute("data-status", "saved");
  await conflictOn(other, "dismiss");

  expect(dropped(), "另一端的推送确实被挡住了").toBeGreaterThan(0);
  await expect(offerCard(other)).toHaveAttribute("data-status", "saved");
  await expect(offerCard(other).getByTestId("preference-offer-decided")).toHaveText("已记住");
  await expect(offerCard(other).getByTestId("preference-offer-dismiss")).toHaveCount(0);
  await expect(offerCard(other).getByTestId("preference-offer-error"), "卡已收敛，不再留失败提示").toHaveCount(0);
  const served = (await (await other.request.get(SERVER_PREFS)).json()) as { items: unknown[] };
  expect(served.items).toHaveLength(6);
  await expect(other.getByTestId("bot-know-toggle")).toContainText("记住 6 条");
  await other.getByTestId("bot-know-toggle").click();
  await expect(other.getByTestId("bot-pref").filter({ hasText: OFFER_TEXT })).toHaveCount(1);
});

test("另一端点了不用而推送没到，这一端点记住得 409 后卡收敛到没记，偏好数不变", async ({ page }) => {
  const { other, dropped } = await secondPageMissingPushes(page);

  await offerCard(page).getByTestId("preference-offer-dismiss").click();
  await expect(offerCard(page)).toHaveAttribute("data-status", "dismissed");
  await conflictOn(other, "save");

  expect(dropped(), "另一端的推送确实被挡住了").toBeGreaterThan(0);
  await expect(offerCard(other)).toHaveAttribute("data-status", "dismissed");
  await expect(offerCard(other).getByTestId("preference-offer-decided")).toHaveText("没记");
  await expect(offerCard(other).getByTestId("preference-offer-save")).toHaveCount(0);
  const served = (await (await other.request.get(SERVER_PREFS)).json()) as { items: unknown[] };
  expect(served.items).toHaveLength(5);
  await expect(other.getByTestId("bot-know-toggle")).toContainText("记住 5 条");
});

test("点卡失败又补读不到结论时，卡上说一句，按钮可以再点", async ({ page }) => {
  await login(page);
  await openBot(page, "小服");
  await sendText(page, OFFER_TEXT);
  await expect(offerCard(page)).toHaveAttribute("data-status", "offered");

  await page.route("**/api/messages/*/preference-offer", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "服务暂时不可用" }) }),
  );
  await offerCard(page).getByTestId("preference-offer-save").click();

  await expect(offerCard(page).getByTestId("preference-offer-error")).toContainText("没记上");
  await expect(offerCard(page)).toHaveAttribute("data-status", "offered");
  await expect(offerCard(page).getByTestId("preference-offer-save")).toBeEnabled();
});
