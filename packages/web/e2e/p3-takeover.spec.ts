import { LiveFromViewer } from "@baize/shared";
import { z } from "zod";
import {
  SHOT,
  expect,
  login,
  openRoutines,
  openSeededBot,
  openSettings,
  test,
  type APIRequestContext,
  type Page,
} from "./fixtures";

// Bot 请人接手：群里一张工具调用卡，右下角一条提示，用户点「打开画面」才摆面板。
// mock 的 /api/test/live/takeover 同时写卡、登记会话，两处同一个 liveId；观看者发 end 时 mock 先关会话、再替运行器改卡。

const REASON = "知乎要登录，请扫码或用短信登录，登好后点交还";

const Created = z.object({ liveId: z.string(), messageId: z.string() });
const Received = z.object({ received: z.array(z.object({ liveId: z.string(), message: LiveFromViewer })) });

const takeover = async (request: APIRequestContext, computerId = "cmp_remote", reason = REASON) => {
  const response = await request.post("/api/test/live/takeover", {
    data: { computerId, botId: "bot_service", groupId: "grp_service", reason },
  });
  expect(response.status(), "mock 造出一次接手").toBe(200);
  return Created.parse(await response.json()).liveId;
};

const ends = async (request: APIRequestContext, liveId: string) =>
  Received.parse(await (await request.get("/api/test/live/received")).json())
    .received.filter((entry) => entry.liveId === liveId)
    .map((entry) => entry.message)
    .filter((message) => message.t === "end");

const card = (page: Page, liveId: string) => page.locator(`[data-testid=takeover-card][data-live-id="${liveId}"]`);
const hint = (page: Page, liveId: string) => page.locator(`[data-testid=takeover-hint][data-live-id="${liveId}"]`);
const panel = (page: Page) => page.getByTestId("live-panel");

test("群里出现接手卡，面板不自己弹；点「打开画面」有交还和不弄了，交还后电脑收到 finish，卡写「已交还」，面板消失", async ({
  page,
  request,
}) => {
  await login(page);
  await openSeededBot(page, "小服");
  const liveId = await takeover(request);

  await expect(card(page, liveId)).toBeVisible();
  await expect(card(page, liveId).getByTestId("takeover-inspect")).toContainText("小服请你接手这一页");
  await expect(card(page, liveId).getByTestId("takeover-inspect")).toContainText(REASON);
  await expect(card(page, liveId).getByTestId("takeover-computer")).toHaveText("页面开在远程电脑 remote.baize.dev");
  await expect(card(page, liveId).getByTestId("takeover-open")).toBeEnabled();
  await expect(hint(page, liveId), "面板没摆着它，右下角有提示").toBeVisible();
  await expect(panel(page), "接手是 Bot 发起的，不自己弹").toHaveCount(0);
  await card(page, liveId).screenshot({ path: `${SHOT}/p3-takeover-card.png` });

  await card(page, liveId).getByTestId("takeover-inspect").click();
  await expect(page.getByTestId("tool-inspector-summary"), "卡的其余部分照旧开工具检查器").toContainText(
    "请你接手这一页",
  );
  await expect(page.getByTestId("tool-inspector-summary")).toContainText(REASON);

  await card(page, liveId).getByTestId("takeover-open").click();
  await expect(panel(page)).toHaveAttribute("data-purpose", "takeover");
  await expect(panel(page)).toHaveAttribute("data-live-id", liveId);
  await expect(panel(page)).toHaveAttribute("data-state", "live");
  await expect(panel(page).locator(".dialog-head b"), "标题说是哪个 Bot 请的").toHaveText("小服请你接手这一页");
  await expect(panel(page).locator(".dialog-head small"), "副标题是 Bot 给的理由").toHaveText(REASON);
  await expect(panel(page).getByTestId("live-end")).toHaveText(["交还给 Bot", "不弄了"]);
  await expect(hint(page, liveId), "摆着的那个不再提示").toHaveCount(0);
  await page.screenshot({ path: `${SHOT}/p3-takeover-panel.png` });

  await panel(page).locator("[data-testid=live-end][data-action=finish]").click();
  await expect.poll(() => ends(request, liveId)).toEqual([{ t: "end", action: "finish" }]);
  await expect(panel(page)).toHaveCount(0);
  await expect(card(page, liveId).getByTestId("takeover-result"), "交还之后卡还看得见，不折进做了几步").toHaveText(
    "已交还",
  );
  await expect(card(page, liveId).getByTestId("takeover-open")).toHaveCount(0);
  await expect(hint(page, liveId)).toHaveCount(0);
});

