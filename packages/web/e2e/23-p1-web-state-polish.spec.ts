import { MessageListResponse, expect, login, openSeededBot, openSettings, test } from "./fixtures";

test("电脑页听 computer_updated 推送：另一台休眠，状态不刷新就变，圆点和文字之间有间距", async ({ page, request }) => {
  await login(page);
  await openSettings(page);
  const listed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/computers");
  await page.getByTestId("settings-nav-accounts").click();
  await listed;
  const remote = page.locator("[data-testid=computer-row][data-computer-id=cmp_remote]");
  await expect(remote.getByTestId("computer-status")).toHaveAttribute("data-status", "online");

  const pushed = await request.post("/api/test/computers/cmp_remote/status", { data: { status: "sleeping" } });
  expect(pushed.status()).toBe(204);

  await expect(remote.getByTestId("computer-status"), "推送到了，页面不重拉就变").toHaveAttribute(
    "data-status",
    "sleeping",
  );
  await expect(remote).toHaveText("远程电脑休眠");

  const dot = await remote.locator(".status-dot").boundingBox();
  const label = await remote.locator("[data-testid=computer-status] b").boundingBox();
  if (dot === null || label === null) throw new Error("圆点或状态文字没画出来");
  expect(label.x - (dot.x + dot.width), "圆点和文字之间至少 4px，不再贴着").toBeGreaterThanOrEqual(4);
});

test("群聊按 createdAt 排：系统回应先到、你那句后到，屏上你那句仍在前", async ({ page, request }) => {
  await login(page);
  await openSeededBot(page, "小服");
  const list = page.getByTestId("message-list");
  const base = Date.now() + 3_600_000;
  const said = "乱序到达：你先说的这句";
  const reply = "乱序到达：它回的这句";

  const replyPosted = await request.post("/api/test/messages", {
    data: {
      groupId: "grp_service",
      botId: "bot_service",
      text: reply,
      createdAt: new Date(base + 2_000).toISOString(),
    },
  });
  expect(replyPosted.status()).toBe(204);
  await expect(list.getByText(reply)).toBeVisible();
  const saidPosted = await request.post("/api/test/messages", {
    data: { groupId: "grp_service", text: said, createdAt: new Date(base + 1_000).toISOString() },
  });
  expect(saidPosted.status()).toBe(204);
  await expect(list.getByText(said)).toBeVisible();

  const shown = await list.getByTestId("message").evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
  const tail = shown.slice(-2);
  expect(tail[0], "后到的那句按时间排在前").toContain(said);
  expect(tail[1]).toContain(reply);
});

test("项目页最近一轮：同一个 Bot 一块一条地连着说，头像和名字只在第一条显示，换人再显示", async ({ page, request }) => {
  await login(page);
  await page.goto("/p/grp_order");
  const base = Date.now() + 3_600_000;
  const post = async (data: object) => expect((await request.post("/api/test/messages", { data })).status()).toBe(204);
  await post({ groupId: "grp_order", text: "开干", createdAt: new Date(base).toISOString() });
  const lines = [
    ["bot_service", "先读资料"],
    ["bot_service", "读完了，开始排期"],
    ["bot_service", "排好了"],
    ["bot_sales", "我来报价"],
  ] as const;
  for (const [at, [botId, text]] of lines.entries()) {
    await post({ groupId: "grp_order", botId, text, createdAt: new Date(base + 1_000 * (at + 1)).toISOString() });
  }

  const latest = page.getByTestId("project-latest-turn");
  await expect(latest.getByText("我来报价")).toBeVisible();
  await expect(latest.getByText("先读资料")).toBeVisible();
  await expect(latest.getByTestId("project-turn-who"), "小服连说三条只露一次，换成小销再露一次").toHaveText([
    /小服/,
    /小销/,
  ]);
});

test("群聊同一毫秒：先推你那句、再推 id 更小的回应，屏上仍是你那句在前", async ({ page, request }) => {
  await login(page);
  await openSeededBot(page, "小服");
  const list = page.getByTestId("message-list");
  const createdAt = new Date(Date.now() + 3_600_000).toISOString();
  const post = async (data: object) => expect((await request.post("/api/test/messages", { data })).status()).toBe(204);
  const said = "同毫秒：你先说的这句";
  const reply = "同毫秒：它回的这句";
  await post({ groupId: "grp_service", text: said, createdAt, id: "msg_tie_zzzz" });
  await expect(list.getByText(said)).toBeVisible();
  await post({ groupId: "grp_service", botId: "bot_service", text: reply, createdAt, id: "msg_tie_aaaa" });
  await expect(list.getByText(reply)).toBeVisible();

  const shown = await list.getByTestId("message").evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
  const tail = shown.slice(-2);
  expect(tail[0], "同毫秒保留推送到达的次序，不按 id 翻过来").toContain(said);
  expect(tail[1]).toContain(reply);
});

