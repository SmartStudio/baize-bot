import { LiveFromViewer } from "@baize/shared";
import { z } from "zod";
import { SHOT, expect, login, openSettings, test, type APIRequestContext, type Page } from "./fixtures";

// 画面面板：点登录 → 电脑建好登录页推 live_session → 网页按尝试号认领、自动弹面板、连 /api/live/<id> 看画面。
// mock 的画面面默认关着，老的登录用例点了登录不会凭空多出面板；这里每条先打开。

const ACCOUNT = "acc_today_xhs";

const Received = z.object({ received: z.array(z.object({ liveId: z.string(), message: LiveFromViewer })) });

const screenOn = async (request: APIRequestContext) => {
  const response = await request.post("/api/test/live/screen", { data: { on: true } });
  expect(response.status(), "打开 mock 的画面面").toBe(204);
};

const received = async (request: APIRequestContext) =>
  Received.parse(await (await request.get("/api/test/live/received")).json()).received.map((entry) => entry.message);

const loginCard = (page: Page) =>
  page.getByTestId("today-pending").locator(`[data-testid=today-row][data-kind=login][data-account-id=${ACCOUNT}]`);

// 发到这个号的待批稿子先批掉，首页那行才换成能扫码的登录卡，照 26-p1-u7-relogin。
const openTodayLoginCard = async (page: Page) => {
  await login(page);
  const approved = await page.request.post("/api/drafts/draft_today_review", { data: { decision: "approve" } });
  expect(approved.status()).toBe(200);
  await page.reload();
  await expect(loginCard(page)).toHaveAttribute("data-state", "needed");
};

const panel = (page: Page) => page.getByTestId("live-panel");

// 左上角那块红：mock 发的那一帧真画到了画布上，不是只把面板框摆出来。
const cornerPixel = (page: Page) =>
  page.getByTestId("live-canvas").evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext("2d")?.getImageData(10, 10, 1, 1).data;
    return data === undefined ? null : [data[0], data[1], data[2]];
  });

