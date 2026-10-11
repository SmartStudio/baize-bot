import {
  expect,
  test,
  Message,
  MessageListResponse,
  login,
  openBot,
  openSeededBot,
  sendText,
  teamCard,
  SHOT,
} from "./fixtures";

test("小服的对话按回合排，工具过程收成一行且不露单轮花费", async ({ page }) => {
  await login(page);
  await openBot(page, "小服");
  const list = page.getByTestId("message-list");
  await expect(list.getByTestId("message")).toHaveCount(8);
  await expect(list.locator("[data-kind=user]")).toHaveCount(1);
  await expect(list.locator("[data-kind=bot]")).toHaveCount(2);
  await expect(list.locator("[data-kind=system]")).toHaveCount(1);
  await expect(list.locator("[data-kind=tool_call]").getByTestId("tool-call-card")).toHaveCount(4);
  await expect(list.getByTestId("cost-card"), "单轮花费不在对话里露出").toHaveCount(0);
  await expect(list).not.toContainText("¥4.6");
  await expect(list.getByTestId("activity-toggle")).toHaveAttribute("aria-expanded", "false");
  for (const tool of await list.getByTestId("tool-call-card").all()) await expect(tool).toBeHidden();
  await expect(list.getByTestId("time-divider").first()).toContainText(/\d{2}:\d{2}/);
  await expect(list.getByTestId("bot-turn")).toHaveCount(1);
  await expect(list.locator(".bot-block .avatar"), "单 Bot 气泡旁不再重复头像").toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toHaveAttribute("placeholder", "给 小服 发消息");
  await expect(list.getByTestId("message").first()).toHaveAttribute("data-kind", "user");
  await page.getByTestId("chat").screenshot({ path: "test-results/chat-normal.png" });
  // 今天是默认首页；这里已经点进小服，只截对话这一栏，避免把首页侧栏重复收进用例证据。
  await page.getByTestId("chat").screenshot({ path: `${SHOT}/2a.png` });
});

test("错误 system 显示左对齐提示卡，也不露单轮花费", async ({ page }) => {
  await page.route("**/api/groups/grp_service/messages*", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const payload = MessageListResponse.parse(await response.json());
    const groupId = payload.messages[0]?.groupId;
    if (groupId === undefined) throw new Error("预置对话没有消息");
    const now = Date.now();
    const extra = [
      Message.parse({
        id: "message_error_user",
        groupId,
        body: { kind: "user", text: "刚才的请求有结果吗？" },
        createdAt: new Date(now - 2000).toISOString(),
        revision: 0,
        visibleTo: null,
      }),
      Message.parse({
        id: "message_error_notice",
        groupId,
        body: { kind: "system", tone: "error", text: "模型上游没回话，请稍后再试。" },
        createdAt: new Date(now - 1000).toISOString(),
        revision: 0,
        visibleTo: null,
      }),
      Message.parse({
        id: "message_error_cost",
        groupId,
        body: { kind: "cost", runId: "run_error", steps: 1, amount: 0.000372 },
        createdAt: new Date(now).toISOString(),
        revision: 0,
        visibleTo: null,
      }),
    ];
    await route.fulfill({ response, json: { ...payload, messages: [...payload.messages, ...extra] } });
  });

  await login(page);
  await openSeededBot(page, "小服");
  const notice = page.getByTestId("notice");
  await expect(notice).toHaveAttribute("data-tone", "error");
  await expect(notice).toContainText("模型上游没回话，请稍后再试。");
  await expect(notice.locator("svg")).toHaveCount(1);
  await expect(notice.getByTestId("cost-card"), "报错卡也不露单轮花费").toHaveCount(0);
  await expect(page.getByTestId("time-divider").last()).toContainText(/今天 \d{2}:\d{2}/);
  await page.getByTestId("chat").screenshot({ path: "test-results/chat-error.png" });
});

test("多个已完成工具默认只露摘要，展开后各有状态和一位小数耗时", async ({ page }) => {
  await page.route("**/api/groups/grp_service/messages*", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const payload = MessageListResponse.parse(await response.json());
    const index = payload.messages.findIndex((message) => message.body.kind === "tool_call");
    const first = payload.messages[index];
    if (first?.body.kind !== "tool_call") throw new Error("预置对话没有工具调用");
    const second = Message.parse({
      ...first,
      id: "message_second_tool",
      body: {
        ...first.body,
        tool: "read_task",
        view: { kind: "bash", command: "cat TASK.md", raw: { command: "cat TASK.md" } },
        durationMs: 1500,
      },
    });
    const messages = payload.messages.slice();
    messages.splice(index + 1, 0, second);
    await route.fulfill({ response, json: { ...payload, messages } });
  });

  await login(page);
  await openSeededBot(page, "小服");
  const list = page.getByTestId("message-list");
  await expect(list.getByTestId("activity-toggle")).toContainText("做了 5 步");
  await expect(list.getByTestId("tool-call-card")).toHaveCount(5);
  await expect(list.getByTestId("tool-call-card").first()).toBeHidden();
  await list.getByTestId("activity-toggle").click();
  await expect(list.getByTestId("tool-call-card").first()).toBeVisible();
  const extra = list.locator('[data-testid="tool-call-card"][data-view-kind="bash"]').last();
  await expect(extra).toContainText("cat TASK.md");
  await expect(extra).toContainText("1.5s");
});

test("离底部超过一屏显示回到底部，新消息不抢阅读位置", async ({ page }) => {
  await page.route("**/api/groups/grp_service/messages*", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const payload = MessageListResponse.parse(await response.json());
    const groupId = payload.messages[0]?.groupId;
    if (groupId === undefined) throw new Error("预置对话没有消息");
    const extra = Array.from({ length: 35 }, (_, index) =>
      Message.parse({
        id: `message_scroll_${index}`,
        groupId,
        body: { kind: "user", text: `历史问题 ${index + 1}：请核对这一轮的记录。` },
        createdAt: new Date(Date.now() - (35 - index) * 60_000).toISOString(),
        revision: 0,
        visibleTo: null,
      }),
    );
    await route.fulfill({ response, json: { ...payload, messages: [...payload.messages, ...extra] } });
  });

  await login(page);
  await openSeededBot(page, "小服");
  const list = page.getByTestId("message-list");
  await expect(list.locator('[data-kind="user"]')).toHaveCount(36);
  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
  const back = page.getByTestId("scroll-to-bottom");
  await expect(back).toBeVisible();

  await sendText(page, "请再看最新记录");
  await expect(list.locator('[data-kind="user"]', { hasText: "请再看最新记录" })).toHaveCount(1);
  expect(await list.evaluate((element) => element.scrollTop)).toBe(0);

  await back.click();
  await expect(back).toHaveCount(0);
  await expect
    .poll(() => list.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight))
    .toBeLessThan(24);
});

test("发一条消息后它出现在列表里，Bot 的回复从 WebSocket 推回来", async ({ page }) => {
  await login(page);
  await openSeededBot(page, "小销");
  const list = page.getByTestId("message-list");
  const botsBefore = await list.locator("[data-kind=bot]").count();
  const text = "把 Globex 的报价单再核一遍";

  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();

  await expect(list.locator("[data-kind=user]", { hasText: text })).toHaveCount(1);
  await expect(list.locator("[data-kind=bot]")).toHaveCount(botsBefore + 1);
  // Bot 回完会收到花费摘要，团队页卡片上的摘要停在最后那条上。
  await page.getByTestId("team-nav").click();
  const card = teamCard(page, "小销");
  await expect(card).toContainText("已完成");
  await expect(card).not.toContainText("本次花费");
});
