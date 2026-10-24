import {
  login,
  openSeededBot,
  openSettings,
  openTeamGroup,
  SHOT,
  TEAM_TITLE,
  test,
  expect,
  type Page,
} from "./fixtures";

const CHAT_MIN_WIDTH = 480;

const boxOf = async (page: Page, testId: string) => {
  const box = await page.getByTestId(testId).boundingBox();
  if (box === null) throw new Error(`${testId} 没有渲染出来`);
  return box;
};

const expectChatUsable = async (page: Page, what: string) => {
  const chat = await boxOf(page, "chat");
  expect(chat.width, `${what}：对话区不窄于 ${CHAT_MIN_WIDTH}px`).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH);
};

const BESIDE_DRAWER = { x: 24, y: 400 };
const clickScrimBesideDrawer = (page: Page) => page.getByTestId("panel-scrim").click({ position: BESIDE_DRAWER });

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme === "light" ? "亮色" : "暗色"} 900 宽`, () => {
    test.use({ viewport: { width: 900, height: 900 }, colorScheme });

    test("任务详情是盖在对话区上的抽屉，对话区不被挤，点外面、按 Esc 都关得掉", async ({ page }) => {
      await login(page);
      await openTeamGroup(page, TEAM_TITLE);
      await expectChatUsable(page, "任务详情收着");

      await page.getByTestId("task-open").click();
      await expect(page.getByTestId("task-panel")).toBeVisible();
      await expect(page.getByTestId("panel-scrim")).toBeVisible();
      await expectChatUsable(page, "任务详情开着");
      const panel = await boxOf(page, "task-panel");
      expect(panel.x + panel.width, "抽屉贴着窗口右边").toBe(900);
      await page.screenshot({ path: `${SHOT}/panel-drawer-900-task-${colorScheme}.png` });

      await clickScrimBesideDrawer(page);
      await expect(page.getByTestId("task-panel"), "点抽屉外面收起").toHaveCount(0);
      await expect(page.getByTestId("panel-scrim")).toHaveCount(0);
      await page.screenshot({ path: `${SHOT}/panel-drawer-900-closed-${colorScheme}.png` });

      await page.getByTestId("task-open").click();
      await expect(page.getByTestId("task-panel")).toBeVisible();
      await openSettings(page);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("settings-window"), "Esc 先关设置窗口").toHaveCount(0);
      await expect(page.getByTestId("task-panel"), "底下的抽屉还开着").toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("task-panel"), "Esc 收起").toHaveCount(0);
    });
  });
}

test.describe("900 宽", () => {
  test.use({ viewport: { width: 900, height: 900 } });

  test("单聊进来不自动盖上 Bot 设置，点「设置」才拉出来；在这里收起不改宽窗口的偏好", async ({ page }) => {
    await login(page);
    await openSeededBot(page, "小服");
    await expect(page.getByTestId("bot-panel"), "窄窗口进单聊，对话不被抽屉挡住").toHaveCount(0);
    await expect(page.getByTestId("bot-panel-toggle")).toHaveAttribute("aria-pressed", "false");

    await page.getByTestId("bot-panel-toggle").click();
    await expect(page.getByTestId("bot-panel")).toBeVisible();
    await expectChatUsable(page, "Bot 设置开着");
    await page.screenshot({ path: `${SHOT}/panel-drawer-900-bot.png` });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("bot-panel"), "Esc 收起").toHaveCount(0);

    await page.getByTestId("activity-toggle").click();
    await page.locator('[data-testid="tool-call-card"][data-view-kind="bash"]').click();
    await expect(page.getByTestId("tool-inspector")).toBeVisible();
    await expectChatUsable(page, "工具检查器开着");
    await clickScrimBesideDrawer(page);
    await expect(page.getByTestId("tool-inspector"), "点抽屉外面收起").toHaveCount(0);

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByTestId("bot-panel"), "宽窗口照旧默认展开 Bot 设置").toBeVisible();
  });
});

test.describe("1280 宽", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("右栏仍和对话区并排，没有遮罩", async ({ page }) => {
    await login(page);
    await openSeededBot(page, "小服");
    await expect(page.getByTestId("bot-panel")).toBeVisible();
    const chat = await boxOf(page, "chat");
    const botPanel = await boxOf(page, "bot-panel");
    expect(botPanel.x, "Bot 设置排在对话区右边").toBeGreaterThanOrEqual(chat.x + chat.width);
    await expectChatUsable(page, "Bot 设置开着");
    await expect(page.getByTestId("panel-scrim")).toBeHidden();

    await openTeamGroup(page, TEAM_TITLE);
    await page.getByTestId("task-open").click();
    await expect(page.getByTestId("task-panel")).toBeVisible();
    const teamChat = await boxOf(page, "chat");
    const taskPanel = await boxOf(page, "task-panel");
    expect(taskPanel.x, "任务详情排在对话区右边").toBeGreaterThanOrEqual(teamChat.x + teamChat.width);
    await expectChatUsable(page, "任务详情开着");
    await expect(page.getByTestId("panel-scrim")).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("task-panel"), "并排时 Esc 不动右栏").toBeVisible();
  });
});
