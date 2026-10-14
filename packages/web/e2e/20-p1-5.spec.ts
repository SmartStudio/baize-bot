import { AccountListResponse } from "@baize/shared";
import { expect, login, openSettings, test, type APIRequestContext, type Page } from "./fixtures";

const LOGIN_ID = "acc_today_login";
const EXPIRED_ID = "acc_today_xhs";

const loginCard = (page: Page, accountId: string) =>
  page.getByTestId("today-pending").locator(`[data-testid=today-row][data-kind=login][data-account-id=${accountId}]`);

const seedLoginCard = async (request: APIRequestContext) => {
  const response = await request.post("/api/test/accounts/login-card");
  expect(response.status(), "本机一个没登录的小红书号，带一条等着发给它的稿子").toBe(200);
};

const reportLogin = async (request: APIRequestContext, accountId: string, data: object) => {
  const response = await request.post(`/api/test/accounts/${accountId}/login-state`, { data });
  expect(response.status(), "代替电脑代理报登录结果").toBe(204);
};

const setComputer = async (request: APIRequestContext, computerId: string, status: string) => {
  const response = await request.post(`/api/test/computers/${computerId}/status`, { data: { status } });
  expect(response.status()).toBe(204);
};

const openLoginCard = async (page: Page, request: APIRequestContext) => {
  await seedLoginCard(request);
  await login(page);
  const card = loginCard(page, LOGIN_ID);
  await expect(card).toHaveAttribute("data-state", "needed");
  return card;
};

test("账号页按电脑分组，小红书没有可直接发布", async ({ page, request }) => {
  await setComputer(request, "cmp_remote", "sleeping");
  await login(page);
  await openSettings(page);
  await page.getByTestId("settings-nav-accounts").click();

  const groups = page.getByTestId("accounts-page").getByTestId("account-group");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0).getByTestId("account-group-head"), "本机在前，组头写在线状态").toHaveText("本机在线");
  await expect(groups.nth(1).getByTestId("account-group-head")).toHaveText("远程电脑 remote.baize.dev休眠");
  await expect(groups.nth(0).getByTestId("account-row")).toHaveCount(2);
  await expect(groups.nth(1).getByTestId("account-row")).toHaveCount(2);

  const xhs = groups.nth(0).getByTestId("account-row").filter({ hasText: "要务机械星球" });
  await expect(xhs.getByTestId("account-where")).toHaveText("在本机 · 权限「可起草」");
  await expect(xhs.getByTestId("account-login"), "过期的号写登录状态").toContainText("登录已过期");
  await expect(xhs.getByTestId("account-tier-option"), "没点开只显示当前一档").toHaveCount(0);
  const diary = groups.nth(1).getByTestId("account-row").filter({ hasText: "白泽工厂日记" });
  await expect(diary.getByTestId("account-where")).toHaveText("在远程电脑 remote.baize.dev · 权限「发布要确认」");
  await expect(diary.getByTestId("account-login")).toHaveText("已登录");

  await xhs.getByTestId("account-tier-toggle").click();
  await expect(xhs.getByTestId("account-tier-option")).toHaveCount(4);
  await expect(xhs.locator("[data-testid=account-tier-option][data-tier=direct_publish] input")).toBeDisabled();
  await expect(xhs.getByTestId("account-tier-reason")).toHaveText("平台 2026-03-10 起封 AI 托管账号");
  await xhs.locator("[data-testid=account-tier-option][data-tier=confirm_publish] input").click();
  await expect(xhs.getByTestId("account-where"), "改档走 PATCH，说明行跟着换").toHaveText(
    "在本机 · 权限「发布要确认」",
  );
});

