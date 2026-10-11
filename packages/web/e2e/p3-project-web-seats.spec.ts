import { PokerTableResponse, POKER_PERSONAS, type GroupId, type PokerTableView } from "@baize/shared";
import { expect, login, test, type Page } from "./fixtures";

// 牌桌在 mock 里没有侧栏入口以外的路径，用例建好桌直接按网址进项目页。
const openTableProject = async (page: Page): Promise<PokerTableView> => {
  await login(page);
  const created = await page.request.post("/api/poker/tables", { data: { requestId: `seats-${Date.now()}` } });
  expect(created.status(), "建桌成功").toBe(201);
  const table = PokerTableResponse.parse(await created.json()).table;
  await page.goto(`/p/${table.groupId}`);
  await expect(page.getByTestId("poker-project")).toBeVisible();
  return table;
};

const tableOf = async (page: Page, groupId: GroupId): Promise<PokerTableView> =>
  PokerTableResponse.parse(await (await page.request.get(`/api/poker/tables/${groupId}`)).json()).table;

const seatCard = (page: Page, name: string) => page.locator(`[data-testid=poker-seat][data-seat-name="${name}"]`);

test("项目页显示三个牌友加老白，各有人设一句话", async ({ page }) => {
  await openTableProject(page);
  await expect(page.getByTestId("poker-project").getByRole("heading", { name: "周末德州" })).toBeVisible();

  const seats = page.getByTestId("poker-seat");
  await expect(seats, "三个牌友加老白").toHaveCount(4);
  await expect(seats.locator("[data-testid=poker-seat-name]"), "牌友按座位排，老白在末尾").toHaveText([
    "阿豹",
    "茉莉",
    "大刘",
    "老白",
  ]);
  for (const persona of ["leopard", "jasmine", "dalu", "laobai"] as const) {
    const card = POKER_PERSONAS[persona];
    await expect(seatCard(page, card.name).getByTestId("poker-seat-line"), `${card.name}的人设一句话`).toHaveText(
      card.line,
    );
  }
  await expect(page.getByTestId("poker-seat-swap"), "老白不可换，只有三个换人按钮").toHaveCount(3);
  await expect(seatCard(page, "老白").getByTestId("poker-seat-swap")).toHaveCount(0);
  await expect(page.getByTestId("poker-project"), "你坐 4 号位").toContainText("你坐 4 号位");

  const rules = page.getByTestId("poker-rules");
  await rules.locator("summary").click();
  await expect(rules).toContainText("10/20，每人 2000");
  await expect(rules).toContainText("只有你和发牌引擎");
});

test("换人弹窗只列没在桌上的牌友", async ({ page }) => {
  await openTableProject(page);
  await seatCard(page, "茉莉").getByTestId("poker-seat-swap").click();

  const dialog = page.getByTestId("swap-seat-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("swap-seat-option").locator("b"), "桌上的阿豹、茉莉、大刘和老白都不列").toHaveText([
    "老K",
    "小七",
  ]);
  await expect(dialog.getByTestId("swap-seat-option").first(), "每个候选带人设一句话").toContainText(
    POKER_PERSONAS.old_k.line,
  );

  await dialog.getByTestId("swap-seat-cancel").click();
  await expect(dialog, "取消只关弹窗").toHaveCount(0);
  await expect(seatCard(page, "茉莉")).toBeVisible();
});

test("换人后座位卡变成新人并提示谁下谁上", async ({ page }) => {
  const table = await openTableProject(page);
  await seatCard(page, "茉莉").getByTestId("poker-seat-swap").click();
  await page.getByTestId("swap-seat-option").filter({ hasText: "小七" }).click();

  await expect(page.getByTestId("swap-seat-dialog"), "换完弹窗关掉").toHaveCount(0);
  await expect(page.getByTestId("poker-swap-notice"), "提示谁下谁上").toHaveText("茉莉 下桌，小七 上桌");
  await expect(page.getByTestId("poker-seat-name"), "只换了 2 号位").toHaveText(["阿豹", "小七", "大刘", "老白"]);
  await expect(seatCard(page, "小七").getByTestId("poker-seat-line")).toHaveText(POKER_PERSONAS.xiaoqi.line);

  const after = await tableOf(page, table.groupId);
  expect(
    after.seats.map((seat) => seat.persona),
    "控制面那头也只换了 2 号位",
  ).toEqual(["leopard", "xiaoqi", "dalu", null]);
});

test("手进行中换人按钮不可点", async ({ page }) => {
  const table = await openTableProject(page);
  const swaps = page.getByTestId("poker-seat-swap");
  await expect(swaps.first()).toBeEnabled();

  const started = await page.request.post(`/api/poker/tables/${table.groupId}/hands`, { data: {} });
  expect(started.status()).toBe(200);
  await expect(swaps, "手开始的推送一到，页面不刷新就全部变灰").toHaveCount(3);
  for (const swap of await swaps.all()) await expect(swap).toBeDisabled();
  await expect(page.getByTestId("poker-seats-note"), "说明为什么不能换").toContainText("这手打完");
});

test("点开一局进牌桌页，回来写接着打", async ({ page }) => {
  const table = await openTableProject(page);
  const start = page.getByTestId("poker-start");
  await expect(start).toHaveText("开一局");

  await start.click();
  await expect(page, "进牌桌页").toHaveURL(new RegExp(`/t/${table.groupId}$`));
  await expect(page.locator(`[data-table="${table.groupId}"]`)).toBeVisible();
  expect((await tableOf(page, table.groupId)).status, "开一局就发了第一手").toBe("in_hand");

  await page.goto(`/p/${table.groupId}`);
  await expect(page.getByTestId("poker-start"), "没散的桌子写接着打").toHaveText("接着打");
  await page.getByTestId("poker-start").click();
  await expect(page).toHaveURL(new RegExp(`/t/${table.groupId}$`));
  expect((await tableOf(page, table.groupId)).hand?.number, "接着打不再发新手").toBe(1);
});

test("新项目弹窗里选牌桌，直接建桌进项目页", async ({ page }) => {
  await login(page);
  await page.getByTestId("new-project").click();
  await page.getByTestId("new-project-table").click();

  await expect(page, "进新桌的项目页").toHaveURL(/\/p\/grp_poker_/);
  await expect(page.getByTestId("poker-project")).toBeVisible();
  await expect(page.getByTestId("new-project-dialog"), "弹窗关掉").toHaveCount(0);
  await expect(page.getByTestId("poker-seat-name")).toHaveText(["阿豹", "茉莉", "大刘", "老白"]);
  await expect(page.locator('[data-testid=group-item][data-group-title="周末德州"]'), "侧栏多了这个项目").toHaveCount(
    1,
  );
});

test("普通项目的项目页不受影响", async ({ page }) => {
  await login(page);
  await page.goto("/p/grp_order");
  await expect(page.getByTestId("project-page")).toBeVisible();
  await expect(page.getByTestId("poker-project")).toHaveCount(0);
});
