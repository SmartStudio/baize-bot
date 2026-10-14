import { AccountResponse, LoginAccountResponse } from "@baize/shared";
import { expect, login, openSettings, test, type APIRequestContext, type Page } from "./fixtures";

// 核验轮 verify-p1-5-web 的反例。页面里的 WebSocket 换成能从测试里掐断、也能往里塞一条推送的壳，
// 断线模拟成连到一个没人听的端口，重连退避照旧走。
declare global {
  interface Window {
    __sockets?: WebSocket[];
    __blockSockets?: boolean;
  }
}

const LOGIN_ID = "acc_today_login";
const SECOND_ID = "acc_today_login2";

const loginCard = (page: Page, accountId: string) =>
  page.getByTestId("today-pending").locator(`[data-testid=today-row][data-kind=login][data-account-id=${accountId}]`);

const seedLoginCard = async (request: APIRequestContext, slot: 1 | 2 = 1) => {
  const response = await request.post("/api/test/accounts/login-card", { data: { slot } });
  expect(response.status(), "本机一个没登录的小红书号，带一条等着发给它的稿子").toBe(200);
};

const reportLogin = async (request: APIRequestContext, accountId: string, data: object) => {
  const response = await request.post(`/api/test/accounts/${accountId}/login-state`, { data });
  expect(response.status(), "代替电脑代理报登录结果").toBe(204);
};

const setComputer = async (request: APIRequestContext, computerId: string, status: string) => {
  const response = await request.post(`/api/test/computers/${computerId}/status`, { data: { status } });
  expect(response.status()).toBe(204);
};

const wrapSockets = (page: Page) =>
  page.addInitScript(() => {
    const Native = window.WebSocket;
    window.__sockets = [];
    window.__blockSockets = false;
    class TestWebSocket extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(window.__blockSockets ? "ws://127.0.0.1:9" : url, protocols);
        window.__sockets?.push(this);
      }
    }
    Object.defineProperty(window, "WebSocket", { value: TestWebSocket, configurable: true, writable: true });
  });

const cutSockets = (page: Page) =>
  page.evaluate(() => {
    window.__blockSockets = true;
    for (const socket of window.__sockets ?? []) socket.close();
  });

const restoreSockets = async (page: Page) => {
  await page.evaluate(() => {
    window.__blockSockets = false;
  });
  await page.waitForFunction(() => (window.__sockets ?? []).some((socket) => socket.readyState === WebSocket.OPEN));
};

// 点「打开登录窗口」，把 202 里的尝试号带回来。
const openWindow = async (page: Page, accountId: string): Promise<string> => {
  const card = loginCard(page, accountId);
  const responded = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith(`/api/accounts/${accountId}/login`),
  );
  await card.getByTestId("login-open").click();
  const { attempt } = LoginAccountResponse.parse(await (await responded).json());
  await expect(card).toHaveAttribute("data-state", "opening");
  return attempt;
};

const openLoginCard = async (page: Page, request: APIRequestContext) => {
  await wrapSockets(page);
  await seedLoginCard(request);
  await login(page);
  const card = loginCard(page, LOGIN_ID);
  await expect(card).toHaveAttribute("data-state", "needed");
  return card;
};

test("两个号同时登录，一个没成只结算它自己那张卡", async ({ page, request }) => {
  await seedLoginCard(request, 2);
  const first = await openLoginCard(page, request);
  const second = loginCard(page, SECOND_ID);
  await openWindow(page, LOGIN_ID);
  await openWindow(page, SECOND_ID);

  await reportLogin(request, LOGIN_ID, { login: "failed", reason: "window_failed" });
  await expect(first).toHaveAttribute("data-state", "failed");
  await expect(second, "另一个号还在等扫码").toHaveAttribute("data-state", "opening");
  await expect(second.getByTestId("login-open")).toBeDisabled();
});

test("202 之后电脑离线，卡写电脑不在线；再点一次后旧尝试的失败晚到不盖新尝试", async ({ page, request }) => {
  const card = await openLoginCard(page, request);
  const stale = await openWindow(page, LOGIN_ID);

  await setComputer(request, "cmp_local", "sleeping");
  await expect(card).toHaveAttribute("data-state", "offline");
  await expect(card.getByTestId("login-card-note")).toHaveText("本机不在线，打开电脑上的白泽后再点登录。");
  await expect(card.getByTestId("login-open"), "还能再点").toBeEnabled();

  await setComputer(request, "cmp_local", "online");
  const fresh = await openWindow(page, LOGIN_ID);
  expect(fresh).not.toBe(stale);
  await reportLogin(request, LOGIN_ID, { login: "failed", reason: "window_failed", attempt: stale });
  await expect(card, "旧尝试的失败不算").toHaveAttribute("data-state", "opening");
  await reportLogin(request, LOGIN_ID, { login: "failed", reason: "timed_out", attempt: fresh });
  await expect(card).toHaveAttribute("data-state", "failed");
  await expect(card.getByTestId("login-card-note")).toHaveText(
    "登录没成。登录窗口开了很久还没登上，已经收起，账号状态没变，可以再点一次。",
  );
});

