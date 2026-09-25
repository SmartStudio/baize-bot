import { expect, test, OvernightResponse, SHOT, UsageResponse, login, openSettings } from "./fixtures";

test("用量与账单按 Bot 分列本周花费，并列出五条最近任务", async ({ page }) => {
  await login(page);
  await page.getByTestId("overnight-card").getByRole("button", { name: "知道了" }).click();
  await openSettings(page);
  const loaded = page.waitForResponse((response) => response.url().endsWith("/api/usage") && response.ok());
  await page.getByTestId("settings-nav-usage").click();
  await loaded;

  const usage = page.getByTestId("usage-page");
  await expect(usage.getByTestId("usage-total")).toHaveText("¥38.2");
  await expect(usage.getByTestId("usage-bots").locator(".usage-bot")).toHaveCount(3);
  for (const name of ["小销", "小采", "小服"]) {
    await expect(usage.getByTestId("usage-bots")).toContainText(name);
  }
  await expect(usage.getByTestId("usage-recent").locator(".usage-run")).toHaveCount(5);
  await expect(usage).toContainText("Globex X3 × 200 报价");
  await expect(usage).toContainText("周预算 · 后续");
  await expect(usage).toContainText("快用完时提醒 · 后续");
  await expect(usage).toContainText("负责人加额 · 后续");
  await expect(usage).toContainText("默认档位 · 后续");
  await expect(usage).toContainText("导出本月明细 · 后续");
  await expect(usage.getByRole("button")).toHaveCount(0);
  await page.screenshot({ path: `${SHOT}/11a.png` });
});

test("昨夜进展卡点小采，选中对应群并关卡", async ({ page }) => {
  await login(page);
  const card = page.getByTestId("overnight-card");
  await expect(card).toContainText("你下线的时候，活没停");
  await expect(card.getByTestId("overnight-row")).toHaveCount(3);
  await expect(card.getByTestId("overnight-row").filter({ hasText: "小采" })).toContainText("完成");
  await expect(card.getByTestId("overnight-row").filter({ hasText: "小服" })).toContainText("等你");
  await expect(card.getByTestId("overnight-row").filter({ hasText: "小销" })).toContainText("在干活");
  await page.screenshot({ path: `${SHOT}/11b.png` });
  await card.getByTestId("overnight-row").filter({ hasText: "小采" }).click();
  await expect(page.getByTestId("chat-title")).toHaveText("小采");
  await expect(card).toHaveCount(0);
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

test("昨夜进展只在进入应用时拉取，关卡后本会话不再弹", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/overnight", async (route) => {
    calls += 1;
    await route.continue();
  });
  await login(page);
  expect(calls).toBe(1);
  await page.getByTestId("overnight-card").getByRole("button", { name: "知道了" }).click();
  await openSettings(page);
  await page.getByTestId("settings-close").click();
  await expect(page.getByTestId("overnight-card")).toHaveCount(0);
  expect(calls, "关卡和开关设置不重新拉取").toBe(1);
  await page.reload();
  await expect(page.getByTestId("main-window")).toBeVisible();
  await expect.poll(() => calls, "保持登录的冷启动重新进入应用").toBe(2);
});

test("昨夜没有进展时不弹卡", async ({ page }) => {
  await page.route("**/api/overnight", async (route) => {
    const response = await route.fetch();
    const overnight = OvernightResponse.parse(await response.json());
    await route.fulfill({ response, json: { ...overnight, items: [] } });
  });
  await login(page);
  await expect(page.getByTestId("overnight-card")).toHaveCount(0);
});

test("窄屏用量页仍能看到合计和任务，不横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);
  await page.getByTestId("overnight-card").getByRole("button", { name: "知道了" }).click();
  await openSettings(page);
  await page.getByTestId("settings-nav-usage").click();
  const usage = page.getByTestId("usage-page");
  await expect(usage.getByTestId("usage-total")).toHaveText("¥38.2");
  await expect(usage.getByTestId("usage-recent").locator(".usage-run")).toHaveCount(5);
  expect(await usage.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: `${SHOT}/11d.png` });
});
