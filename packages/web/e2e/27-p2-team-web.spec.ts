import { z } from "zod";
import { BotId, BotListResponse, DecideTeamOfferResponse, GroupId, GroupListResponse, MessageId } from "@baize/shared";
import { expect, login, ServerPush, teamCard, test, type Page } from "./fixtures";
import type { ProviderProbe } from "./support/mount-provider";

declare global {
  interface Window {
    __provider?: ProviderProbe;
    __pushOpens?: number;
  }
}

/**
 * 登录后等推送连接在页面上 open 了再往下走。主窗口出来时推送连接可能还在握手，紧跟着造的数据赶在服务端
 * 登记这条连接之前，推送就丢了。Playwright 转发的连接要等服务端握手完成才在页面上触发 open。
 */
const signIn = async (page: Page) => {
  await page.addInitScript(() => {
    window.__pushOpens = 0;
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (!String(url).includes("/api/ws")) return;
        this.addEventListener("open", () => {
          window.__pushOpens = (window.__pushOpens ?? 0) + 1;
        });
      }
    };
  });
  await login(page);
  await page.waitForFunction(() => (window.__pushOpens ?? 0) > 0);
};

const Seeded = z.object({ groupId: GroupId, messageId: MessageId });
type Seeded = z.infer<typeof Seeded>;

const PROJECT = "公众号开号";

/** mock 里塞一张主助理发的建队卡：目标是新建的项目群，人选是已有的小服、建议人选校对和配图。 */
const seedOffer = async (page: Page): Promise<Seeded> => {
  const response = await page.request.post("/api/test/team-offer");
  expect(response.status(), "mock 里塞一张建队卡").toBe(200);
  return Seeded.parse(await response.json());
};

const botCount = async (page: Page): Promise<number> =>
  BotListResponse.parse(await (await page.request.get("/api/bots")).json()).items.length;

const todayRow = (page: Page) =>
  page.getByTestId("today-pending").locator("[data-testid=today-row][data-kind=team_offer]");

const confirmPosts = (page: Page): string[] => {
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/team-offer")) posts.push(request.postData() ?? "");
  });
  return posts;
};

/** 从 start 起扣住这些地址的回包，release 之后一起放。 */
const holdResponses = async (page: Page, patterns: string[]) => {
  let holding = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const pattern of patterns) {
    await page.route(pattern, async (route) => {
      if (holding) await gate;
      await route.continue();
    });
  }
  return {
    start: () => {
      holding = true;
    },
    release: () => release(),
  };
};

const openTodayCard = async (page: Page) => {
  const row = todayRow(page);
  await expect(row, "首页等你确认里出了这张卡").toHaveCount(1);
  await row.getByTestId("today-expand").click();
  const card = row.getByTestId("team-offer");
  await expect(card).toBeVisible();
  return card;
};

test("建队卡勾上建议人选后确认，团队页多一张卡", async ({ page }) => {
  await signIn(page);
  const { groupId } = await seedOffer(page);
  await page.getByTestId("team-nav").click();
  await expect(page.getByTestId("team-bot")).not.toHaveCount(0);
  const before = await page.getByTestId("team-bot").count();
  const botsBefore = await botCount(page);

  await page.getByTestId("today-nav").click();
  const card = await openTodayCard(page);
  await expect(card).toHaveAttribute("data-status", "offered");
  await expect(card, "卡上写着是哪个项目要队伍").toContainText(PROJECT);

  const members = card.getByTestId("team-offer-member");
  await expect(members, "每个人选一行").toHaveCount(3);
  const existing = members.filter({ hasText: "小服" });
  const checker = members.filter({ hasText: "校对" });
  const layout = members.filter({ hasText: "配图" });
  await expect(existing.getByTestId("team-offer-new"), "已有的队员不标新").toHaveCount(0);
  await expect(checker.getByTestId("team-offer-new"), "新请的人标新").toHaveText("新");
  await expect(existing, "每一行都写着为什么要这个人").toContainText("评论");
  await expect(checker).toContainText("发之前再看一遍");
  await expect(existing, "主助理直接提的人默认在队里").toHaveAttribute("data-picked", "true");
  await expect(checker, "建议人选默认不勾").toHaveAttribute("data-picked", "false");
  await expect(layout).toHaveAttribute("data-picked", "false");
  await expect(existing.getByTestId("team-offer-toggle"), "主助理直接提的人也能取消").toHaveText("不加了");

  const confirm = card.getByTestId("team-offer-confirm");
  await expect(confirm).toHaveText("确认组队（1 个）");
  await checker.getByTestId("team-offer-toggle").click();
  await expect(checker, "点加上之后这一行算入队").toHaveAttribute("data-picked", "true");
  await expect(confirm, "按钮上的数跟着勾选走").toHaveText("确认组队（2 个）");

  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/team-offer")) requests.push(request.postData() ?? "");
  });
  await confirm.click();
  await expect
    .poll(() => requests, "只发了一次确认，带着勾上的两行")
    .toEqual([JSON.stringify({ decision: "confirm", picked: [0, 1] })]);

  await page.getByTestId("team-nav").click();
  await expect(page.getByTestId("team-bot"), "团队页多了新请的那一个").toHaveCount(before + 1);
  await expect(teamCard(page, "校对")).toHaveCount(1);
  await expect(teamCard(page, "配图"), "没点加上的建议人选不进团队").toHaveCount(0);
  expect(await botCount(page), "控制面那头也只多一个 Bot").toBe(botsBefore + 1);

  await page.goto(`/p/${groupId}`);
  await page.getByTestId("project-fold").locator("summary").click();
  const fold = page.getByTestId("project-fold");
  await expect(fold, "加进了这个项目群").toContainText("校对");
  await expect(fold).toContainText("小服");
  await expect(fold).not.toContainText("配图");
  await expect(page.getByTestId("project-pending"), "确认过的卡不再等你").not.toContainText(PROJECT);
});

test("先放着之后卡还在等你确认", async ({ page }) => {
  await signIn(page);
  const { groupId } = await seedOffer(page);
  const before = await botCount(page);

  const card = await openTodayCard(page);
  await card.getByTestId("team-offer-defer").click();
  await expect(card, "先放着只改卡的状态").toHaveAttribute("data-status", "deferred");
  await expect(card.getByTestId("team-offer-confirm"), "先放着的卡随时能确认").toBeEnabled();
  await expect(card.getByTestId("team-offer-defer"), "已经放着的卡不再有先放着").toHaveCount(0);
  expect(await botCount(page), "先放着不建人").toBe(before);

  await page.reload();
  await expect(todayRow(page), "刷新后首页等你确认里还有它").toHaveCount(1);
  await todayRow(page).getByTestId("today-expand").click();
  await expect(todayRow(page).getByTestId("team-offer")).toHaveAttribute("data-status", "deferred");

  await page.goto(`/p/${groupId}`);
  const pending = page.getByTestId("project-pending");
  const row = pending.locator("[data-testid=today-row][data-kind=team_offer]");
  await expect(row, "项目页的等你里也有它").toHaveCount(1);
  await row.getByTestId("today-expand").click();
  await row.getByTestId("team-offer-confirm").click();
  await expect(pending, "确认之后才从等你里走").not.toContainText(PROJECT);
  expect(await botCount(page), "确认时配图和校对都没勾，不建人").toBe(before);
});

