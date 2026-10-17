import { AccountListResponse } from "@baize/shared";
import { expect, login, openSettings, test, type APIRequestContext, type Page } from "./fixtures";

const EXPIRED_ID = "acc_today_xhs";

const reportLogin = async (request: APIRequestContext, accountId: string, data: object) => {
  const response = await request.post(`/api/test/accounts/${accountId}/login-state`, { data });
  expect(response.status(), "代替电脑代理报登录结果").toBe(204);
};

const setComputer = async (request: APIRequestContext, computerId: string, status: string) => {
  const response = await request.post(`/api/test/computers/${computerId}/status`, { data: { status } });
  expect(response.status()).toBe(204);
};

const loginCard = (page: Page, accountId: string) =>
  page.getByTestId("today-pending").locator(`[data-testid=today-row][data-kind=login][data-account-id=${accountId}]`);

const openAccounts = async (page: Page) => {
  await openSettings(page);
  await page.getByTestId("settings-nav-accounts").click();
  await expect(page.getByTestId("accounts-page")).toBeVisible();
};

const accountRow = (page: Page, text: string) =>
  page.getByTestId("accounts-page").getByTestId("account-row").filter({ hasText: text });

test("过期的号只剩批过的稿子等着，首页照样出能扫码的登录卡，扫码后卡片变成已登录", async ({ page, request }) => {
  await login(page);
  const approved = await page.request.post("/api/drafts/draft_today_review", { data: { decision: "approve" } });
  expect(approved.status(), "发到这个号的待批稿子先批掉，只剩排着要发的").toBe(200);
  await page.reload();

  const card = loginCard(page, EXPIRED_ID);
  await expect(card, "过期号那行换成登录卡，不再是只能点去账号页的一行").toHaveAttribute("data-state", "needed");
  await expect(card.getByTestId("login-card-title")).toHaveText("小红书 · 要务机械星球 登录过期了");
  await expect(
    page.locator("[data-testid=today-row][data-kind=account]").filter({ hasText: "要务机械星球" }),
  ).toHaveCount(0);

  const before = Number(await page.getByTestId("today-pending").getByTestId("today-section-count").textContent());
  expect(before, "过期号那一件计在等你确认里").toBeGreaterThan(0);
  await card.getByTestId("login-open").click();
  await expect(card).toHaveAttribute("data-state", "opening");
  await expect(card.getByTestId("login-open")).toHaveText("等你登录…");

  await reportLogin(request, EXPIRED_ID, { login: "valid", handle: "要务机械星球" });
  await expect(card, "服务端那行随登上没了，卡片留下当回执").toHaveAttribute("data-state", "signed_in");
  await expect(card.getByTestId("login-card-title")).toHaveText("要务机械星球 已登录 · 本机");
  await expect(card.getByTestId("login-open")).toHaveCount(0);
  const count = page.getByTestId("today-pending").getByTestId("today-section-count");
  if (before > 1) await expect(count, "已登录的卡是回执，不计进等你确认").toHaveText(String(before - 1));
  else await expect(count, "已登录的卡是回执，不计进等你确认").toHaveCount(0);
  await expect(card, "服务端那行重拉后没了，回执还在").toHaveAttribute("data-state", "signed_in");
});

test("账号页上过期的小红书号行上就能打开登录窗口，登上后按钮收起；OAuth 的号没有这个按钮", async ({
  page,
  request,
}) => {
  await login(page);
  await openAccounts(page);
  const xhs = accountRow(page, "要务机械星球");
  await expect(xhs).toHaveAttribute("data-login", "expired");
  await expect(accountRow(page, "白泽工厂日记").getByTestId("login-open"), "已登录的号不出按钮").toHaveCount(0);
  await expect(
    page.getByTestId("accounts-page").locator("[data-testid=account-row]").getByTestId("login-open"),
    "只有过期的小红书号有登录按钮",
  ).toHaveCount(1);

  await xhs.getByTestId("login-open").click();
  await expect(xhs.getByTestId("login-open")).toHaveText("等你登录…");
  await expect(xhs.getByTestId("login-open")).toBeDisabled();
  await expect(xhs.getByTestId("login-card-note")).toHaveText("登录窗口已在本机打开，登上后这里会变成已登录。");

  await reportLogin(request, EXPIRED_ID, { login: "valid", handle: "要务机械星球" });
  await expect(xhs).toHaveAttribute("data-login", "valid");
  await expect(xhs.getByTestId("account-login")).toHaveText("已登录");
  await expect(xhs.getByTestId("login-open")).toHaveCount(0);
});

