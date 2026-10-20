import { LiveFromViewer } from "@baize/shared";
import { z } from "zod";
import { SHOT, expect, login, openSettings, test, type APIRequestContext, type Page } from "./fixtures";

// 网页终端：账号与电脑页的云电脑行下面点「打开终端」→ 回 202 只给号 → 「电脑」稍后推 live_session → 面板摆出来。
// mock 的假终端把收到的字原样回显，回滚缓冲每次连上整份补发，和电脑代理的终端一个样。

const Received = z.object({ received: z.array(z.object({ liveId: z.string(), message: LiveFromViewer })) });

const received = async (request: APIRequestContext) =>
  Received.parse(await (await request.get("/api/test/live/received")).json()).received.map((entry) => entry.message);

const typedText = async (request: APIRequestContext) =>
  (await received(request))
    .flatMap((message) => (message.t === "input" && message.input.kind === "term" ? [message.input.data] : []))
    .join("");

const panel = (page: Page) => page.getByTestId("terminal-panel");
const screen = (page: Page) => panel(page).locator(".xterm-rows");
const entry = (page: Page) => page.getByTestId("computer-terminal");

const openComputers = async (page: Page) => {
  await openSettings(page);
  await page.getByTestId("settings-nav-accounts").click();
  await expect(page.getByTestId("computer-list")).toBeVisible();
};

test("云电脑行下面点开终端，打字回显；收起再刷新能回到同一个终端、旧输出补回来；关掉后电脑收到 finish", async ({
  page,
  request,
}) => {
  await login(page);
  await openComputers(page);

  await expect(entry(page), "只有云电脑那一行下面有终端入口，本机没有").toHaveCount(1);
  await expect(entry(page)).toContainText("登录态存在云电脑上，所有 Bot 共用");
  await expect(entry(page).getByTestId("terminal-open")).toHaveText("打开终端");
  await entry(page).getByTestId("terminal-open").click();

  await expect(panel(page), "live_session 推到才摆面板").toBeVisible();
  await expect(panel(page)).toHaveAttribute("data-state", "live");
  await expect(page.getByTestId("settings-window"), "设置窗口还开着，终端在它上面").toBeVisible();
  await expect(screen(page), "连上补发的回滚缓冲写进了 xterm").toContainText("baize@cloud:~$");
  await expect(panel(page).getByTestId("terminal-end")).toHaveText("关掉终端");
  await expect(panel(page).getByTestId("terminal-end")).toHaveAttribute("data-action", "finish");

  await panel(page).locator(".xterm").click();
  await page.keyboard.type("grok login");
  await page.keyboard.press("Enter");
  await expect(screen(page), "字送到电脑、回显回来").toContainText("baize@cloud:~$ grok login");
  await expect.poll(() => typedText(request), { message: "onData 原样发，回车是 \\r" }).toBe("grok login\r");
  const resizes = (await received(request)).flatMap((message) =>
    message.t === "input" && message.input.kind === "resize" ? [message.input] : [],
  );
  expect(resizes.length, "连上就按 xterm 量出来的大小发一次 resize").toBeGreaterThan(0);
  expect(resizes.at(-1)?.cols ?? 0, "量出来的列数是实打实的，不是兜底的最小值").toBeGreaterThan(40);
  await page.screenshot({ path: `${SHOT}/p3-terminal-panel.png` });

  await panel(page).getByTestId("terminal-hide").click();
  await expect(panel(page), "收起只收面板").toHaveCount(0);
  await expect(entry(page).getByTestId("terminal-open"), "终端还在电脑上跑").toHaveText("回到终端");
  expect(
    (await received(request)).filter((message) => message.t === "end"),
    "收起不发结束",
  ).toEqual([]);

  await page.reload();
  await openComputers(page);
  await expect(entry(page).getByTestId("terminal-open"), "刷新后靠 GET /api/live 认出还开着的终端").toHaveText(
    "回到终端",
  );
  await entry(page).getByTestId("terminal-open").click();
  await expect(panel(page)).toHaveAttribute("data-state", "live");
  await expect(screen(page), "重连后整份回滚缓冲补回来，只有一份").toContainText("baize@cloud:~$ grok login");
  await expect(screen(page).getByText("baize@cloud:~$", { exact: false })).toHaveCount(1);

  await panel(page).getByTestId("terminal-end").click();
  await expect(panel(page)).toHaveCount(0);
  await expect
    .poll(async () => (await received(request)).filter((message) => message.t === "end"))
    .toEqual([{ t: "end", action: "finish" }]);
  await expect(entry(page).getByTestId("terminal-open"), "电脑收起终端后按钮回到打开").toHaveText("打开终端");
});

test("云电脑不在线时点打开终端，行上说明白不在线，按钮放开能再点", async ({ page, request }) => {
  const offline = await request.post("/api/test/computers/cmp_remote/status", { data: { status: "sleeping" } });
  expect(offline.status()).toBe(204);
  await login(page);
  await openComputers(page);

  await entry(page).getByTestId("terminal-open").click();
  await expect(entry(page).getByTestId("terminal-open-error")).toHaveText("云电脑不在线，等它连上白泽后再开终端");
  await expect(entry(page).getByTestId("terminal-open")).toBeEnabled();
  await expect(panel(page)).toHaveCount(0);
});

test("电脑断线进宽限：观看者被 1012 关掉，面板不消失、按退避连回来，补发的回滚缓冲清屏重写只有一份", async ({
  page,
  request,
}) => {
  await login(page);
  await openComputers(page);
  await entry(page).getByTestId("terminal-open").click();
  await expect(panel(page)).toHaveAttribute("data-state", "live");
  await expect(screen(page)).toContainText("baize@cloud:~$");
  await panel(page).locator(".xterm").click();
  await page.keyboard.type("codex login");
  await page.keyboard.press("Enter");
  await expect(screen(page)).toContainText("baize@cloud:~$ codex login");

  const liveId = await panel(page).getAttribute("data-live-id");
  const restart = await request.post(`/api/test/live/${liveId}/restart`);
  expect(restart.status()).toBe(204);
  await expect(panel(page), "1012 当断网重连，同一块面板还在").toHaveAttribute("data-state", "reconnecting");
  await expect(panel(page)).toHaveAttribute("data-state", "live");
  await expect(panel(page)).toHaveAttribute("data-live-id", liveId ?? "");
  await expect(screen(page), "重连后补发的回滚缓冲写回来").toContainText("baize@cloud:~$ codex login");
  await expect(
    screen(page).getByText("baize@cloud:~$", { exact: false }),
    "replay 帧上先清屏，旧输出不叠两份",
  ).toHaveCount(1);
});

test("电脑拒开终端：live_closed 一到行上就说没开起来，不干等 20 秒，按钮放开能再点", async ({ page, request }) => {
  await login(page);
  await openComputers(page);
  const refuse = await request.post("/api/test/live/refuse-terminal");
  expect(refuse.status()).toBe(204);

  await entry(page).getByTestId("terminal-open").click();
  await expect(entry(page).getByTestId("terminal-open-error")).toHaveText("终端没开起来，可以再点一次。", {
    timeout: 5_000,
  });
  await expect(entry(page).getByTestId("terminal-open")).toBeEnabled();
  await expect(entry(page).getByTestId("terminal-open")).toHaveText("打开终端");
  await expect(panel(page)).toHaveCount(0);

  await entry(page).getByTestId("terminal-open").click();
  await expect(panel(page), "再点一次，这回电脑开起来了").toHaveAttribute("data-state", "live");
  await expect(entry(page).getByTestId("terminal-open-error"), "开起来了就不再挂着报错").toHaveCount(0);
});