test("建队卡上没有权限和模型字样", async ({ page }) => {
  await signIn(page);
  const { groupId } = await seedOffer(page);
  const forbidden = /权限|模型/;

  const today = await openTodayCard(page);
  await expect(today.getByTestId("team-offer-confirm"), "查的是真卡，不是一块空白").toBeVisible();
  await expect(today, "首页展开的卡").not.toContainText(forbidden);
  await expect(today.getByRole("combobox"), "卡上没有选模型的下拉").toHaveCount(0);
  await expect(today.getByRole("radio")).toHaveCount(0);

  await page.getByTestId("assistant-nav").click();
  const chat = page.getByTestId("message-list").getByTestId("team-offer");
  await expect(chat, "主助理单聊里是同一张卡").toHaveCount(1);
  await expect(chat.getByTestId("team-offer-confirm")).toBeVisible();
  await expect(chat).not.toContainText(forbidden);
  await expect(chat.getByRole("combobox")).toHaveCount(0);

  await page.goto(`/p/${groupId}`);
  const row = page.getByTestId("project-pending").locator("[data-testid=today-row][data-kind=team_offer]");
  await row.getByTestId("today-expand").click();
  const project = row.getByTestId("team-offer");
  await expect(project.getByTestId("team-offer-confirm")).toBeVisible();
  await expect(project, "项目页等你里的卡").not.toContainText(forbidden);
  await expect(row, "收起的那一行也不带").not.toContainText(forbidden);
});

test("临时帮手的工具行只显示一行人话", async ({ page }) => {
  await signIn(page);
  expect((await page.request.post("/api/test/helper-tool")).status(), "mock 里塞一条临时帮手的工具调用").toBe(200);
  await page.getByTestId("assistant-nav").click();

  const line = page.getByTestId("message-list").locator("[data-testid=tool-call-card][data-view-kind=helper]");
  await expect(line).toHaveCount(1);
  await expect(line, "写的是拉了谁").toContainText("拉临时帮手：资料员");
  await expect(line, "写的是让它干什么").toContainText("整理三家竞品的公众号定价");
  const text = await line.innerText();
  expect(text, "不露工具名、参数和 JSON").not.toMatch(/call_helper|helper|[{}"]/);
  expect(text.trim().split("\n"), "只有一行").toHaveLength(1);
  const fits = await line.evaluate((element) => element.scrollHeight <= element.clientHeight);
  expect(fits, "一行排得下，不撑高").toBe(true);
});

test("项目页队伍折叠里点调整队伍，输入框预填一句话", async ({ page }) => {
  await signIn(page);
  const { groupId } = await seedOffer(page);
  await page.goto(`/p/${groupId}`);
  await page.getByTestId("project-fold").locator("summary").click();

  const messages: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/messages")) messages.push(request.url());
  });
  await page.getByTestId("project-adjust-team").click();
  const input = page.getByTestId("project-composer-input");
  await expect(input).toHaveValue(/^想调整队伍：/);
  await expect(input, "光标落在输入框里，接着写就行").toBeFocused();
  expect(messages, "预填不会自己发出去").toEqual([]);
});

test("默认勾上的已有人选被删了，确认得 409，取消这一行后同一张卡确认成功", async ({ page }) => {
  await signIn(page);
  const { groupId } = await seedOffer(page);
  expect((await page.request.delete("/api/bots/bot_service")).status(), "卡上默认勾上的小服被删了").toBe(204);
  const botsBefore = await botCount(page);
  const posts = confirmPosts(page);

  const card = await openTodayCard(page);
  const members = card.getByTestId("team-offer-member");
  const gone = members.nth(0);
  const checker = members.nth(1);
  await checker.getByTestId("team-offer-toggle").click();
  const confirm = card.getByTestId("team-offer-confirm");
  await confirm.click();
  await expect(card.getByRole("alert"), "控制面说第 1 位不在了").toHaveText("卡上第 1 位已经不在了，重新勾一下");
  await expect(card, "卡原样还在等你").toHaveAttribute("data-status", "offered");
  expect(await botCount(page), "409 不建人").toBe(botsBefore);

  await expect(gone, "被删的人还勾着").toHaveAttribute("data-picked", "true");
  await gone.getByTestId("team-offer-toggle").click();
  await expect(gone, "默认勾上的人能取消").toHaveAttribute("data-picked", "false");
  await expect(checker, "别的勾选不受影响").toHaveAttribute("data-picked", "true");
  await expect(confirm).toHaveText("确认组队（1 个）");
  await confirm.click();
  await expect(todayRow(page), "同一张卡确认成功，从等你里走了").toHaveCount(0);
  expect(posts, "第二次只带还在的校对").toEqual([
    JSON.stringify({ decision: "confirm", picked: [0, 1] }),
    JSON.stringify({ decision: "confirm", picked: [1] }),
  ]);
  expect(await botCount(page), "只多了校对").toBe(botsBefore + 1);

  await page.goto(`/p/${groupId}`);
  await page.getByTestId("project-fold").locator("summary").click();
  await expect(page.getByTestId("project-fold"), "校对进了项目").toContainText("校对");
});

test("加上和不加了来回切，焦点留在同一行的按钮上", async ({ page }) => {
  await signIn(page);
  await seedOffer(page);
  const card = await openTodayCard(page);
  const checker = card.getByTestId("team-offer-member").nth(1);
  const toggle = checker.getByTestId("team-offer-toggle");

  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(checker).toHaveAttribute("data-picked", "true");
  await expect(toggle).toHaveText("不加了");
  await expect(toggle, "加上之后焦点还在这一行的按钮上").toBeFocused();
  await page.keyboard.press("Enter");
  await expect(checker).toHaveAttribute("data-picked", "false");
  await expect(toggle).toHaveText("加上");
  await expect(toggle, "不加了之后焦点也还在").toBeFocused();
});

test("首页确认成功后清单还没刷新，连点和 Enter 都只发一次", async ({ page }) => {
  await signIn(page);
  await seedOffer(page);
  const card = await openTodayCard(page);
  const posts = confirmPosts(page);
  const refresh = await holdResponses(page, ["**/api/today"]);
  refresh.start();

  const confirm = card.getByTestId("team-offer-confirm");
  const answered = page.waitForResponse((response) => response.url().endsWith("/team-offer"));
  await confirm.dblclick();
  expect((await answered).status(), "第一下确认成功").toBe(200);
  await expect(card, "成功之后卡按回包收成已组好，不等清单刷新").toHaveAttribute("data-status", "confirmed");
  await expect(confirm, "已组好的卡没有确认按钮").toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(card.getByRole("alert"), "没有第二趟撞出的「已经处理过了」").toHaveCount(0);

  refresh.release();
  await expect(todayRow(page), "清单刷新回来，卡走了").toHaveCount(0);
  expect(posts, "连点和 Enter 只发了一次").toHaveLength(1);
});

test("项目页确认成功后清单还没刷新，连点和 Enter 都只发一次", async ({ page }) => {
  await signIn(page);
  const { groupId } = await seedOffer(page);
  await page.goto(`/p/${groupId}`);
  const row = page.getByTestId("project-pending").locator("[data-testid=today-row][data-kind=team_offer]");
  await row.getByTestId("today-expand").click();
  const card = row.getByTestId("team-offer");
  const posts = confirmPosts(page);
  const refresh = await holdResponses(page, [`**/api/projects/${groupId}`, "**/api/today"]);
  refresh.start();

  const confirm = card.getByTestId("team-offer-confirm");
  const answered = page.waitForResponse((response) => response.url().endsWith("/team-offer"));
  await confirm.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  expect((await answered).status(), "第一下确认成功").toBe(200);
  await expect(card, "成功之后卡按回包收成已组好，不等清单刷新").toHaveAttribute("data-status", "confirmed");
  await expect(confirm, "已组好的卡没有确认按钮").toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(card.getByRole("alert")).toHaveCount(0);

  refresh.release();
  await expect(row, "清单刷新回来，卡走了").toHaveCount(0);
  expect(posts, "连点和 Enter 只发了一次").toHaveLength(1);
});

