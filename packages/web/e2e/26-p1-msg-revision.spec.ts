import type { APIRequestContext, Page } from "@playwright/test";
import { expect, login, openSeededBot, test } from "./fixtures";

// 单拉失败每趟要等一个重试间隔，错误处理再落后几秒，三趟加起来会超过默认的 30 秒。
test.describe.configure({ timeout: 60_000 });

// 开发构建挂在 window 上的应用状态，见 state/app.tsx。等确定的状态再断言，不靠两趟请求之间的时间先后。
type Observed = {
  messageGaps?: Record<string, { revision: number; attempts: number }>;
  loads?: Record<string, string>;
};
const observe = (page: Page, messageId: string) =>
  page.evaluate((id) => {
    const state = (window as Window & { __baizeState?: Observed }).__baizeState;
    return { gap: state?.messageGaps?.[id] ?? null, load: state?.loads?.[`message:${id}`] ?? null };
  }, messageId);
const until = (page: Page, messageId: string, ok: (seen: Awaited<ReturnType<typeof observe>>) => boolean) =>
  expect.poll(async () => ok(await observe(page, messageId)), { timeout: 30_000 }).toBe(true);

const singleFetches = (page: Page) => {
  const requested: string[] = [];
  page.on("request", (req) => {
    const id = /\/api\/messages\/(msg_[a-z_]+)$/.exec(req.url())?.[1];
    if (req.method() === "GET" && id !== undefined) requested.push(id);
  });
  return (id: string) => requested.filter((seen) => seen === id).length;
};

// 另造一条能补齐的漏档：它的请求一发出来，说明 MainWindow 又按当时的整张漏档表跑了一遍。
const probe = async (page: Page, request: APIRequestContext, id: string, text: string) => {
  const stored = await request.post("/api/test/messages", {
    data: { groupId: "grp_service", botId: "bot_service", id, text, silent: true, revision: 3 },
  });
  expect(stored.status()).toBe(204);
  const fetched = page.waitForResponse(
    (res) => res.request().method() === "GET" && res.url().endsWith(`/api/messages/${id}`) && res.ok(),
  );
  const streamed = await request.post("/api/test/message-delta", {
    data: { groupId: "grp_service", messageId: id, delta: "半截", done: false, revision: 3 },
  });
  expect(streamed.status()).toBe(204);
  await fetched;
  await expect(page.getByTestId("message-list").getByText(text)).toBeVisible();
};

test("delta 中间漏了几版，不接半截，单独拉回这一条换成服务端的完整正文，哪怕它已落出最近一页历史", async ({
  page,
  request,
}) => {
  await login(page);
  await openSeededBot(page, "小服");
  const list = page.getByTestId("message-list");
  const stored = await request.post("/api/test/messages", {
    data: {
      groupId: "grp_service",
      botId: "bot_service",
      id: "msg_gap",
      text: "缺口：服务端的完整回复",
      silent: true,
      revision: 3,
    },
  });
  expect(stored.status(), "完整回复只落在 mock 里，页面只能从单拉这一条读到").toBe(204);
  for (let i = 0; i < 50; i += 1) {
    const newer = await request.post("/api/test/messages", {
      data: { groupId: "grp_service", text: `后来的第 ${i + 1} 句`, silent: true },
    });
    expect(newer.status()).toBe(204);
  }
  const history = await page.request.get("/api/groups/grp_service/messages");
  const ids = ((await history.json()) as { messages: { id: string }[] }).messages.map((m) => m.id);
  expect(ids, "msg_gap 已落出最近 50 条，重拉历史补不回它").not.toContain("msg_gap");

  const fetched = page.waitForResponse(
    (res) => res.request().method() === "GET" && /\/api\/messages\/msg_gap$/.test(res.url()) && res.ok(),
  );
  const streamed = await request.post("/api/test/message-delta", {
    data: { groupId: "grp_service", messageId: "msg_gap", delta: "缺口：后半截", done: false, revision: 3 },
  });
  expect(streamed.status()).toBe(204);
  await fetched;
  await expect(list.getByText("缺口：服务端的完整回复")).toBeVisible();
  await expect(list.getByText("缺口：后半截"), "漏了版本的 delta 不接上屏").toHaveCount(0);
});

