import { expect, test, SHOT, UsageResponse, login, openSettings } from "./fixtures";

test("用量页按 Bot 分列本月花费，没设预算，并列出五条最近任务", async ({ page }) => {
  await login(page);
  await openSettings(page);
  const loaded = page.waitForResponse((response) => response.url().endsWith("/api/usage") && response.ok());
  await page.getByTestId("settings-nav-usage").click();
  await loaded;

  const usage = page.getByTestId("usage-page");
  await expect(usage.getByTestId("usage-total")).toHaveText("¥38.2");
  await expect(usage.getByTestId("usage-bots").locator(".usage-bot")).toHaveCount(4);
  for (const name of ["小销", "小采", "小服", "主助理"]) {
    await expect(usage.getByTestId("usage-bots")).toContainText(name);
  }
  await expect(usage.getByTestId("usage-recent").locator(".usage-run")).toHaveCount(5);
  await expect(usage).toContainText("Globex X3 × 200 报价");
  await expect(usage.getByTestId("usage-budget")).toHaveText("没设预算");
  await expect(usage, "旧的「后续」占位都去掉了").not.toContainText("后续");
  await page.screenshot({ path: `${SHOT}/11a.png` });
});

test("打开应用默认进入今天", async ({ page }) => {
  await login(page);
  await expect(page.getByTestId("today-page")).toBeVisible();
  await expect(page.getByTestId("today-nav")).toHaveAttribute("aria-current", "page");
  await page.screenshot({ path: `${SHOT}/11b.png` });
});

test("账户菜单显示接口合计而非写死的金额，点开用量页", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/usage", async (route) => {
    calls += 1;
    const response = await route.fetch();
    const usage = UsageResponse.parse(await response.json());
    await route.fulfill({ response, json: { ...usage, total: 47.3 } });
  });
  await login(page);
  await page.getByTestId("account-button").click();
  await expect(page.getByTestId("account-usage-total")).toHaveText("¥47.3");
  expect(calls, "进入应用时拉一次用量").toBe(1);
  await page.getByTestId("open-usage").click();
  await expect(page.getByTestId("usage-page")).toBeVisible();
  await expect(page.getByTestId("usage-total")).toHaveText("¥47.3");
  await expect.poll(() => calls, "打开用量页再拉一次").toBe(2);
  await page.screenshot({ path: `${SHOT}/11c.png` });
});

test("窄屏用量页仍能看到合计和任务，不横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);
  await openSettings(page);
  await page.getByTestId("settings-nav-usage").click();
  const usage = page.getByTestId("usage-page");
  await expect(usage.getByTestId("usage-total")).toHaveText("¥38.2");
  await expect(usage.getByTestId("usage-recent").locator(".usage-run")).toHaveCount(5);
  expect(await usage.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: `${SHOT}/11d.png` });
});
