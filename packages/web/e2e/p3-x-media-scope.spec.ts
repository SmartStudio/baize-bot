import { expect, login, openBot, openSettings, test, type APIRequestContext, type Page } from "./fixtures";

const MISSING = "X 账号缺发图权限，重新连接一次就好";

const seedMissingScope = async (request: APIRequestContext) => {
  const response = await request.post("/api/test/accounts/missing-scope");
  expect(response.status(), "预置一个缺 media.write 的 X 号和因此没发出去的带图草稿").toBe(200);
};

const accountRow = async (page: Page) => {
  await openSettings(page);
  await page.getByTestId("settings-nav-accounts").click();
  return page.getByTestId("accounts-page").getByTestId("account-row").filter({ hasText: "X · mock_x" });
};

const scopeDraft = (page: Page) =>
  page.getByTestId("message-list").getByTestId("draft-card").filter({ hasText: "X3 新看板三张图" });

test("X 号缺发图权限：账号页写缺权限、给重新连接，登录状态仍是已登录", async ({ page, request }) => {
  await seedMissingScope(request);
  await login(page);
  const row = await accountRow(page);

  await expect(row.getByTestId("account-login"), "缺权限不是登录过期").toHaveText("已登录");
  await expect(row.getByTestId("scope-reconnect-text")).toHaveText(MISSING);
  await expect(row.getByTestId("scope-reconnect-link")).toHaveText("重新连接");
  await expect(row.getByTestId("scope-reconnect-link"), "走接入 X 的同一个授权入口").toHaveAttribute(
    "href",
    "/api/oauth/x/start",
  );
  await expect(page.getByTestId("accounts-page").getByTestId("scope-reconnect"), "授权齐全的号不出这一行").toHaveCount(
    1,
  );
});

test("缺发图权限没发出去的草稿卡写原因、给重新连接，重连之后按钮收起只留原因", async ({ page, request }) => {
  await seedMissingScope(request);
  await login(page);
  await openBot(page, "小采");
  const card = scopeDraft(page);

  await expect(card).toHaveAttribute("data-status", "failed");
  await expect(card.getByTestId("scope-reconnect-text")).toHaveText(MISSING);
  await expect(card.getByTestId("scope-reconnect-link")).toHaveAttribute("href", "/api/oauth/x/start");

  await card.getByTestId("scope-reconnect-link").click();
  await page.waitForURL((url) => url.searchParams.get("oauth") === "x");
  await openBot(page, "小采");
  await expect(scopeDraft(page).getByTestId("scope-reconnect"), "账号补上权限之后卡上不再给按钮").toHaveCount(0);
  await expect(scopeDraft(page).getByTestId("draft-failure")).toHaveText(
    "账号缺发图权限，没发出去，重新连接后让 Bot 再起一稿",
  );

  const row = await accountRow(page);
  await expect(row.getByTestId("scope-reconnect"), "重连过的号账号页也不再提缺权限").toHaveCount(0);
});
