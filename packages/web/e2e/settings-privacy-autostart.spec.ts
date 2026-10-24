import {
  KEPT_EDGE_BYTES,
  MAX_ROUTINE_RUNS,
  RETAIN_TEXT_LIMIT_BYTES,
  SESSION_TTL_MS,
  type OpenAtLogin,
} from "@baize/shared";
import { expect, login, openSettings, test, type Page } from "./fixtures";

type MockBridgeWindow = Window & {
  __bridgeSets: OpenAtLogin[];
  __loginItemChanged: (value: OpenAtLogin) => void;
  __failSet: boolean;
};

const installDesktopBridge = (page: Page, initial: OpenAtLogin) =>
  page.addInitScript((initial) => {
    let openAtLogin = initial;
    const listeners = new Set<(value: OpenAtLogin) => void>();
    const target = window as unknown as MockBridgeWindow;
    target.__bridgeSets = [];
    target.__failSet = false;
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
            if (target.__failSet) throw new Error("Error invoking remote method 'baize:open-at-login:set': boom");
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

test("主进程改开机启动失败，开关行内说没改成，开关留在实际的值", async ({ page }) => {
  const unhandled: string[] = [];
  page.on("pageerror", (error) => unhandled.push(error.message));
  await installDesktopBridge(page, "off");
  await login(page);
  await openSettings(page);

  const toggle = page.getByTestId("open-at-login-switch");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page.evaluate(() => {
    (window as unknown as MockBridgeWindow).__failSet = true;
  });
  await toggle.click();
  await expect(page.getByTestId("open-at-login-error")).toHaveText("没改成开机启动，请再试一次");
  await expect(toggle, "失败了开关不假装打开").toHaveAttribute("aria-checked", "false");
  expect(await page.evaluate(() => (window as unknown as MockBridgeWindow).__bridgeSets)).toEqual(["on"]);

  await page.evaluate(() => {
    (window as unknown as MockBridgeWindow).__failSet = false;
  });
  await toggle.click();
  await expect(toggle, "再点一次成功").toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("open-at-login-error"), "成功之后错误收起").toHaveCount(0);
  expect(unhandled, "失败不留未处理的 rejection").toEqual([]);
});

test("开发版 App 的桥报不支持，不出开机启动开关", async ({ page }) => {
  await installDesktopBridge(page, "unsupported");
  await login(page);
  await openSettings(page);
  await expect(page.getByTestId("theme-select")).toBeVisible();
  await expect(page.getByTestId("open-at-login-switch")).toHaveCount(0);
});

test("数据与隐私页写明每类数据存在哪、留多久，删账号要清干净得删整个 App 数据目录", async ({ page }) => {
  await login(page);
  await openSettings(page);
  await page.getByTestId("settings-nav-privacy").click();

  const storage = page.getByTestId("privacy-storage");
  await expect(storage).toContainText("~/Library/Application Support/白泽/bots");
  await expect(storage.getByTestId("privacy-storage-item").filter({ hasText: "对话和工作记录" })).toContainText(
    `超过 ${RETAIN_TEXT_LIMIT_BYTES / 1024} KB 的输出只留头尾各 ${KEPT_EDGE_BYTES / 1024} KB`,
  );
  await expect(storage.getByTestId("privacy-storage-item").filter({ hasText: "网页登录" })).toContainText(
    `${SESSION_TTL_MS / (24 * 60 * 60 * 1000)} 天过期`,
  );
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
    `每个例行大约只留最近 ${MAX_ROUTINE_RUNS} 次运行记录，正在跑的那次`,
  );
  const deletion = page.getByTestId("privacy-delete-note");
  await expect(deletion).toContainText("电脑上的数据目录和 App 存的连接凭据不会跟着删");
  await expect(deletion, "凭据和设置不在 bots 下面，要删整个 userData").toContainText(
    "删掉整个 ~/Library/Application Support/白泽 目录",
  );
});
