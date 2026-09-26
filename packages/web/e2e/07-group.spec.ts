import {
  expect,
  test,
  EMAIL,
  PASSWORD,
  SHOT,
  TEAM_TITLE,
  handoffFromService,
  login,
  openTeamGroup,
  stubNotifications,
  teamItem,
} from "./fixtures";

test("现有群的任务卡不再显示 T 编号", async ({ page }) => {
  await login(page);
  await expect(page.locator("[data-testid=group-item]"), "预置里本来就有一个多 Bot 群").toHaveCount(1);

  await openTeamGroup(page, TEAM_TITLE);
  await expect(page.getByTestId("chat-subtitle")).toContainText("你 + 3 个 Bot");
  await expect(page.getByTestId("task-number"), "任务卡不再露出系统编号").toHaveCount(0);
  await expect(page.getByTestId("task-card")).not.toContainText(/T-\d{4}/);
  await expect(page.getByTestId("task-progress"), "预置清单保留").toHaveText("清单 0 / 5");
  await expect(page.getByTestId("task-current")).toHaveText("当前 还没人接手");
  await page.screenshot({ path: `${SHOT}/08.png` });
});

test("群里 @ 一个 Bot，只有它回话，清单第一项跟着勾上", async ({ page }) => {
  await login(page);
  await openTeamGroup(page, TEAM_TITLE);
  await expect(page.getByTestId("task-progress")).toHaveText("清单 0 / 5");
  await expect(page.getByTestId("task-current"), "建好还没人接手").toHaveText("当前 还没人接手");

  const input = page.getByTestId("composer-input");
  await input.fill("@小");
  await expect(page.getByTestId("mention-menu"), "打 @ 就弹成员名单").toBeVisible();
  await page.locator('[data-testid=mention-option][data-bot-name="小销"]').click();
  await expect(input, "选中谁就往输入框里插「@小销 」").toHaveValue("@小销 ");
  await input.fill("@小销 查一下 X3 的现货还有多少");
  await page.getByTestId("composer-send").click();

  const list = page.getByTestId("message-list");
  await expect(page.getByTestId("task-progress"), "清单进度更新说明这次运行跑完了").toHaveText("清单 1 / 5");
  await expect(list.locator("[data-kind=bot]"), "群里只有被 @ 的那个开口").toHaveCount(1);
  const source = list.getByTestId("bot-source");
  await expect(source, "多 Bot 群里每条 Bot 消息上方写清是谁说的").toHaveCount(1);
  await expect(source).toHaveAttribute("data-bot-name", "小销");
  await expect(source).toContainText("小销 · 销售");
  expect(await source.evaluate((element) => element.nextElementSibling?.getAttribute("data-testid"))).toBe(
    "bot-bubble",
  );
  await expect(page.getByTestId("composer-input")).toHaveAttribute("placeholder", `给 ${TEAM_TITLE} 发消息`);
  await expect(page.locator('[data-testid=bot-source][data-bot-name="小服"]'), "没被 @ 的那个一句话都没说").toHaveCount(
    0,
  );

  await expect(page.getByTestId("task-current"), "被 @ 就是接手").toHaveText("当前 小销");
  await expect(page.getByTestId("checklist-item").first(), "接手的 Bot 干完一步就勾掉一项").toBeChecked();
  await expect(page.getByTestId("task-progress")).toHaveText("清单 1 / 5");
  await page.screenshot({ path: `${SHOT}/05.png` });
});

test("在任务卡上勾掉第二项，卡片和任务详情一起跟着变，刷新还在", async ({ page }) => {
  await login(page);
  await openTeamGroup(page, TEAM_TITLE);
  const items = page.getByTestId("checklist-item");
  await expect(items).toHaveCount(5);

  const saved = page.waitForResponse((res) => res.url().includes("/api/tasks/") && res.request().method() === "PATCH");
  // 清单是受控的，勾上要等服务端把整份清单回过来，check() 会因为点完那一下状态还没变而失败。
  await items.nth(1).click();
  await saved;

  await expect(items.nth(1), "勾的是第二项").toBeChecked();
  await expect(items.first(), "别的项不受影响").not.toBeChecked();
  await expect(page.getByTestId("task-progress"), "卡片上的进度跟着走").toHaveText("清单 1 / 5");

  await page.getByTestId("task-open").click();
  const panel = page.getByTestId("task-panel");
  await expect(panel.getByTestId("task-panel-checklist").locator("li").nth(1)).toHaveAttribute("data-done", "true");
  await expect(panel.getByTestId("task-handled"), "还没人接手，经手里两个成员都在等").toContainText("等待接手");
  await page.screenshot({ path: `${SHOT}/5b.png` });

  // 刷新走的是拉历史那条路。整份清单真存到服务端了才留得住。
  await page.reload();
  await openTeamGroup(page, TEAM_TITLE);
  await expect(page.getByTestId("checklist-item").nth(1), "刷新后第二项还是勾着的").toBeChecked();
});

test("登录前已有的交接在未打开群时收到确认推送，侧栏角标归零", async ({ page, request }) => {
  expect((await request.post("/api/test/handoff/pending")).status()).toBe(201);
  await login(page);
  const badge = teamItem(page).getByTestId("bot-handoff");
  await expect(badge, "登录列表带回待确认计数").toHaveText("等 Bot 确认 1");

  expect((await request.post("/api/test/handoff/accept")).status()).toBe(204);
  await expect(badge, "未拉群历史也能按终态推送清掉角标").toHaveCount(0);
});