test("确认回包晚于后来的队伍推送，旧回包不把新队员盖掉", async ({ page }) => {
  let toPage!: (frame: string) => void;
  await page.routeWebSocket("**/api/ws", (socket) => {
    socket.connectToServer();
    toPage = (frame) => socket.send(frame);
  });
  await signIn(page);
  const { messageId, groupId } = await seedOffer(page);
  await page.goto(`/p/${groupId}`);
  await page.getByTestId("project-fold").locator("summary").click();
  const fold = page.getByTestId("project-fold");
  const row = page.getByTestId("project-pending").locator("[data-testid=today-row][data-kind=team_offer]");
  await row.getByTestId("today-expand").click();

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let captured!: (response: DecideTeamOfferResponse) => void;
  const answer = new Promise<DecideTeamOfferResponse>((resolve) => {
    captured = resolve;
  });
  await page.route(`**/api/messages/${messageId}/team-offer`, async (route) => {
    const response = await route.fetch();
    captured(DecideTeamOfferResponse.parse(await response.json()));
    await held;
    await route.fulfill({ response });
  });
  await row.getByTestId("team-offer-confirm").click();
  const { group } = await answer;
  if (group === null) throw new Error("确认回包里应当带着团队");

  await expect(fold, "回包还扣着，确认自己的队伍推送先到了").toContainText("小服");
  const laterGroup = { ...group, botIds: [...group.botIds, BotId.parse("bot_buy")] };
  toPage(JSON.stringify(ServerPush.parse({ type: "group_updated", group: laterGroup })));
  await expect(fold, "后来的队伍推送加上了小采").toContainText("小采");
  // 这条推送代表服务端后来的名单。旧回包被挡下会换来一次名单补拉，补拉拿到的也该是这份。
  await page.route("**/api/groups", async (route) => {
    const listed = GroupListResponse.parse(await (await route.fetch()).json());
    const items = listed.items.map((item) => (item.group.id === laterGroup.id ? { ...item, group: laterGroup } : item));
    await route.fulfill({ json: { items } });
  });
  // 回包落地后 action 才让项目页重拉，看到这趟重拉就说明旧回包已经写过一遍了。
  const refetched = page.waitForRequest((request) => request.url().endsWith(`/api/projects/${groupId}`));
  release();
  await refetched;
  await expect(row, "确认之后卡走了").toHaveCount(0);
  await expect(fold, "旧回包没把小采盖掉").toContainText("小采");
});

for (const surface of ["today", "project"] as const) {
  for (const refresh of ["stale", "failed"] as const) {
    test(`${surface === "today" ? "首页" : "项目页"}先放着成功后清单${refresh === "stale" ? "回旧快照" : "刷新失败"}，卡照样能改人选、确认，确认后不再发第二趟`, async ({
      page,
    }) => {
      await signIn(page);
      const { messageId, groupId } = await seedOffer(page);
      const url = surface === "today" ? "/api/today" : `/api/projects/${groupId}`;
      let card;
      if (surface === "today") card = await openTodayCard(page);
      else {
        await page.goto(`/p/${groupId}`);
        const row = page.getByTestId("project-pending").locator("[data-testid=today-row][data-kind=team_offer]");
        await row.getByTestId("today-expand").click();
        card = row.getByTestId("team-offer");
      }
      const checker = card.getByTestId("team-offer-member").filter({ hasText: "校对" });
      await checker.getByTestId("team-offer-toggle").click();
      await expect(checker, "先放着之前勾上校对").toHaveAttribute("data-picked", "true");

      const snapshot: unknown = await (await page.request.get(url)).json();
      let loads = 0;
      await page.route(`**${url}`, async (route) => {
        loads += 1;
        await route.fulfill(
          refresh === "stale" ? { status: 200, json: snapshot } : { status: 503, json: { error: "刷新失败" } },
        );
      });
      const posts = confirmPosts(page);
      const deferred = page.waitForResponse((response) => response.url().endsWith(`/messages/${messageId}/team-offer`));
      await card.getByTestId("team-offer-defer").click();
      expect((await deferred).status(), "先放着成功").toBe(200);
      await expect.poll(() => loads, "先放着之后清单重拉过").toBeGreaterThan(0);

      await expect(card, "卡按回包归到先放着").toHaveAttribute("data-status", "deferred");
      await expect(checker, "用户的勾选还在").toHaveAttribute("data-picked", "true");
      await expect(card.getByTestId("team-offer-toggle").first(), "人选能接着改").toBeEnabled();
      const confirm = card.getByTestId("team-offer-confirm");
      await expect(confirm, "放着的卡能确认").toBeEnabled();

      const confirmed = page.waitForResponse((response) =>
        response.url().endsWith(`/messages/${messageId}/team-offer`),
      );
      await confirm.click();
      expect((await confirmed).status(), "确认成功").toBe(200);
      await expect(card, "确认回包把卡收成已组好").toHaveAttribute("data-status", "confirmed");
      await expect(card.getByTestId("team-offer-confirm"), "已确认的卡没有再点的按钮").toHaveCount(0);
      expect(posts, "先放着一趟、带着校对确认一趟").toEqual([
        JSON.stringify({ decision: "defer" }),
        JSON.stringify({ decision: "confirm", picked: [0, 1] }),
      ]);
    });
  }
}

test("确认请求发出后先到首席推送，服务端后处理的确认回包被序号挡掉时补拉群名单", async ({ page }) => {
  let forward = true;
  await page.routeWebSocket("**/api/ws", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((frame) => server.send(frame));
    server.onMessage((frame) => {
      if (forward) socket.send(frame);
    });
  });
  await signIn(page);
  const { messageId, groupId } = await seedOffer(page);
  await page.goto(`/p/${groupId}`);
  const row = page.getByTestId("project-pending").locator("[data-testid=today-row][data-kind=team_offer]");
  await row.getByTestId("today-expand").click();

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let grabbed!: () => void;
  const started = new Promise<void>((resolve) => {
    grabbed = resolve;
  });
  await page.route(`**/api/messages/${messageId}/team-offer`, async (route) => {
    grabbed();
    await held;
    await route.continue();
  });
  await row.getByTestId("team-offer-confirm").click();
  await started;

  await page.getByTestId("project-open-group").click();
  expect(
    (await page.request.post("/api/test/group/updated", { data: { groupId, chiefBotId: "bot_sales" } })).status(),
  ).toBe(204);
  await expect(page.getByTestId("chat-members"), "旧名单的首席推送先到").toContainText("小销首席");
  forward = false;

  const answered = page.waitForResponse((response) => response.url().endsWith(`/messages/${messageId}/team-offer`));
  release();
  const body = DecideTeamOfferResponse.parse(await (await answered).json());
  expect(body.group?.botIds, "服务端放行后才加入小服").toContain("bot_service");
  await expect(page.getByTestId("chat-members"), "被挡掉的回包换来一次名单补拉").toContainText("小服");

  await page.locator(`[data-testid=group-item][data-group-title="${PROJECT}"]`).click();
  await page.getByTestId("project-fold").locator("summary").click();
  await expect(page.getByTestId("project-fold"), "项目页队伍里有小服").toContainText("小服");
});

test("断线期间别处确认了建队卡，重连后补拉群名单", async ({ page }) => {
  const sockets: { close: () => Promise<void> }[] = [];
  let forward = true;
  await page.routeWebSocket("**/api/ws", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((frame) => server.send(frame));
    server.onMessage((frame) => {
      if (forward) socket.send(frame);
    });
    sockets.push(socket);
  });
  await signIn(page);
  const { messageId, groupId } = await seedOffer(page);
  await page.goto(`/p/${groupId}`);
  await page.getByTestId("project-fold").locator("summary").click();
  const fold = page.getByTestId("project-fold");
  await expect(fold).toContainText("小销");
  await expect(fold).not.toContainText("小服");

  forward = false;
  const reply = await page.request.post(`/api/messages/${messageId}/team-offer`, {
    data: { decision: "confirm", picked: [0] },
  });
  expect(reply.status(), "另一处确认成功").toBe(200);
  await expect(fold, "推送断着，页面还不知道").not.toContainText("小服");

  const count = sockets.length;
  const roster = page.waitForResponse((response) => isGroups(response.url()));
  await sockets.at(-1)?.close();
  await expect.poll(() => sockets.length, "应用自己重连").toBe(count + 1);
  forward = true;
  await roster;
  await expect(page.getByTestId("project-pending").locator("[data-kind=team_offer]"), "清单补拉后卡走了").toHaveCount(
    0,
  );
  await expect(fold, "名单补拉后小服进了队伍").toContainText("小服");
});

