import { login, NEEDS_APPROVAL, sendText, SHOT, teamCard, TEAM_TITLE, test, expect, type Page } from "./fixtures";

const PHONE = { width: 390, height: 844 };
const TOUCH_MIN = 40;

const boxOf = async (page: Page, testId: string) => {
  const box = await page.getByTestId(testId).first().boundingBox();
  if (box === null) throw new Error(`${testId} 没有渲染出来`);
  return box;
};

const expectNoSideScroll = async (page: Page, where: string) => {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${where}：整页没有横向滚动`).toBeLessThanOrEqual(clientWidth);
};

const expectTouchable = async (page: Page, testId: string, what: string) => {
  const target = page.getByTestId(testId).first();
  await expect(target, `${what} 看得见`).toBeInViewport();
  const box = await boxOf(page, testId);
  expect(box.height, `${what} 不矮于 ${TOUCH_MIN}px`).toBeGreaterThanOrEqual(TOUCH_MIN);
  expect(box.x + box.width, `${what} 没有伸出屏幕右边`).toBeLessThanOrEqual(PHONE.width);
};

const openNav = async (page: Page) => {
  await page.getByTestId("nav-open").click();
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect(page.getByTestId("nav-scrim")).toBeVisible();
};

const expectNavClosed = async (page: Page, why: string) => {
  await expect(page.getByTestId("sidebar"), why).toBeHidden();
  await expect(page.getByTestId("nav-scrim")).toHaveCount(0);
  await expect(page.getByTestId("nav-open")).toHaveAttribute("aria-expanded", "false");
};

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme === "light" ? "亮色" : "暗色"} 390 宽`, () => {
    test.use({ viewport: PHONE, colorScheme });

    test("侧栏收成抽屉，选完群自己收起，对话区占满宽度能发消息", async ({ page }) => {
      await login(page);
      await expect(page.getByTestId("sidebar"), "手机宽度下侧栏默认收着").toBeHidden();
      await expectTouchable(page, "nav-open", "打开侧栏的按钮");
      await expectNoSideScroll(page, "今天页");
      await page.screenshot({ path: `${SHOT}/mobile-390-today-${colorScheme}.png`, fullPage: true });

      await openNav(page);
      const sidebar = await boxOf(page, "sidebar");
      expect(sidebar.x, "抽屉贴着屏幕左边").toBe(0);
      expect(sidebar.width, "抽屉右边留一条能点回去的遮罩").toBeLessThan(PHONE.width);
      await expectTouchable(page, "assistant-nav", "侧栏里的群");
      await page.screenshot({ path: `${SHOT}/mobile-390-nav-${colorScheme}.png` });

      await page.getByTestId("assistant-nav").click();
      await expect(page.getByTestId("chat-title")).toHaveText("主助理");
      await expectNavClosed(page, "点了群抽屉自己收起");
      const chat = await boxOf(page, "chat");
      expect(chat.x, "对话区从屏幕左边开始").toBe(0);
      expect(chat.width, "对话区占满宽度").toBe(PHONE.width);

      await sendText(page, "手机上发一条");
      await expect(page.getByTestId("message").filter({ hasText: "手机上发一条" })).toBeVisible();
      const composer = await boxOf(page, "composer-input");
      expect(composer.y + composer.height, "输入框贴在屏幕底部").toBeGreaterThan(PHONE.height - 80);
      await expectTouchable(page, "composer-send", "发送按钮");
      await expectNoSideScroll(page, "单聊");
      await page.screenshot({ path: `${SHOT}/mobile-390-chat-${colorScheme}.png` });
    });

    test("今天页的审批按钮看得全、点得到", async ({ page }) => {
      await login(page);
      const approval = page.getByTestId("today-pending").getByTestId("today-row").filter({ hasText: "发送 Globex" });
      await expect(approval).toBeVisible();
      await expectTouchable(page, "approval-scope-once", "今天页的「批准」");
      const reject = approval.getByRole("button", { name: "拒绝" });
      await expect(reject, "今天页的「拒绝」看得见").toBeInViewport();
      expect((await reject.boundingBox())?.height ?? 0, "今天页的「拒绝」不矮于 40px").toBeGreaterThanOrEqual(
        TOUCH_MIN,
      );
      await reject.click();
      await expect(approval, "点了拒绝这一行就收走").toHaveCount(0);
    });

    test("设置窗口铺满屏幕，能关", async ({ page }) => {
      await login(page);
      await openNav(page);
      await page.getByTestId("sidebar-settings").click();
      await expectNavClosed(page, "开设置时侧栏先收起");
      await expect(page.getByTestId("settings-window")).toBeVisible();
      const settings = await page.locator(".settings").boundingBox();
      expect(settings, "设置窗口铺满屏幕").toEqual({ x: 0, y: 0, width: PHONE.width, height: PHONE.height });
      await expectTouchable(page, "settings-close", "关闭设置");
      await expectNoSideScroll(page, "设置窗口");
      await page.screenshot({ path: `${SHOT}/mobile-390-settings-${colorScheme}.png` });
      await page.getByTestId("settings-close").click();
      await expect(page.getByTestId("settings-window")).toHaveCount(0);
    });
  });
}

