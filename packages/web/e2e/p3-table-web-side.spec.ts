import { PokerTableResponse, type PokerTableView } from "@baize/shared";
import { expect, login, test, type Page } from "./fixtures";

// 牌桌 mock 里的牌桌没有对应的 Group，侧栏点不进去，用例直接按 URL 进页面。
// 进页面先拉一次牌桌视图；delay 接口顺手把每张桌重推一遍，enter 里轮询它只是保证节奏已经设上。
// 节奏默认手动（ms 为 null），牌友出牌用 tick 一拍一拍走；要一口气走完的地方改成 0。

type Pace = number | null;

const createTable = async (page: Page): Promise<string> => {
  const response = await page.request.post("/api/poker/tables", { data: { requestId: "side-spec" } });
  expect(response.status(), "建桌").toBe(201);
  return PokerTableResponse.parse(await response.json()).table.groupId;
};

const tableOf = async (page: Page, groupId: string): Promise<PokerTableView> => {
  const response = await page.request.get(`/api/poker/tables/${groupId}`);
  expect(response.status(), "读牌桌").toBe(200);
  return PokerTableResponse.parse(await response.json()).table;
};

const setPace = async (page: Page, ms: Pace) => {
  expect((await page.request.post("/api/poker/test/delay", { data: { ms } })).status(), `牌友节奏 ${ms}`).toBe(200);
};

const enter = async (page: Page, groupId: string, pace: Pace = null) => {
  await page.goto(`/t/${groupId}`);
  await expect
    .poll(
      async () => {
        await setPace(page, pace);
        return page.getByTestId("table-log").count();
      },
      { message: "牌桌视图经推送到页面，右栏出现" },
    )
    .toBe(1);
};

const openTable = async (page: Page, pace: Pace = null): Promise<string> => {
  await login(page);
  const groupId = await createTable(page);
  await enter(page, groupId, pace);
  return groupId;
};

const startHand = async (page: Page, groupId: string) => {
  expect((await page.request.post(`/api/poker/tables/${groupId}/hands`, { data: {} })).status(), "开一手").toBe(200);
};

const tick = async (page: Page, groupId: string) => {
  const response = await page.request.post("/api/poker/test/tick", { data: { groupId } });
  expect(response.status(), "牌友走一拍").toBe(200);
};

// 开一手，牌友 3 号先加到 60，轮到你。
const toMyTurn = async (page: Page, groupId: string) => {
  await startHand(page, groupId);
  await tick(page, groupId);
  await expect(page.getByTestId("hint-ask"), "轮到你，问老白的按钮可点").toBeEnabled();
};

const act = async (page: Page, groupId: string, action: { kind: "fold" | "call" | "all_in" }) => {
  const table = await tableOf(page, groupId);
  const hand = table.hand;
  if (hand === null) throw new Error("没有进行中的手");
  const response = await page.request.post(`/api/poker/hands/${hand.id}/act`, {
    data: { seq: hand.view.events.length, action },
  });
  expect(response.status(), `你出 ${action.kind}`).toBe(200);
};

const say = async (
  page: Page,
  groupId: string,
  lines: { speaker: string; text: string; at?: string; private?: boolean }[],
) => {
  const response = await page.request.post("/api/poker/test/side/say", { data: { groupId, lines } });
  expect(response.status(), "往牌桌群里塞话").toBe(200);
};

const logTexts = (page: Page) => page.getByTestId("table-log-line").locator(".table-log-text").allTextContents();

// 全下让桌子一路发到摊牌，你赢。
const playToShowdown = async (page: Page, groupId: string) => {
  await toMyTurn(page, groupId);
  await act(page, groupId, { kind: "all_in" });
  await setPace(page, 0);
  await expect(page.getByTestId("hand-end"), "一手打完").toBeVisible();
};

