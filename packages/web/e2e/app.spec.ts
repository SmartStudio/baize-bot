import { expect, test, type Page } from "@playwright/test";

const EMAIL = "chen@baize.dev";
const PASSWORD = "baize-dev";
const SHOT = "e2e/screenshots";

test.beforeEach(async ({ request }) => {
  expect((await request.post("/api/test/reset")).status(), "mock 状态倒回预置的三个 Bot").toBe(204);
});

const fillCredentials = async (page: Page, password: string) => {
  await page.goto("/");
  await page.getByTestId("workspace-input").fill("acme");
  await page.getByTestId("workspace-continue").click();
  await page.getByTestId("email-input").fill(EMAIL);
  await page.getByTestId("password-input").fill(password);
  await page.getByTestId("login-submit").click();
};

const login = async (page: Page) => {
  await fillCredentials(page, PASSWORD);
  await expect(page.getByTestId("main-window")).toBeVisible();
};

const openBot = async (page: Page, name: string) => {
  await page.locator(`[data-testid=bot-item][data-bot-name="${name}"]`).click();
  await expect(page.getByTestId("chat-title")).toHaveText(name);
};

const openSettings = async (page: Page) => {
  await page.getByTestId("account-button").click();
  await expect(page.getByTestId("account-menu")).toBeVisible();
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("settings-window")).toBeVisible();
};

test("密码不对时登录页留在原地并说明原因", async ({ page }) => {
  await fillCredentials(page, "wrong-password");
  await expect(page.getByTestId("login-error")).toHaveText("邮箱或密码不对");
  await expect(page.getByTestId("main-window")).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/login");
  await page.screenshot({ path: `${SHOT}/01.png` });
});

test("登录成功进主窗口，侧栏列出预置的三个 Bot", async ({ page }) => {
  await login(page);
  const names = page.locator("[data-testid=bot-item]");
  await expect(names).toHaveCount(3);
  for (const name of ["小服", "小销", "小采"]) {
    await expect(page.locator(`[data-testid=bot-item][data-bot-name="${name}"]`)).toHaveCount(1);
  }
  await page.screenshot({ path: `${SHOT}/02.png` });
});

test("小服的对话里 bot、tool_call、cost 三种消息各渲染成一张卡", async ({ page }) => {
  await login(page);
  await openBot(page, "小服");
  const list = page.getByTestId("message-list");
  await expect(list.getByTestId("message")).toHaveCount(6);
  await expect(list.locator("[data-kind=user]")).toHaveCount(1);
  await expect(list.locator("[data-kind=bot]")).toHaveCount(2);
  await expect(list.locator("[data-kind=system]")).toHaveCount(1);
  await expect(list.locator("[data-kind=tool_call]").getByTestId("tool-call-card")).toHaveCount(1);
  await expect(list.locator("[data-kind=cost]").getByTestId("cost-card")).toHaveCount(1);
  await expect(list.getByTestId("cost-card")).toContainText("约 ¥4.6");
  await expect(list.getByTestId("message").first()).toHaveAttribute("data-kind", "user");
  // 登录后本来就选中第一个 Bot，整窗截图会和 02 一模一样，所以 2a 只截对话这一栏。
  await page.getByTestId("chat").screenshot({ path: `${SHOT}/2a.png` });
});

test("发一条消息后它出现在列表里，Bot 的回复从 WebSocket 推回来", async ({ page }) => {
  await login(page);
  await openBot(page, "小销");
  const list = page.getByTestId("message-list");
  const botsBefore = await list.locator("[data-kind=bot]").count();
  const text = "把 Globex 的报价单再核一遍";

  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();

  await expect(list.locator("[data-kind=user]", { hasText: text })).toHaveCount(1);
  await expect(list.locator("[data-kind=bot]")).toHaveCount(botsBefore + 1);
  // Bot 回完会紧跟一张花费卡，侧栏摘要停在最后那条上。
  await expect(page.locator('[data-testid=bot-item][data-bot-name="小销"]')).toContainText("本次花费");
});

test("点加号建的新 Bot 进侧栏并直接进入它的对话", async ({ page }) => {
  await login(page);
  const items = page.locator("[data-testid=bot-item]");
  const before = await items.count();

  await page.getByTestId("new-bot").click();

  await expect(items).toHaveCount(before + 1);
  const created = await page.getByTestId("chat-title").textContent();
  expect(created).toMatch(/^新 Bot/);
  await expect(page.locator(`[data-testid=bot-item][data-bot-name="${created}"]`)).toHaveClass(/is-selected/);
  await expect(page.getByTestId("message-list").getByTestId("message")).toHaveCount(0);
  await expect(page.getByTestId("bot-name-input")).toHaveValue(String(created));
  await page.screenshot({ path: `${SHOT}/2b.png` });
});

test("改完描述刷新页面还在", async ({ page }) => {
  await login(page);
  await openBot(page, "小采");
  const description = "只比价和询价，下单和付钱先找我点头。";

  const saved = page.waitForResponse((res) => res.url().includes("/api/bots/") && res.request().method() === "PATCH");
  await page.getByTestId("bot-description-input").fill(description);
  await page.getByTestId("bot-name-input").click();
  await saved;

  await page.reload();
  await openBot(page, "小采");
  await expect(page.getByTestId("bot-description-input")).toHaveValue(description);
});

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