test.describe("390 宽", () => {
  test.use({ viewport: PHONE });

  test("群里的审批卡按钮点得到，批了卡上留结论", async ({ page }) => {
    await login(page);
    await openNav(page);
    await page.getByTestId("team-nav").click();
    await expectNavClosed(page, "进团队页抽屉收起");
    await teamCard(page, "小销").getByTestId("team-bot-chat").click();
    await expect(page.getByTestId("chat-title")).toHaveText("小销");
    await sendText(page, NEEDS_APPROVAL);
    const card = page.getByTestId("approval-card");
    await expect(card).toHaveAttribute("data-status", "pending");
    await card.scrollIntoViewIfNeeded();
    await expectTouchable(page, "approval-reject", "审批卡的「拒绝」");
    await expectTouchable(page, "approval-approve", "审批卡的「批准」");
    await expectNoSideScroll(page, "审批卡");
    await page.getByTestId("approval-approve").click();
    await expect(card).toHaveAttribute("data-status", "approved");
  });

  test("点遮罩、按 Esc 都只收起侧栏；开着时 Tab 走不进被盖住的页面", async ({ page }) => {
    await login(page);
    await openNav(page);
    await page.getByTestId("nav-scrim").click({ position: { x: PHONE.width - 24, y: 400 } });
    await expectNavClosed(page, "点抽屉外面收起");
    await expect(page.getByTestId("today-pending"), "底下的今天页还在").toBeVisible();

    await openNav(page);
    const stops: string[] = [];
    for (let press = 0; press < 30; press += 1) {
      await page.keyboard.press("Tab");
      stops.push(
        await page.evaluate(() => {
          const at = document.activeElement;
          if (at?.closest("[data-testid=sidebar]")) return "sidebar";
          return at?.closest("[data-testid=main-window]") ? "covered" : "outside";
        }),
      );
    }
    expect(stops, "Tab 走得到侧栏").toContain("sidebar");
    expect(stops, "侧栏开着时 Tab 不进被盖住的页面").not.toContain("covered");
    await page.keyboard.press("Escape");
    await expectNavClosed(page, "Esc 收起");
    await expect(page.getByTestId("today-pending")).toBeVisible();
    await page.getByTestId("today-composer-input").focus();
    await expect(page.getByTestId("today-composer-input"), "收起后页面又能聚焦").toBeFocused();
  });

  test("任务详情在手机上铺满宽度，侧栏开着的时候不会跟它叠在一起", async ({ page }) => {
    await login(page);
    await openNav(page);
    await page.locator(`[data-testid=group-item][data-group-title="${TEAM_TITLE}"]`).click();
    await expectNavClosed(page, "点项目抽屉收起");
    await page.getByTestId("project-open-group").click();
    await page.getByTestId("task-open").click();
    const panel = await boxOf(page, "task-panel");
    expect(panel, "任务详情铺满宽度").toMatchObject({ x: 0, width: PHONE.width });
    await page.getByTestId("nav-open").focus();
    await expect(page.getByTestId("nav-open"), "任务详情盖着时键盘也摸不到打开侧栏的按钮").not.toBeFocused();
    await expectNoSideScroll(page, "任务详情");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("task-panel"), "Esc 收起任务详情").toHaveCount(0);
  });

  test("开着侧栏拉宽到电脑宽度再缩回来，侧栏不会自己又盖上来", async ({ page }) => {
    await login(page);
    await openNav(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByTestId("nav-scrim")).toHaveCount(0);
    await expect(page.getByTestId("nav-open")).toHaveCount(0);
    await page.setViewportSize(PHONE);
    await expectNavClosed(page, "缩回手机宽度侧栏收着");
  });
});

const TABLET_PORTRAIT = [744, 768, 810, 820, 834];

test.describe("平板竖屏", () => {
  test("744 到 834 宽侧栏都收成抽屉，1024 横屏仍是三栏", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await login(page);
    for (const width of TABLET_PORTRAIT) {
      await page.setViewportSize({ width: 1024, height: 768 });
      await expect(page.getByTestId("nav-open"), "1024 宽侧栏常驻，没有打开侧栏的按钮").toHaveCount(0);
      await page.setViewportSize({ width, height: 1024 });
      await expect(page.getByTestId("sidebar"), `${width} 宽侧栏默认收着`).toBeHidden();
      await openNav(page);
      expect((await boxOf(page, "sidebar")).x, `${width} 宽抽屉贴着屏幕左边`).toBe(0);
      await page.keyboard.press("Escape");
      await expectNavClosed(page, `${width} 宽 Esc 收起`);
      await expectNoSideScroll(page, `${width} 宽今天页`);
    }
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.getByTestId("nav-open"), "1024 宽没有打开侧栏的按钮").toHaveCount(0);
    await expect(page.getByTestId("sidebar"), "1024 宽侧栏常驻").toBeVisible();
    const sidebar = await boxOf(page, "sidebar");
    await page.getByTestId("assistant-nav").click();
    const chat = await boxOf(page, "chat");
    expect(chat.x, "1024 宽对话区排在侧栏右边").toBeGreaterThanOrEqual(sidebar.x + sidebar.width);
  });
});