test("小服干完活发一张交接报文卡，侧栏记一笔「等 Bot 确认 1」", async ({ page, request }) => {
  await login(page);
  const card = await handoffFromService(page, request);

  await expect(card, "小采还没确认").toHaveAttribute("data-status", "pending");
  const pair = card.getByTestId("handoff-pair");
  await expect(pair, "卡头写清这一份从谁手上交出去").toContainText("小服");
  await expect(pair, "也写清交到谁手上").toContainText("小采");
  await expect(card.getByTestId("handoff-status"), "没确认之前卡上写的是在等谁").toHaveText("等小采确认");
  await expect(card.getByTestId("handoff-done"), "做了什么").toContainText("10 月 20 日能先交 120 台");
  await expect(card.getByTestId("handoff-not-done"), "没做什么").toContainText("三家供应商的现货和到货期");
  await expect(card.getByTestId("handoff-next"), "下一步").toContainText("最早到货日");
  // 小服接手时勾掉了第一项，指针指的是下一个人该接着做的那一项，卡上写的是那一项的正文而不只是个序号。
  await expect(card.getByTestId("handoff-checklist"), "清单指针指到具体哪一项").toHaveText(
    "第 2 项 · 出 200 台 X3 的报价单",
  );

  await expect(page.getByTestId("task-current"), "还没确认，任务卡上仍是小服").toHaveText("当前 小服");
  const sidebarItem = teamItem(page);
  const handoffBadge = sidebarItem.getByTestId("bot-handoff");
  await expect(handoffBadge, "一条没确认的交接在侧栏就是「等 Bot 确认 1」").toHaveText("等 Bot 确认 1");
  const title = sidebarItem.getByTestId("project-title");
  const titleMetrics = await title.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
  }));
  expect(titleMetrics.height, "有角标时群标题仍只有一行").toBeLessThan(titleMetrics.lineHeight * 2);
  const titleBox = await title.boundingBox();
  const badgeBox = await handoffBadge.boundingBox();
  if (titleBox === null || badgeBox === null) throw new Error("群标题或交接角标没有可测量的布局框");
  expect(badgeBox.y, "角标单独排在标题下一行").toBeGreaterThan(titleBox.y + titleBox.height / 2);

  // 角标这一路是推送加出来的。刷新后它只能从列表接口的计数里来，两个接口没数上的话一刷新角标就没了。
  await request.post("/api/auth/login", { data: { email: EMAIL, password: PASSWORD } });
  const listed = (await (await request.get("/api/groups")).json()) as { items: { pendingHandoffs: number }[] };
  expect(
    listed.items.map((entry) => entry.pendingHandoffs),
    "没确认的交接进 GET /api/groups 的计数",
  ).toEqual([1]);
  const listedBots = (await (await request.get("/api/bots")).json()) as { items: { pendingHandoffs: number }[] };
  expect(
    listedBots.items.map((entry) => entry.pendingHandoffs),
    "交接记在群那本账上，不串到四个单 Bot 群里",
  ).toEqual([0, 0, 0, 0]);
  await page.screenshot({ path: `${SHOT}/5c.png` });
});

test("小采确认之后卡片变已接手、角标归零、任务卡当前经手换成小采", async ({ page, request }) => {
  await login(page);
  const card = await handoffFromService(page, request);

  await expect(card, "确认前交接仍在等待").toHaveAttribute("data-status", "pending");
  expect((await request.post("/api/test/handoff/accept")).status(), "小采现在确认").toBe(204);
  await expect(card, "小采确认后状态从服务端推回来").toHaveAttribute("data-status", "accepted");
  await expect(card.getByTestId("handoff-status"), "接手了就写上时刻").toContainText("已接手 · ");
  await expect(teamItem(page).getByTestId("bot-handoff"), "没有在等确认的交接了，角标整个不渲染").toHaveCount(0);
  await expect(page.getByTestId("task-current"), "接手就是换经手人").toHaveText("当前 小采");

  await page.getByTestId("task-open").click();
  const handled = page.getByTestId("task-panel").getByTestId("task-handled").locator("li");
  await expect(handled.nth(0), "小服那一条在接手的时刻收了尾").not.toContainText("当前");
  await expect(handled.nth(1), "经手记录随 task_updated 长出新的一条").toContainText("小采");
  await expect(handled.nth(1), "小采是当前那一位").toContainText("当前");
  await page.screenshot({ path: `${SHOT}/5d.png` });

  // 刷新走的是拉历史那条路。卡的状态得跟着 GET /messages 的 handoffs 回来，不能只活在推送攒出来的内存里。
  await page.reload();
  await openTeamGroup(page, TEAM_TITLE);
  await expect(page.getByTestId("handoff-card"), "刷新后交接卡还带着已接手").toHaveAttribute("data-status", "accepted");
  await expect(page.getByTestId("task-current"), "换过的经手人也存住了").toHaveText("当前 小采");
});

test("交接是 Bot 等 Bot：不占「等你点头」那个角标，也不弹通知", async ({ page, request }) => {
  await stubNotifications(page);
  await login(page);
  await handoffFromService(page, request);

  const item = teamItem(page);
  await expect(item.getByTestId("bot-handoff"), "交接记在自己那本账上").toHaveText("等 Bot 确认 1");
  await expect(item.getByTestId("bot-pending"), "Bot 之间的确认不是你的审批，不该混进「等你点头」").toHaveCount(0);
  expect(
    (await page.evaluate(() => window.__notifications?.sent)) ?? [],
    "这件事不用你动手，不该拿系统通知把你从别的事上拽回来",
  ).toHaveLength(0);
});