test("登录没成在账号页留一句，刷新后还在，登上之后消失", async ({ page, request }) => {
  const openAccounts = async () => {
    await openSettings(page);
    await page.getByTestId("settings-nav-accounts").click();
    return page.getByTestId("accounts-page").getByTestId("account-row").filter({ hasText: "要务机械星球" });
  };
  await login(page);
  let row = await openAccounts();
  await expect(row.getByTestId("account-login"), "账号页先拉到了").toContainText("登录已过期");
  await expect(row.getByTestId("account-login-failure"), "还没失败过，不写").toHaveCount(0);

  await reportLogin(request, EXPIRED_ID, { login: "failed", reason: "window_failed" });
  await expect(row.getByTestId("account-login-failure"), "不刷新，推送到了就写在登录状态下面").toHaveText(
    /^上次登录没成（今天 \d\d:\d\d）：登录窗口出错或被关掉了，账号状态没变，可以再点一次。$/,
  );
  await expect(row.getByTestId("account-login"), "登录状态不变").toContainText("登录已过期");

  await page.reload();
  await expect(page.getByTestId("main-window")).toBeVisible();
  row = await openAccounts();
  await expect(row.getByTestId("account-login-failure"), "刷新之后从账号列表里读回来，还在").toContainText(
    "上次登录没成",
  );

  await reportLogin(request, EXPIRED_ID, { login: "valid", handle: "要务机械星球" });
  await expect(row.getByTestId("account-login")).toHaveText("已登录");
  await expect(row.getByTestId("account-login-failure"), "登上之后不再写").toHaveCount(0);
});

test("登录卡从未登录到点打开登录窗口，推送登上后变成已登录", async ({ page, request }) => {
  const card = await openLoginCard(page, request);
  await expect(card.getByTestId("login-card-title")).toHaveText("小红书 还没登录");
  const next = card.locator("xpath=following-sibling::*[1]");
  await expect(next, "登录卡排在要用这个号的稿子前面").toContainText("车间主任的一天");

  await card.getByTestId("login-open").click();
  await expect(card).toHaveAttribute("data-state", "opening");
  await expect(card.getByTestId("login-open")).toHaveText("等你登录…");
  await expect(card.getByTestId("login-open")).toBeDisabled();

  await reportLogin(request, LOGIN_ID, { login: "valid", handle: "车间主任小王" });
  await expect(card).toHaveAttribute("data-state", "signed_in");
  await expect(card.getByTestId("login-card-title")).toHaveText("车间主任小王 已登录 · 本机");
  await expect(card.getByTestId("login-open")).toHaveCount(0);
});

test("电脑不在线时点登录，卡上写电脑不在线", async ({ page, request }) => {
  const card = await openLoginCard(page, request);
  await setComputer(request, "cmp_local", "sleeping");
  await card.getByTestId("login-open").click();
  await expect(card).toHaveAttribute("data-state", "offline");
  await expect(card.getByTestId("login-card-note")).toHaveText("本机不在线，打开电脑上的白泽后再点登录。");
  await expect(card.getByTestId("login-open"), "还能再点").toBeEnabled();
});

for (const [reason, copy] of [
  ["window_failed", "登录没成。登录窗口出错或被关掉了，账号状态没变，可以再点一次。"],
  ["timed_out", "登录没成。登录窗口开了很久还没登上，已经收起，账号状态没变，可以再点一次。"],
] as const) {
  test(`登录没成（${reason}）按原因写文案`, async ({ page, request }) => {
    const card = await openLoginCard(page, request);
    await card.getByTestId("login-open").click();
    await expect(card).toHaveAttribute("data-state", "opening");
    await reportLogin(request, LOGIN_ID, { login: "failed", reason });
    await expect(card).toHaveAttribute("data-state", "failed");
    await expect(card.getByTestId("login-card-note")).toHaveText(copy);
    await expect(card.getByTestId("login-open")).toHaveText("打开登录窗口");
  });
}

test("过期的号有稿子等着，登录卡写什么时候过期的", async ({ page }) => {
  await login(page);
  const { accounts } = AccountListResponse.parse(await (await page.request.get("/api/accounts")).json());
  const changedAt = new Date(accounts.find((item) => item.id === EXPIRED_ID)?.loginChangedAt ?? "");
  const clock = `${String(changedAt.getHours()).padStart(2, "0")}:${String(changedAt.getMinutes()).padStart(2, "0")}`;
  const card = loginCard(page, EXPIRED_ID);
  await expect(card.getByTestId("login-card-title")).toHaveText("小红书 · 要务机械星球 登录过期了");
  await expect(card.getByTestId("login-card-note"), "用 loginChangedAt 写过期时刻").toHaveText(
    new RegExp(`^\\S+ ${clock} 过期的 · 账号在本机，稿子先不发。$`),
  );
});
