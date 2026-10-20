import type { Request } from "@playwright/test";
import {
  EMAIL,
  PASSWORD,
  MessageListResponse,
  expect,
  login,
  openBot,
  stubNotifications,
  test,
  type Page,
} from "./fixtures";

declare global {
  interface Window {
    __pushListeners?: ((event: MessageEvent) => void)[];
    __pushSockets?: number;
  }
}

const HISTORY = "**/api/groups/grp_sales/messages*";

const held = () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
};

const settledOf = (page: Page, request: Request) =>
  new Promise<void>((resolve) => {
    const done = (seen: Request) => {
      if (seen === request) resolve();
    };
    page.on("requestfinished", done);
    page.on("requestfailed", done);
  });

// 记下每条 /api/ws 连接注册的 message 回调和建过几条连接。Vite 的热更新也走 WebSocket，按地址筛掉。
const recordPushSockets = (page: Page) =>
  page.addInitScript(() => {
    const listeners: ((event: MessageEvent) => void)[] = [];
    window.__pushListeners = listeners;
    window.__pushSockets = 0;
    const Native = window.WebSocket;
    const addEventListener = Native.prototype.addEventListener;
    Native.prototype.addEventListener = function (
      this: WebSocket,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type === "message" && this.url.includes("/api/ws") && typeof listener === "function")
        listeners.push(listener as (event: MessageEvent) => void);
      addEventListener.call(this, type, listener, options);
    };
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (String(url).includes("/api/ws")) window.__pushSockets = (window.__pushSockets ?? 0) + 1;
      }
    };
  });

const pageErrors = (page: Page): string[] => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
};

test("登录的入口数据还在路上时改去注册，注册先完成，晚到的登录入口不能盖掉注册会话", async ({ page }) => {
  const entry = held();
  let oldEntry: Request | null = null;
  let oldSettled: Promise<void> = Promise.resolve();
  await page.route("**/api/groups", async (route) => {
    if (route.request().method() !== "GET" || oldEntry !== null) return route.continue();
    oldEntry = route.request();
    oldSettled = settledOf(page, oldEntry);
    const response = await route.fetch();
    await entry.gate;
    await route.fulfill({ response }).catch(() => undefined);
  });

  await page.goto("/");
  await page.getByTestId("register-link").click();
  await expect(page.getByTestId("register")).toBeVisible();
  // 表单忙时去注册的链接是禁掉的，浏览器的前进后退还在，照样能在登录进行中换到注册页。
  await page.goBack();
  await page.getByTestId("email-input").fill(EMAIL);
  await page.getByTestId("password-input").fill(PASSWORD);
  await page.getByTestId("login-submit").click();
  await expect.poll(() => oldEntry !== null, "登录的入口请求已经发出").toBe(true);

  await page.goForward();
  await page.getByTestId("register-email").fill("yi@baize.dev");
  await page.getByTestId("register-password").fill("baize-dev-yi");
  await page.getByTestId("register-name").fill("乙");
  await page.getByTestId("register-submit").click();
  await expect(page.locator(".avatar-user"), "注册的会话先进了主窗口").toHaveText("乙");

  entry.release();
  await oldSettled;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.locator(".avatar-user").textContent(), "最后完成的注册会话不被晚到的登录入口盖掉").toBe("乙");
});