test("旧尝试的失败在再点一次之后、新 202 之前到达，不结算新尝试", async ({ page, request }) => {
  const card = await openLoginCard(page, request);
  const stale = await openWindow(page, LOGIN_ID);
  await setComputer(request, "cmp_local", "sleeping");
  await expect(card).toHaveAttribute("data-state", "offline");
  await setComputer(request, "cmp_local", "online");

  // 新点击的 202 被卡住，期间旧尝试的失败先到。
  let release = () => undefined as void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `**/api/accounts/${LOGIN_ID}/login`,
    async (route) => {
      await gate;
      await route.continue();
    },
    { times: 1 },
  );
  const responded = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith(`/api/accounts/${LOGIN_ID}/login`),
  );
  const staleArrived = page.evaluate(
    (attempt) =>
      new Promise<void>((resolve) => {
        for (const socket of window.__sockets ?? []) {
          socket.addEventListener("message", (event) => {
            const data = JSON.parse(String(event.data)) as { type?: string; attempt?: string };
            if (data.type === "login_failed" && data.attempt === attempt) resolve();
          });
        }
      }),
    stale,
  );
  await card.getByTestId("login-open").click();
  await expect(card).toHaveAttribute("data-state", "opening");
  await reportLogin(request, LOGIN_ID, { login: "failed", reason: "window_failed", attempt: stale });
  await staleArrived;
  await expect(card, "202 还没回来，旧尝试的失败也对不上这次的号").toHaveAttribute("data-state", "opening");

  release();
  const { attempt: fresh } = LoginAccountResponse.parse(await (await responded).json());
  expect(fresh).not.toBe(stale);
  await expect(card).toHaveAttribute("data-state", "opening");
  await reportLogin(request, LOGIN_ID, { login: "failed", reason: "timed_out", attempt: fresh });
  await expect(card).toHaveAttribute("data-state", "failed");
  await expect(card.getByTestId("login-card-note")).toHaveText(
    "登录没成。登录窗口开了很久还没登上，已经收起，账号状态没变，可以再点一次。",
  );
});

test("过期号有稿子等着时首页只放登录卡，待办数和菜单栏一致", async ({ page, request }) => {
  expect((await request.post("/api/test/today", { data: { mode: "full" } })).status()).toBe(204);
  await login(page);
  const rows = page.getByTestId("today-pending").getByTestId("today-row");
  await expect(rows.first()).toBeVisible();
  await expect(loginCard(page, "acc_today_xhs"), "过期的小红书号有稿子等着，放登录卡").toHaveCount(1);
  await expect(
    page
      .getByTestId("today-pending")
      .locator("[data-testid=today-row][data-kind=account]", { hasText: "要务机械星球" }),
    "同一个号不再另列一行过期",
  ).toHaveCount(0);
  await expect(page.getByTestId("today-count"), "侧栏待办数等于列表条数").toHaveText(String(await rows.count()));
  const homeCount = await page.getByTestId("today-count").textContent();

  await page.goto("/menubar");
  const menubar = page.getByTestId("menubar-page");
  await expect(menubar).toContainText(`${homeCount} 件等你`);
  const menubarRows = menubar.getByTestId("today-row");
  await expect(menubarRows, "菜单栏不放卡，过期号照原样一行，条数和首页一样").toHaveCount(Number(homeCount));
  await expect(menubarRows.filter({ hasText: "要务机械星球" })).toHaveCount(1);
});

