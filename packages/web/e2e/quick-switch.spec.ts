import { login, openSeededBot, openSettings, SHOT, TEAM_TITLE, test, expect, type Page } from "./fixtures";

const SWITCH = "ControlOrMeta+k";
const SHEET = "ControlOrMeta+Slash";

const options = (page: Page) => page.getByTestId("quick-switch-option");
const selectedOption = (page: Page) => page.locator('[data-testid=quick-switch-option][aria-selected="true"]');

const openSwitch = async (page: Page) => {
  await page.keyboard.press(SWITCH);
  await expect(page.getByTestId("quick-switch")).toBeVisible();
  await expect(page.getByTestId("quick-switch-input"), "一打开就能打字").toBeFocused();
};

const openInspector = async (page: Page) => {
  await openSeededBot(page, "小服");
  await page.getByTestId("activity-toggle").click();
  await page.locator('[data-testid="tool-call-card"][data-view-kind="bash"]').click();
  await expect(page.getByTestId("tool-inspector")).toBeVisible();
};

// keyboard.press 带不了 isComposing，只能在页面里合成；合成事件不经 ControlOrMeta 换算，修饰键得自己挑。
const dispatchSwitchKey = (page: Page, composing: boolean) =>
  page.getByTestId("composer-input").evaluate((input, isComposing) => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        code: "KeyK",
        metaKey: mac,
        ctrlKey: !mac,
        isComposing,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, composing);

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(colorScheme === "light" ? "亮色" : "暗色", () => {
    test.use({ colorScheme });

    test("⌘K 打开快速切换，Bot、群、项目分组列出；⌘/ 打开快捷键表", async ({ page }) => {
      await login(page);
      await openSwitch(page);
      await expect(page.getByTestId("quick-switch-group")).toHaveCount(3);
      await expect(page.locator("[data-testid=quick-switch-group][data-kind=bot]")).toContainText("Bot");
      await expect(page.locator("[data-testid=quick-switch-group][data-kind=group]")).toContainText("群");
      await expect(page.locator("[data-testid=quick-switch-group][data-kind=project]")).toContainText("项目");
      await page.screenshot({ path: `${SHOT}/quick-switch-open-${colorScheme}.png` });

      await page.getByTestId("quick-switch-input").fill("小");
      await expect(options(page).first()).toHaveAttribute("data-kind", "bot");
      await page.screenshot({ path: `${SHOT}/quick-switch-typed-${colorScheme}.png` });
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("quick-switch")).toHaveCount(0);

      await page.keyboard.press(SHEET);
      const sheet = page.getByTestId("shortcut-sheet");
      await expect(sheet).toBeVisible();
      await expect(sheet.getByTestId("shortcut-row").filter({ hasText: "快速切换 Bot、群、项目" })).toContainText(
        /⌘|Ctrl/,
      );
      await expect(sheet, "画面接管里已有的快捷键也列着").toContainText("贴的是你这边剪贴板里的字");
      await page.screenshot({ path: `${SHOT}/shortcut-sheet-${colorScheme}.png` });
      await page.keyboard.press("Escape");
      await expect(sheet, "Esc 关掉快捷键表").toHaveCount(0);
    });
  });
}

test("输入几个字只剩名字对得上的，上下键挑、回车跳到项目页或群里", async ({ page }) => {
  await login(page);
  await openSwitch(page);
  await page.getByTestId("quick-switch-input").fill("globex");
  await expect(options(page), "只剩这个项目自己和它的群").toHaveCount(2);
  await expect(options(page).nth(0)).toHaveAttribute("data-kind", "group");
  await expect(options(page).nth(1)).toHaveAttribute("data-kind", "project");
  await expect(selectedOption(page)).toHaveAttribute("data-kind", "group");

  await page.keyboard.press("ArrowDown");
  await expect(selectedOption(page)).toHaveAttribute("data-kind", "project");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("quick-switch")).toHaveCount(0);
  await expect(page.getByTestId("project-page"), "回车进到项目页").toBeVisible();
  await expect(page).toHaveURL(/\/p\//);

  await openSwitch(page);
  await page.getByTestId("quick-switch-input").fill("globex");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("task-card"), "选群就进项目群的聊天").toBeVisible();
  await expect(page).toHaveURL(/\/g\//);

  await openSwitch(page);
  await page.getByTestId("quick-switch-input").fill("小服");
  await expect(options(page)).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("chat-title")).toHaveText("小服");

  await openSwitch(page);
  await page.getByTestId("quick-switch-input").fill("没有这个名字");
  await expect(page.getByTestId("quick-switch-empty")).toBeVisible();
  await page.keyboard.press("Escape");

  await openSwitch(page);
  await page.getByTestId("quick-switch-input").fill(TEAM_TITLE);
  await options(page).filter({ hasText: TEAM_TITLE }).and(page.locator("[data-kind=project]")).click();
  await expect(page.getByTestId("project-page"), "点一下也能跳").toBeVisible();
});