test("登出再登录后，旧连接已经排队的推送回调不弹旧会话的系统通知", async ({ page }) => {
  await stubNotifications(page);
  await recordPushSockets(page);
  const fire = (listener: number, text: string) =>
    page.evaluate(
      ([at, body]) => {
        const push = {
          type: "notify",
          notice: { kind: "result", text: body, groupId: null, at: new Date().toISOString() },
        };
        window.__pushListeners?.[at]?.(new MessageEvent("message", { data: JSON.stringify(push) }));
      },
      [listener, text] as const,
    );

  await login(page);
  await expect.poll(() => page.evaluate(() => window.__pushListeners?.length), "第一次会话的连接挂上了回调").toBe(1);
  await page.getByTestId("account-button").click();
  await page.getByTestId("logout").click();
  await expect(page.getByTestId("login")).toBeVisible();
  await page.getByTestId("email-input").fill(EMAIL);
  await page.getByTestId("password-input").fill(PASSWORD);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("main-window")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__pushListeners?.length), "新会话的连接挂上了回调").toBe(2);

  await fire(0, "旧会话的机密通知");
  await fire(1, "新会话自己的通知");
  const sent = (await page.evaluate(() => window.__notifications?.sent)) ?? [];
  expect(sent.join("\n"), "新会话自己的通知照常弹").toContain("新会话自己的通知");
  expect(sent.join("\n"), "旧连接排队的回调不弹旧会话的通知").not.toContain("旧会话的机密通知");
});

test("群历史首次拉取 500，界面说没拉下来，点重试后历史出现", async ({ page }) => {
  const errors = pageErrors(page);
  let failing = true;
  await page.route(HISTORY, (route) =>
    route.request().method() === "GET" && failing
      ? route.fulfill({ status: 500, json: { error: "服务挂了" } })
      : route.continue(),
  );

  await login(page);
  await openBot(page, "小销");
  await expect(page.getByTestId("history-failed"), "历史没拉下来要说出来").toBeVisible();
  failing = false;
  await page.getByTestId("history-retry").click();
  await expect(page.getByTestId("message-list").getByTestId("message"), "重试后历史到了").not.toHaveCount(0);
  await expect(page.getByTestId("history-failed")).toHaveCount(0);
  expect(errors, "500 不变成未处理的 Promise").toEqual([]);
});

test("例行首次拉取 500，界面说没拉下来，点重试后例行出现", async ({ page }) => {
  const errors = pageErrors(page);
  let failing = true;
  await page.route("**/api/routines", (route) =>
    route.request().method() === "GET" && failing
      ? route.fulfill({ status: 500, json: { error: "服务挂了" } })
      : route.continue(),
  );

  await login(page);
  await page.getByTestId("routines-nav").click();
  await expect(page.getByTestId("routines-failed"), "例行没拉下来要说出来").toBeVisible();
  failing = false;
  await page.getByTestId("routines-retry").click();
  await expect(page.getByTestId("routine-row"), "重试后例行到了").not.toHaveCount(0);
  await expect(page.getByTestId("routines-failed")).toHaveCount(0);
  expect(errors, "500 不变成未处理的 Promise").toEqual([]);
});

test("会做的事首次拉取 500，「它知道的」说没拉下来，点重试后列表出现", async ({ page }) => {
  const errors = pageErrors(page);
  let failing = true;
  await page.route("**/api/bots/*/skills", (route) =>
    route.request().method() === "GET" && failing
      ? route.fulfill({ status: 500, json: { error: "服务挂了" } })
      : route.continue(),
  );

  await login(page);
  await openBot(page, "小销");
  await page.getByTestId("bot-know-toggle").click();
  await expect(page.getByTestId("skills-failed"), "会做的事没拉下来要说出来").toBeVisible();
  failing = false;
  await page.getByTestId("skills-retry").click();
  await expect(page.getByTestId("bot-skill"), "重试后会做的事到了").not.toHaveCount(0);
  expect(errors, "500 不变成未处理的 Promise").toEqual([]);
});

