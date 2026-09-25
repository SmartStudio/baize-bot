import {
  expect,
  test,
  Message,
  MessageListResponse,
  ServerPush,
  SHOT,
  TEAM_TITLE,
  handoffFromService,
  login,
  openBot,
  openTeamGroup,
  teamItem,
} from "./fixtures";

test("Bot 定向气泡在署名旁标收件人，用户和普通 Bot 消息不标", async ({ page }) => {
  await page.route("**/api/groups/grp_order/messages*", async (route) => {
    const response = await route.fetch();
    const payload = MessageListResponse.parse(await response.json());
    payload.messages = [
      Message.parse({
        id: "msg_direct_one",
        groupId: "grp_order",
        createdAt: "2026-09-18T01:00:00.000Z",
        body: { kind: "bot", botId: "bot_service", text: "请查供应商库存。", streaming: false, mentions: ["bot_buy"] },
      }),
      Message.parse({
        id: "msg_direct_many",
        groupId: "grp_order",
        createdAt: "2026-09-18T01:01:00.000Z",
        body: {
          kind: "bot",
          botId: "bot_service",
          text: "请一起核对报价。",
          streaming: false,
          mentions: ["bot_buy", "bot_sales"],
        },
      }),
      Message.parse({
        id: "msg_direct_user",
        groupId: "grp_order",
        createdAt: "2026-09-18T01:02:00.000Z",
        body: { kind: "user", text: "@小采 查一下。", mentions: ["bot_buy"] },
      }),
      Message.parse({
        id: "msg_direct_empty",
        groupId: "grp_order",
        createdAt: "2026-09-18T01:03:00.000Z",
        body: { kind: "bot", botId: "bot_buy", text: "收到。", streaming: false, mentions: [] },
      }),
      Message.parse({
        id: "msg_direct_absent",
        groupId: "grp_order",
        createdAt: "2026-09-18T01:04:00.000Z",
        body: { kind: "bot", botId: "bot_buy", text: "正在查询。", streaming: false },
      }),
    ];
    await route.fulfill({ json: payload });
  });
  await login(page);
  await page.getByTestId("overnight-card").getByRole("button", { name: "知道了" }).click();
  await openTeamGroup(page, TEAM_TITLE);
  await expect(page.getByTestId("bot-recipient")).toHaveText(["发给 小采", "发给 小采、小销"]);
  await expect(page.getByTestId("bot-source").filter({ has: page.getByTestId("bot-recipient") })).toHaveCount(2);
  await expect(page.locator('[data-kind="user"]').getByTestId("bot-recipient")).toHaveCount(0);
  await page.screenshot({ path: `${SHOT}/comm-mentions.png` });
});

test("群头成员和侧栏经手人随 task_updated 同步变化，单 Bot 不显示成员行", async ({ page, request }) => {
  await login(page);
  await page.getByTestId("overnight-card").getByRole("button", { name: "知道了" }).click();
  await openBot(page, "小服");
  await expect(page.getByTestId("chat-members")).toHaveCount(0);
  await expect(page.getByTestId("bot-item").getByTestId("group-handler")).toHaveCount(0);
  await openTeamGroup(page, TEAM_TITLE);
  const members = page.getByTestId("chat-member");
  await expect(members).toContainText(["小服", "小销", "小采"]);
  await expect(members.locator(".avatar")).toHaveCount(3);
  const handler = teamItem(page).getByTestId("group-handler");
  await expect(handler).toHaveText("待派活");
  await handoffFromService(page, request);
  await expect(members.filter({ hasText: "经手" })).toContainText("小服经手");
  await expect(handler).toHaveText("小服 经手");
  expect((await request.post("/api/test/handoff/accept")).status()).toBe(204);
  await expect(members.filter({ hasText: "经手" })).toContainText("小采经手");
  await expect(handler).toHaveText("小采 经手");
  await page.screenshot({ path: `${SHOT}/comm-handler.png` });
  await page.reload();
  await openTeamGroup(page, TEAM_TITLE);
  await expect(members.filter({ hasText: "经手" })).toContainText("小采经手");
  await expect(handler).toHaveText("小采 经手");
});

