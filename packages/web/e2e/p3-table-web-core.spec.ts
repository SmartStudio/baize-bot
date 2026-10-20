import { expect, login, test, type Page } from "./fixtures";

// 牌桌页的牌桌和按钮条。mock 的牌桌没有对应的 Group，侧栏点不进去，用例直接按 URL 进。
// 牌友出牌默认隔 600ms 走一拍，用例把它挂起，再用 tick 一拍一拍走，免得靠等。

type TableBody = { table: { groupId: string; version: number } };

const openTable = async (page: Page, requestId: string): Promise<string> => {
  await login(page);
  const { request } = page;
  expect((await request.post("/api/poker/test/delay", { data: { ms: null } })).ok(), "牌友出牌挂起").toBe(true);
  const created = (await (await request.post("/api/poker/tables", { data: { requestId } })).json()) as TableBody;
  const groupId = created.table.groupId;
  expect((await request.post(`/api/poker/tables/${groupId}/hands`, { data: {} })).ok(), "开一手").toBe(true);
  await page.goto(`/t/${groupId}`);
  await expect(page.getByTestId("table-page")).toBeVisible();
  return groupId;
};

// 把队里的牌友出牌走完，停在轮到你为止。ran 为 false 说明队空了。
const drain = async (page: Page, groupId: string): Promise<void> => {
  for (;;) {
    const tick = (await (await page.request.post("/api/poker/test/tick", { data: { groupId } })).json()) as {
      ran: boolean;
    };
    if (!tick.ran) return;
  }
};

// 点下去到接口回来之间牌友的任务还没排上，立刻 tick 会空跑。等接口回了再往下走。
const pressPass = async (page: Page): Promise<void> => {
  const answered = page.waitForResponse((response) => /\/api\/poker\/hands\/[^/]+\/act$/.test(response.url()));
  await page.getByTestId("action-pass").click();
  expect((await answered).ok(), "出牌被接受").toBe(true);
};

const bar = (page: Page) => page.getByTestId("action-bar");
const buttons = (page: Page) => [
  page.getByTestId("action-fold"),
  page.getByTestId("action-pass"),
  page.getByTestId("action-raise"),
];

test("进牌桌页看到自己的两张手牌，对手只有背面", async ({ page }) => {
  await openTable(page, "web-core-cards");
  const mine = page.getByTestId("felt-me");
  await expect(mine.getByTestId("card-face"), "你的两张手牌翻开").toHaveCount(2);
  await expect(mine.getByTestId("card-face").first()).toHaveAttribute("data-card", "As");
  await expect(mine.getByTestId("card-face").nth(1)).toHaveAttribute("data-card", "Kd");

  const opponents = page.getByTestId("felt-opponent");
  await expect(opponents, "三个牌友").toHaveCount(3);
  for (const seat of await opponents.all()) {
    await expect(seat.getByTestId("card-back"), "每个对手两张背面").toHaveCount(2);
    await expect(seat.getByTestId("card-face"), "对手没有牌面").toHaveCount(0);
  }
  await expect(page.getByTestId("felt").getByTestId("card-face"), "整张牌桌上只有你那两张牌面").toHaveCount(2);
  await expect(page.getByTestId("board-slot"), "五个公共牌槽").toHaveCount(5);
});

test("不轮到我时三个按钮不可点", async ({ page }) => {
  await openTable(page, "web-core-idle");
  await expect(bar(page)).toHaveAttribute("data-mine", "false");
  for (const button of buttons(page)) await expect(button).toBeDisabled();
});

