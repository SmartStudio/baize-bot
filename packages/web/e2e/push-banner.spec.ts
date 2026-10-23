import { PUSH_GRACE_MS as GRACE_MS } from "../src/state/reconnect.js";
import type { Locator } from "@playwright/test";
import { expect, login, openBot, test, type Page } from "./fixtures";

declare global {
  interface Window {
    __pushBannerSeen?: boolean;
  }
}

const refusePush = async (page: Page, refused: boolean) => {
  expect((await page.request.post("/api/test/sockets/refuse", { data: { refused } })).status()).toBe(204);
};

const dropPush = async (page: Page) => {
  expect((await page.request.post("/api/test/sockets/drop")).status()).toBe(204);
};

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("元素没有渲染出来");
  return box;
};

const overlaps = async (a: Locator, b: Locator) => {
  const [x, y] = [await boxOf(a), await boxOf(b)];
  return x.x < y.x + y.width && y.x < x.x + x.width && x.y < y.y + y.height && y.y < x.y + x.height;
};

const postMissed = async (page: Page, text: string) => {
  const posted = await page.request.post("/api/test/messages", { data: { groupId: "grp_sales", text } });
  expect(posted.status(), "断线时服务端多了一条推不过来的消息").toBe(204);
};

test("推送断线超过宽限期，顶上说连不上、正在重试；连回来提示消失，断线期间的消息补拉出来", async ({ page }) => {
  const MISSED = "推送断着的时候别的窗口说的话";
  await login(page);
  await openBot(page, "小销");
  const list = page.getByTestId("message-list");
  await expect(list.getByTestId("message"), "预置的历史到齐了").not.toHaveCount(0);
  const banner = page.getByTestId("push-banner");
  await expect(banner, "连着的时候不提示").toHaveCount(0);

  await refusePush(page, true);
  await dropPush(page);
  await expect(banner, "断线超过宽限期就提示").toBeVisible();
  await expect(banner).toContainText("连不上");
  await expect(banner).toContainText("重试");
  await expect(
    page.locator("[aria-live=polite]").filter({ has: banner }),
    "提示放在礼貌播报的区域里，读屏会念出来",
  ).toHaveCount(1);
  for (const [testId, name] of [
    ["bot-edit", "编辑"],
    ["bot-share", "分享"],
  ] as const) {
    const button = page.getByTestId(testId);
    await expect(button, `断线时聊天头的「${name}」还看得见`).toBeVisible();
    await expect(button).toBeEnabled();
    await button.click({ trial: true });
    expect(await overlaps(banner, button), `断线提示不压在「${name}」上`).toBe(false);
  }

  await postMissed(page, MISSED);
  await expect(list.locator("[data-kind=user]", { hasText: MISSED }), "断着的时候推不过来").toHaveCount(0);
  await expect(banner, "一直连不上就一直提示").toBeVisible();

  await refusePush(page, false);
  await expect(banner, "连回来提示就收起").toHaveCount(0, { timeout: 15_000 });
  await expect(list.locator("[data-kind=user]", { hasText: MISSED }), "连回来补拉出断线期间的消息").toHaveCount(1);
});

test("推送断一下马上连回来，提示不闪出来", async ({ page }) => {
  const MISSED = "一闪而过的断线里说的话";
  await page.addInitScript(() => {
    window.__pushBannerSeen = false;
    new MutationObserver(() => {
      if (document.querySelector("[data-testid=push-banner]") !== null) window.__pushBannerSeen = true;
    }).observe(document, { childList: true, subtree: true });
  });
  await login(page);
  await openBot(page, "小销");
  const list = page.getByTestId("message-list");
  await expect(list.getByTestId("message"), "预置的历史到齐了").not.toHaveCount(0);

  const droppedAt = Date.now();
  await dropPush(page);
  await postMissed(page, MISSED);
  await expect(list.locator("[data-kind=user]", { hasText: MISSED }), "推送已经连回来了").toHaveCount(1);
  expect(Date.now() - droppedAt, "这一趟重连要快过宽限期，否则测不出闪不闪").toBeLessThan(GRACE_MS);
  await page.waitForTimeout(droppedAt + GRACE_MS + 500 - Date.now());
  expect(await page.evaluate(() => window.__pushBannerSeen), "宽限期内连回来，提示一次都没出现过").toBe(false);
});

test("断线提示和顶上的浮动提示同时出现时各占各的位置，不叠在一起", async ({ page }) => {
  await login(page);
  await page.goto("/?oauth=x&result=failed");
  const notice = page.getByTestId("oauth-notice");
  await expect(notice).toBeVisible();

  await refusePush(page, true);
  await dropPush(page);
  const banner = page.getByTestId("push-banner");
  await expect(banner).toBeVisible();
  await expect(notice, "断线不会把授权结果的提示挤掉").toBeVisible();
  expect(await overlaps(banner, notice), "授权结果的提示让到断线提示下面").toBe(false);
  await notice.getByTestId("oauth-notice-close").click({ trial: true });
});
