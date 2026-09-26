import { TEAM_TITLE, expect, login, test, type APIRequestContext } from "./fixtures";

const setTodayMode = async (request: APIRequestContext, mode: string) => {
  expect((await request.post("/api/test/today", { data: { mode } })).status()).toBe(204);
};

test("侧栏只有今天、主助理、项目、例行、团队、你，没有搜索框和 Bot 列表", async ({ page }) => {
  await login(page);
  const sidebar = page.getByTestId("sidebar");

  await expect(sidebar.getByTestId("today-nav")).toHaveText(/今天/);
  await expect(sidebar.getByTestId("assistant-nav")).toHaveText("主助理");
  await expect(sidebar.getByTestId("projects-label")).toContainText("项目");
  await expect(sidebar.getByTestId("new-project")).toBeVisible();
  await expect(sidebar.getByTestId("group-item"), "项目只列多 Bot 群").toHaveCount(1);
  await expect(sidebar.getByTestId("group-item")).toHaveAttribute("data-group-title", TEAM_TITLE);
  await expect(sidebar.getByTestId("routines-nav")).toHaveText("例行");
  await expect(sidebar.getByTestId("team-nav")).toHaveText("团队");
  await expect(sidebar.getByTestId("account-button")).toContainText("你");
  await expect(sidebar.getByTestId("sidebar-settings")).toBeVisible();

  const order = await sidebar
    .locator(
      "[data-testid=today-nav], [data-testid=assistant-nav], [data-testid=projects-label], [data-testid=group-item], [data-testid=routines-nav], [data-testid=team-nav], [data-testid=account-button]",
    )
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
  expect(order, "从上到下的顺序照原型方案 A").toEqual([
    "today-nav",
    "assistant-nav",
    "projects-label",
    "group-item",
    "routines-nav",
    "team-nav",
    "account-button",
  ]);

  await expect(sidebar.getByTestId("sidebar-search"), "搜索框删掉了").toHaveCount(0);
  await expect(sidebar.getByTestId("bot-item"), "Bot 列表删掉了").toHaveCount(0);
  for (const name of ["小服", "小销", "小采"]) {
    await expect(sidebar.getByText(name, { exact: true }), `侧栏不再单列 ${name}`).toHaveCount(0);
  }
});

test("没有主助理 Bot 时侧栏不出主助理", async ({ page }) => {
  await login(page);
  expect((await page.request.delete("/api/bots/bot_assistant")).status(), "先把 mock 里的主助理删掉").toBe(204);
  await page.reload();

  await expect(page.getByTestId("today-nav")).toBeVisible();
  await expect(page.getByTestId("team-nav")).toBeVisible();
  await expect(page.getByTestId("assistant-nav")).toHaveCount(0);
});

test("点主助理进它的单 Bot 群", async ({ page }) => {
  await login(page);
  await page.getByTestId("assistant-nav").click();
  await expect(page).toHaveURL(/\/g\/grp_assistant$/);
  await expect(page.getByTestId("chat-title")).toHaveText("主助理");
  await expect(page.getByTestId("assistant-nav")).toHaveAttribute("aria-current", "page");
});

test("点项目进群聊，刷新后还在这个群", async ({ page }) => {
  await login(page);
  const project = page.getByTestId("group-item").filter({ hasText: TEAM_TITLE });
  await project.click();
  await expect(page).toHaveURL(/\/g\/grp_order$/);
  await expect(page.getByTestId("chat-title")).toHaveText(TEAM_TITLE);
  await expect(page.getByTestId("task-card")).toBeVisible();
  await expect(project).toHaveAttribute("aria-current", "page");

  await page.reload();
  await expect(page).toHaveURL(/\/g\/grp_order$/);
  await expect(page.getByTestId("chat-title"), "刷新后还停在这个群").toHaveText(TEAM_TITLE);
  await expect(page.getByTestId("group-item").filter({ hasText: TEAM_TITLE })).toHaveAttribute("aria-current", "page");
});

