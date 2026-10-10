import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { expect, test, login, TEAM_TITLE, type Page } from "./fixtures";

const TEAM_GROUP_ID = "grp_order";

const createRoutine = async (page: Page, data: Record<string, unknown>) => {
  const created = await page.request.post("/api/bots/bot_service/routines", {
    data: {
      instruction: "把这周的订单进度汇总给我",
      triggers: [{ kind: "cron", expr: "0 17 * * 5" }],
      onFailure: "stop_and_tell",
      ...data,
    },
  });
  expect(created.status(), "mock 建例行").toBe(201);
};

const section = (page: Page, title: string) =>
  page.locator(`[data-testid=routine-section][data-section-title="${title}"]`);
const row = (page: Page, name: string) => page.locator(`[data-testid=routine-row][data-routine-name="${name}"]`);

test("例行页按日常和项目分组", async ({ page }) => {
  await login(page);
  await createRoutine(page, { name: "订单周报", groupId: TEAM_GROUP_ID });
  await page.getByTestId("routines-nav").click();

  const sections = page.getByTestId("routine-section");
  await expect(sections, "日常在前，项目按侧栏顺序排在后面").toHaveCount(2);
  await expect(sections.nth(0)).toHaveAttribute("data-section-title", "日常");
  await expect(sections.nth(1)).toHaveAttribute("data-section-title", TEAM_TITLE);
  await expect(section(page, "日常").getByTestId("routine-row"), "不挂项目的留在日常").toHaveText(/每日工单早报/);
  await expect(section(page, TEAM_TITLE).getByTestId("routine-row"), "挂在项目群上的归到那个项目").toHaveText(
    /订单周报/,
  );
  await expect(section(page, "日常").getByTestId("routine-row")).toHaveCount(1);
  await expect(row(page, "订单周报").getByTestId("routine-state"), "三态 chip").toHaveText("在跑");
});

test("auto_paused 的例行有横幅，点恢复后横幅消失、侧栏点灭", async ({ page }) => {
  await login(page);
  const dot = page.getByTestId("routines-nav").getByTestId("routines-alert");
  await expect(dot, "开始时没有自己停了的例行").toHaveCount(0);

  await createRoutine(page, { name: "小红书数据周报", state: "auto_paused" });
  await expect(dot, "推送一到侧栏就亮点，不用先进例行页").toBeVisible();

  await page.getByTestId("routines-nav").click();
  const banner = page.getByTestId("routine-stopped");
  await expect(banner).toHaveCount(1);
  await expect(banner).toContainText("「小红书数据周报」连续 3 次没人看，自己停了");
  await expect(row(page, "小红书数据周报").getByTestId("routine-state")).toHaveText("自己停了");

  const resumed = page.waitForRequest(
    (req) => req.method() === "PATCH" && /\/api\/routines\/[^/]+$/.test(new URL(req.url()).pathname),
  );
  await banner.getByTestId("routine-resume").click();
  expect((await resumed).postDataJSON(), "恢复就是把三态改回 on").toEqual({ state: "on" });

  await expect(banner, "恢复后横幅消失").toHaveCount(0);
  await expect(dot, "侧栏点跟着灭").toHaveCount(0);
  await expect(row(page, "小红书数据周报").getByTestId("routine-state")).toHaveText("在跑");
});

test("点改后跳到对话且输入框有预填", async ({ page }) => {
  await login(page);
  await page.getByTestId("routines-nav").click();
  await row(page, "每日工单早报").getByTestId("routine-edit").click();

  await expect(page.getByTestId("assistant-nav"), "改是回主助理的对话").toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("composer-input"), "输入框预填一句话，不弹表单").toHaveValue("把「每日工单早报」改成");
  await expect(page.getByTestId("composer-input")).toBeFocused();

  // 预填跟着这次跳转走，刷新不再填一遍。
  await page.reload();
  await expect(page.getByTestId("composer-input")).toHaveValue("");

  await page.getByTestId("routines-nav").click();
  await page.getByTestId("routine-new").click();
  await expect(page.getByTestId("assistant-nav"), "新建也回主助理的对话").toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("composer-input")).toHaveValue("加一条例行：");
});