for (const width of [768, 820]) {
  test.describe(`${width} 宽`, () => {
    test.use({ viewport: { width, height: 1024 } });

    test("侧栏是抽屉，对话区占满宽度，右栏照旧是抽屉", async ({ page }) => {
      await login(page);
      await expect(page.getByTestId("sidebar"), "平板竖屏侧栏默认收着").toBeHidden();
      await expectNoSideScroll(page, "今天页");
      await openNav(page);
      await page.screenshot({ path: `${SHOT}/mobile-${width}-nav.png` });
      await page.locator(`[data-testid=group-item][data-group-title="${TEAM_TITLE}"]`).click();
      await expectNavClosed(page, "点项目抽屉收起");
      await page.getByTestId("project-open-group").click();
      const chat = await boxOf(page, "chat");
      expect(chat, "对话区占满宽度").toMatchObject({ x: 0, width });
      await page.getByTestId("task-open").click();
      await expect(page.getByTestId("panel-scrim")).toBeVisible();
      const panel = await boxOf(page, "task-panel");
      expect(panel.x + panel.width, "任务详情贴着窗口右边").toBe(width);
      await expectNoSideScroll(page, "任务详情开着");
      await page.screenshot({ path: `${SHOT}/mobile-${width}-task.png` });
    });
  });
}

test.describe("720 宽", () => {
  test.use({ viewport: { width: 720, height: 900 } });

  test("设置窗口铺满屏幕，关闭按钮不小于 40px", async ({ page }) => {
    await login(page);
    await openNav(page);
    await page.getByTestId("sidebar-settings").click();
    await expect(page.getByTestId("settings-window")).toBeVisible();
    const settings = await page.locator(".settings").boundingBox();
    expect(settings, "设置窗口铺满屏幕").toEqual({ x: 0, y: 0, width: 720, height: 900 });
    const close = await boxOf(page, "settings-close");
    expect(close.width, "关闭设置不窄于 40px").toBeGreaterThanOrEqual(TOUCH_MIN);
    expect(close.height, "关闭设置不矮于 40px").toBeGreaterThanOrEqual(TOUCH_MIN);
  });
});

const expectFocusOn = async (page: Page, testId: string, why: string) => {
  const at = await page.evaluate(() => ({
    body: document.activeElement === null || document.activeElement === document.body,
    testId: document.activeElement?.getAttribute("data-testid") ?? null,
  }));
  expect(at.body, `${why}：焦点没掉到 body`).toBe(false);
  expect(at.testId, why).toBe(testId);
};

test.describe("390 宽焦点", () => {
  test.use({ viewport: PHONE });

  test("抽屉拉开焦点进侧栏，Esc、点遮罩、选群收起后焦点回到菜单按钮", async ({ page }) => {
    await login(page);
    await openNav(page);
    expect(
      await page.evaluate(() => document.activeElement?.closest("[data-testid=sidebar]") !== null),
      "拉开抽屉焦点在侧栏里",
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expectNavClosed(page, "Esc 收起");
    await expectFocusOn(page, "nav-open", "Esc 收起后焦点回到菜单按钮");

    await openNav(page);
    await page.getByTestId("nav-scrim").click({ position: { x: PHONE.width - 24, y: 400 } });
    await expectNavClosed(page, "点遮罩收起");
    await expectFocusOn(page, "nav-open", "点遮罩收起后焦点回到菜单按钮");

    await openNav(page);
    await page.getByTestId("assistant-nav").click();
    await expectNavClosed(page, "选了群收起");
    await expectFocusOn(page, "nav-open", "选群收起后焦点回到菜单按钮");
  });

  test("从菜单按钮拉开抽屉再开快速切换，Esc 退出后焦点回到侧栏，再收起回到菜单按钮", async ({ page }) => {
    await login(page);
    await page.getByTestId("nav-open").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByTestId("quick-switch-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("quick-switch")).toHaveCount(0);
    expect(
      await page.evaluate(() => document.activeElement?.closest("[data-testid=sidebar]") !== null),
      "退出快速切换焦点回到侧栏里",
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expectNavClosed(page, "再按 Esc 收起抽屉");
    await expectFocusOn(page, "nav-open", "收起后焦点回到菜单按钮");
  });
});

test.describe("1280 宽", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("侧栏常驻在左边，不出打开侧栏的按钮", async ({ page }) => {
    await login(page);
    await expect(page.getByTestId("nav-open")).toHaveCount(0);
    const sidebar = await boxOf(page, "sidebar");
    expect(sidebar.x, "侧栏在最左边").toBe(0);
    await page.getByTestId("assistant-nav").click();
    const chat = await boxOf(page, "chat");
    expect(chat.x, "对话区排在侧栏右边").toBeGreaterThanOrEqual(sidebar.x + sidebar.width);
    await expect(page.getByTestId("sidebar"), "选了群侧栏也还在").toBeVisible();
    await expectNoSideScroll(page, "单聊");
  });
});
