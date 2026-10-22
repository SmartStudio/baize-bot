import { AccountListResponse } from "@baize/shared";
import { SHOT, expect, login, openSettings, test, type APIRequestContext, type Page } from "./fixtures";

// 账号页「接入小红书」：号挂在哪台电脑上就在哪台登录。mock 预置本机和远程两台，用例按需摘掉一台或改状态。
// mock 的画面面默认关着，要看登录面板的用例先打开。

const screenOn = async (request: APIRequestContext) => {
  expect((await request.post("/api/test/live/screen", { data: { on: true } })).status(), "打开 mock 的画面面").toBe(
    204,
  );
};

const removeComputer = async (request: APIRequestContext, computerId: string) => {
  expect((await request.delete(`/api/test/computers/${computerId}`)).status(), `mock 摘掉 ${computerId}`).toBe(204);
};

const setComputer = async (request: APIRequestContext, computerId: string, status: string) => {
  const response = await request.post(`/api/test/computers/${computerId}/status`, { data: { status } });
  expect(response.status()).toBe(204);
};

const openAccounts = async (page: Page) => {
  await openSettings(page);
  await page.getByTestId("settings-nav-accounts").click();
  await expect(page.getByTestId("accounts-page")).toBeVisible();
};

const entry = (page: Page) => page.locator("[data-testid=account-connect-browser][data-platform=xiaohongshu]");
const menu = (page: Page) => page.getByTestId("account-connect-menu");
const option = (page: Page, computerId: string) =>
  page.locator(`[data-testid=account-connect-computer][data-computer-id=${computerId}]`);
const panel = (page: Page) => page.getByTestId("live-panel");

const createdOn = (page: Page) =>
  page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/accounts");

test("本机和远程都在线：点「接入小红书」先挑电脑，本机在前；挑远程，号建在远程电脑上，登录面板没有「到本机窗口操作」", async ({
  page,
  request,
}) => {
  await screenOn(request);
  await login(page);
  await openAccounts(page);

  await entry(page).click();
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).toHaveAccessibleName("在哪台电脑上登录小红书");
  const options = menu(page).getByTestId("account-connect-computer");
  await expect(options, "两台电脑两个选项，本机排第一").toHaveText(["本机", "远程电脑remote.baize.dev"]);
  await expect(options.first()).toHaveAttribute("data-computer-id", "cmp_local");
  await expect(menu(page).getByTestId("account-connect-blocked"), "两台都在线，没有灰掉的").toHaveCount(0);
  await page.screenshot({ path: `${SHOT}/p3-connect-picker.png` });

  const posted = createdOn(page);
  await option(page, "cmp_remote").click();
  expect((await posted).postDataJSON(), "号建在挑中的那台电脑上").toEqual({
    platform: "xiaohongshu",
    computerId: "cmp_remote",
  });
  await expect(menu(page), "挑完菜单收起").toHaveCount(0);

  await expect(panel(page), "建完就在远程电脑上开登录窗口").toHaveAttribute("data-purpose", "login");
  await expect(panel(page)).toHaveAttribute("data-state", "live");
  await expect(panel(page).getByTestId("live-reveal"), "远程那台的窗口用户够不着").toHaveCount(0);
  await page.screenshot({ path: `${SHOT}/p3-connect-remote-login.png` });

  const { accounts } = AccountListResponse.parse(await (await page.request.get("/api/accounts")).json());
  const created = accounts.filter((account) => account.platform === "xiaohongshu" && account.login === "none");
  expect(
    created.map((account) => account.computerId),
    "控制面那边只多了一个未登录的号，挂在远程电脑上",
  ).toEqual(["cmp_remote"]);
});