test("确认卡点加上后例行页多一条", async ({ page }) => {
  await login(page);
  await page.getByTestId("routines-nav").click();
  const rows = page.getByTestId("routine-row");
  await expect(rows).toHaveCount(1);

  expect((await page.request.post("/api/test/routine-offer")).status(), "主助理发来一张例行确认卡").toBe(201);
  await page.getByTestId("assistant-nav").click();
  const card = page.getByTestId("message-list").getByTestId("routine-offer");
  await expect(card).toHaveAttribute("data-status", "offered");
  await expect(card).toContainText("同类项目周报");
  await expect(card.getByTestId("routine-offer-when"), "表达式说成人话").toHaveText("每周五 17:00");
  await expect(card.getByTestId("routine-offer-where")).toContainText(TEAM_TITLE);
  await expect(card.getByTestId("routine-offer-boundary")).toHaveText("只读，不发东西");

  await card.getByTestId("routine-offer-add").click();
  await expect(card, "点完卡收起，状态跟着消息走").toHaveAttribute("data-status", "added");

  await page.getByTestId("routines-nav").click();
  await expect(rows, "例行页多一条").toHaveCount(2);
  await expect(section(page, TEAM_TITLE).getByTestId("routine-row")).toHaveAttribute(
    "data-routine-name",
    "同类项目周报",
  );
});

test("打开项目页后发出一次 seen 请求", async ({ page }) => {
  const seen: string[] = [];
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    if (req.method() === "POST" && path.endsWith("/seen")) seen.push(path);
  });
  await login(page);
  expect(seen, "首页扫到不算看过").toEqual([]);

  const sent = page.waitForRequest((req) => req.method() === "POST" && new URL(req.url()).pathname.endsWith("/seen"));
  await page.locator(`[data-testid=group-item][data-group-title="${TEAM_TITLE}"]`).click();
  await expect(page.getByTestId("project-page")).toBeVisible();
  const request = await sent;
  expect((await request.response())?.status(), "mock 收下回 204").toBe(204);

  // 从项目页进同一个项目群还是同一个群，不再记一次。
  await page.getByTestId("project-open-group").click();
  await expect(page.getByTestId("chat")).toBeVisible();
  expect(seen).toEqual([`/api/groups/${TEAM_GROUP_ID}/seen`]);
});

const seedOffer = async (page: Page, data: Record<string, unknown> = {}): Promise<string> => {
  const seeded = await page.request.post("/api/test/routine-offer", { data });
  expect(seeded.status(), "主助理发来一张例行确认卡").toBe(201);
  const { message } = (await seeded.json()) as { message: { id: string } };
  return message.id;
};

const todayOffer = (page: Page) => page.locator("[data-testid=today-row][data-kind=routine_offer]");

test("首页的例行确认卡跟推送出现，点加上后离开待办", async ({ page }) => {
  await login(page);
  await expect(page.getByTestId("today-page")).toBeVisible();
  await expect(todayOffer(page)).toHaveCount(0);

  await seedOffer(page);
  const card = todayOffer(page).getByTestId("routine-offer");
  await expect(card, "新卡一推到，停在首页也看得见，不用切页").toHaveAttribute("data-status", "offered");

  await card.getByTestId("routine-offer-add").click();
  await expect(todayOffer(page), "加上之后卡离开首页待办").toHaveCount(0);

  await page.getByTestId("routines-nav").click();
  await expect(row(page, "同类项目周报"), "例行页多出这一条").toHaveCount(1);
});

test("首页的确认卡在别的窗口结掉后跟着离开", async ({ page }) => {
  await login(page);
  const messageId = await seedOffer(page);
  await expect(todayOffer(page)).toHaveCount(1);

  const decided = await page.request.post(`/api/messages/${messageId}/routine-offer`, {
    data: { decision: "dismiss" },
  });
  expect(decided.status(), "另一个窗口点了不要").toBe(200);
  await expect(todayOffer(page), "推送到了首页就收起这张卡").toHaveCount(0);
});

