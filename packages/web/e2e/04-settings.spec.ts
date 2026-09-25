import { expect, test, login, openBot, openSettings, openTools, toolCard, fillTool, SHOT } from "./fixtures";

test("设置通用页切到深色，html 的 data-theme 变 dark", async ({ page }) => {
  await login(page);
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", "dark");

  await openSettings(page);
  await page.getByTestId("theme-select").selectOption("dark");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByTestId("notify-switch")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("dnd-from")).toHaveValue("22:00");
  await page.screenshot({ path: `${SHOT}/07.png` });

  await page.getByTestId("settings-nav-computer").click();
  await expect(page.getByTestId("settings-later")).toHaveText("电脑 · 后续");

  // 刷新才分得清「存住了」和「服务端把 patch 原样回了一遍」。
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("工具页列出两个预置 MCP 连接和分配摘要", async ({ page }) => {
  await login(page);
  await openTools(page);

  await expect(page.getByTestId("tool-card")).toHaveCount(2);
  await expect(toolCard(page, "工单系统")).toContainText("tickets.acme.internal · MCP");
  await expect(toolCard(page, "工单系统").getByTestId("tool-assignment")).toHaveText("小服");
  await expect(toolCard(page, "邮箱")).toContainText("mail.acme.com · MCP");
  await expect(toolCard(page, "邮箱").getByTestId("tool-assignment")).toHaveText("全部 3 个 Bot");
  await page.screenshot({ path: `${SHOT}/09a.png` });
});

test("工具分配和操作审批写入 PATCH，刷新后保留", async ({ page }) => {
  await login(page);
  await openTools(page);
  const card = toolCard(page, "工单系统");
  await card.getByTestId("tool-edit-assignment").click();

  const sales = card.locator('[data-testid=tool-bot-checkbox][data-bot-name="小销"]');
  await sales.click();
  await expect(sales, "小销被勾入工单系统").toBeChecked();
  const lookup = card.locator('[data-testid=tool-operation-switch][data-operation-name="lookup_ticket"]');
  await lookup.click();
  await expect(lookup, "查询操作改为需要点头").toHaveAttribute("aria-checked", "true");

  await page.reload();
  await openTools(page);
  const saved = toolCard(page, "工单系统");
  await saved.getByTestId("tool-edit-assignment").click();
  await expect(saved.locator('[data-testid=tool-bot-checkbox][data-bot-name="小销"]')).toBeChecked();
  await expect(
    saved.locator('[data-testid=tool-operation-switch][data-operation-name="lookup_ticket"]'),
  ).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: `${SHOT}/09b.png` });
});

test("连接新工具后展开操作，同名和坏地址各显示接口原因", async ({ page }) => {
  await login(page);
  await openTools(page);
  await fillTool(page, "供应商门户", "https://vendor.acme.internal/mcp");
  const created = toolCard(page, "供应商门户");
  await expect(created).toBeVisible();
  await expect(created.getByTestId("tool-details"), "新连接成功后自动展开").toBeVisible();
  await expect(created.getByTestId("tool-operation-switch")).toHaveCount(2);
  await expect(created).toContainText("do_thing");
  await expect(created).toContainText("list_things");

  await fillTool(page, "供应商门户", "https://vendor.acme.internal/mcp");
  await expect(page.getByTestId("tool-create-error")).toHaveText("已有同名工具连接");
  await fillTool(page, "坏工具", "https://bad.acme.internal/mcp");
  await expect(page.getByTestId("tool-create-error")).toHaveText("连不上 MCP：ECONNREFUSED");
});

test("断开工具后卡片消失，刷新也不回来", async ({ page }) => {
  await login(page);
  await openTools(page);
  await fillTool(page, "供应商门户", "https://vendor.acme.internal/mcp");
  const created = toolCard(page, "供应商门户");
  await expect(created.getByTestId("tool-details")).toBeVisible();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("断开后所有 Bot 都用不了它");
    await dialog.accept();
  });
  await created.getByTestId("tool-disconnect").click();
  await expect(created).toHaveCount(0);

  await page.reload();
  await openTools(page);
  await expect(toolCard(page, "供应商门户")).toHaveCount(0);
});

test("Bot 设置显示可用工具，点击直达设置的工具页", async ({ page }) => {
  await login(page);
  await expect(page.getByTestId("bot-available-tools-summary")).toHaveText("工单系统 · 邮箱");
  await openBot(page, "小销");
  await expect(page.getByTestId("bot-available-tools-summary")).toHaveText("邮箱");
  await openBot(page, "小服");
  await page.screenshot({ path: `${SHOT}/07b.png` });
  await page.getByTestId("bot-available-tools").click();
  await expect(page.getByTestId("tools-page")).toBeVisible();
  await expect(page.getByTestId("settings-nav-tools")).toHaveClass(/is-selected/);
});

test("375px 工具页能看见连接与表单，没有横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);
  await openTools(page);
  await expect(page.getByTestId("tool-card")).toHaveCount(2);
  await expect(page.getByTestId("tool-create-form")).toBeVisible();
  expect(await page.getByTestId("tools-page").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );
  expect(await page.locator(".settings").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("退出登录回到登录页", async ({ page }) => {
  await login(page);
  await page.getByTestId("account-button").click();
  await page.getByTestId("logout").click();

  await expect(page.getByTestId("login")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/login");
  await expect(page.getByTestId("main-window")).toHaveCount(0);

  // 服务端会话真作废了才算退出，光清 cookie 的话刷新会把人放回主窗口。
  await page.reload();
  await expect(page.getByTestId("login")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/login");
});