test("快速切换开着时 Esc 只关它，后面的检查器、设置窗口都还开着", async ({ page }) => {
  await login(page);
  await openInspector(page);
  await openSwitch(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("quick-switch")).toHaveCount(0);
  await expect(page.getByTestId("tool-inspector"), "检查器还开着").toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tool-inspector"), "再按一下 Esc 才轮到检查器").toHaveCount(0);

  await openSettings(page);
  await openSwitch(page);
  await page.getByTestId("quick-switch-input").fill("小");
  await page.locator(".quick-switch-label").first().click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("quick-switch"), "点了列表里的空处，Esc 还是先关快速切换").toHaveCount(0);
  await expect(page.getByTestId("settings-window"), "设置窗口还开着").toBeVisible();

  await page.keyboard.press(SHEET);
  await expect(page.getByTestId("shortcut-sheet")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("shortcut-sheet")).toHaveCount(0);
  await expect(page.getByTestId("settings-window"), "关快捷键表也不连带设置窗口").toBeVisible();

  await openSwitch(page);
  await page.getByTestId("quick-switch-input").fill("小服");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("chat-title")).toHaveText("小服");
  await expect(page.getByTestId("settings-window"), "跳走了，挡在前面的设置窗口收起").toHaveCount(0);
});

test("Tab、Shift+Tab 走不出快速切换和快捷键表，Esc 仍然只关最上面这层", async ({ page }) => {
  await login(page);
  await openInspector(page);
  await openSwitch(page);
  for (const key of ["Shift+Tab", "Tab", "Tab"]) {
    await page.keyboard.press(key);
    await expect(page.getByTestId("quick-switch-input"), `${key} 之后焦点还在快速切换里`).toBeFocused();
  }
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("quick-switch")).toHaveCount(0);
  await expect(page.getByTestId("tool-inspector"), "检查器还开着").toBeVisible();

  await page.keyboard.press(SHEET);
  for (const key of ["Tab", "Shift+Tab", "Tab"]) {
    await page.keyboard.press(key);
    await expect(page.getByTestId("shortcut-sheet-close"), `${key} 之后焦点还在快捷键表里`).toBeFocused();
  }
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("shortcut-sheet")).toHaveCount(0);
  await expect(page.getByTestId("tool-inspector"), "关快捷键表也不连带检查器").toBeVisible();
});

test("在输入框里打着字按 ⌘K 照样打开，关掉后接着打；单按 K、/ 不抢输入", async ({ page }) => {
  await login(page);
  await openSeededBot(page, "小服");
  const composer = page.getByTestId("composer-input");
  await composer.click();
  await page.keyboard.type("看一下k");
  await expect(composer).toHaveValue("看一下k");
  await expect(page.getByTestId("quick-switch")).toHaveCount(0);

  await openSwitch(page);
  await page.keyboard.press(SWITCH);
  await expect(page.getByTestId("quick-switch"), "再按一次 ⌘K 收起").toHaveCount(0);
  await expect(composer, "焦点回到输入框").toBeFocused();
  await page.keyboard.type("工单");
  await expect(composer).toHaveValue("看一下k工单");

  await page.keyboard.press(SHEET);
  await expect(page.getByTestId("shortcut-sheet")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("看一下k工单");
});

test("输入法组字时按 ⌘K 不打开", async ({ page }) => {
  await login(page);
  await openSeededBot(page, "小服");
  const composer = page.getByTestId("composer-input");
  await composer.focus();
  await composer.dispatchEvent("compositionstart", { data: "" });
  await dispatchSwitchKey(page, true);
  await dispatchSwitchKey(page, false);
  await expect(page.getByTestId("quick-switch"), "组字中那下没开，否则这一下就是把它关上").toBeVisible();
});
