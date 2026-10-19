import { AccountListResponse } from "@baize/shared";
import { SHOT, expect, login, openSettings, test, type APIRequestContext, type Page } from "./fixtures";

// 账号页的 X 有两种连法：接口授权（OAuth）和电脑上的浏览器登录。后者和小红书同一套：在挑中的电脑上建占位号、开登录画面。
// 号是哪种连法看 account.via，不看平台：预置的 acc_today_x 是接口授权连上的，过期了也不在行上开登录窗口。

const screenOn = async (request: APIRequestContext) => {
  expect((await request.post("/api/test/live/screen", { data: { on: true } })).status(), "打开 mock 的画面面").toBe(
    204,
  );
};

const reportLogin = async (request: APIRequestContext, accountId: string, data: object) => {
  const response = await request.post(`/api/test/accounts/${accountId}/login-state`, { data });
  expect(response.status(), "代替电脑代理报登录结果").toBe(204);
};

const openAccounts = async (page: Page) => {
  await openSettings(page);
  await page.getByTestId("settings-nav-accounts").click();
  await expect(page.getByTestId("accounts-page")).toBeVisible();
};

const browserEntry = (page: Page) => page.locator("[data-testid=account-connect-browser][data-platform=x]");
const panel = (page: Page) => page.getByTestId("live-panel");

const createdOn = (page: Page) =>
  page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/accounts");

test("X 卡片点「用电脑上的浏览器登录」挑本机：建出 X 的浏览器账号、开 x.com 的登录画面，账号卡写连接方式，登上后不能挂可直接发布", async ({
  page,
  request,
}) => {
  await screenOn(request);
  await login(page);
  await openAccounts(page);

  await expect(page.locator("[data-testid=account-connect-link][data-platform=x]"), "接口授权的入口还在").toHaveText(
    "接入 X",
  );
  await expect(browserEntry(page)).toHaveText("用电脑上的浏览器登录 X");
  await expect(page.locator("[data-testid=account-connect-risk][data-platform=x]")).toHaveText(
    "浏览器发帖可能被 X 识别为自动化操作",
  );

  const seeded = page.getByTestId("accounts-page").getByTestId("account-row").filter({ hasText: "X · @baize_x3" });
  await expect(seeded.getByTestId("account-via"), "预置的 X 号是接口授权连上的").toHaveText("连接方式：接口授权");
  await expect(seeded.getByTestId("login-open"), "接口授权的号过期了也不在行上开登录窗口").toHaveCount(0);

  await browserEntry(page).click();
  await expect(page.getByTestId("account-connect-menu")).toHaveAccessibleName("在哪台电脑上登录X");
  const posted = createdOn(page);
  await page.locator("[data-testid=account-connect-computer][data-computer-id=cmp_local]").click();
  expect((await posted).postDataJSON(), "建的是 X，挂在本机").toEqual({ platform: "x", computerId: "cmp_local" });

  await expect(panel(page), "建完就开登录画面").toHaveAttribute("data-purpose", "login");
  await expect(panel(page).getByTestId("live-origin")).toHaveText("https://x.com");
  await page.screenshot({ path: `${SHOT}/p3-x-browser-login.png` });

  const { accounts } = AccountListResponse.parse(await (await page.request.get("/api/accounts")).json());
  const created = accounts.filter((account) => account.platform === "x" && account.via === "computer");
  expect(
    created.map((account) => [account.login, account.computerId]),
    "控制面那边多了一个未登录的 X 浏览器号",
  ).toEqual([["none", "cmp_local"]]);
  const accountId = created[0]?.id ?? "";

  const fresh = page.getByTestId("accounts-page").locator("[data-testid=account-row][data-login=none]");
  await expect(fresh).toContainText("X · 未登录");
  await expect(fresh.getByTestId("account-via")).toHaveText("连接方式：电脑上的浏览器登录");
  await expect(fresh.getByTestId("account-via")).toHaveAttribute("data-via", "computer");
  await expect(fresh.getByTestId("login-open"), "建完就开了登录窗口").toHaveText("等你登录…");

  await reportLogin(request, accountId, { login: "valid", handle: "@baize_browser" });
  const signedIn = page.getByTestId("accounts-page").getByTestId("account-row").filter({ hasText: "@baize_browser" });
  await expect(signedIn).toHaveAttribute("data-login", "valid");
  await expect(signedIn.getByTestId("account-via")).toHaveText("连接方式：电脑上的浏览器登录");
  await signedIn.getByTestId("account-tier-toggle").click();
  const direct = signedIn.locator("[data-testid=account-tier-option][data-tier=direct_publish]");
  await expect(direct.locator("input"), "电脑浏览器登录的号不开直接发布").toBeDisabled();
  await expect(direct.getByTestId("account-tier-reason")).toHaveText("电脑浏览器发帖每条先给你看，不开直接发布");
  await page.getByTestId("accounts-page").screenshot({ path: `${SHOT}/p3-x-browser-account.png` });
});

test("只剩一台远程电脑：「用电脑上的浏览器登录 X」不出选择，直接在远程电脑上建号；再点一次不多建，还是那一个占位", async ({
  page,
  request,
}) => {
  expect((await request.delete("/api/test/computers/cmp_local")).status(), "mock 摘掉本机").toBe(204);
  await login(page);
  await openAccounts(page);

  const posted = createdOn(page);
  await browserEntry(page).click();
  expect((await posted).postDataJSON()).toEqual({ platform: "x", computerId: "cmp_remote" });
  const fresh = page.getByTestId("accounts-page").locator("[data-testid=account-row][data-login=none]");
  await expect(fresh).toContainText("X · 未登录");
  await expect(fresh.getByTestId("account-where")).toContainText("在远程电脑");

  const again = await page.request.post("/api/accounts", { data: { platform: "x", computerId: "cmp_remote" } });
  expect(again.status(), "已有未登录占位就回那一行").toBe(200);
  const { accounts } = AccountListResponse.parse(await (await page.request.get("/api/accounts")).json());
  expect(accounts.filter((account) => account.platform === "x" && account.via === "computer")).toHaveLength(1);
  expect(
    accounts.filter((account) => account.platform === "x" && account.via === "api").map((account) => account.handle),
    "接口授权的 X 号不受影响",
  ).toEqual(["@baize_x3"]);
});