test("没人下注时按钮写过牌，有人下注时写跟注和数额", async ({ page }) => {
  const groupId = await openTable(page, "web-core-pass");
  await drain(page, groupId);
  await expect(bar(page)).toHaveAttribute("data-mine", "true");
  await expect(page.getByTestId("action-pass"), "3 号加到 60，要跟 60").toHaveText("跟 60");
  await expect(page.getByTestId("action-pass")).toBeEnabled();

  await pressPass(page);
  await drain(page, groupId);
  await expect(page.getByTestId("action-pass"), "翻牌圈 1 号下了 100").toHaveText("跟 100");

  await pressPass(page);
  await drain(page, groupId);
  await expect(bar(page)).toHaveAttribute("data-mine", "true");
  await expect(page.getByTestId("action-pass"), "转牌圈 1 号过牌，没人下注").toHaveText("过牌");
});

test("加注低于最小额时按钮不可点，说明之外一键改成最小", async ({ page }) => {
  const groupId = await openTable(page, "web-core-raise");
  await drain(page, groupId);
  const input = page.getByTestId("raise-amount");
  await expect(input, "输入框默认填最小加注").toHaveValue("100");
  await expect(page.getByTestId("action-raise")).toHaveText("加注到 100");
  await expect(page.getByTestId("raise-hint"), "合法时不占地方").toHaveCount(0);

  await input.fill("50");
  await expect(page.getByTestId("action-raise")).toBeDisabled();
  await expect(page.getByTestId("raise-hint")).toContainText("最少要加注到 100");
  await page.getByTestId("raise-fix").click();
  await expect(input, "一键改成最小").toHaveValue("100");
  await expect(page.getByTestId("action-raise")).toBeEnabled();

  await input.fill("5000");
  await expect(page.getByTestId("action-raise")).toBeDisabled();
  await expect(page.getByTestId("raise-hint")).toContainText("筹码不够，最多只能加注到 2,000");
  await expect(page.getByTestId("raise-fix")).toHaveText("改成最多 2,000");
});

test("半池直接出牌：按钮上写着数，点了就是加注到这个数", async ({ page }) => {
  const groupId = await openTable(page, "web-core-half");
  await drain(page, groupId);
  // 跟 60 后底池 150，当前注 60，半池加到 60 + 75。
  const half = page.getByTestId("raise-quick-half");
  await expect(half).toHaveText("半池 135");
  const sent = page.waitForRequest((request) => /\/api\/poker\/hands\/[^/]+\/act$/.test(request.url()));
  await half.click();
  expect((await sent).postDataJSON().action, "不用再点加注").toEqual({ kind: "raise", amount: 135 });
  await expect(page.getByTestId("felt-me").getByTestId("seat-label")).toHaveText("加注到 135");
  await expect(page.getByTestId("felt-me").getByTestId("seat-bet"), "桌上推出去的筹码").toHaveText("135");
});

test("座位上标庄位和大小盲、本街动作，轮到谁写在谁身上", async ({ page }) => {
  const groupId = await openTable(page, "web-core-seats");
  await expect(page.getByTestId("felt-me").getByTestId("seat-marker"), "你坐庄").toHaveText("庄");
  const seat = (no: number) => page.locator(`[data-testid=felt-opponent][data-seat="${no}"]`);
  await expect(seat(1).getByTestId("seat-marker")).toHaveText("小盲");
  await expect(seat(2).getByTestId("seat-marker")).toHaveText("大盲");
  await expect(seat(2).getByTestId("seat-bet"), "大盲垫的 20").toHaveText("20");

  await drain(page, groupId);
  await expect(seat(3).getByTestId("seat-label")).toHaveText("加注到 60");
  await expect(page.getByTestId("felt-me").getByTestId("seat-turn")).toHaveText("轮到你");
  await pressPass(page);
  await expect(page.getByTestId("felt-me").getByTestId("seat-label")).toHaveText("跟 60");
  await expect(page.getByTestId("felt").getByTestId("seat-turn"), "轮到牌友时他身上写着倒数").toContainText("秒");
});

