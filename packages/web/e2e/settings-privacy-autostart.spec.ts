import type { OpenAtLogin } from "@baize/shared";
import { expect, login, openSettings, test, type Page } from "./fixtures";

type MockBridgeWindow = Window & {
  __bridgeSets: OpenAtLogin[];
  __loginItemChanged: (value: OpenAtLogin) => void;
};

const installDesktopBridge = (page: Page, initial: OpenAtLogin) =>
  page.addInitScript((initial) => {
    let openAtLogin = initial;
    const listeners = new Set<(value: OpenAtLogin) => void>();
    const target = window as unknown as MockBridgeWindow;
    target.__bridgeSets = [];
    target.__loginItemChanged = (value) => {
      openAtLogin = value;
      for (const listener of listeners) listener(value);
    };
    Object.assign(window, {
      baizeDesktop: {
        openAtLogin: {
          get: async () => openAtLogin,
          set: async (value: OpenAtLogin) => {
            target.__bridgeSets.push(value);
            target.__loginItemChanged(value);
            return openAtLogin;
          },
          subscribe: (listener: (value: OpenAtLogin) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      },
    });
  }, initial);

test("网页里没有桌面桥，通用页不出开机启动开关", async ({ page }) => {
  await login(page);
  await openSettings(page);
  await expect(page.getByTestId("theme-select"), "通用页已经渲染").toBeVisible();
  await expect(page.getByTestId("open-at-login-switch")).toHaveCount(0);
  await expect(page.getByText("开机时启动白泽")).toHaveCount(0);
});

test("App 里的开机启动开关能切换，菜单那边改了这里跟着变", async ({ page }) => {
  await installDesktopBridge(page, "off");
  await login(page);
  await openSettings(page);

  const toggle = page.getByTestId("open-at-login-switch");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle, "点了之后显示桥回读的值").toHaveAttribute("aria-checked", "true");
  expect(await page.evaluate(() => (window as unknown as MockBridgeWindow).__bridgeSets)).toEqual(["on"]);

  await page.evaluate(() => (window as unknown as MockBridgeWindow).__loginItemChanged("off"));
  await expect(toggle, "菜单里取消勾选，设置页跟着关").toHaveAttribute("aria-checked", "false");
});

test("开发版 App 的桥报不支持，不出开机启动开关", async ({ page }) => {
  await installDesktopBridge(page, "unsupported");
  await login(page);
  await openSettings(page);
  await expect(page.getByTestId("theme-select")).toBeVisible();
  await expect(page.getByTestId("open-at-login-switch")).toHaveCount(0);
});

test("数据与隐私页写明每类数据存在哪、留多久，删账号不清电脑上的目录", async ({ page }) => {
  await login(page);
  await openSettings(page);
  await page.getByTestId("settings-nav-privacy").click();

  const storage = page.getByTestId("privacy-storage");
  await expect(storage).toContainText("~/Library/Application Support/白泽/bots");
  await expect(storage.getByTestId("privacy-storage-item").locator("b")).toHaveText([
    "对话和工作记录",
    "会话文件",
    "记忆和偏好",
    "skill",
    "浏览器登录态",
    "图片、草稿和品牌手册",
    "用量和例行记录",
    "网页登录",
  ]);
  for (const item of await storage.getByTestId("privacy-storage-item").all()) {
    await expect(item, "每一类都说存在哪").toContainText("存在：");
    await expect(item, "每一类都说留多久").toContainText("留多久：");
  }
  await expect(storage.getByTestId("privacy-storage-item").filter({ hasText: "会话文件" })).toContainText(
    "截图原图和完整输出都在",
  );
  await expect(storage.getByTestId("privacy-storage-item").filter({ hasText: "用量和例行记录" })).toContainText(
    "只留最近 20 次运行记录",
  );
  await expect(page.getByTestId("privacy-page")).toContainText("电脑上的数据目录和 App 存的连接凭据不会跟着删");
});