test("单拉漏档那一趟失败了，过一会儿自己再拉一次，补回完整正文，不用等新的推送", async ({ page, request }) => {
  await login(page);
  await openSeededBot(page, "小服");
  const list = page.getByTestId("message-list");
  const stored = await request.post("/api/test/messages", {
    data: {
      groupId: "grp_service",
      botId: "bot_service",
      id: "msg_retry",
      text: "重试：服务端的完整回复",
      silent: true,
      revision: 3,
    },
  });
  expect(stored.status()).toBe(204);
  const faults = await request.post("/api/test/message-fetch-failures", {
    data: { messageId: "msg_retry", count: 1 },
  });
  expect(faults.status(), "下一趟单拉回 503").toBe(204);

  const statuses: number[] = [];
  page.on("response", (res) => {
    if (res.request().method() === "GET" && /\/api\/messages\/msg_retry$/.test(res.url())) statuses.push(res.status());
  });
  const recovered = page.waitForResponse(
    (res) => res.request().method() === "GET" && /\/api\/messages\/msg_retry$/.test(res.url()) && res.ok(),
  );
  const streamed = await request.post("/api/test/message-delta", {
    data: { groupId: "grp_service", messageId: "msg_retry", delta: "重试：后半截", done: false, revision: 3 },
  });
  expect(streamed.status()).toBe(204);
  await recovered;
  await expect(list.getByText("重试：服务端的完整回复")).toBeVisible();
  expect(statuses, "第一趟 503，第二趟由失败计数自己触发").toEqual([503, 200]);
  await expect(list.getByText("重试：后半截"), "漏了版本的 delta 不接上屏").toHaveCount(0);
});

test("单拉回 404 的漏档就此作废，之后别的漏档变化不再带着它重拉", async ({ page, request }) => {
  await login(page);
  await openSeededBot(page, "小服");
  const fetches = singleFetches(page);

  const ghost = await request.post("/api/test/message-delta", {
    data: { groupId: "grp_service", messageId: "msg_missing", delta: "已删：半截", done: false, revision: 3 },
  });
  expect(ghost.status()).toBe(204);
  await until(page, "msg_missing", ({ gap, load }) => gap === null && load === "idle");
  expect(fetches("msg_missing"), "404 当场收尾").toBe(1);

  await probe(page, request, "msg_after_gone", "后来：服务端的完整回复");
  expect(fetches("msg_missing"), "漏档已清掉，别的漏档变化不再带着它拉").toBe(1);
  await expect(page.getByTestId("message-list").getByText("已删：半截")).toHaveCount(0);
});

test("单拉连着失败到上限就停手，不跟着别的漏档变化一直重拉", async ({ page, request }) => {
  await login(page);
  await openSeededBot(page, "小服");
  const fetches = singleFetches(page);
  const stored = await request.post("/api/test/messages", {
    data: {
      groupId: "grp_service",
      botId: "bot_service",
      id: "msg_capped",
      text: "上限：完整",
      silent: true,
      revision: 3,
    },
  });
  expect(stored.status()).toBe(204);
  const faults = await request.post("/api/test/message-fetch-failures", {
    data: { messageId: "msg_capped", count: 10 },
  });
  expect(faults.status()).toBe(204);

  const capped = await request.post("/api/test/message-delta", {
    data: { groupId: "grp_service", messageId: "msg_capped", delta: "上限：半截", done: false, revision: 3 },
  });
  expect(capped.status()).toBe(204);
  // 第三次失败记上、桶也收尾了，MainWindow 对这张漏档表的那一轮已经跑完。
  await until(page, "msg_capped", ({ gap, load }) => gap?.attempts === 3 && load === "failed");
  expect(fetches("msg_capped")).toBe(3);

  await probe(page, request, "msg_probe", "探针：完整");
  expect(fetches("msg_capped"), "连着失败三次就停，等重连或重拉历史再给机会").toBe(3);
  await expect(page.getByTestId("message-list").getByText("上限：半截")).toHaveCount(0);
});

test("单拉在途时又来了一次补拉需求，第一趟回 404：排着的那一趟作废，终态不被后来的失败改写", async ({
  page,
  request,
}) => {
  await login(page);
  await openSeededBot(page, "小服");
  const fetches = singleFetches(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived = () => {};
  const firstArrived = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let routed = 0;
  await page.route(/\/api\/messages\/msg_terminal$/, async (route) => {
    routed += 1;
    if (routed === 1) {
      arrived();
      await held;
      await route.continue();
    } else {
      // 万一排着的那一趟还是发了，让它失败，看终态会不会被改写成失败计数。
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "暂时失败" }),
      });
    }
  });

  const first = await request.post("/api/test/message-delta", {
    data: { groupId: "grp_service", messageId: "msg_terminal", delta: "终态：一", done: false, revision: 3 },
  });
  expect(first.status()).toBe(204);
  await firstArrived;
  const second = await request.post("/api/test/message-delta", {
    data: { groupId: "grp_service", messageId: "msg_terminal", delta: "终态：二", done: false, revision: 4 },
  });
  expect(second.status()).toBe(204);
  // 漏档目标到了 4，MainWindow 已按它再要一趟，撞上在途的第一趟，记成待补。
  await until(page, "msg_terminal", ({ gap, load }) => gap?.revision === 4 && load === "loading");

  release();
  await until(page, "msg_terminal", ({ gap, load }) => gap === null && load === "idle");
  expect(fetches("msg_terminal"), "第一趟 404 之后待补的不再发").toBe(1);

  await probe(page, request, "msg_after_terminal", "终态之后：完整");
  expect(fetches("msg_terminal")).toBe(1);
  await expect(page.getByTestId("message-list").getByText(/终态：/)).toHaveCount(0);
});