test("账号页行上点登录时本机不在线，行上写不在线，还能再点", async ({ page, request }) => {
  await login(page);
  await openAccounts(page);
  await setComputer(request, "cmp_local", "sleeping");
  const xhs = accountRow(page, "要务机械星球");
  await xhs.getByTestId("login-open").click();
  await expect(xhs.getByTestId("login-card-note")).toHaveText("本机不在线，打开电脑上的白泽后再点登录。");
  await expect(xhs.getByTestId("login-card-note")).toHaveAttribute("role", "alert");
  await expect(xhs.getByTestId("login-open")).toBeEnabled();
});

test("账号页主动接入小红书：选本机，在本机建一个号、打开登录窗口，扫码后多一行已登录", async ({ page, request }) => {
  await login(page);
  await openAccounts(page);
  const rows = page.getByTestId("accounts-page").getByTestId("account-row");
  const before = await rows.count();

  await page.locator("[data-testid=account-connect-browser][data-platform=xiaohongshu]").click();
  await page.locator("[data-testid=account-connect-computer][data-computer-id=cmp_local]").click();
  await expect(rows, "多出一行没登录的小红书号").toHaveCount(before + 1);
  const fresh = page.getByTestId("accounts-page").locator("[data-testid=account-row][data-login=none]");
  await expect(fresh).toContainText("小红书 · 未登录");
  await expect(fresh.getByTestId("account-where")).toContainText("在本机");
  await expect(fresh.getByTestId("login-open"), "建完就开了登录窗口，不用再点一次").toHaveText("等你登录…");

  const { accounts } = AccountListResponse.parse(await (await page.request.get("/api/accounts")).json());
  const created = accounts.find((item) => item.platform === "xiaohongshu" && item.login === "none");
  expect(created, "控制面那边建出了未登录的小红书号").toBeDefined();
  await reportLogin(request, created?.id ?? "", { login: "valid", handle: "白泽工厂日记二号" });
  const signedIn = accountRow(page, "白泽工厂日记二号");
  await expect(signedIn).toHaveAttribute("data-login", "valid");
  await expect(signedIn.getByTestId("account-tier")).toHaveText("发布要确认");
  await expect(signedIn.getByTestId("login-open")).toHaveCount(0);
});

test("过期卡原本排在多项待办之后，扫码登上后回执还在原位，不跳到最前", async ({ page, request }) => {
  await login(page);
  const created = await page.request.post("/api/accounts", {
    data: { platform: "xiaohongshu", computerId: "cmp_local" },
  });
  expect(created.status()).toBe(201);
  const { account } = (await created.json()) as { account: { id: string } };
  await reportLogin(request, account.id, { login: "valid", handle: "排在后面的号" });
  await reportLogin(request, account.id, { login: "expired" });
  await page.reload();

  const rows = page.getByTestId("today-pending").getByTestId("today-row");
  const card = loginCard(page, account.id);
  await expect(card).toHaveAttribute("data-state", "needed");
  const position = () => card.evaluate((el) => [...document.querySelectorAll("[data-testid=today-row]")].indexOf(el));
  const before = await position();
  expect(before, "这张过期卡排在几件待办后面").toBeGreaterThan(1);
  const total = await rows.count();

  await card.getByTestId("login-open").click();
  await reportLogin(request, account.id, { login: "valid", handle: "排在后面的号" });
  await expect(card).toHaveAttribute("data-state", "signed_in");
  await expect(
    page.getByTestId("today-pending").getByTestId("today-section-count"),
    "服务端那行没了，计数少一件",
  ).toHaveText(String(total - 1));
  await expect(rows, "回执顶替了原来那张卡，条数不变").toHaveCount(total);
  expect(await position(), "回执留在原来的位置").toBe(before);
  await expect(card).toHaveAttribute("data-state", "signed_in");
});