for (const skew of [-5_000, 5_000]) {
  test(`没有空壳的 delta 到达，本地时钟偏 ${skew}ms，回复仍排在已知消息之后、之后的消息之前`, async ({
    page,
    request,
  }) => {
    await login(page);
    await openSeededBot(page, "小服");
    const list = page.getByTestId("message-list");
    const base = Date.now() + 3_600_000;
    await page.clock.setFixedTime(new Date(base + 1_000 + skew));
    const post = async (data: object) =>
      expect((await request.post("/api/test/messages", { data })).status()).toBe(204);
    await post({ groupId: "grp_service", text: "偏钟：你那句", createdAt: new Date(base).toISOString() });
    await post({
      groupId: "grp_service",
      botId: "bot_service",
      text: "偏钟：中间那条",
      createdAt: new Date(base + 1_000).toISOString(),
    });
    await expect(list.getByText("偏钟：中间那条")).toBeVisible();

    const streamed = await request.post("/api/test/message-delta", {
      data: { groupId: "grp_service", messageId: "msg_delta_only", delta: "偏钟：只靠 delta 长出来的回复", done: true },
    });
    expect(streamed.status()).toBe(204);
    await expect(list.getByText("偏钟：只靠 delta 长出来的回复")).toBeVisible();
    await post({ groupId: "grp_service", text: "偏钟：之后那句", createdAt: new Date(base + 2_000).toISOString() });
    await expect(list.getByText("偏钟：之后那句")).toBeVisible();

    const shown = await list.getByTestId("message").evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
    const rank = ["偏钟：你那句", "偏钟：中间那条", "偏钟：只靠 delta", "偏钟：之后那句"].map((text) =>
      shown.findIndex((shownText) => shownText.includes(text)),
    );
    expect(
      rank.every((at) => at >= 0),
      "四条都在屏上",
    ).toBe(true);
    expect(rank, "顺序是你那句、中间那条、delta 回复、之后那句").toEqual(rank.toSorted((left, right) => left - right));
  });
}

test("较晚的回复先到、较早的用户消息后到，团队页摘要仍是较晚那条", async ({ page, request }) => {
  await login(page);
  await openSeededBot(page, "小服");
  const list = page.getByTestId("message-list");
  const base = Date.now() + 3_600_000;
  const post = async (data: object) => expect((await request.post("/api/test/messages", { data })).status()).toBe(204);
  await post({
    groupId: "grp_service",
    botId: "bot_service",
    text: "摘要：较晚的回复",
    createdAt: new Date(base + 1_000).toISOString(),
  });
  await expect(list.getByText("摘要：较晚的回复")).toBeVisible();
  await post({ groupId: "grp_service", text: "摘要：较早的话", createdAt: new Date(base).toISOString() });
  await expect(list.getByText("摘要：较早的话")).toBeVisible();

  await page.getByTestId("team-nav").click();
  await expect(page.locator('[data-testid=team-bot][data-bot-name="小服"] .team-bot-preview')).toContainText(
    "摘要：较晚的回复",
  );
});

test("默认 50 条历史窗口跨同毫秒边界，重连重拉后用户那句仍在回应前", async ({ page, request }) => {
  await login(page);
  await openSeededBot(page, "小服");
  const list = page.getByTestId("message-list");
  const base = Date.now() + 3_600_000;
  const post = async (data: object) => expect((await request.post("/api/test/messages", { data })).status()).toBe(204);
  const tied = new Date(base).toISOString();
  await post({ groupId: "grp_service", text: "窗口：A 用户那句", createdAt: tied, id: "msg_window_zzzz" });
  await post({
    groupId: "grp_service",
    botId: "bot_service",
    text: "窗口：B 回应",
    createdAt: tied,
    id: "msg_window_aaaa",
  });
  for (let at = 1; at <= 48; at += 1) {
    await post({
      groupId: "grp_service",
      botId: "bot_service",
      text: `窗口：之后第 ${at} 条`,
      createdAt: new Date(base + 1_000 * at).toISOString(),
    });
  }
  await expect(list.getByText("窗口：之后第 48 条")).toBeVisible();

  await post({
    groupId: "grp_service",
    botId: "bot_service",
    text: "窗口：只在历史里的收尾",
    createdAt: new Date(base + 60_000).toISOString(),
    silent: true,
  });
  const resynced = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === "/api/groups/grp_service/messages",
  );
  expect((await request.post("/api/test/sockets/drop")).status()).toBe(204);
  const history = MessageListResponse.parse(await (await resynced).json());
  expect(history.messages, "默认窗口 50 条").toHaveLength(50);
  expect(history.messages[0]?.id, "窗口从 B 开始").toBe("msg_window_aaaa");
  expect(
    history.messages.some((message) => message.id === "msg_window_zzzz"),
    "A 在窗口外",
  ).toBe(false);
  await expect(list.getByText("窗口：只在历史里的收尾"), "没推送过，页面有它说明这份历史已落地").toBeVisible();

  const shown = await list.getByTestId("message").evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
  const userAt = shown.findIndex((text) => text.includes("窗口：A 用户那句"));
  const replyAt = shown.findIndex((text) => text.includes("窗口：B 回应"));
  expect(userAt, "窗口外的 A 本地还留着").toBeGreaterThanOrEqual(0);
  expect(userAt, "A 和 B 同毫秒，A 本来在前，重拉不翻").toBeLessThan(replyAt);
});