test("点问老白后出现老白的建议，刷新后还在", async ({ page }) => {
  const groupId = await openTable(page);
  await toMyTurn(page, groupId);
  await expect(page.getByTestId("hint-card"), "没问之前没有建议").toHaveCount(0);

  await page.getByTestId("hint-ask").click();
  await expect(page.getByTestId("hint-waiting"), "老白还没答，页面写等待态").toBeVisible();
  await expect(page.getByTestId("hint-card")).toHaveCount(0);

  await tick(page, groupId);
  const card = page.getByTestId("hint-card");
  await expect(card, "老白答了，建议卡出现").toContainText("A♠ K♦ 是最好的起手牌之一");
  await expect(card.getByTestId("hint-private"), "建议卡标仅你可见").toHaveText("仅你可见");
  await expect(page.getByTestId("hint-waiting")).toHaveCount(0);
  await expect(page.getByTestId("table-log"), "仅你可见的建议不进公开的牌桌记录").not.toContainText(
    "A♠ K♦ 是最好的起手牌之一",
  );

  await page.reload();
  await expect
    .poll(
      async () => {
        await setPace(page, null);
        return page.getByTestId("hint-card").count();
      },
      { message: "刷新后视图再到，建议还在" },
    )
    .toBe(1);
  await expect(page.getByTestId("hint-card"), "建议正文从消息历史里回来").toContainText("A♠ K♦ 是最好的起手牌之一");
  await expect(page.getByTestId("hint-ask"), "同一个决策点不再给问的按钮").toHaveCount(0);
});

test("出过牌后上一步的建议灰着留到这一街结束", async ({ page }) => {
  const groupId = await openTable(page);
  await toMyTurn(page, groupId);
  await page.getByTestId("hint-ask").click();
  await tick(page, groupId);
  await expect(page.getByTestId("hint-card")).toContainText("A♠ K♦ 是最好的起手牌之一");

  await act(page, groupId, { kind: "call" });
  const earlier = page.getByTestId("hint-earlier");
  await expect(earlier, "出了牌，建议换成灰的上一步建议").toContainText("上一步的建议");
  await expect(earlier).toContainText("A♠ K♦ 是最好的起手牌之一");
  await expect(page.getByTestId("hint-card")).toHaveCount(0);

  await expect
    .poll(
      async () => {
        await tick(page, groupId);
        return (await tableOf(page, groupId)).hand?.view.street;
      },
      { message: "牌友走到翻牌" },
    )
    .toBe("flop");
  await expect(earlier, "换街就收起").toHaveCount(0);
});