test("远程电脑休眠：它的选项照样列着，灰掉写「休眠中」，点了不建号；本机照常能挑", async ({ page, request }) => {
  await login(page);
  await setComputer(request, "cmp_remote", "sleeping");
  await openAccounts(page);

  await entry(page).click();
  const sleeping = option(page, "cmp_remote");
  await expect(sleeping).toHaveAttribute("aria-disabled", "true");
  await expect(sleeping.getByTestId("account-connect-blocked")).toHaveText("休眠中");
  await expect(option(page, "cmp_local")).not.toHaveAttribute("aria-disabled", "true");
  await expect(option(page, "cmp_local"), "焦点落在第一个能挑的选项上").toBeFocused();
  await page.screenshot({ path: `${SHOT}/p3-connect-picker-sleeping.png` });

  const rows = page.getByTestId("accounts-page").getByTestId("account-row");
  const before = await rows.count();
  // aria-disabled 的选项 Playwright 默认不点，force 照样把点击送上去，看它是不是真的不动。
  await sleeping.click({ force: true });
  await expect(menu(page), "灰掉的选项点了不收菜单").toBeVisible();
  await option(page, "cmp_local").click();
  await expect(rows, "最后只多了本机上的那一个号").toHaveCount(before + 1);
  const { accounts } = AccountListResponse.parse(await (await page.request.get("/api/accounts")).json());
  expect(
    accounts
      .filter((account) => account.platform === "xiaohongshu" && account.login === "none")
      .map((account) => account.computerId),
    "休眠那台上没建号",
  ).toEqual(["cmp_local"]);
});

test("菜单能只用键盘挑：方向键在选项间走、到头绕回，Esc 关上、焦点回到入口", async ({ page }) => {
  await login(page);
  await openAccounts(page);

  await entry(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(menu(page)).toBeVisible();
  await expect(entry(page)).toHaveAttribute("aria-expanded", "true");
  await expect(option(page, "cmp_local")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(option(page, "cmp_remote")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(option(page, "cmp_local"), "到底再往下绕回第一个").toBeFocused();
  await page.keyboard.press("End");
  await expect(option(page, "cmp_remote")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(entry(page)).toBeFocused();
  await expect(entry(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("settings-window"), "Esc 只关菜单，不关设置窗口").toBeVisible();

  await page.keyboard.press("Enter");
  await expect(option(page, "cmp_local")).toBeFocused();
  const posted = createdOn(page);
  await page.keyboard.press("Enter");
  expect((await posted).postDataJSON()).toEqual({ platform: "xiaohongshu", computerId: "cmp_local" });
});

test("只有一台远程电脑：点「接入小红书」不出选择，直接在它上面建号、开登录窗口", async ({ page, request }) => {
  await removeComputer(request, "cmp_local");
  await screenOn(request);
  await login(page);
  await openAccounts(page);

  await expect(entry(page)).toBeEnabled();
  await expect(entry(page), "只有一台，入口不带下拉").not.toHaveAttribute("aria-haspopup", "menu");
  await expect(page.getByTestId("account-connect-note"), "不要求有本机").toHaveCount(0);

  const posted = createdOn(page);
  await entry(page).click();
  expect((await posted).postDataJSON()).toEqual({ platform: "xiaohongshu", computerId: "cmp_remote" });
  await expect(menu(page)).toHaveCount(0);
  await expect(panel(page)).toHaveAttribute("data-purpose", "login");
  await expect(panel(page).getByTestId("live-reveal")).toHaveCount(0);
});

test("一台电脑都没有：入口灰掉，旁边让人先加一台电脑，不提本机；GitHub 和 X 照常能点", async ({ page, request }) => {
  await removeComputer(request, "cmp_local");
  await removeComputer(request, "cmp_remote");
  await login(page);
  await openAccounts(page);

  await expect(entry(page)).toBeDisabled();
  await expect(page.getByTestId("account-connect-note")).toHaveText("先在下面的「电脑」里加一台电脑，才能接入");
  await expect(page.getByTestId("account-connect-link"), "OAuth 平台不经电脑").toHaveText(["接入 GitHub", "接入 X"]);
  await page.getByTestId("account-connect").screenshot({ path: `${SHOT}/p3-connect-no-computer.png` });
});

test("设置里挑电脑的菜单开着时按 Esc 只收菜单，再按一下才关设置", async ({ page }) => {
  await login(page);
  await openAccounts(page);
  await entry(page).click();
  await expect(menu(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(menu(page), "第一下 Esc 收菜单").toHaveCount(0);
  await expect(page.getByTestId("settings-window"), "菜单吃掉了这一下，设置还开着").toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-window")).toHaveCount(0);
});