test("没登录的号有稿子等着，首页行数、侧栏、标题、菜单栏行数和数字五者一致", async ({ page, request }) => {
  expect((await request.post("/api/test/today", { data: { mode: "full" } })).status()).toBe(204);
  await seedLoginCard(request);
  await login(page);
  const rows = page.getByTestId("today-pending").getByTestId("today-row");
  await expect(loginCard(page, LOGIN_ID), "没登录的小红书号有稿子等着，放登录卡").toHaveCount(1);
  const homeRows = await rows.count();
  await expect(
    page.getByTestId("today-pending").locator(`[data-testid=today-row][data-kind=account]`, { hasText: "还没登录" }),
    "登录卡换掉服务端那行，不再另列",
  ).toHaveCount(0);
  await expect(page.getByTestId("today-count"), "侧栏待办数等于首页可见行数").toHaveText(String(homeRows));
  await expect(page.locator(".today-greeting p"), "首页标题数字等于可见行数").toHaveText(
    `${homeRows} 件事等你，其余在按计划跑。`,
  );

  await page.goto("/menubar");
  const menubar = page.getByTestId("menubar-page");
  await expect(menubar.locator(".menubar-head strong")).toHaveText(`${homeRows} 件等你`);
  await expect(menubar.locator(".menubar-count"), "菜单栏数字").toHaveText(String(homeRows));
  await expect(menubar.getByTestId("today-row"), "菜单栏不放卡，没登录的号照原样一行").toHaveCount(homeRows);
  const placeholderRow = menubar.locator("[data-testid=today-row][data-kind=account]", { hasText: "还没登录" });
  await expect(placeholderRow).toHaveCount(1);
  await expect(placeholderRow, "没登录不是过期").not.toContainText("登录过期");
});

test("断线期间登上了，重连后卡变成已登录", async ({ page, request }) => {
  const card = await openLoginCard(page, request);
  await openWindow(page, LOGIN_ID);
  await cutSockets(page);
  await reportLogin(request, LOGIN_ID, { login: "valid", handle: "断线时登上的小王" });
  await restoreSockets(page);
  await expect(card).toHaveAttribute("data-state", "signed_in");
  await expect(card.getByTestId("login-card-title")).toHaveText("断线时登上的小王 已登录 · 本机");
});

test("等太久没结果，卡说没等到，还能再点", async ({ page, request }) => {
  await page.clock.install();
  const card = await openLoginCard(page, request);
  await openWindow(page, LOGIN_ID);
  await page.clock.runFor(149_000);
  await expect(card).toHaveAttribute("data-state", "opening");
  await page.clock.runFor(2_000);
  await expect(card).toHaveAttribute("data-state", "lapsed");
  await expect(card.getByTestId("login-card-note")).toHaveText("没等到登录结果，可以再点一次登录。");
  await expect(card.getByTestId("login-open")).toBeEnabled();
});

test("断线时批准了稿子，登录卡跟着走", async ({ page, request }) => {
  const card = await openLoginCard(page, request);
  await cutSockets(page);
  const draftRow = card.locator("xpath=following-sibling::*[1]");
  await draftRow.getByTestId("today-expand").click();
  await draftRow.getByTestId("draft-approve").click();
  await expect(card).toHaveCount(0);
  await expect(
    page.getByTestId("today-pending").getByTestId("today-row").filter({ hasText: "车间主任的一天" }),
    "清单也自己重拉了，批掉的稿子不再列在等你确认里",
  ).toHaveCount(0);
});

test("没有稿子等着的过期号，今天页也换成能当场扫码的登录卡，不再是只能点去账号页的一行", async ({ page, request }) => {
  await login(page);
  const created = await page.request.post("/api/accounts", {
    data: { platform: "xiaohongshu", computerId: "cmp_local" },
  });
  expect([200, 201]).toContain(created.status());
  const { account } = AccountResponse.parse(await created.json());
  await reportLogin(request, account.id, { login: "valid", handle: "没稿子的号" });
  await reportLogin(request, account.id, { login: "expired" });
  await page.reload();

  const rows = page.getByTestId("today-pending").locator("[data-testid=today-row][data-kind=account]");
  await expect(rows.filter({ hasText: "没稿子的号" })).toHaveCount(0);
  await expect(loginCard(page, account.id)).toHaveAttribute("data-state", "needed");
  await expect(loginCard(page, account.id).getByTestId("login-card-title")).toHaveText(
    "小红书 · 没稿子的号 登录过期了",
  );
});

test("电脑的旧快照晚于状态推送到，账号页仍写推送里的状态", async ({ page, request }) => {
  await wrapSockets(page);
  await login(page);
  const stale = await (await page.request.get("/api/computers")).text();

  // 账号页打开时发出的那次电脑快照被卡住；卡住期间电脑休眠的推送先到，再放行那份还写着在线的旧快照。
  let release = () => undefined as void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived = () => undefined as void;
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await page.route(
    "**/api/computers",
    async (route) => {
      arrived();
      await gate;
      await route.fulfill({ status: 200, contentType: "application/json", body: stale });
    },
    { times: 1 },
  );

  await openSettings(page);
  const opening = page.getByTestId("settings-nav-accounts").click();
  await started;
  await setComputer(request, "cmp_local", "sleeping");
  const head = page.locator("[data-testid=account-group][data-computer-id=cmp_local] [data-testid=account-group-head]");
  await expect(head).toHaveText("本机休眠");
  release();
  await opening;
  await expect(head, "在线那份快照是推送之前发出的请求，不盖它").toHaveText("本机休眠");
});
