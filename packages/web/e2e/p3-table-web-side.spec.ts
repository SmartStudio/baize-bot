import { PokerTableResponse, type PokerTableView } from "@baize/shared";
import { expect, login, test, type Page } from "./fixtures";

// 牌桌 mock 里的牌桌没有对应的 Group，侧栏点不进去，用例直接按 URL 进页面。
// 进页面不拉牌桌视图（单元 11 的事），视图靠 mock 的重发推送带进来：delay 接口顺手把每张桌重推一遍。
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
