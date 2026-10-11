import { PokerTableResponse, type PokerTableView } from "@baize/shared";
import { expect, login, test, type APIRequestContext, type Page } from "./fixtures";

const REQUEST_ID = "p3-project-review";
const USER_SEAT = 4;

const fetchTable = async (request: APIRequestContext, groupId: string): Promise<PokerTableView> => {
  const res = await request.get(`/api/poker/tables/${groupId}`);
  expect(res.status(), "牌桌视图可读").toBe(200);
  return PokerTableResponse.parse(await res.json()).table;
};

// 牌友的出牌是任务队，测试里把自动走停掉，每一拍自己按，不靠等真实时间。
const createTable = async (request: APIRequestContext): Promise<string> => {
  const res = await request.post("/api/poker/tables", { data: { requestId: REQUEST_ID } });
  expect(res.status(), "牌桌新建").toBe(201);
  const { table } = PokerTableResponse.parse(await res.json());
  const paused = await request.post("/api/poker/test/delay", { data: { ms: null } });
  expect(paused.status(), "牌友回合挂起").toBe(200);
  return table.groupId;
};

const attachProjectGroup = async (request: APIRequestContext, groupId: string): Promise<void> => {
  const res = await request.post("/api/poker/test/project-group", { data: { groupId, title: "周末德州" } });
  expect(res.status(), "牌桌挂上项目群").toBe(200);
};

// 你只会过牌或跟注，其余座位一拍一拍走，直到这一手结束。
const playHandToEnd = async (request: APIRequestContext, groupId: string): Promise<void> => {
  const started = await request.post(`/api/poker/tables/${groupId}/hands`, { data: {} });
  expect(started.status(), "开一手").toBe(200);
  for (let step = 0; step < 200; step += 1) {
    const table = await fetchTable(request, groupId);
    const hand = table.hand;
    if (table.status === "idle" || hand === null) return;
    if (hand.toAct === USER_SEAT) {
      const legal = hand.view.legal;
      if (legal.kind !== "your_turn") throw new Error("轮到你却没有可选动作");
      const action = legal.options.some((option) => option.kind === "check") ? { kind: "check" } : { kind: "call" };
      const acted = await request.post(`/api/poker/hands/${hand.id}/act`, { data: { seq: hand.version, action } });
      expect(acted.status(), "你的动作被接受").toBe(200);
    } else {
      const ticked = await request.post("/api/poker/test/tick", { data: { groupId } });
      expect(ticked.status(), "牌友走一拍").toBe(200);
      expect((await ticked.json()).ran, "牌友有动作可走").toBe(true);
    }
  }
  throw new Error("一手牌 200 步还没打完");
};

// 散场之后复盘排成任务，晚一拍才写好，这里走到复盘状态变成已完成为止。
const waitForReview = async (request: APIRequestContext, groupId: string): Promise<PokerTableView> => {
  for (let step = 0; step < 20; step += 1) {
    const table = await fetchTable(request, groupId);
    if (table.reviewState?.status === "done") return table;
    await request.post("/api/poker/test/tick", { data: { groupId } });
  }
  throw new Error("复盘 20 拍还没写好");
};

const leave = async (request: APIRequestContext, groupId: string): Promise<PokerTableView> => {
  const left = await request.post(`/api/poker/tables/${groupId}/leave`, { data: {} });
  expect(left.status(), "散场").toBe(200);
  return PokerTableResponse.parse(await left.json()).table;
};

const leaveAndWaitForReview = async (request: APIRequestContext, groupId: string): Promise<PokerTableView> => {
  await leave(request, groupId);
  return waitForReview(request, groupId);
};

// 项目页进来先拉一次牌桌视图，不等推送。
const openProject = async (page: Page, groupId: string): Promise<void> => {
  await page.goto(`/p/${encodeURIComponent(groupId)}`);
  await expect(page.locator(`[data-poker-project="${groupId}"]`), "牌桌项目页出现").toHaveCount(1);
};

const signed = (net: number): string => (net > 0 ? `+${net}` : `${net}`);

test("散场后回项目页顶上是老白的三手复盘", async ({ page }) => {
  await login(page);
  const request = page.request;
  const groupId = await createTable(request);
  await attachProjectGroup(request, groupId);
  for (let hand = 0; hand < 3; hand += 1) await playHandToEnd(request, groupId);
  await leaveAndWaitForReview(request, groupId);

  await openProject(page, groupId);
  const card = page.getByTestId("review-card");
  await expect(card).toBeVisible();
  await expect(
    page.locator(`[data-poker-project="${groupId}"] .today-content > :not(header)`).first(),
    "复盘卡紧跟页头，是正文第一块",
  ).toHaveAttribute("data-testid", "review-card");
  await expect(card).toContainText("老白");
  await expect(card.getByTestId("review-hand"), "三手关键牌").toHaveCount(3);
});