test("点「不弄了」：电脑收到 abandon，卡写「没接手」", async ({ page, request }) => {
  await login(page);
  await openSeededBot(page, "小服");
  const liveId = await takeover(request);

  await card(page, liveId).getByTestId("takeover-open").click();
  await panel(page).locator("[data-testid=live-end][data-action=abandon]").click();

  await expect.poll(() => ends(request, liveId)).toEqual([{ t: "end", action: "abandon" }]);
  await expect(panel(page)).toHaveCount(0);
  await expect(card(page, liveId).getByTestId("takeover-result")).toHaveText("没接手");
});

test("电脑那头页面没了、卡还没结论：卡上的按钮收掉，面板跟着消失", async ({ page, request }) => {
  await login(page);
  await openSeededBot(page, "小服");
  const liveId = await takeover(request);
  await card(page, liveId).getByTestId("takeover-open").click();
  await expect(panel(page)).toHaveAttribute("data-state", "live");

  expect((await request.post(`/api/test/live/${liveId}/close`)).status(), "只关会话不改卡").toBe(204);

  await expect(panel(page), "会话不在表里就卸掉").toHaveCount(0);
  await expect(card(page, liveId).getByTestId("takeover-open")).toHaveCount(0);
  await expect(card(page, liveId)).toHaveAttribute("data-status", "running");
  await expect(card(page, liveId).getByTestId("takeover-result")).toHaveText("画面还没出来");
  await expect(hint(page, liveId)).toHaveCount(0);
  expect(await ends(request, liveId), "网页没替用户发 end").toEqual([]);
});

test("本机电脑的接手面板有「到本机窗口操作」，远程电脑的没有", async ({ page, request }) => {
  await login(page);
  await openSeededBot(page, "小服");

  const local = await takeover(request, "cmp_local");
  await expect(card(page, local).getByTestId("takeover-computer")).toHaveText("页面开在本机");
  await card(page, local).getByTestId("takeover-open").click();
  await expect(panel(page)).toHaveAttribute("data-live-id", local);
  await expect(panel(page).getByTestId("live-reveal")).toHaveText("到本机窗口操作");
  await panel(page).locator("[data-testid=live-end][data-action=abandon]").click();
  await expect(panel(page)).toHaveCount(0);

  const remote = await takeover(request, "cmp_remote");
  await card(page, remote).getByTestId("takeover-open").click();
  await expect(panel(page)).toHaveAttribute("data-live-id", remote);
  await expect(panel(page)).toHaveAttribute("data-state", "live");
  await expect(panel(page).getByTestId("live-reveal"), "远程那台的窗口用户够不着").toHaveCount(0);
});

test("设置窗口开着时右下角提示照样出来，点「打开画面」面板盖在设置窗口上；「稍后」只收起提示，卡还在群里", async ({
  page,
  request,
}) => {
  await login(page);
  await openSettings(page);

  const first = await takeover(request);
  await expect(hint(page, first)).toBeVisible();
  await expect(hint(page, first)).toContainText("小服请你接手这一页");
  await expect(hint(page, first)).toContainText(REASON);
  await page.screenshot({ path: `${SHOT}/p3-takeover-hint.png` });

  await hint(page, first).getByTestId("takeover-hint-open").click();
  await expect(panel(page)).toHaveAttribute("data-live-id", first);
  await expect(page.getByTestId("settings-window"), "设置窗口还开着，面板在它上面").toBeVisible();
  // 点得到就说明没被设置窗口盖住：Playwright 点之前会核对落点上是不是这个按钮。
  await panel(page).locator("[data-testid=live-end][data-action=abandon]").click();
  await expect(panel(page)).toHaveCount(0);

  const second = await takeover(request);
  await expect(hint(page, second)).toBeVisible();
  await hint(page, second).getByTestId("takeover-hint-later").click();
  await expect(hint(page, second), "稍后只收起提示").toHaveCount(0);
  await expect(panel(page), "稍后不开面板").toHaveCount(0);

  await page.getByTestId("settings-close").click();
  await openSeededBot(page, "小服");
  await expect(card(page, second).getByTestId("takeover-open"), "卡片还在群里，随时能开").toBeEnabled();
  await expect(hint(page, second)).toHaveCount(0);
  await expect(card(page, first).getByTestId("takeover-result")).toHaveText("没接手");
});