test("/routines 和 /team 刷新后停在原页", async ({ page }) => {
  await login(page);

  await page.getByTestId("routines-nav").click();
  await expect(page).toHaveURL(/\/routines$/);
  await expect(page.getByTestId("routines-page")).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/routines$/);
  await expect(page.getByTestId("routines-page"), "刷新后还在例行页").toBeVisible();
  await expect(page.getByTestId("routines-nav")).toHaveAttribute("aria-current", "page");

  await page.getByTestId("team-nav").click();
  await expect(page).toHaveURL(/\/team$/);
  await expect(page.getByTestId("team-page")).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/team$/);
  await expect(page.getByTestId("team-page"), "刷新后还在团队页").toBeVisible();
  await expect(page.getByTestId("team-nav")).toHaveAttribute("aria-current", "page");
});

test("/g/不存在的群 回到今天", async ({ page }) => {
  await login(page);
  await page.goto("/g/grp_nope");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("today-page")).toBeVisible();
  await expect(page.getByTestId("today-nav")).toHaveAttribute("aria-current", "page");
});

test("团队页点单聊进单 Bot 群，右栏是 Bot 设置且没有例行页签", async ({ page }) => {
  await login(page);
  await page.getByTestId("team-nav").click();

  const cards = page.getByTestId("team-bot");
  await expect(cards, "团队页只列 role = member 的 Bot，主助理不在里面").toHaveCount(3);
  await expect(cards.locator("[data-bot-name=主助理]")).toHaveCount(0);
  const sales = page.locator("[data-testid=team-bot][data-bot-name=小销]");
  await expect(sales).toContainText("销售");

  await sales.getByTestId("team-bot-chat").click();
  await expect(page).toHaveURL(/\/g\/grp_sales$/);
  await expect(page.getByTestId("chat-title")).toHaveText("小销");
  await expect(page.getByTestId("team-nav"), "单聊算在团队底下").toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("bot-panel")).toBeVisible();
  await expect(page.getByTestId("bot-tab-settings")).toBeVisible();
  await expect(page.getByTestId("bot-tab-skills")).toBeVisible();
  await expect(page.getByTestId("bot-tab-routines"), "例行挪去了例行页").toHaveCount(0);
});

test("例行页列出两个 Bot 的例行，行上写着各自的 Bot 名，试跑后这一行多一条运行记录", async ({ page }) => {
  await login(page);
  const created = await page.request.post("/api/bots/bot_sales/routines", {
    data: {
      name: "每日线索早报",
      instruction: "汇总昨天进来的线索",
      triggers: [{ kind: "cron", expr: "0 9 * * *" }],
      onFailure: "stop_and_tell",
    },
  });
  expect(created.status(), "给小销也建一条例行").toBe(201);
  await page.getByTestId("routines-nav").click();

  const service = page.locator("[data-testid=routine-row][data-routine-name=每日工单早报]");
  const sales = page.locator("[data-testid=routine-row][data-routine-name=每日线索早报]");
  await expect(page.getByTestId("routine-row")).toHaveCount(2);
  await expect(service).toHaveAttribute("data-bot-name", "小服");
  await expect(service.getByTestId("routine-bot")).toHaveText("小服");
  await expect(sales).toHaveAttribute("data-bot-name", "小销");
  await expect(sales.getByTestId("routine-bot")).toHaveText("小销");

  await expect(service.getByTestId("routine-run-count")).toHaveText("跑过 3 次");
  await service.getByTestId("routine-run").click();
  await expect(service.getByTestId("routine-run-count"), "试跑多一条运行记录").toHaveText("跑过 4 次");
  await expect(service.getByTestId("routine-last")).toContainText("运行中");
  await expect(sales.getByTestId("routine-run-count"), "别的行不受影响").toHaveText("还没跑过");
});

test("今天页点一条待办进对应群，URL 跟着变", async ({ page, request }) => {
  await setTodayMode(request, "full");
  await login(page);
  await expect(page).toHaveURL(/\/$/);
  const pending = page.getByTestId("today-pending").getByTestId("today-row");
  await expect(pending.first()).toBeVisible();
  await expect(page.getByTestId("today-count"), "今天旁边带待办数").toHaveText(String(await pending.count()));

  await page.getByTestId("today-pending").getByTestId("today-row").filter({ hasText: "本周 X3" }).click();
  await expect(page).toHaveURL(/\/g\/grp_sales$/);
  await expect(page.getByTestId("chat-title")).toHaveText("小销");

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("today-page"), "浏览器后退回到今天").toBeVisible();
});