test("页头写桌名和第几手，一手没打完散场灰着并说明，能回项目页", async ({ page }) => {
  const groupId = await openTable(page, "web-core-head");
  await expect(page.getByTestId("table-hand-no")).toHaveText("第 1 手");
  await expect(page.getByTestId("table-chips-note"), "虚拟筹码只在牌桌页说一次").toHaveCount(1);
  const leave = page.getByTestId("table-leave");
  await expect(leave).toBeDisabled();
  await expect(leave).toHaveAttribute("title", "这一手还没打完，打完再散场");
  await page.getByTestId("table-back").click();
  await expect(page).toHaveURL(new RegExp(`/p/${groupId}$`));
});

test("桌上还没发牌时有开一手", async ({ page }) => {
  await login(page);
  const created = (await (
    await page.request.post("/api/poker/tables", { data: { requestId: "web-core-empty" } })
  ).json()) as TableBody;
  await page.goto(`/t/${created.table.groupId}`);
  await expect(page.getByTestId("table-leave"), "没开打没有可散的").toBeDisabled();
  await page.getByTestId("table-start").click();
  await expect(page.getByTestId("felt-me").getByTestId("card-face"), "发了牌").toHaveCount(2);
  await expect(page.getByTestId("table-empty")).toHaveCount(0);
});

test("点跟注后按钮立刻禁用直到下一次推送", async ({ page }) => {
  const groupId = await openTable(page, "web-core-pending");
  await drain(page, groupId);
  await expect(page.getByTestId("action-pass")).toBeEnabled();

  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/poker/hands/*/act", async (route) => {
    await gate;
    await route.continue();
  });
  await page.getByTestId("action-pass").click();
  await expect(bar(page), "请求还在路上，已经禁用").toHaveAttribute("data-pending", "true");
  for (const button of buttons(page)) await expect(button).toBeDisabled();

  release();
  await expect(bar(page), "新视图到了就放开判定").toHaveAttribute("data-pending", "false");
  await expect(bar(page), "牌友挂起没出牌，所以仍不是你").toHaveAttribute("data-mine", "false");
});

test("刷新后牌桌状态还在", async ({ page }) => {
  const groupId = await openTable(page, "web-core-reload");
  await drain(page, groupId);
  await expect(page.getByTestId("action-pass")).toHaveText("跟 60");
  const pot = await page.getByTestId("pot").textContent();

  await page.reload();
  await expect(page.getByTestId("felt-me").getByTestId("card-face")).toHaveCount(2);
  await expect(page.getByTestId("action-pass")).toHaveText("跟 60");
  await expect(page.getByTestId("pot")).toHaveText(pot ?? "");
});

test("旧版本的推送不覆盖新版本", async ({ page }) => {
  const groupId = await openTable(page, "web-core-stale");
  await drain(page, groupId);
  await expect(page.getByTestId("pot")).toBeVisible();
  const before = (await page.getByTestId("pot").textContent()) ?? "";

  // 底池每次变化都记下来，跑完断言整串序列：旧推送哪怕只盖过一瞬，序列里也会多出一项。
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __pots: string[] }).__pots = seen;
    const sample = () => {
      const text = document.querySelector("[data-testid=pot]")?.textContent ?? "";
      if (seen.at(-1) !== text) seen.push(text);
    };
    sample();
    new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, characterData: true });
  });

  const forge = async (kind: "next" | "stale", pot: number) =>
    expect((await page.request.post("/api/poker/test/web-core/push", { data: { groupId, kind, pot } })).ok()).toBe(
      true,
    );
  await forge("next", 777);
  await expect(page.getByTestId("pot"), "新版本盖得上去").toContainText("777");
  await forge("stale", 9999);
  await forge("next", 888);
  await expect(page.getByTestId("pot")).toContainText("888");

  const pots = await page.evaluate(() => (window as unknown as { __pots: string[] }).__pots);
  expect(
    pots.map((text) => text.replace(/\D/g, "")),
    "旧版本的 9999 一次都没露出来",
  ).toEqual([before.replace(/\D/g, ""), "777", "888"]);
});