type Snapshot = {
  bots: Record<string, unknown>;
  conversations: { groupId: string }[];
  reconnectedAt: number;
  messageGaps: Record<string, { attempts: number }>;
  loads: Record<string, string>;
  messages: Record<"rows" | "early", Record<string, { id: string; body: { text?: string } }[]>>;
};
const snapshot = (page: Page) =>
  page.evaluate(() => (window as Window & { __baizeState?: Snapshot }).__baizeState as Snapshot);

test("入口的 Bot 表早于群表、群里的成员本地还不认识，删一个无关的 Bot 不抹掉这个群的漏档，重连后补回", async ({
  page,
  request,
}) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let botsServed = () => {};
  const botsArrived = new Promise<void>((resolve) => {
    botsServed = resolve;
  });
  await page.route("**/api/bots", async (route) => {
    await route.fulfill({ response: await route.fetch() });
    botsServed();
  });
  await page.route("**/api/groups", async (route) => {
    if (route.request().method() === "GET") await held;
    await route.continue();
  });
  await page.goto("/");
  await page.getByTestId("email-input").fill("chen@baize.dev");
  await page.getByTestId("password-input").fill("baize-dev");
  await page.getByTestId("login-submit").click();
  await botsArrived;

  // 另一个客户端在入口两次读取之间建了两个 Bot 和它们的团队群。
  const botIds: string[] = [];
  for (const name of ["快照之后甲", "快照之后乙"]) {
    const made = await page.request.post("/api/bots", { data: { name } });
    expect(made.status()).toBe(200);
    botIds.push(((await made.json()) as { bot: { id: string } }).bot.id);
  }
  const created = await page.request.post("/api/groups", {
    data: { title: "快照之后团队", botIds, chiefBotId: botIds[0] },
  });
  expect(created.status()).toBe(200);
  const groupId = ((await created.json()) as { group: { id: string } }).group.id;
  release();
  await expect(page.getByTestId("main-window")).toBeVisible();
  await page.unroute("**/api/bots");
  await page.unroute("**/api/groups");
  await expect.poll(async () => (await snapshot(page)).conversations.some((c) => c.groupId === groupId)).toBe(true);
  const entered = await snapshot(page);
  expect(
    botIds.map((id) => entered.bots[id]),
    "Bot 表是建 Bot 之前那一刻的",
  ).toEqual([undefined, undefined]);

  const stored = await request.post("/api/test/messages", {
    data: { groupId, botId: botIds[0], id: "msg_snapshot", text: "快照：服务端的完整回复", silent: true, revision: 3 },
  });
  expect(stored.status()).toBe(204);
  const faults = await request.post("/api/test/message-fetch-failures", {
    data: { messageId: "msg_snapshot", count: 3 },
  });
  expect(faults.status()).toBe(204);
  for (let i = 0; i < 50; i += 1) {
    const newer = await request.post("/api/test/messages", {
      data: { groupId, text: `后来的第 ${i + 1} 句`, silent: true },
    });
    expect(newer.status()).toBe(204);
  }
  const history = await page.request.get(`/api/groups/${groupId}/messages`);
  const ids = ((await history.json()) as { messages: { id: string }[] }).messages.map((m) => m.id);
  expect(ids, "msg_snapshot 已落出最近 50 条，丢了漏档就没有别的路补回").not.toContain("msg_snapshot");

  const fetches = singleFetches(page);
  const streamed = await request.post("/api/test/message-delta", {
    data: { groupId, messageId: "msg_snapshot", delta: "快照：半截", done: true, revision: 3 },
  });
  expect(streamed.status()).toBe(204);
  await until(page, "msg_snapshot", ({ gap, load }) => gap?.attempts === 3 && load === "failed");

  expect((await page.request.delete("/api/bots/bot_sales")).status()).toBe(204);
  await expect.poll(async () => (await snapshot(page)).bots.bot_sales).toBeUndefined();
  expect((await observe(page, "msg_snapshot")).gap, "删的是群外的 Bot，这个群的漏档照留").toMatchObject({
    revision: 3,
    attempts: 3,
  });

  const before = (await snapshot(page)).reconnectedAt;
  expect((await request.post("/api/test/sockets/drop")).status()).toBe(204);
  await expect.poll(async () => (await snapshot(page)).reconnectedAt, { timeout: 15_000 }).toBeGreaterThan(before);
  await until(page, "msg_snapshot", ({ gap, load }) => gap === null && load === "idle");
  expect(fetches("msg_snapshot"), "三次失败之后，重连再给一次机会").toBe(4);
  const { messages } = await snapshot(page);
  const row = (messages.rows[groupId] ?? messages.early[groupId])?.find((m) => m.id === "msg_snapshot");
  expect(row?.body.text, "没打开过的群，补回的那条先放在 early").toBe("快照：服务端的完整回复");
});