test("确认失败时卡上说清楚，按钮能再点", async ({ page }) => {
  await login(page);
  await seedOffer(page);
  await page.route("**/api/messages/*/routine-offer", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "复核：确认失败" }) }),
  );
  const card = todayOffer(page).getByTestId("routine-offer");
  await card.getByTestId("routine-offer-add").click();

  await expect(card.getByRole("alert"), "失败原因写在卡上").toContainText("复核：确认失败");
  await expect(card, "没有装作加上了").toHaveAttribute("data-status", "offered");
  await expect(card.getByTestId("routine-offer-add"), "按钮恢复可点，好重试").toBeEnabled();
});

test("确认回 409 时取回权威消息", async ({ page }) => {
  await login(page);
  const messageId = await seedOffer(page);
  await page.route("**/api/messages/*/routine-offer", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "这张卡已经有结论了" }),
    }),
  );
  const fetched = page.waitForRequest(
    (req) => req.method() === "GET" && new URL(req.url()).pathname === `/api/messages/${messageId}`,
  );
  const card = todayOffer(page).getByTestId("routine-offer");
  await card.getByTestId("routine-offer-add").click();
  await fetched;
  await expect(card.getByRole("alert"), "409 也告诉用户").toContainText("这张卡已经有结论了");
});

test("暂停失败时例行页说清楚，状态不变", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  await page.getByTestId("routines-nav").click();
  await page.route("**/api/routines/*", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "复核：暂停失败" }),
        })
      : route.fallback(),
  );
  await row(page, "每日工单早报").getByTestId("routine-toggle").click();

  await expect(page.getByTestId("routine-state-error"), "失败原因可见").toContainText("复核：暂停失败");
  await expect(row(page, "每日工单早报").getByTestId("routine-state"), "没有装作停了").toHaveText("在跑");
  expect(errors, "失败被接住，不成未处理的异常").toEqual([]);
});

test("mock 加上前重认执行者：删了回 404，不在项目群回 400", async ({ page }) => {
  await login(page);
  const decide = (messageId: string) =>
    page.request.post(`/api/messages/${messageId}/routine-offer`, { data: { decision: "add" } });

  const outside = await seedOffer(page, { executorBotId: "bot_assistant" });
  expect((await decide(outside)).status(), "执行者不在目标项目群").toBe(400);
  const nowhere = await seedOffer(page, { groupId: "grp_gone" });
  expect((await decide(nowhere)).status(), "目标项目群已经没了").toBe(400);

  const gone = await seedOffer(page);
  expect((await page.request.delete("/api/bots/bot_service")).status()).toBe(204);
  expect((await decide(gone)).status(), "执行者已经删了").toBe(404);

  const routines = (await (await page.request.get("/api/routines")).json()) as { items: { name: string }[] };
  expect(
    routines.items.map((item) => item.name),
    "三次都没建出例行",
  ).not.toContain("同类项目周报");
});

test("seen 给盖了章的例行各推一条 routine_updated", async ({ page }) => {
  const pushed: { type: string; routine?: { name: string; runs: { seenAt: string | null; status: string }[] } }[] = [];
  page.on("websocket", (ws) =>
    ws.on("framereceived", (frame) => {
      if (typeof frame.payload === "string") pushed.push(JSON.parse(frame.payload) as (typeof pushed)[number]);
    }),
  );
  await login(page);
  expect((await page.request.post("/api/groups/grp_service/seen")).status(), "工单助理的单聊记成看过").toBe(204);
  await expect
    .poll(() => pushed.filter((push) => push.type === "routine_updated" && push.routine?.name === "每日工单早报"))
    .toHaveLength(1);
  const routine = pushed.find((push) => push.type === "routine_updated")?.routine;
  expect(
    routine?.runs.every((run) => run.seenAt !== null),
    "推出去的是盖过章的那份",
  ).toBe(true);
});