/** 接管页面的推送：quiet 时服务端的帧不转给页面，send 往页面塞一帧，reconnect 关掉当前连接等应用自己连回来。 */
const wires = async (page: Page) => {
  const sockets: { close: () => Promise<void>; send: (frame: string) => void }[] = [];
  let quiet = false;
  await page.routeWebSocket("**/api/ws", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((frame) => server.send(frame));
    server.onMessage((frame) => {
      if (!quiet) socket.send(frame);
    });
    sockets.push(socket);
  });
  return {
    quiet: (on: boolean) => {
      quiet = on;
    },
    send: (push: unknown) => sockets.at(-1)?.send(JSON.stringify(ServerPush.parse(push))),
    reconnect: async () => {
      const before = sockets.length;
      await sockets.at(-1)?.close();
      await expect.poll(() => sockets.length, "应用自己重连").toBe(before + 1);
    },
  };
};

const projectRow = (page: Page) =>
  page.getByTestId("project-pending").locator("[data-testid=today-row][data-kind=team_offer]");

const projectLink = (page: Page, groupId: string) => page.locator(`[data-testid=group-item][href="/p/${groupId}"]`);

const openProjectCard = async (page: Page, groupId: string) => {
  await projectLink(page, groupId).click();
  const row = projectRow(page);
  await row.getByTestId("today-expand").click();
  const card = row.getByTestId("team-offer");
  await expect(card).toBeVisible();
  return card;
};

// 任务卡补读（for=task）归 28 管，这里只数名单快照和补计数。
const isGroups = (url: string) => {
  const parsed = new URL(url);
  return parsed.pathname === "/api/groups" && parsed.searchParams.get("for") !== "task";
};

for (const surface of ["today", "project"] as const) {
  test(`${surface === "today" ? "首页" : "项目页"}确认成功后清单回旧快照，收起再展开也不再放出确认按钮`, async ({
    page,
  }) => {
    const wire = await wires(page);
    await signIn(page);
    const { groupId } = await seedOffer(page);
    const url = surface === "today" ? "/api/today" : `/api/projects/${groupId}`;
    const snapshot: unknown = await (await page.request.get(url)).json();
    const card = surface === "today" ? await openTodayCard(page) : await openProjectCard(page, groupId);
    wire.quiet(true);
    await page.route(`**${url}`, (route) => route.fulfill({ json: snapshot }));
    const posts = confirmPosts(page);

    await card.getByTestId("team-offer-confirm").click();
    await expect(card, "回包把卡收成已组好").toHaveAttribute("data-status", "confirmed");
    const row = surface === "today" ? todayRow(page) : projectRow(page);
    await row.getByTestId("today-expand").click();
    await row.getByTestId("today-expand").click();
    await expect(card, "重新展开读到全局的终态，不是旧快照的 offered").toHaveAttribute("data-status", "confirmed");
    await expect(card.getByTestId("team-offer-confirm"), "没有可再点的确认").toHaveCount(0);
    expect(posts, "只发过一趟").toHaveLength(1);
  });
}

test("首页确认成功后换到项目页，项目页旧快照里的同一张卡也是已组好", async ({ page }) => {
  const wire = await wires(page);
  await signIn(page);
  const { groupId } = await seedOffer(page);
  const project: unknown = await (await page.request.get(`/api/projects/${groupId}`)).json();
  const today: unknown = await (await page.request.get("/api/today")).json();
  await expect(todayRow(page), "静音之前建队卡的推送已经进了首页").toHaveCount(1);
  wire.quiet(true);
  await page.route(`**/api/projects/${groupId}`, (route) => route.fulfill({ json: project }));
  await page.route("**/api/today", (route) => route.fulfill({ json: today }));
  const card = await openTodayCard(page);
  const posts = confirmPosts(page);
  await card.getByTestId("team-offer-confirm").click();
  await expect(card).toHaveAttribute("data-status", "confirmed");

  const other = await openProjectCard(page, groupId);
  await expect(other, "项目页的卡认回首页点过的终态").toHaveAttribute("data-status", "confirmed");
  await expect(other.getByTestId("team-offer-confirm")).toHaveCount(0);
  expect(posts, "只发过一趟").toHaveLength(1);
});

/** 两张卡各在自己的项目里确认，确认回包都被请求发出后到的首席推送挡掉。A 挡下后的补拉在途时 B 再被挡。 */
const blockedPair = async (page: Page, answerFirst: (route: import("@playwright/test").Route) => Promise<void>) => {
  const wire = await wires(page);
  await signIn(page);
  const a = await seedOffer(page);
  const b = await seedOffer(page);
  const initial = GroupListResponse.parse(await (await page.request.get("/api/groups")).json()).items;
  // 建群推送要走 WebSocket 才进侧栏。不等它们到齐就静音，慢机器上推送被一起挡掉，后面点不到项目链接。
  await expect(projectLink(page, a.groupId), "A 已经在侧栏").toHaveCount(1);
  await expect(projectLink(page, b.groupId), "B 已经在侧栏").toHaveCount(1);
  wire.quiet(true);
  let gets = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let grabbed!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    grabbed = resolve;
  });
  const later: ((route: import("@playwright/test").Route) => Promise<void>)[] = [];
  await page.route("**/api/groups", async (route) => {
    gets += 1;
    if (gets === 1) {
      grabbed();
      await gate;
      await answerFirst(route);
    } else await (later.shift() ?? ((next) => next.continue()))(route);
  });
  const decideBlocked = async (offer: Seeded) => {
    const group = initial.find((item) => item.group.id === offer.groupId)?.group;
    if (group === undefined) throw new Error("清单里应当有这个项目");
    await projectLink(page, offer.groupId).click();
    const row = projectRow(page);
    await row.getByTestId("today-expand").click();
    let answer!: () => void;
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    let captured!: () => void;
    const fetched = new Promise<void>((resolve) => {
      captured = resolve;
    });
    await page.route(`**/api/messages/${offer.messageId}/team-offer`, async (route) => {
      const response = await route.fetch();
      captured();
      await held;
      await route.fulfill({ response });
    });
    await row.getByTestId("team-offer-confirm").click();
    await fetched;
    wire.send({ type: "group_updated", group: { ...group, chiefBotId: "bot_sales" } });
    await page.getByTestId("project-open-group").click();
    await expect(page.getByTestId("chat-members")).toContainText("小销首席");
    const returned = page.waitForResponse((response) =>
      response.url().endsWith(`/messages/${offer.messageId}/team-offer`),
    );
    answer();
    expect((await returned).status()).toBe(200);
  };
  await decideBlocked(a);
  await firstStarted;
  await decideBlocked(b);
  await projectLink(page, b.groupId).click();
  await page.getByTestId("project-fold").locator("summary").click();
  const fold = page.getByTestId("project-fold");
  await expect(fold, "B 的名单还没补上").not.toContainText("小服");
  return { fold, gets: () => gets, release, later };
};

test("名单补拉在途时又被挡了一次，这趟失败后记下的那趟照样补", async ({ page }) => {
  const pair = await blockedPair(page, (route) => route.fulfill({ status: 503, json: { error: "名单补拉失败" } }));
  pair.release();
  await expect(pair.fold, "失败之后接着补，B 的小服回来了").toContainText("小服");
  expect(pair.gets(), "失败一趟、再补一趟").toBe(2);
  await expect(page.getByTestId("groups-stale"), "补上了就没有没刷新的提示").toHaveCount(0);
});

test("名单补拉连着失败三趟就停，给出没刷新的提示，点重试补回来", async ({ page }) => {
  const fail = (route: import("@playwright/test").Route) =>
    route.fulfill({ status: 503, json: { error: "名单补拉失败" } });
  const pair = await blockedPair(page, fail);
  pair.later.push(fail, fail);
  pair.release();
  const stale = page.getByTestId("groups-stale");
  await expect(stale, "连试三趟仍失败，界面说名单没刷新").toContainText("名单没刷新");
  expect(pair.gets(), "提示出来时恰好连试了三趟").toBe(3);
  await expect(pair.fold).not.toContainText("小服");

  await stale.getByRole("button", { name: "重试" }).click();
  await expect(pair.fold, "重试拿到服务端名单").toContainText("小服");
  expect(pair.gets(), "重试只多一趟").toBe(4);
  await expect(stale, "补上后提示消失").toHaveCount(0);
});