test("牌桌上的话按时间排，新话不把按钮顶走", async ({ page }) => {
  const groupId = await openTable(page);
  await toMyTurn(page, groupId);

  // 后到的话时间更早：顺序按 createdAt，不按到达先后。
  await say(page, groupId, [
    { speaker: "old_k", text: "晚一点说的", at: "2030-01-01T00:00:02.000Z" },
    { speaker: "jasmine", text: "早一点说的", at: "2030-01-01T00:00:01.000Z" },
  ]);
  await expect(page.getByTestId("table-log-line").filter({ hasText: "晚一点说的" })).toHaveCount(1);
  const texts = await logTexts(page);
  expect(texts.indexOf("早一点说的"), "时间早的排在前面").toBeGreaterThanOrEqual(0);
  expect(texts.indexOf("早一点说的"), "时间早的排在前面").toBeLessThan(texts.indexOf("晚一点说的"));
  expect(texts.indexOf("新一手。盲注 10/20，你在 4 号位。"), "开局那句在最前面").toBeLessThan(
    texts.indexOf("早一点说的"),
  );

  const ask = page.getByTestId("hint-ask");
  const before = await ask.boundingBox();
  if (before === null) throw new Error("按钮没渲染出来");
  await say(
    page,
    groupId,
    Array.from({ length: 30 }, (_, index) => ({
      speaker: "dalu",
      text: `第 ${index + 1} 句闲话`,
      at: `2031-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    })),
  );
  const last = page.getByTestId("table-log-line").filter({ hasText: "第 30 句闲话" });
  await expect(last, "新话到了").toHaveCount(1);
  await expect(last, "新话自动滚进右栏视野").toBeInViewport();

  const lines = page.getByTestId("table-log-lines");
  const scrolls = await lines.evaluate((element) => element.scrollHeight > element.clientHeight);
  expect(scrolls, "话多了在右栏里滚，不是把页面撑长").toBe(true);
  const after = await ask.boundingBox();
  expect(after?.y, "按钮纹丝没动").toBe(before.y);
  await ask.click();
  await expect(page.getByTestId("hint-waiting"), "按钮点得到").toBeVisible();
});

test("一手结束出现再来一手和散场看复盘", async ({ page }) => {
  const groupId = await openTable(page);
  await toMyTurn(page, groupId);
  await expect(page.getByTestId("hand-end"), "手还在打，不出结束卡").toHaveCount(0);

  await act(page, groupId, { kind: "all_in" });
  await setPace(page, 0);
  const end = page.getByTestId("hand-end");
  await expect(end).toBeVisible();
  await expect(end.getByTestId("hand-again")).toHaveText(/再来一手/);
  await expect(end.getByTestId("hand-leave")).toHaveText(/散场看复盘/);
  await expect(end.getByTestId("hand-again"), "再来一手是默认动作，焦点在它上面").toBeFocused();
  await expect(page.getByTestId("hint-ask"), "一手打完不再问老白").toHaveCount(0);

  const table = await tableOf(page, groupId);
  const me = table.seats.find((seat) => seat.kind === "user");
  const net = (me?.stack ?? 0) - 2000;
  expect(net, "这一手你全下赢了").toBeGreaterThan(0);
  await expect(end.getByTestId("hand-result"), "结果写你赢了多少").toContainText(
    `你赢了 ${net.toLocaleString("en-US")} 筹码`,
  );
});

test("再来一手后手牌换新、庄位转", async ({ page }) => {
  const groupId = await openTable(page);
  await playToShowdown(page, groupId);
  const first = await tableOf(page, groupId);
  expect(first.hand?.number).toBe(1);
  await expect(page.getByTestId("host-hint")).toHaveAttribute("data-hand", "1");

  await setPace(page, null);
  await page.getByTestId("hand-again").click();
  await expect(page.getByTestId("hand-end"), "新一手开始，结束卡收起").toHaveCount(0);
  const second = await tableOf(page, groupId);
  expect(second.hand?.number, "是第二手").toBe(2);
  expect(second.hand?.id, "换了一手牌").not.toBe(first.hand?.id);
  expect(
    second.hand?.view.events.map((event) => event.kind),
    "新手只有盲注",
  ).toEqual(["blind", "blind"]);
  await expect(page.getByTestId("host-hint"), "页面认的是第二手").toHaveAttribute("data-hand", "2");
  const texts = await logTexts(page);
  expect(
    texts.filter((text) => text.startsWith("新一手")),
    "牌桌上有两次新一手",
  ).toHaveLength(2);
  await expect(page.getByTestId("hint-card"), "上一手的建议不带过来").toHaveCount(0);
});

test("牌友的名字在牌桌上的话里能显示", async ({ page }) => {
  const groupId = await openTable(page);
  await startHand(page, groupId);
  await tick(page, groupId);

  const table = await tableOf(page, groupId);
  const third = table.seats.find((seat) => seat.seat === 3);
  expect(third?.kind, "3 号位是牌友").toBe("bot");
  const bots = await page.request.get("/api/bots");
  expect(await bots.text(), "牌友不在 Bot 列表里，名字只能取自牌桌座位").not.toContain(third?.name ?? "");

  const raise = page.getByTestId("table-log-line").filter({ hasText: "加到 60。" });
  await expect(raise, "牌友的话到了").toHaveCount(1);
  await expect(raise.locator(".table-log-name"), "署的是牌友的名字").toHaveText(third?.name ?? "");
  const opening = page.getByTestId("table-log-line").filter({ hasText: "新一手。" });
  await expect(opening.locator(".table-log-name"), "老白的话署老白").toHaveText(table.host.name);
});

test("点散场看复盘后离桌，回到这张桌的项目页，复盘写好后在顶上", async ({ page }) => {
  await login(page);
  const groupId = await createTable(page);
  const attached = await page.request.post("/api/poker/test/project-group", { data: { groupId, title: "周末德州" } });
  expect(attached.status(), "牌桌挂上项目群，项目页才认得出").toBe(200);
  await enter(page, groupId);
  await playToShowdown(page, groupId);

  const left = page.waitForResponse((response) => response.url().endsWith(`/api/poker/tables/${groupId}/leave`));
  await page.getByTestId("hand-leave").click();
  expect((await left).status(), "散场被接受").toBe(200);
  await expect(page, "离桌后跳到这张桌的项目页").toHaveURL(`/p/${groupId}`);
  await expect(page.getByTestId("table-page"), "牌桌页收起").toHaveCount(0);
  await expect(page.locator(`[data-poker-project="${groupId}"]`)).toHaveCount(1);
  expect((await tableOf(page, groupId)).stats.sessions, "这一场记进战绩").toBe(1);
  await expect(page.getByTestId("stats-sessions"), "项目页的战绩跟着散场的视图走").toHaveText("1");
  await expect(page.getByTestId("review-card"), "节奏是 0，复盘任务自己跑完，推到项目页").toBeVisible();
});

// 牌桌上三处按钮的请求都走会话动作：会话过期回 401 时和别的页面一样回登录页，而不是只在按钮下面报错。
const expiredCases = [
  {
    name: "问老白",
    route: "**/api/poker/hands/*/hint",
    setup: async (page: Page, groupId: string) => toMyTurn(page, groupId),
    press: "hint-ask",
  },
  {
    name: "出牌",
    route: "**/api/poker/hands/*/act",
    setup: async (page: Page, groupId: string) => toMyTurn(page, groupId),
    press: "action-pass",
  },
  {
    name: "散场",
    route: "**/api/poker/tables/*/leave",
    setup: async (page: Page, groupId: string) => playToShowdown(page, groupId),
    press: "hand-leave",
  },
] as const;

for (const expired of expiredCases) {
  test(`${expired.name}的请求回 401 时回到登录页`, async ({ page }) => {
    const groupId = await openTable(page);
    await expired.setup(page, groupId);
    await page.route(expired.route, (route) => route.fulfill({ status: 401, json: { error: "没登录" } }));
    await expect(page.getByTestId("table-page"), "点之前还在牌桌上").toBeVisible();

    await page.getByTestId(expired.press).click();
    await expect(page.getByTestId("login-submit"), "会话过期，牌桌这一路也切回登录").toBeVisible();
    await expect(page.getByTestId("table-page")).toHaveCount(0);
  });
}

test("电脑不在线时问老白回 409，页面显示控制面的原话，没有老白的回话也没有等待态，电脑回来后可再问", async ({
  page,
}) => {
  const groupId = await openTable(page);
  await toMyTurn(page, groupId);
  const offline = "电脑不在线，这次没有问牌，电脑回来后再问一次";
  await page.route("**/api/poker/hands/*/hint", (route) => route.fulfill({ status: 409, json: { error: offline } }), {
    times: 1,
  });
  const lines = page.getByTestId("table-log-line");
  const before = await lines.count();

  await page.getByTestId("hint-ask").click();
  await expect(page.getByRole("alert"), "409 的中文文案原样显示在按钮下面").toHaveText(offline);
  await expect(page.getByTestId("hint-waiting"), "没有问成，不能画成等老白").toHaveCount(0);
  await expect(page.getByTestId("hint-card")).toHaveCount(0);
  await expect(lines, "没有多出一条老白的消息").toHaveCount(before);
  await expect(page.getByTestId("hint-ask"), "按钮回到可点，电脑回来后能再问").toBeEnabled();

  await page.getByTestId("hint-ask").click();
  await expect(page.getByTestId("hint-waiting"), "再问一次走到真接口，进入等待态").toBeVisible();
  await expect(page.getByRole("alert"), "上一次的错误随新请求清掉").toHaveCount(0);
});