test("4000 字连续英文指令不撑破确认卡", async ({ page }) => {
  await login(page);
  await seedOffer(page, { instruction: "x".repeat(4000), name: "y".repeat(40) });
  const widths = async (card: ReturnType<Page["locator"]>) =>
    card.evaluate((node) => ({ client: node.clientWidth, scroll: node.scrollWidth }));

  const onToday = todayOffer(page).getByTestId("routine-offer");
  await expect(onToday).toBeVisible();
  const today = await widths(onToday);
  expect(today.scroll, "首页卡没有横向溢出").toBeLessThanOrEqual(today.client);

  await page.getByTestId("assistant-nav").click();
  const inChat = page.getByTestId("message-list").getByTestId("routine-offer").last();
  await expect(inChat).toBeVisible();
  const chat = await widths(inChat);
  expect(chat.scroll, "聊天里的卡没有横向溢出").toBeLessThanOrEqual(chat.client);
});

test("项目页折叠行的三态 chip 跟例行推送走", async ({ page }) => {
  await login(page);
  await createRoutine(page, { name: "订单周报", groupId: TEAM_GROUP_ID });
  await page.locator(`[data-testid=group-item][data-group-title="${TEAM_TITLE}"]`).click();
  await expect(page.getByTestId("project-page")).toBeVisible();
  await page.getByTestId("project-fold").locator("summary").click();
  const chip = page.getByTestId("project-fold").getByTestId("routine-state");
  await expect(chip).toHaveText("在跑");

  const routines = (await (await page.request.get("/api/routines")).json()) as {
    items: { id: string; name: string }[];
  };
  const id = routines.items.find((item) => item.name === "订单周报")?.id;
  const patch = async (state: string) =>
    expect((await page.request.patch(`/api/routines/${id}`, { data: { state } })).status()).toBe(200);

  await patch("auto_paused");
  await expect(chip, "另一处改成自己停了，项目页跟着变").toHaveText("自己停了");
  await patch("paused");
  await expect(chip).toHaveText("暂停了");
  await patch("on");
  await expect(chip).toHaveText("在跑");
});

// 请求头先发、请求体扣住。服务端发回 100 Continue 的同一段同步代码里就会调起路由，
// 所以收到它时处理函数已经停在读请求体上，两个请求都「进来了」，不用睡一觉去猜。
const holdDecision = async (cookie: string, messageId: string, decision: "add" | "dismiss") => {
  const payload = JSON.stringify({ decision });
  const req = httpRequest({
    hostname: "127.0.0.1",
    port: Number(process.env.E2E_API_PORT ?? "3317"),
    path: `/api/messages/${messageId}/routine-offer`,
    method: "POST",
    headers: {
      cookie,
      expect: "100-continue",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    },
  });
  const status = new Promise<number>((resolve, reject) => {
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
  });
  req.flushHeaders();
  await once(req, "continue");
  return {
    release: () => {
      req.end(payload);
      return status;
    },
  };
};

const SAME_CARD_RACES = [
  { first: "add", second: "add", added: 1, final: "added" },
  { first: "add", second: "dismiss", added: 1, final: "added" },
  { first: "dismiss", second: "add", added: 0, final: "dismissed" },
] as const;

for (const race of SAME_CARD_RACES) {
  test(`两个请求同时拍板同一张卡（先${race.first}后${race.second}）：一个 200、一个 409`, async ({ page, context }) => {
    await login(page);
    const messageId = await seedOffer(page);
    const cookie = (await context.cookies()).map((item) => `${item.name}=${item.value}`).join("; ");

    const first = await holdDecision(cookie, messageId, race.first);
    const second = await holdDecision(cookie, messageId, race.second);
    const statuses = [await first.release(), await second.release()];
    expect(statuses, "先到的拍板成功，后到的看见新状态回 409").toEqual([200, 409]);

    const routines = (await (await page.request.get("/api/routines")).json()) as { items: { name: string }[] };
    expect(
      routines.items.filter((item) => item.name === "同类项目周报"),
      "例行只建出赢家那一条",
    ).toHaveLength(race.added);
    const { message } = (await (await page.request.get(`/api/messages/${messageId}`)).json()) as {
      message: { body: { status: string } };
    };
    expect(message.body.status, "卡的结论是赢家的决定").toBe(race.final);
  });
}