test("没打过时不显示复盘卡", async ({ page }) => {
  await login(page);
  const request = page.request;
  const groupId = await createTable(request);
  await attachProjectGroup(request, groupId);

  await openProject(page, groupId);
  await expect(page.getByTestId("review-card")).toHaveCount(0);
  await expect(page.getByTestId("stats-sessions")).toHaveText("0");
});

test("战绩数字和 mock 一致并写明虚拟筹码", async ({ page }) => {
  await login(page);
  const request = page.request;
  const groupId = await createTable(request);
  await attachProjectGroup(request, groupId);
  for (let hand = 0; hand < 2; hand += 1) await playHandToEnd(request, groupId);
  const finished = await leaveAndWaitForReview(request, groupId);
  const { stats } = finished;
  expect(stats.sessions, "这一场记进战绩").toBe(1);

  await openProject(page, groupId);
  await expect(page.getByTestId("stats-sessions")).toHaveText(String(stats.sessions));
  await expect(page.getByTestId("stats-won")).toHaveText(String(stats.sessionsWon));
  await expect(page.getByTestId("stats-net")).toHaveText(signed(stats.net));
  await expect(page.getByTestId("stats-note")).toHaveText("虚拟筹码，不涉及真钱");
});

test("项目页各块之间的段间距一致，战绩块不贴着牌友块", async ({ page }) => {
  await login(page);
  const request = page.request;
  const groupId = await createTable(request);
  await attachProjectGroup(request, groupId);
  for (let hand = 0; hand < 2; hand += 1) await playHandToEnd(request, groupId);
  await leaveAndWaitForReview(request, groupId);

  await openProject(page, groupId);
  const boxes = await Promise.all(
    ["review-card", "poker-seats", "stats-block", "poker-rules"].map(async (id) => {
      const box = await page.getByTestId(id).boundingBox();
      if (box === null) throw new Error(`${id} 在页面上没有位置`);
      return box;
    }),
  );
  const gaps = boxes.flatMap((above, index) => {
    const below = boxes[index + 1];
    return below === undefined ? [] : [below.y - (above.y + above.height)];
  });
  expect(gaps, "复盘卡、牌友、战绩、规则相邻两块之间的间距一样").toEqual([gaps[0], gaps[0], gaps[0]]);
  expect(gaps[0], "块之间有段间距").toBeGreaterThan(0);
});

test("老白还在写复盘时，复盘卡是生成中的提示", async ({ page }) => {
  await login(page);
  const request = page.request;
  const groupId = await createTable(request);
  await attachProjectGroup(request, groupId);
  await playHandToEnd(request, groupId);
  const left = await leave(request, groupId);
  expect(left.reviewState?.status, "散场时复盘在写").toBe("generating");

  await openProject(page, groupId);
  const card = page.getByTestId("review-card");
  await expect(card).toHaveAttribute("data-review-status", "generating");
  await expect(card.getByTestId("review-generating")).toContainText("老白正在写");
  await expect(card.getByTestId("review-hand")).toHaveCount(0);
  await expect(card.getByTestId("review-retry")).toHaveCount(0);

  await waitForReview(request, groupId);
  await expect(card).toHaveAttribute("data-review-status", "done");
  await expect(card.getByTestId("review-hand"), "推送到了就列出关键手").toHaveCount(1);
});

test("复盘失败后卡上有重新生成，点了回到生成中，写好后列出关键手", async ({ page }) => {
  await login(page);
  const request = page.request;
  const groupId = await createTable(request);
  await attachProjectGroup(request, groupId);
  for (let hand = 0; hand < 3; hand += 1) await playHandToEnd(request, groupId);
  await leave(request, groupId);
  const failed = await request.post("/api/poker/test/fail-review", { data: { groupId } });
  expect(failed.status(), "把复盘弄失败").toBe(200);

  await openProject(page, groupId);
  const card = page.getByTestId("review-card");
  await expect(card).toHaveAttribute("data-review-status", "failed");
  await expect(card.getByTestId("review-failed")).toContainText("没写成");
  await card.getByTestId("review-retry").click();
  await expect(card, "点了重试，复盘回到生成中").toHaveAttribute("data-review-status", "generating");
  await expect(card.getByTestId("review-retry")).toHaveCount(0);

  await waitForReview(request, groupId);
  await expect(card).toHaveAttribute("data-review-status", "done");
  await expect(card.getByTestId("review-hand"), "三手关键牌").toHaveCount(3);
});

test("开了新一场还没散，复盘卡仍是上一场", async ({ page }) => {
  await login(page);
  const request = page.request;
  const groupId = await createTable(request);
  await attachProjectGroup(request, groupId);
  for (let hand = 0; hand < 3; hand += 1) await playHandToEnd(request, groupId);
  await leaveAndWaitForReview(request, groupId);
  const started = await request.post(`/api/poker/tables/${groupId}/hands`, { data: {} });
  expect(started.status(), "开新一场的第一手").toBe(200);

  await openProject(page, groupId);
  await expect(page.getByTestId("review-card").getByTestId("review-hand")).toHaveCount(3);
  await expect(page.getByTestId("stats-sessions")).toHaveText("1");
});