test("首页点登录，面板自己弹出来画出电脑上那一页；点一下、打几个字、粘贴原样发到电脑；电脑收起后面板消失、按钮复位", async ({
  page,
  request,
}) => {
  await screenOn(request);
  await openTodayLoginCard(page);
  const card = loginCard(page);
  await card.getByTestId("login-open").click();

  await expect(panel(page), "按尝试号认领到这次点击的画面，自动弹出").toBeVisible();
  await expect(panel(page)).toHaveAttribute("data-purpose", "login");
  await expect(panel(page)).toHaveAttribute("data-state", "live");
  await expect(panel(page).getByTestId("live-origin"), "地址栏取自浏览器本身").toHaveText(
    "https://www.xiaohongshu.com",
  );
  await expect
    .poll(async () => (await cornerPixel(page))?.[0] ?? 0, { message: "mock 那一帧画上去了" })
    .toBeGreaterThan(190);
  const [, g, b] = (await cornerPixel(page)) ?? [0, 0, 0];
  expect(g, "左上角是红块，不是白底").toBeLessThan(110);
  expect(b, "左上角是红块，不是白底").toBeLessThan(110);

  const ends = panel(page).getByTestId("live-end");
  await expect(ends, "登录只能放弃，登上由电脑判定").toHaveCount(1);
  await expect(ends).toHaveAttribute("data-action", "abandon");
  await expect(ends).toHaveText("不登了");
  await expect(panel(page).getByTestId("live-reveal"), "本机电脑多一个到本机窗口操作").toHaveText("到本机窗口操作");
  await expect(card.getByTestId("login-open"), "面板开着时卡上的按钮还是等你扫码").toBeDisabled();
  await page.screenshot({ path: `${SHOT}/p3-live-login-panel.png` });

  await page.getByTestId("live-canvas").click();
  await page.keyboard.type("ab1");
  await page.getByTestId("live-keys").evaluate((keys: HTMLTextAreaElement) => {
    const data = new DataTransfer();
    data.setData("text/plain", "验证码 123456");
    keys.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await panel(page).getByTestId("live-reveal").click();

  await expect.poll(async () => (await received(request)).filter((message) => message.t === "reveal").length).toBe(1);
  const messages = await received(request);
  const inputs = messages.flatMap((message) => (message.t === "input" ? [message.input] : []));
  const down = inputs.find((input) => input.kind === "mouse" && input.phase === "down");
  expect(down, "点在画布正中").toMatchObject({ kind: "mouse", button: "left", clicks: 1 });
  if (down?.kind !== "mouse") throw new Error("没收到按下");
  expect(down.x).toBeCloseTo(0.5, 1);
  expect(down.y).toBeCloseTo(0.5, 1);
  expect(
    inputs.some((input) => input.kind === "mouse" && input.phase === "up"),
    "按下之后有抬起",
  ).toBe(true);
  const typed = inputs.flatMap((input) => (input.kind === "key" && input.phase === "down" ? [input.text] : []));
  expect(typed, "逐键带上屏的字").toEqual(["a", "b", "1"]);
  expect(inputs.filter((input) => input.kind === "key" && input.phase === "up")).toHaveLength(3);
  expect(
    inputs.filter((input) => input.kind === "text"),
    "粘贴整段上屏",
  ).toEqual([{ kind: "text", text: "验证码 123456" }]);

  const liveId = await panel(page).getAttribute("data-live-id");
  expect((await request.post(`/api/test/live/${liveId}/close`)).status(), "电脑那头收起登录页").toBe(204);
  await expect(panel(page), "会话不在表里就卸掉").toHaveCount(0);
  await expect(card).toHaveAttribute("data-state", "closed");
  await expect(card.getByTestId("login-open"), "按钮复位，要登再点").toBeEnabled();
  await expect(card.getByTestId("login-open")).toHaveText("打开登录窗口");
  await expect(card.getByTestId("login-card-note")).toHaveText("登录页已收起，要登再点一次。");

  await request.post("/api/test/accounts/acc_today_xhs/login-state", {
    data: { login: "valid", handle: "要务机械星球" },
  });
  await expect(card, "画面收起之后晚到的登上照样落上来").toHaveAttribute("data-state", "signed_in");
});

test("账号页点登录，面板盖在设置窗口上；点「不登了」电脑收到 abandon，按钮复位，不记失败", async ({
  page,
  request,
}) => {
  await screenOn(request);
  await login(page);
  await openSettings(page);
  await page.getByTestId("settings-nav-accounts").click();
  const row = page.getByTestId("accounts-page").getByTestId("account-row").filter({ hasText: "要务机械星球" });
  await row.getByTestId("login-open").click();

  await expect(panel(page)).toHaveAttribute("data-state", "live");
  await expect(page.getByTestId("settings-window"), "设置窗口还开着，面板在它上面").toBeVisible();
  await panel(page).getByTestId("live-end").click();

  await expect(panel(page)).toHaveCount(0);
  await expect(row.getByTestId("login-open")).toBeEnabled();
  await expect(row.getByTestId("login-open")).toHaveText("打开登录窗口");
  await expect(row.getByTestId("login-card-note"), "放弃不是失败，不出红字").toHaveCount(0);
  await expect
    .poll(async () => (await received(request)).filter((message) => message.t === "end"))
    .toEqual([{ t: "end", action: "abandon" }]);
});

test("同一台电脑上别处连上来看画面，这边以 4101 被顶掉，说「画面在别的窗口打开了」，点「在这里看」抢回来", async ({
  page,
  request,
}) => {
  await screenOn(request);
  await openTodayLoginCard(page);
  await loginCard(page).getByTestId("login-open").click();
  await expect(panel(page)).toHaveAttribute("data-state", "live");
  const liveId = await panel(page).getAttribute("data-live-id");

  // 另一个标签页连同一个画面：中继一台电脑只留一个观看者，先来的被 4101 顶掉。
  const other = await page.context().newPage();
  await other.goto("/");
  const otherClosed = other.evaluate(
    (id) =>
      new Promise<number>((resolve) => {
        const socket = new WebSocket(`ws://${window.location.host}/api/live/${id}`);
        socket.addEventListener("message", () => socket.close(1000), { once: true });
        socket.addEventListener("close", (event) => resolve(event.code));
      }),
    liveId,
  );

  await expect(panel(page)).toHaveAttribute("data-state", "replaced");
  await expect(panel(page).getByTestId("live-notice")).toHaveText("画面在别的窗口打开了");
  await expect(panel(page).getByTestId("live-end"), "被顶掉时不能替别处结束").toHaveCount(0);
  await page.screenshot({ path: `${SHOT}/p3-live-replaced.png` });
  expect(await otherClosed, "另一处看完自己关").toBe(1000);
  await other.close();

  await panel(page).getByTestId("live-reclaim").click();
  await expect(panel(page), "点了才抢回来，重新连上").toHaveAttribute("data-state", "live");
  await expect(panel(page).getByTestId("live-notice")).toHaveCount(0);
});

test("看着看着断网：面板说在重连、画面变灰，自己连回来；再断一次时点「不登了」照样送到电脑", async ({
  page,
  request,
}) => {
  await screenOn(request);
  await openTodayLoginCard(page);
  await loginCard(page).getByTestId("login-open").click();
  await expect(panel(page)).toHaveAttribute("data-state", "live");
  const liveId = await panel(page).getAttribute("data-live-id");

  expect((await request.post(`/api/test/live/${liveId}/drop`)).status(), "掐掉观看连接").toBe(204);
  await expect(panel(page)).toHaveAttribute("data-state", "reconnecting");
  await expect(panel(page).getByTestId("live-notice")).toHaveText("画面断了，正在重连…");
  await expect(page.getByTestId("live-canvas"), "旧画面留着但变灰，不让人当成实时的").toHaveClass(/is-stale/);
  await expect(panel(page).getByTestId("live-end"), "断网不等于结束，按钮还在").toHaveCount(1);
  await expect(panel(page), "按退避自己连回来").toHaveAttribute("data-state", "live");
  await expect(panel(page).getByTestId("live-notice")).toHaveCount(0);

  expect((await request.post(`/api/test/live/${liveId}/drop`)).status()).toBe(204);
  await expect(panel(page)).toHaveAttribute("data-state", "reconnecting");
  await panel(page).getByTestId("live-end").click();
  await expect(panel(page)).toHaveCount(0);
  await expect
    .poll(async () => (await received(request)).filter((message) => message.t === "end"))
    .toEqual([{ t: "end", action: "abandon" }]);
  await expect(loginCard(page).getByTestId("login-open")).toBeEnabled();
});