test("登录面板摆着时来了接手：登录不被替换，提示出来；点提示摆接手，接手收起后登录面板回来", async ({
  page,
  request,
}) => {
  expect((await request.post("/api/test/live/screen", { data: { on: true } })).status()).toBe(204);
  await login(page);
  await openSettings(page);
  await page.getByTestId("settings-nav-accounts").click();
  const row = page.getByTestId("accounts-page").getByTestId("account-row").filter({ hasText: "要务机械星球" });
  await row.getByTestId("login-open").click();
  await expect(panel(page)).toHaveAttribute("data-purpose", "login");
  const loginLive = await panel(page).getAttribute("data-live-id");

  const liveId = await takeover(request);
  await expect(hint(page, liveId), "登录面板开着也看得到提示").toBeVisible();
  await expect(panel(page), "接手不顶掉用户自己点的登录").toHaveAttribute("data-purpose", "login");

  await hint(page, liveId).getByTestId("takeover-hint-open").click();
  await expect(panel(page)).toHaveAttribute("data-purpose", "takeover");
  await expect(panel(page)).toHaveAttribute("data-state", "live");
  await panel(page).locator("[data-testid=live-end][data-action=finish]").click();

  await expect.poll(() => ends(request, liveId)).toEqual([{ t: "end", action: "finish" }]);
  await expect(panel(page), "登录还在等，面板回到登录").toHaveAttribute("data-purpose", "login");
  await expect(panel(page)).toHaveAttribute("data-live-id", loginLive ?? "");
  await expect(panel(page)).toHaveAttribute("data-state", "live");
  await expect(row.getByTestId("login-open"), "登录那次点击还在等").toBeDisabled();
});

test("例行页和牌桌上也看得到提示，点得到：例行页上点「稍后」，牌桌上点「打开画面」", async ({ page, request }) => {
  await login(page);
  await openRoutines(page, "小服");
  const onRoutines = await takeover(request);
  await expect(hint(page, onRoutines)).toBeVisible();
  // 点得到就说明没被这一页的东西盖住：Playwright 点之前会核对落点上是不是这个按钮。
  await hint(page, onRoutines).getByTestId("takeover-hint-later").click();
  await expect(hint(page, onRoutines)).toHaveCount(0);

  expect((await page.request.post("/api/poker/test/delay", { data: { ms: null } })).ok(), "牌友出牌挂起").toBe(true);
  const created = z
    .object({ table: z.object({ groupId: z.string() }) })
    .parse(await (await page.request.post("/api/poker/tables", { data: { requestId: "takeover-hint-table" } })).json());
  await page.goto(`/t/${created.table.groupId}`);
  await expect(page.getByTestId("table-page")).toBeVisible();

  const onTable = await takeover(request);
  await expect(hint(page, onTable)).toBeVisible();
  await expect(hint(page, onRoutines), "整页重载后「稍后」不记得了，这条又出来").toBeVisible();
  await page.screenshot({ path: `${SHOT}/p3-takeover-hint-table.png` });
  await hint(page, onTable).getByTestId("takeover-hint-open").click();
  await expect(panel(page)).toHaveAttribute("data-live-id", onTable);
  await expect(page.getByTestId("table-page")).toBeVisible();
});