test("连着断线重连三次，同一个群的历史只有一个请求在途，最后显示服务端的完整历史", async ({ page }) => {
  const MISSED = "断线期间别的窗口说的话";
  await recordPushSockets(page);
  await login(page);
  await openBot(page, "小销");
  const list = page.getByTestId("message-list");
  await expect(list.getByTestId("message"), "预置的历史到齐了").not.toHaveCount(0);

  const first = held();
  let requests = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  await page.route(HISTORY, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    requests += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // 服务端在请求到的那一刻读状态，第一趟的回包压到三次重连之后才放。
    const response = await route.fetch();
    if (requests === 1) await first.gate;
    inFlight -= 1;
    await route.fulfill({ response }).catch(() => undefined);
  });

  for (const round of [1, 2, 3]) {
    expect((await page.request.post("/api/test/sockets/drop")).status()).toBe(204);
    if (round === 2) {
      const posted = await page.request.post("/api/test/messages", { data: { groupId: "grp_sales", text: MISSED } });
      expect(posted.status(), "断线时服务端多了一条推不过来的消息").toBe(204);
    }
    await expect.poll(() => page.evaluate(() => window.__pushSockets), `第 ${round} 次重连上了`).toBe(round + 1);
    await expect.poll(() => requests, `第 ${round} 次重连后第一趟历史请求在途`).toBe(1);
  }
  first.release();

  await expect(list.locator("[data-kind=user]", { hasText: MISSED }), "补拉的那一趟带回了断线期间的消息").toHaveCount(
    1,
  );
  expect(maxInFlight, "同一个群的历史请求在途不超过一个").toBe(1);
  expect(requests, "三次重连只补拉了一次").toBe(2);
  const server = MessageListResponse.parse(await (await page.request.get("/api/groups/grp_sales/messages")).json());
  const userTexts = server.messages.flatMap((message) => (message.body.kind === "user" ? [message.body.text] : []));
  await expect(list.locator("[data-kind=user]"), "用户说过的话和服务端一条不差").toHaveCount(userTexts.length);
});

test("服务端登录失效后推送断开，页面回到登录页，不再每秒建新连接", async ({ page }) => {
  await recordPushSockets(page);
  await login(page);
  await expect.poll(() => page.evaluate(() => window.__pushSockets), "推送连上了").toBe(1);

  expect((await page.request.post("/api/test/sessions/expire")).status()).toBe(204);
  await expect(page.getByTestId("login"), "登录失效后回到登录页").toBeVisible();
  await expect(page.getByTestId("login-error")).toHaveText("登录已过期，请重新登录");
  const sockets = await page.evaluate(() => window.__pushSockets);
  await page.waitForTimeout(2_500);
  expect(await page.evaluate(() => window.__pushSockets), "回到登录页之后不再建推送连接").toBe(sockets);
  expect(sockets, "探明登录失效之前没有用失效的登录去重连").toBe(1);
});

test("旧登出的回包晚于 401 之后建立的新会话到达，新会话不被结束", async ({ page }) => {
  await recordPushSockets(page);
  await login(page);
  const gate = held();
  let serverProcessed = false;
  await page.route("**/api/auth/logout", async (route) => {
    const response = await route.fetch();
    serverProcessed = true;
    await gate.gate;
    await route.fulfill({ response }).catch(() => {});
  });

  const logoutRequest = page.waitForRequest("**/api/auth/logout");
  await page.getByTestId("account-button").click();
  await page.getByTestId("logout").click();
  const logoutSettled = settledOf(page, await logoutRequest);
  await expect.poll(() => serverProcessed, "旧登出已在服务端删掉会话").toBe(true);
  expect((await page.request.post("/api/test/sockets/drop")).status()).toBe(204);
  await expect(page.getByTestId("login"), "推送探测到 401 先回登录页").toBeVisible();

  await page.getByTestId("register-link").click();
  await page.getByTestId("register-email").fill("yi-late-logout@baize.dev");
  await page.getByTestId("register-password").fill("baize-dev-yi");
  await page.getByTestId("register-name").fill("乙");
  await page.getByTestId("register-submit").click();
  await expect(page.locator(".avatar-user"), "新会话已建立").toHaveText("乙");

  gate.release();
  await logoutSettled;
  expect((await page.request.get("/api/me")).status(), "新会话的 cookie 没被旧登出清掉").toBe(200);
  await expect(page.locator(".avatar-user"), "晚到的旧登出不能结束新会话").toHaveText("乙");
});