test("首席和群回合由 WebSocket 推送更新，结束后恢复群头和侧栏", async ({ page, request }) => {
  const turnFrames: number[] = [];
  page.on("websocket", (socket) =>
    socket.on("framereceived", (frame) => {
      const parsed = ServerPush.safeParse(JSON.parse(String(frame.payload)));
      if (parsed.success && parsed.data.type === "group_turn") turnFrames.push(parsed.data.epoch);
    }),
  );
  await login(page);
  await page.getByTestId("overnight-card").getByRole("button", { name: "知道了" }).click();
  await openBot(page, "小服");
  await expect(page.getByTestId("chat-members"), "单 Bot 群没有成员行").toHaveCount(0);
  await expect(page.getByTestId("group-turn"), "单 Bot 群没有轮流说提示").toHaveCount(0);
  await openTeamGroup(page, TEAM_TITLE);

  const members = page.getByTestId("chat-members");
  const handler = teamItem(page).getByTestId("group-handler");
  await expect(members.getByText("首席"), "预置群没有首席").toHaveCount(0);
  expect(
    (
      await request.post("/api/test/group/updated", { data: { groupId: "grp_order", chiefBotId: "bot_sales" } })
    ).status(),
    "mock 把整条 group_updated 推到 WebSocket",
  ).toBe(204);
  await expect(members.getByTestId("chat-member").filter({ hasText: "首席" })).toContainText("小销首席");
  await page.screenshot({ path: `${SHOT}/comm-chief.png` });

  const turn = { groupId: "grp_order", epoch: 12, current: "bot_sales", next: ["bot_buy"] };
  expect((await request.post("/api/test/group/turn", { data: turn })).status(), "mock 推送 group_turn").toBe(204);
  await expect(page.getByTestId("group-turn")).toHaveText("轮到 小销，接着 小采");
  await expect(handler).toHaveText("小销正在说");

  await page.reload();
  await openTeamGroup(page, TEAM_TITLE);
  await expect(members.getByTestId("chat-member").filter({ hasText: "首席" }), "首席从群列表重新读回").toContainText(
    "小销首席",
  );
  await expect(page.getByTestId("group-turn"), "重连后收到正在进行的回合快照").toHaveText("轮到 小销，接着 小采");
  await expect(handler).toHaveText("小销正在说");

  await handoffFromService(page, request);
  await expect(page.getByTestId("task-current"), "回合进行中任务卡仍更新经手人").toHaveText("当前 小服");
  await expect(handler, "轮流说提示优先于经手人").toHaveText("小销正在说");
  expect((await request.post("/api/test/handoff/accept")).status(), "小采确认交接").toBe(204);
  await expect(page.getByTestId("task-current")).toHaveText("当前 小采");
  await expect(handler, "经手人变更后仍优先显示当前发言人").toHaveText("小销正在说");
  await expect(page.getByTestId("handoff-card")).toHaveAttribute("data-status", "accepted");
  await expect(page.getByTestId("message-list").getByTestId("cost-card")).toHaveCount(1);
  await expect(page.getByTestId("group-turn")).toHaveText("轮到 小销，接着 小采");
  const overnight = page.getByTestId("overnight-card");
  if (await overnight.isVisible()) {
    await overnight.getByRole("button", { name: "知道了" }).click();
    await expect(overnight).toHaveCount(0);
  }
  await page.getByTestId("handoff-card").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOT}/comm-turn.png` });

  const beforeStale = turnFrames.length;
  expect(
    (
      await request.post("/api/test/group/turn", { data: { ...turn, epoch: 11, current: "bot_service", next: [] } })
    ).status(),
    "旧 epoch 仍通过真实 WebSocket 发出",
  ).toBe(204);
  await expect.poll(() => turnFrames.length).toBe(beforeStale + 1);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.getByTestId("group-turn"), "旧回合不能盖掉新回合").toHaveText("轮到 小销，接着 小采");
  await expect(handler).toHaveText("小销正在说");

  await openBot(page, "小服");
  await expect(page.getByTestId("chat-members"), "回合进行中单 Bot 群仍没有成员行").toHaveCount(0);
  await expect(page.getByTestId("group-turn"), "回合进行中单 Bot 群仍没有轮流说提示").toHaveCount(0);
  await expect(page.getByTestId("bot-item").getByTestId("group-handler")).toHaveCount(0);
  await openTeamGroup(page, TEAM_TITLE);

  const beforeEnd = turnFrames.length;
  expect(
    (
      await request.post("/api/test/group/turn", { data: { groupId: "grp_order", epoch: 12, current: null, next: [] } })
    ).status(),
    "结束报文清掉回合",
  ).toBe(204);
  await expect.poll(() => turnFrames.length).toBe(beforeEnd + 1);
  await expect(page.getByTestId("group-turn")).toHaveCount(0);
  await expect(handler).toHaveText("小采 经手");
  await expect(members.getByTestId("chat-member").filter({ hasText: "首席" })).toContainText("小销首席");

  const beforeLate = turnFrames.length;
  expect(
    (await request.post("/api/test/group/turn", { data: { ...turn, epoch: 11 } })).status(),
    "结束后旧 epoch 仍通过 WebSocket 发出",
  ).toBe(204);
  await expect.poll(() => turnFrames.length).toBe(beforeLate + 1);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.getByTestId("group-turn"), "结束后旧回合不能复活").toHaveCount(0);
  await expect(handler).toHaveText("小采 经手");
});