test("断线期间别处新建的项目，重连后出现在侧栏，也能进它的项目页", async ({ page }) => {
  const wire = await wires(page);
  await signIn(page);
  wire.quiet(true);
  const answer = await page.request.post("/api/groups", {
    data: { title: "断线时新建的项目", botIds: ["bot_sales", "bot_service"] },
  });
  expect(answer.status()).toBe(200);
  const made = z.object({ group: z.object({ id: GroupId }) }).parse(await answer.json());
  const link = projectLink(page, made.group.id);
  await expect(link, "推送断着，侧栏还没有").toHaveCount(0);

  const roster = page.waitForResponse((response) => isGroups(response.url()));
  await wire.reconnect();
  await roster;
  await expect(link, "名单快照里有的群补进侧栏").toHaveCount(1);
  await link.click();
  await expect(page, "能停在新项目页上").toHaveURL(new RegExp(`/p/${made.group.id}$`));
});

test("快照里没有的项目从侧栏移除，正停在它的项目页上的回首页", async ({ page }) => {
  const wire = await wires(page);
  await signIn(page);
  const listed = GroupListResponse.parse(await (await page.request.get("/api/groups")).json());
  const target = listed.items.find((item) => item.group.botIds.length >= 2);
  if (target === undefined) throw new Error("mock 里应当有一个两人以上的项目");
  const link = projectLink(page, target.group.id);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/p/${target.group.id}$`));

  // 控制面列群只列成员多于一个的；删 Bot 删到只剩一个，群就从列表里消失。这里只镜像列表这一层。
  await page.route("**/api/groups", async (route) => {
    const actual = GroupListResponse.parse(await (await route.fetch()).json());
    await route.fulfill({ json: { items: actual.items.filter((item) => item.group.id !== target.group.id) } });
  });
  const roster = page.waitForResponse((response) => isGroups(response.url()));
  await wire.reconnect();
  await roster;
  await expect(link, "快照里没有的项目移出侧栏").toHaveCount(0);
  await expect(page.getByTestId("today-page"), "停在被移除的项目上的回首页").toBeVisible();
});

test("快照发起之后才推来的新项目，不被这份旧快照移除", async ({ page }) => {
  const wire = await wires(page);
  await signIn(page);
  const before = GroupListResponse.parse(await (await page.request.get("/api/groups")).json());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let grabbed!: () => void;
  const started = new Promise<void>((resolve) => {
    grabbed = resolve;
  });
  await page.route("**/api/groups", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    grabbed();
    await gate;
    await route.fulfill({ json: before });
  });
  await wire.reconnect();
  await started;
  const answer = await page.request.post("/api/groups", {
    data: { title: "补拉途中新建的项目", botIds: ["bot_sales", "bot_service"] },
  });
  const made = z.object({ group: z.object({ id: GroupId }) }).parse(await answer.json());
  const link = projectLink(page, made.group.id);
  await expect(link, "推送带来新项目").toHaveCount(1);

  const roster = page.waitForResponse((response) => isGroups(response.url()));
  release();
  await roster;
  // 旧快照落地后再塞一帧确定会到的推送，它上屏说明快照已经处理过。
  const marker = before.items[0];
  if (marker === undefined) throw new Error("mock 里应当有项目");
  wire.send({ type: "task_updated", task: { ...marker.task, title: "快照之后的标记" } });
  await expect(page.locator('[data-testid=group-item][data-group-title="快照之后的标记"]')).toHaveCount(1);
  await expect(link, "推送比快照新，项目留着").toHaveCount(1);
});

test("断线期间项目里来了审批，重连后侧栏角标按快照补上", async ({ page }) => {
  const wire = await wires(page);
  await signIn(page);
  const { groupId } = await seedOffer(page);
  const badge = projectLink(page, groupId).getByTestId("bot-pending");
  await expect(badge).toHaveCount(0);
  wire.quiet(true);
  const created = await page.request.post("/api/test/approval", { data: { groupId, action: "shell" } });
  expect(created.status()).toBe(201);

  const roster = page.waitForResponse((response) => isGroups(response.url()));
  await wire.reconnect();
  await roster;
  await expect(badge, "角标随快照校正").toHaveText(/等你点头 1/);
});

test("快照发起之后才推来的审批，角标不被旧快照的计数压回去", async ({ page }) => {
  const wire = await wires(page);
  await signIn(page);
  const { groupId } = await seedOffer(page);
  await expect(projectLink(page, groupId), "重连之前项目已经在侧栏，之后只看角标").toHaveCount(1);
  const before = GroupListResponse.parse(await (await page.request.get("/api/groups")).json());
  const badge = projectLink(page, groupId).getByTestId("bot-pending");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let grabbed!: () => void;
  const started = new Promise<void>((resolve) => {
    grabbed = resolve;
  });
  // 只扣重连那趟名单快照，之后的补拉照常放行。
  let held = false;
  await page.route("**/api/groups", async (route) => {
    if (held) return route.continue();
    held = true;
    grabbed();
    await gate;
    await route.fulfill({ json: before });
  });
  await wire.reconnect();
  await started;
  const created = await page.request.post("/api/test/approval", { data: { groupId, action: "shell" } });
  expect(created.status()).toBe(201);
  await expect(badge, "推送换来一趟补拉，角标是服务端数").toHaveText(/等你点头 1/);

  const roster = page.waitForResponse((response) => isGroups(response.url()));
  release();
  await roster;
  const marker = before.items.find((item) => item.group.id === groupId);
  if (marker === undefined) throw new Error("快照里应当有这个项目");
  wire.send({ type: "task_updated", task: { ...marker.task, title: "快照之后的标记" } });
  await expect(page.locator('[data-testid=group-item][data-group-title="快照之后的标记"]')).toHaveCount(1);
  await expect(badge, "更早发出的快照回包不盖掉后发出的补拉").toHaveText(/等你点头 1/);
});

/** 推一帧确定会到的标题改动，它上屏说明前面的回包已经处理完。 */
const settleMarker = async (page: Page, wire: Awaited<ReturnType<typeof wires>>, groupId: string, title: string) => {
  const listed = GroupListResponse.parse(await (await page.request.get("/api/groups")).json());
  const item = listed.items.find((entry) => entry.group.id === groupId);
  if (item === undefined) throw new Error("名单里应当有这个项目");
  wire.send({ type: "task_updated", task: { ...item.task, title } });
  await expect(page.locator(`[data-testid=group-item][data-group-title="${title}"]`)).toHaveCount(1);
};

const backendCounts = async (page: Page, groupId: string) => {
  const listed = GroupListResponse.parse(await (await page.request.get("/api/groups")).json());
  const item = listed.items.find((entry) => entry.group.id === groupId);
  if (item === undefined) throw new Error("名单里应当有这个项目");
  return { approvals: item.pendingApprovals, handoffs: item.pendingHandoffs };
};

const seedApproval = async (page: Page, groupId: string): Promise<{ id: string }> => {
  const response = await page.request.post("/api/test/approval", { data: { groupId, action: "shell" } });
  expect(response.status()).toBe(201);
  return z.object({ approval: z.object({ id: z.string() }) }).parse(await response.json()).approval;
};

const approveById = async (page: Page, id: string): Promise<unknown> => {
  const response = await page.request.post(`/api/approvals/${id}`, { data: { decision: "approved", scope: "once" } });
  expect(response.status()).toBe(200);
  return z.object({ approval: z.unknown() }).parse(await response.json()).approval;
};

const seedHandoff = async (page: Page) => {
  const response = await page.request.post("/api/test/handoff/pending");
  expect(response.status()).toBe(201);
  return z
    .object({ handoff: z.object({ id: z.string(), groupId: GroupId }).passthrough() })
    .parse(await response.json()).handoff;
};

test("批准 A 后断线重连，再进项目拉到 A 已批准的历史，角标仍是剩下的 B 那 1 个", async ({ page }) => {
  const wire = await wires(page);
  await signIn(page);
  const { groupId } = await seedOffer(page);
  await expect(projectLink(page, groupId)).toHaveCount(1);
  const a = await seedApproval(page, groupId);
  await seedApproval(page, groupId);
  const badge = projectLink(page, groupId).getByTestId("bot-pending");
  await expect(badge).toHaveText(/等你点头 2/);
  await projectLink(page, groupId).click();
  await page.getByTestId("project-open-group").click();
  await expect(page.getByTestId("approval-card"), "历史里两张审批都在本地").toHaveCount(2);

  await page.getByTestId("today-nav").click();
  wire.quiet(true);
  await approveById(page, a.id);
  const roster = page.waitForResponse((response) => isGroups(response.url()));
  await wire.reconnect();
  await roster;
  await expect(badge, "重连快照校正成 1").toHaveText(/等你点头 1/);

  const history = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/api/groups/${groupId}/messages`,
  );
  await projectLink(page, groupId).click();
  await history;
  await page.getByTestId("project-open-group").click();
  await expect(page.getByTestId("approval-card")).toHaveCount(2);
  wire.quiet(false);
  await settleMarker(page, wire, groupId, "审批历史合并之后");
  expect((await backendCounts(page, groupId)).approvals, "服务端还剩 B 一个").toBe(1);
  await expect(badge, "历史里 A 的终态已被快照算过，不再扣一次").toHaveText(/等你点头 1/);
});

