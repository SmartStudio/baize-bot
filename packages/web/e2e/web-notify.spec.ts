import { expect, login, openBot, openSettings, stubNotifications, test, type Page } from "./fixtures";

const notify = async (page: Page, kind: "confirm" | "result" | "stuck" | "failed", text: string) => {
  const posted = await page.request.post("/api/test/notify", {
    data: { kind, text, groupId: "grp_sales", at: new Date().toISOString() },
  });
  expect(posted.status()).toBe(204);
};

const sent = async (page: Page) => (await page.evaluate(() => window.__notifications?.sent)) ?? [];

// 切到别的标签页或别的应用：页面藏起来、窗口没了焦点。
const leavePage = (page: Page) =>
  page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    Object.defineProperty(document, "hasFocus", { value: () => false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });

const returnToPage = (page: Page) =>
  page.evaluate(() => {
    Reflect.deleteProperty(document, "visibilityState");
    Reflect.deleteProperty(document, "hasFocus");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });

const loginWithPush = async (page: Page) => {
  const connected = page.waitForEvent("websocket");
  await login(page);
  await connected;
};

test("人不在页面上时到的通知记进标题，回到页面就清掉", async ({ page }) => {
  await stubNotifications(page);
  await loginWithPush(page);
  await expect(page, "没有未读时标题不带数").toHaveTitle("白泽 Bot");

  await notify(page, "result", "看着页面时到的");
  await expect.poll(() => sent(page), { message: "看着页面时系统通知照弹" }).toHaveLength(1);
  await expect(page, "人就在页面上，不算未读").toHaveTitle("白泽 Bot");

  await leavePage(page);
  await notify(page, "confirm", "把报价单发给 Lisa");
  await notify(page, "stuck", "小红书登录过期");
  await expect.poll(() => sent(page)).toHaveLength(3);
  await expect(page, "离开页面后到的两条都算未读").toHaveTitle("(2) 白泽 Bot");

  await returnToPage(page);
  await expect(page, "回到页面就算看过").toHaveTitle("白泽 Bot");
});

const toggleNotify = async (page: Page, on: boolean) => {
  await openSettings(page);
  await page.getByTestId("notify-switch").click();
  await expect(page.getByTestId("notify-switch")).toHaveAttribute("aria-checked", String(on));
  await page.getByTestId("settings-close").click();
};

test("通知开关关着时，离开页面到的通知既不弹也不记数", async ({ page }) => {
  await stubNotifications(page);
  await loginWithPush(page);
  await toggleNotify(page, false);

  await leavePage(page);
  await notify(page, "confirm", "开关关着时到的");
  await notify(page, "result", "开关关着时又到一条");
  await toggleNotify(page, true);
  await notify(page, "result", "开关打开后到的");

  await expect
    .poll(() => sent(page), { message: "推送按顺序处理，最后这条弹了，前两条已经处理完" })
    .toEqual(["做完了 · 开关打开后到的"]);
  await expect(page, "只数开关打开后那一条").toHaveTitle("(1) 白泽 Bot");
});

test("点「等你确认」类通知：回到「今天」页滚到等你确认，通知收起，标题的数清掉", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 420 });
  await stubNotifications(page);
  await loginWithPush(page);
  await openBot(page, "小销");
  await expect(page).toHaveURL(/\/g\//);

  await leavePage(page);
  await notify(page, "confirm", "把报价单发给 Lisa");
  await expect.poll(() => sent(page)).toHaveLength(1);
  await expect(page).toHaveTitle("(1) 白泽 Bot");

  await page.evaluate(() => window.__notifications?.click(0));

  await expect(page, "点通知打开的是「今天」页").toHaveURL(/\/$/);
  await expect(page.getByTestId("today-pending"), "滚到等你确认那一节").toBeInViewport();
  expect(await page.evaluate(() => window.__notifications?.closed), "点过的通知收起来").toBe(1);
  await expect(page, "点了通知就是看过了").toHaveTitle("白泽 Bot");
});

test("点「做完了」类通知：滚到刚做完那一节", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 420 });
  await stubNotifications(page);
  await loginWithPush(page);
  await expect(page.getByTestId("today-page")).toBeVisible();
  await expect(page.getByTestId("today-done"), "窗口矮，刚做完一开始在视口外").not.toBeInViewport();

  await notify(page, "result", "周报已经完成");
  await expect.poll(() => sent(page)).toHaveLength(1);
  await page.evaluate(() => window.__notifications?.click(0));

  await expect(page.getByTestId("today-done")).toBeInViewport();
  expect(await page.evaluate(() => window.__notifications?.closed)).toBe(1);
});

test("设置里还没问过授权：点「允许通知」请求一次，允许后显示已开启", async ({ page }) => {
  await stubNotifications(page, { permission: "default", answer: "granted" });
  await loginWithPush(page);
  await openSettings(page);
  const row = page.getByTestId("notify-permission");
  await expect(row).toHaveAttribute("data-state", "default");
  await expect(row).toContainText("浏览器还没允许白泽发通知");
  expect(await page.evaluate(() => window.__notifications?.asked), "打开设置不会自己弹权限请求").toBe(0);

  await row.getByTestId("notify-permission-request").click();

  await expect(row).toHaveAttribute("data-state", "granted");
  await expect(row).toContainText("已开启");
  await expect(row.getByTestId("notify-permission-request"), "已允许就不再给按钮").toHaveCount(0);
  expect(await page.evaluate(() => window.__notifications?.asked)).toBe(1);
});

test("设置里请求授权被拒：说明被拒了、要去浏览器设置里打开", async ({ page }) => {
  await stubNotifications(page, { permission: "default", answer: "denied" });
  await loginWithPush(page);
  await openSettings(page);
  const row = page.getByTestId("notify-permission");

  await row.getByTestId("notify-permission-request").click();

  await expect(row).toHaveAttribute("data-state", "denied");
  await expect(row).toContainText("浏览器拒绝了白泽的通知");
  await expect(row).toContainText("网站设置");
  await expect(row.getByTestId("notify-permission-request"), "浏览器不会再弹第二次，按钮没用").toHaveCount(0);
});

test("早先已经拒绝过：打开设置直接说明被拒，不给按钮", async ({ page }) => {
  await stubNotifications(page, { permission: "denied" });
  await loginWithPush(page);
  await openSettings(page);
  const row = page.getByTestId("notify-permission");
  await expect(row).toHaveAttribute("data-state", "denied");
  await expect(row).toContainText("网站设置");
  await expect(row.getByTestId("notify-permission-request")).toHaveCount(0);
  expect(await page.evaluate(() => window.__notifications?.asked)).toBe(0);
});

test("早先已经允许：打开设置显示已开启", async ({ page }) => {
  await stubNotifications(page);
  await loginWithPush(page);
  await openSettings(page);
  const row = page.getByTestId("notify-permission");
  await expect(row).toHaveAttribute("data-state", "granted");
  await expect(row).toContainText("已开启");
});