test("接受交接 A 后断线重连，再进项目拉到 A 已接受的历史，角标仍是剩下的 B 那 1 个", async ({ page }) => {
  const wire = await wires(page);
  await signIn(page);
  const a = await seedHandoff(page);
  const b = await seedHandoff(page);
  const groupId = a.groupId;
  const badge = projectLink(page, groupId).getByTestId("bot-handoff");
  wire.send({ type: "handoff_updated", handoff: a });
  wire.send({ type: "handoff_updated", handoff: b });
  await expect(badge).toHaveText(/等 Bot 确认 2/);

  wire.quiet(true);
  expect((await page.request.post("/api/test/handoff/accept")).status()).toBe(204);
  const roster = page.waitForResponse((response) => isGroups(response.url()));
  await wire.reconnect();
  await roster;
  await expect(badge, "重连快照校正成 1").toHaveText(/等 Bot 确认 1/);

  // mock 造的交接没有消息正文，这里按控制面「群历史附带当前交接状态」的契约把两张交接补进历史。
  const accepted = { ...a, status: "accepted", acceptedAt: new Date().toISOString() };
  await page.route(`**/api/groups/${groupId}/messages`, async (route) => {
    const actual = z
      .object({})
      .passthrough()
      .parse(await (await route.fetch()).json());
    await route.fulfill({ json: { ...actual, handoffs: [accepted, b] } });
  });
  const history = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/api/groups/${groupId}/messages`,
  );
  await projectLink(page, groupId).click();
  await history;
  wire.quiet(false);
  await settleMarker(page, wire, groupId, "交接历史合并之后");
  expect((await backendCounts(page, groupId)).handoffs, "服务端还剩 B 一个").toBe(1);
  await expect(badge, "历史里 A 的终态已被快照算过，不再扣一次").toHaveText(/等 Bot 确认 1/);
});

/** 扣住从现在起第 turns 趟 GET /api/groups：服务端已经拍下计数，回包等 release 才给页面。别的趟数照常放行。
 * late 里的趟数换个扣法：请求先停在浏览器这头，release 之后才到服务端，拿到的是放行那一刻的计数。 */
const holdGroups = async (page: Page, turns: readonly number[], late: readonly number[] = []) => {
  const gates = turns.map(() => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let grabbed!: () => void;
    const started = new Promise<void>((resolve) => {
      grabbed = resolve;
    });
    return { gate, release, started, grabbed };
  });
  let seen = 0;
  await page.route("**/api/groups", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    seen += 1;
    const slot = gates[turns.indexOf(seen)];
    if (slot === undefined) return route.continue();
    if (late.includes(seen)) {
      slot.grabbed();
      await slot.gate;
      return route.continue();
    }
    const response = await route.fetch();
    slot.grabbed();
    await slot.gate;
    await route.fulfill({ response });
  });
  return gates.map(({ started, release }) => ({ started, release }));
};

const holdNextGroups = async (page: Page) => {
  const [first] = await holdGroups(page, [1]);
  if (first === undefined) throw new Error("至少扣一趟");
  return first;
};

/** 从现在起数 GET /api/groups 回了几趟。 */
const groupsReturned = (page: Page) => {
  let returned = 0;
  page.on("response", (response) => {
    if (isGroups(response.url()) && response.request().method() === "GET") returned += 1;
  });
  return () => returned;
};

const acceptHandoff = async (page: Page) =>
  expect((await page.request.post("/api/test/handoff/accept")).status()).toBe(204);

test("审批终态触发补计数，回包前又来新审批，在途回来后再补一趟，角标是服务端数", async ({ page }) => {
  const wire = await wires(page);
  await signIn(page);
  const { groupId } = await seedOffer(page);
  await expect(projectLink(page, groupId)).toHaveCount(1);
  const badge = projectLink(page, groupId).getByTestId("bot-pending");
  wire.quiet(true);
  const a = await seedApproval(page, groupId);
  const terminal = await approveById(page, a.id);
  const held = await holdNextGroups(page);
  wire.send({ type: "approval_updated", approval: terminal });
  await held.started;

  wire.quiet(false);
  await seedApproval(page, groupId);
  const returned = groupsReturned(page);
  held.release();
  await expect.poll(returned, "在途那趟回来后，脏标换来第二趟").toBe(2);
  await settleMarker(page, wire, groupId, "审批补计数落地之后");
  expect((await backendCounts(page, groupId)).approvals).toBe(1);
  await expect(badge, "在途期间来的审批由第二趟补上").toHaveText(/等你点头 1/);
});

test("交接终态触发补计数，回包前又来新交接，在途回来后再补一趟，角标是服务端数", async ({ page }) => {
  const wire = await wires(page);
  await signIn(page);
  wire.quiet(true);
  const a = await seedHandoff(page);
  const groupId = a.groupId;
  const badge = projectLink(page, groupId).getByTestId("bot-handoff");
  await acceptHandoff(page);
  const held = await holdNextGroups(page);
  wire.send({ type: "handoff_updated", handoff: { ...a, status: "accepted", acceptedAt: new Date().toISOString() } });
  await held.started;

  wire.quiet(false);
  const b = await seedHandoff(page);
  wire.send({ type: "handoff_updated", handoff: b });
  const returned = groupsReturned(page);
  held.release();
  await expect.poll(returned, "在途那趟回来后，脏标换来第二趟").toBe(2);
  await settleMarker(page, wire, groupId, "交接补计数落地之后");
  expect((await backendCounts(page, groupId)).handoffs).toBe(1);
  await expect(badge, "在途期间来的交接由第二趟补上").toHaveText(/等 Bot 确认 1/);
});

test("R5-1 快照已算过 A 的批准，A 的终态推送晚到，角标不再扣一次", async ({ page }) => {
  const wire = await wires(page);
  await signIn(page);
  const { groupId } = await seedOffer(page);
  await expect(projectLink(page, groupId)).toHaveCount(1);
  const badge = projectLink(page, groupId).getByTestId("bot-pending");
  const a = await seedApproval(page, groupId);
  await seedApproval(page, groupId);
  await expect(badge).toHaveText(/等你点头 2/);

  wire.quiet(true);
  const terminal = await approveById(page, a.id);
  const held = await holdNextGroups(page);
  await wire.reconnect();
  await held.started;
  const roster = page.waitForResponse((response) => isGroups(response.url()));
  held.release();
  await roster;
  await expect(badge, "重连快照校正成 1").toHaveText(/等你点头 1/);

  const refreshed = page.waitForResponse((response) => isGroups(response.url()));
  wire.send({ type: "approval_updated", approval: terminal });
  await refreshed;
  await settleMarker(page, wire, groupId, "A 的终态晚到之后");
  expect((await backendCounts(page, groupId)).approvals).toBe(1);
  await expect(badge, "晚到的终态只换来补拉，不扣本地的数").toHaveText(/等你点头 1/);
});

test("R5-1 快照已算过 A 的接受，A 的终态推送晚到，角标不再扣一次", async ({ page }) => {
  const wire = await wires(page);
  await signIn(page);
  const a = await seedHandoff(page);
  const b = await seedHandoff(page);
  const groupId = a.groupId;
  const badge = projectLink(page, groupId).getByTestId("bot-handoff");
  wire.send({ type: "handoff_updated", handoff: a });
  wire.send({ type: "handoff_updated", handoff: b });
  await expect(badge).toHaveText(/等 Bot 确认 2/);

  wire.quiet(true);
  await acceptHandoff(page);
  const held = await holdNextGroups(page);
  await wire.reconnect();
  await held.started;
  const roster = page.waitForResponse((response) => isGroups(response.url()));
  held.release();
  await roster;
  await expect(badge, "重连快照校正成 1").toHaveText(/等 Bot 确认 1/);

  const refreshed = page.waitForResponse((response) => isGroups(response.url()));
  wire.send({ type: "handoff_updated", handoff: { ...a, status: "accepted", acceptedAt: new Date().toISOString() } });
  await refreshed;
  await settleMarker(page, wire, groupId, "A 的终态晚到之后");
  expect((await backendCounts(page, groupId)).handoffs).toBe(1);
  await expect(badge, "晚到的终态只换来补拉，不扣本地的数").toHaveText(/等 Bot 确认 1/);
});

test("R5-2 重连快照扣在路上，期间新审批换来更晚的补拉，旧快照放行后角标仍是服务端数", async ({ page }) => {
  const wire = await wires(page);
  await signIn(page);
  const { groupId } = await seedOffer(page);
  await expect(projectLink(page, groupId)).toHaveCount(1);
  const badge = projectLink(page, groupId).getByTestId("bot-pending");
  const a = await seedApproval(page, groupId);
  const b = await seedApproval(page, groupId);
  await expect(badge).toHaveText(/等你点头 2/);

  wire.quiet(true);
  await approveById(page, a.id);
  await approveById(page, b.id);
  const held = await holdNextGroups(page);
  await wire.reconnect();
  await held.started;

  wire.quiet(false);
  await seedApproval(page, groupId);
  await expect(badge, "新审批换来的补拉：服务端只剩它一个").toHaveText(/等你点头 1/);
  const stale = page.waitForResponse((response) => isGroups(response.url()));
  held.release();
  await stale;
  await settleMarker(page, wire, groupId, "旧快照放行之后");
  expect((await backendCounts(page, groupId)).approvals).toBe(1);
  await expect(badge, "更早发出的快照不盖掉更晚发出的补拉").toHaveText(/等你点头 1/);
});

test("R5-2 重连快照扣在路上，期间新交接换来更晚的补拉，旧快照放行后角标仍是服务端数", async ({ page }) => {
  const wire = await wires(page);
  await signIn(page);
  const a = await seedHandoff(page);
  const b = await seedHandoff(page);
  const groupId = a.groupId;
  const badge = projectLink(page, groupId).getByTestId("bot-handoff");
  wire.send({ type: "handoff_updated", handoff: a });
  wire.send({ type: "handoff_updated", handoff: b });
  await expect(badge).toHaveText(/等 Bot 确认 2/);

  wire.quiet(true);
  await acceptHandoff(page);
  await acceptHandoff(page);
  const held = await holdNextGroups(page);
  await wire.reconnect();
  await held.started;

  wire.quiet(false);
  const c = await seedHandoff(page);
  wire.send({ type: "handoff_updated", handoff: c });
  await expect(badge, "新交接换来的补拉：服务端只剩它一个").toHaveText(/等 Bot 确认 1/);
  const stale = page.waitForResponse((response) => isGroups(response.url()));
  held.release();
  await stale;
  await settleMarker(page, wire, groupId, "旧快照放行之后");
  expect((await backendCounts(page, groupId)).handoffs).toBe(1);
  await expect(badge, "更早发出的快照不盖掉更晚发出的补拉").toHaveText(/等 Bot 确认 1/);
});

test("补拉扣在路上，重连快照先落地，旧补拉放行后不把角标改回去", async ({ page }) => {
  const wire = await wires(page);
  await signIn(page);
  const { groupId } = await seedOffer(page);
  await expect(projectLink(page, groupId)).toHaveCount(1);
  const badge = projectLink(page, groupId).getByTestId("bot-pending");
  const a = await seedApproval(page, groupId);
  const b = await seedApproval(page, groupId);
  await expect(badge).toHaveText(/等你点头 2/);

  wire.quiet(true);
  const terminal = await approveById(page, a.id);
  // 第一趟是终态推送换来的补拉，第二趟是重连的名单快照，第三趟是在途期间标脏后的再补拉。
  const [stale, dirty] = await holdGroups(page, [1, 3]);
  if (stale === undefined || dirty === undefined) throw new Error("扣两趟");
  wire.send({ type: "approval_updated", approval: terminal });
  await stale.started;
  await approveById(page, b.id);
  const roster = page.waitForResponse((response) => isGroups(response.url()));
  await wire.reconnect();
  await roster;
  await expect(badge, "重连快照：两张都批了").toHaveCount(0);

  const released = page.waitForResponse((response) => isGroups(response.url()));
  stale.release();
  await released;
  await settleMarker(page, wire, groupId, "旧补拉放行之后");
  expect((await backendCounts(page, groupId)).approvals).toBe(0);
  await expect(badge, "更早发出的补拉回包不盖掉更晚发出的快照").toHaveCount(0);
  dirty.release();
  await settleMarker(page, wire, groupId, "再补拉之后");
  await expect(badge).toHaveCount(0);
});

for (const surface of ["today", "project"] as const) {
  test(`${surface === "today" ? "首页" : "项目页"}确认还在途时收起再展开，新展开的卡仍锁着，不发第二趟`, async ({
    page,
  }) => {
    const wire = await wires(page);
    await signIn(page);
    const { messageId, groupId } = await seedOffer(page);
    const card = surface === "today" ? await openTodayCard(page) : await openProjectCard(page, groupId);
    wire.quiet(true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    await page.route(`**/api/messages/${messageId}/team-offer`, async (route) => {
      calls += 1;
      await gate;
      await route.continue();
    });
    await card.getByTestId("team-offer-confirm").click();
    await expect.poll(() => calls, "第一趟发出去了").toBe(1);
    const row = surface === "today" ? todayRow(page) : projectRow(page);
    await row.getByTestId("today-expand").click();
    await row.getByTestId("today-expand").click();
    const confirm = card.getByTestId("team-offer-confirm");
    await expect(confirm, "新实例读到全局在途，按钮锁着").toBeDisabled();
    await confirm.click({ force: true });
    expect(calls - 1, "在途期间第二次 POST 计数为 0").toBe(0);

    release();
    await expect(card, "第一趟成功，卡收成已组好").toHaveAttribute("data-status", "confirmed");
    expect(calls, "前后只发过一趟").toBe(1);
  });
}

test("确认失败清掉在途，重新展开的卡回到原状态可以重试", async ({ page }) => {
  const wire = await wires(page);
  await signIn(page);
  const { messageId } = await seedOffer(page);
  const card = await openTodayCard(page);
  await card.getByTestId("team-offer-defer").click();
  await expect(card).toHaveAttribute("data-status", "deferred");
  wire.quiet(true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let failNext = true;
  await page.route(`**/api/messages/${messageId}/team-offer`, async (route) => {
    if (!failNext) return route.continue();
    failNext = false;
    await gate;
    return route.fulfill({ status: 503, json: { error: "上游忙" } });
  });
  await card.getByTestId("team-offer-confirm").click();
  const row = todayRow(page);
  await row.getByTestId("today-expand").click();
  await row.getByTestId("today-expand").click();
  await expect(card.getByTestId("team-offer-confirm"), "在途时锁着").toBeDisabled();
  release();
  await expect(card.getByTestId("team-offer-confirm"), "失败后在途清掉，可以重试").toBeEnabled();
  await expect(card).toHaveAttribute("data-status", "deferred");
  await card.getByTestId("team-offer-confirm").click();
  await expect(card).toHaveAttribute("data-status", "confirmed");
});

test("R6-1 新项目还没进侧栏时较新的补计数先回，旧名单随后放行，角标用较新的那份", async ({ page }) => {
  const wire = await wires(page);
  await signIn(page);
  const listed = GroupListResponse.parse(await (await page.request.get("/api/groups")).json());
  const marker = listed.items[0];
  if (marker === undefined) throw new Error("mock 里应当有项目");
  wire.quiet(true);
  const answer = await page.request.post("/api/groups", {
    data: { title: "断线期间的新项目", botIds: ["bot_sales", "bot_service"] },
  });
  expect(answer.ok(), "mock 建出新项目").toBe(true);
  const groupId = z.object({ group: z.object({ id: GroupId }) }).parse(await answer.json()).group.id;
  const link = projectLink(page, groupId);
  await expect(link, "推送静音，新项目还没进侧栏").toHaveCount(0);

  const [roster, counts] = await holdGroups(page, [1, 2], [2]);
  if (roster === undefined || counts === undefined) throw new Error("扣两趟");
  await wire.reconnect();
  await roster.started;
  await counts.started;
  await seedApproval(page, groupId);
  const fresh = page.waitForResponse((response) => isGroups(response.url()));
  counts.release();
  await fresh;
  await settleMarker(page, wire, marker.group.id, "补计数落地之后");
  await expect(link, "旧名单还扣着，新项目仍不在侧栏").toHaveCount(0);

  const stale = page.waitForResponse((response) => isGroups(response.url()));
  roster.release();
  await stale;
  await expect(link).toHaveCount(1);
  await settleMarker(page, wire, marker.group.id, "旧名单落地之后");
  expect((await backendCounts(page, groupId)).approvals, "服务端有 1 个待批").toBe(1);
  await expect(link.getByTestId("bot-pending"), "入列前收到的较新计数不被旧名单的 0 盖掉").toHaveText(/等你点头 1/);
});

test("R6-2 补计数遇到一趟 503，自己重试，角标回到服务端数", async ({ page }) => {
  await signIn(page);
  const { groupId } = await seedOffer(page);
  const link = projectLink(page, groupId);
  await expect(link).toHaveCount(1);
  let failures = 1;
  await page.route("**/api/groups", (route) => {
    if (route.request().method() !== "GET" || failures === 0) return route.continue();
    failures -= 1;
    return route.fulfill({ status: 503, json: { error: "补计数失败" } });
  });
  const failed = page.waitForResponse((response) => isGroups(response.url()) && response.status() === 503);
  await seedApproval(page, groupId);
  await failed;
  expect((await backendCounts(page, groupId)).approvals, "服务端有 1 个待批").toBe(1);
  await expect(link.getByTestId("bot-pending"), "失败的那趟不能把校正丢掉").toHaveText(/等你点头 1/);
  await expect(page.getByTestId("counts-stale"), "重试成功就不留失败提示").toHaveCount(0);
});

test("R6-2 补计数连着失败就停，侧栏给出没刷新的提示，点重试补回来", async ({ page }) => {
  await signIn(page);
  const { groupId } = await seedOffer(page);
  const link = projectLink(page, groupId);
  await expect(link).toHaveCount(1);
  let failing = true;
  await page.route("**/api/groups", (route) => {
    if (route.request().method() !== "GET" || !failing) return route.continue();
    return route.fulfill({ status: 503, json: { error: "补计数失败" } });
  });
  await seedApproval(page, groupId);
  const stale = page.getByTestId("counts-stale");
  await expect(stale, "重试用尽后给出看得见的失败态").toBeVisible();
  await expect(link.getByTestId("bot-pending"), "还没拿到服务端的数").toHaveCount(0);

  failing = false;
  await stale.getByRole("button", { name: "重试" }).click();
  await expect(link.getByTestId("bot-pending"), "点重试拿回服务端的数").toHaveText(/等你点头 1/);
  await expect(stale, "成功之后提示消失").toHaveCount(0);
});

/** 页面上不跑整个应用，只挂一个 AppProvider，好让用例把它真卸载掉。入口那个 main.tsx 换成空模块，登录态靠 cookie 自动进会话。 */
const mountedProvider = async (page: Page) => {
  await login(page);
  await page.route(/\/src\/main\.tsx(\?.*)?$/, (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.goto("/");
  await page.evaluate(async (module) => {
    const { mountProvider } = (await import(/* @vite-ignore */ module)) as typeof import("./support/mount-provider");
    window.__provider = mountProvider();
  }, "/e2e/support/mount-provider.tsx");
  await expect
    .poll(() => page.evaluate(() => window.__provider?.status()), "单独挂的 Provider 自动进了会话")
    .toBe("ready");
};

const groupRequests = (page: Page): string[] => {
  const seen: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "GET" && isGroups(request.url())) seen.push(request.url());
  });
  return seen;
};

const unmountProvider = (page: Page) => page.evaluate(() => window.__provider?.unmount());

// 退避第一档是 500ms，等一倍半以上还没有新请求才算真的取消了。
const BACKOFF_WINDOW = 1_200;

test("R7-2 对照：Provider 还在时，补计数遇到 503 会在退避之后重试", async ({ page }) => {
  await mountedProvider(page);
  const seen = groupRequests(page);
  await page.route("**/api/groups", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 503, json: { error: "补计数失败" } })
      : route.continue(),
  );
  await page.evaluate(() => void window.__provider?.actions()?.loadPendingCounts());
  await expect.poll(() => seen.length, "第一趟之外，退避之后又发了一趟").toBeGreaterThanOrEqual(2);
});

test("R7-2 补计数在退避等待时 Provider 卸载，卸载之后不再重试", async ({ page }) => {
  await mountedProvider(page);
  const seen = groupRequests(page);
  await page.route("**/api/groups", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 503, json: { error: "补计数失败" } })
      : route.continue(),
  );
  const failed = page.waitForResponse((response) => isGroups(response.url()) && response.status() === 503);
  await page.evaluate(() => void window.__provider?.actions()?.loadPendingCounts());
  await failed;
  await unmountProvider(page);
  const atUnmount = seen.length;
  await page.waitForTimeout(BACKOFF_WINDOW);
  expect(seen, "卸载时留在等待里的退避重试要取消").toHaveLength(atUnmount);
});

for (const answer of ["失败", "成功"] as const) {
  test(`R7-2 补计数在途时又记了一笔待补，Provider 卸载后回包${answer}，不再补拉也不重试`, async ({ page }) => {
    await mountedProvider(page);
    const seen = groupRequests(page);
    let reached!: () => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/groups", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      reached();
      await gate;
      // 请求已被卸载取消时放行会抛，这里要的只是回包到不到得了页面。
      await (
        answer === "失败" ? route.fulfill({ status: 503, json: { error: "补计数失败" } }) : route.continue()
      ).catch(() => undefined);
    });
    await page.evaluate(() => {
      const actions = window.__provider?.actions();
      void actions?.loadPendingCounts();
      void actions?.loadPendingCounts();
    });
    await started;
    await unmountProvider(page);
    const atUnmount = seen.length;
    release();
    await page.waitForTimeout(BACKOFF_WINDOW);
    expect(seen, "卸载之后在途那趟的结果不再引出新请求").toHaveLength(atUnmount);
  });
}
