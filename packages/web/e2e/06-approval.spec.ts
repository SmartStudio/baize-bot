import {
  expect,
  test,
  NEEDS_APPROVAL,
  SHOT,
  dndAround,
  login,
  openBot,
  sendForApproval,
  sendText,
  setDnd,
  teamCard,
  stubNotifications,
} from "./fixtures";

test("要点头的工具让群里出一张审批卡，侧栏记一笔「等你点头 1」", async ({ page }) => {
  await login(page);
  const card = await sendForApproval(page, "小销");

  await expect(card.getByTestId("approval-reject"), "拒绝按钮在卡上").toBeVisible();
  await expect(card.getByTestId("approval-approve"), "批准按钮在卡上").toBeVisible();
  await expect(card, "卡上写清楚要点头的是哪一类").toContainText("对外发送");
  await expect(card, "卡上写清楚这次要做什么").toContainText(NEEDS_APPROVAL);

  // 没点头之前这一步不许往下走，工具卡得停在运行中，不能自己变完成。
  await expect(page.getByTestId("tool-call-card"), "等结论的工具卡停在运行中").toHaveAttribute(
    "data-status",
    "running",
  );
  await expect(page.getByTestId("cost-card"), "还没点头就不该结账").toHaveCount(0);

  const item = teamCard(page, "小销");
  await page.getByTestId("team-nav").click();
  await expect(item.getByTestId("bot-pending"), "一条 pending 审批在团队页卡片上就是「等你点头 1」").toHaveText(
    "等你点头 1",
  );

  // 刷新走的是拉历史那条路。历史里的审批只填表不动计数，不然 GET /api/bots 已经数过的这一条会被加第二遍。
  await page.reload();
  await openBot(page, "小销");
  // 先等审批卡从历史里回来。它出现才说明 approvals_loaded 已经派发过，这时候数角标才数得到多加的那一下。
  await expect(page.getByTestId("approval-card"), "历史里的审批卡也带着状态").toHaveAttribute("data-status", "pending");
  await expect(page.getByTestId("approval-approve"), "还没点头，按钮还在").toBeVisible();
  await page.getByTestId("team-nav").click();
  await expect(item.getByTestId("bot-pending"), "刷新后还是 1，历史没有把它再加一遍").toHaveText("等你点头 1");
});

test("点拒绝后卡片留下结论、角标归零、这一步被拦下", async ({ page }) => {
  await login(page);
  const card = await sendForApproval(page, "小销");

  await card.getByTestId("approval-reject").click();

  await expect(card, "结论落在卡上，状态从服务端推回来").toHaveAttribute("data-status", "rejected");
  await expect(card.getByTestId("approval-decided"), "有结论的卡只剩一行记录").toHaveText("已拒绝");
  await expect(card.getByTestId("approval-reject"), "有结论就不该还留着按钮").toHaveCount(0);

  await expect(page.getByTestId("cost-card"), "拒绝之后也不露单轮花费").toHaveCount(0);
  await expect(page.getByTestId("tool-call-card"), "拒绝把这一步拦下，工具卡终态是 blocked").toHaveAttribute(
    "data-status",
    "blocked",
  );
  const trace = await page.evaluate(() => window.__runTrace);
  expect(trace?.tool, "同一张工具卡先运行中再被拦下，中间没有自己变完成").toEqual(["running", "blocked"]);

  await page.getByTestId("team-nav").click();
  const item = teamCard(page, "小销");
  await expect(item, "团队页卡片到了才谈得上看角标").toBeVisible();
  await expect(item.getByTestId("bot-pending"), "没有 pending 审批了角标整个不渲染").toHaveCount(0);
});

test("在群里回一句「批准」和点批准按钮是同一件事", async ({ page }) => {
  await login(page);
  const card = await sendForApproval(page, "小销");

  await sendText(page, "批准");

  await expect(card, "群里回的一句话也作用到那条 pending 审批上").toHaveAttribute("data-status", "approved");
  await expect(card.getByTestId("approval-decided")).toHaveText("已批准");

  await expect(page.getByTestId("tool-call-card"), "批准让这一步真的跑完").toHaveAttribute("data-status", "ok");
  await expect(page.getByTestId("cost-card"), "批准之后也不露单轮花费").toHaveCount(0);
  // 「批准」这四个字本身是结论不是新任务，不该再引出一次运行。
  await expect(page.getByTestId("message-list").locator("[data-kind=tool_call]"), "没有多起一次运行").toHaveCount(1);

  await page.getByTestId("team-nav").click();
  const item = teamCard(page, "小销");
  await expect(item, "团队页卡片到了才谈得上看角标").toBeVisible();
  await expect(item.getByTestId("bot-pending"), "点头之后角标归零").toHaveCount(0);
});

test("已失效的审批卡没有批准按钮", async ({ page, request }) => {
  await login(page);
  const card = await sendForApproval(page, "小销");

  expect((await request.post("/api/test/approval/expire")).status(), "mock 让 pending 审批失效").toBe(204);
  await expect(card).toHaveAttribute("data-status", "expired");
  await expect(card).toContainText("这一步已经不用了");
  await expect(card.getByTestId("approval-approve")).toHaveCount(0);
  await expect(card.getByTestId("approval-reject")).toHaveCount(0);
  await page.screenshot({ path: `${SHOT}/expired-mock.png` });
});

test("发出新消息后，派给当前 Bot 的待批卡作废并解开运行等待", async ({ page }) => {
  await login(page);
  const card = await sendForApproval(page, "小销");

  await sendText(page, "查一下库存");

  await expect(card, "新消息路由给小销后，这条待批卡作废").toHaveAttribute("data-status", "voided");
  await expect(card.getByTestId("approval-decided")).toHaveText("已作废 · 你发了新消息，这一步不做了");
  await expect(card.getByTestId("approval-approve")).toHaveCount(0);
  await expect(card.getByTestId("approval-reject")).toHaveCount(0);
  await expect(page.getByTestId("tool-call-card").first(), "作废后运行等待结束，这一步被拦下").toHaveAttribute(
    "data-status",
    "blocked",
  );
});

test("超时审批卡显示已拒绝且没有决定按钮", async ({ page, request }) => {
  await login(page);
  const card = await sendForApproval(page, "小销");

  expect((await request.post("/api/test/approval/timeout")).status(), "mock 让 pending 审批超时").toBe(204);
  await expect(card).toHaveAttribute("data-status", "timed_out");
  await expect(card.getByTestId("approval-decided")).toHaveText("已拒绝 · 10 分钟没人批");
  await expect(card.getByTestId("approval-approve")).toHaveCount(0);
  await expect(card.getByTestId("approval-reject")).toHaveCount(0);
  await expect(page.getByTestId("tool-call-card").first(), "超时后运行等待结束，这一步被拦下").toHaveAttribute(
    "data-status",
    "blocked",
  );
});

test("已作废和超时审批卡沿用失效卡的淡化样式", async ({ page, request }) => {
  await login(page);
  const expired = await sendForApproval(page, "小销");
  expect((await request.post("/api/test/approval/expire")).status()).toBe(204);
  await expect(expired).toHaveAttribute("data-status", "expired");
  const muted = await expired.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    border: getComputedStyle(element).borderTopColor,
    color: getComputedStyle(element.querySelector(".card-title")!).color,
  }));

  await sendText(page, "帮我处理退款");
  const pending = page.getByTestId("approval-card").last();
  await expect(pending).toHaveAttribute("data-status", "pending");
  await sendText(page, "查一下库存");
  await expect(pending).toHaveAttribute("data-status", "voided");
  const voided = page.locator('[data-testid="approval-card"][data-status="voided"]');

  await sendText(page, "帮我处理退款");
  const timedOut = page.getByTestId("approval-card").last();
  await expect(timedOut).toHaveAttribute("data-status", "pending");
  expect((await request.post("/api/test/approval/timeout")).status()).toBe(204);
  await expect(timedOut).toHaveAttribute("data-status", "timed_out");

  for (const card of [voided, timedOut]) {
    await expect(card, "卡片背景与失效卡一致").toHaveCSS("background-color", muted.background);
    await expect(card, "卡片边框与失效卡一致").toHaveCSS("border-top-color", muted.border);
    await expect(card.locator(".approval-compact-text"), "摘要文字淡化").toHaveCSS("color", muted.color);
    await expect(card.getByTestId("approval-decided"), "结论文字淡化").toHaveCSS("color", muted.color);
    await expect(card.getByTestId("approval-decided"), "结论背景淡化").toHaveCSS("background-color", muted.background);
  }
});

test("pending 审批有截止时间时显示按拒绝处理的提示", async ({ page, request }) => {
  await login(page);
  await openBot(page, "小销");
  const deadlineAt = new Date(Date.now() + 10 * 60_000).toISOString();
  expect(
    (
      await request.post("/api/test/approval", {
        data: { action: "message_person", groupId: "grp_sales", deadlineAt },
      })
    ).status(),
    "mock 可种带截止时间的 pending 审批",
  ).toBe(201);

  const time = await page.evaluate(
    (value) =>
      new Date(value).toLocaleTimeString("zh-TW", {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
    deadlineAt,
  );
  await expect(page.getByTestId("approval-deadline")).toHaveText(`${time} 前没人批就按拒绝处理`);
});

test("点过按钮就锁住，一次点击只发得出一个结论", async ({ page }) => {
  await login(page);
  const card = await sendForApproval(page, "小销");

  // 把结论请求按住，卡片就停在「点过了但结论还没回来」这一刻，否则它几十毫秒就过去了。
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/approvals/*", async (route) => {
    await held;
    await route.continue();
  });

  await page.getByTestId("approval-reject").click();

  await expect(card.getByTestId("approval-reject"), "点过的那颗立刻锁住，连点两下只算一次").toBeDisabled();
  await expect(
    card.getByTestId("approval-approve"),
    "另一颗也一起锁住，免得同一条审批收到两个相反的结论",
  ).toBeDisabled();

  release();
  await expect(card, "结论回来了卡片才落到已拒绝").toHaveAttribute("data-status", "rejected");
});

test("控制面推来的 notify 立即显示，Web 不再按免打扰攒通知", async ({ page, request }) => {
  await stubNotifications(page);
  const connected = page.waitForEvent("websocket");
  await login(page);
  await connected;

  await setDnd(page, await dndAround(page, -1, 1));
  expect(
    (
      await request.post("/api/test/notify", {
        data: { kind: "confirm", text: "把报价单发给 Lisa", groupId: "grp_sales", at: new Date().toISOString() },
      })
    ).status(),
  ).toBe(204);

  await expect
    .poll(async () => (await page.evaluate(() => window.__notifications?.sent)) ?? [], {
      message: "控制面已经决定推送，浏览器收到后立即显示",
    })
    .toHaveLength(1);
  expect(
    (await page.evaluate(() => window.__notifications?.sent))?.[0],
    "通知正文就是这条审批要你点头的那件事",
  ).toContain("把报价单发给 Lisa");

  expect(
    (
      await request.post("/api/test/notify", {
        data: { kind: "stuck", text: "小红书登录过期", groupId: "grp_sales", at: new Date().toISOString() },
      })
    ).status(),
  ).toBe(204);
  await expect
    .poll(async () => (await page.evaluate(() => window.__notifications?.sent)) ?? [], {
      message: "Web 不再按免打扰区间压住控制面已经推来的通知",
    })
    .toHaveLength(2);
  expect((await page.evaluate(() => window.__notifications?.asked)) ?? 0, "任何时候都不该弹权限请求").toBe(0);
});

test("权限没给就跳过，后续通知仍能到达", async ({ page, request }) => {
  await stubNotifications(page);
  const connected = page.waitForEvent("websocket");
  await login(page);
  await connected;

  expect(
    (
      await request.post("/api/test/notify", {
        data: { kind: "result", text: "周报已经完成", groupId: null, at: new Date().toISOString() },
      })
    ).status(),
  ).toBe(204);
  await expect
    .poll(async () => (await page.evaluate(() => window.__notifications?.sent)) ?? [], {
      message: "先确认 WebSocket 上的 notify 已经能送达",
    })
    .toHaveLength(1);

  await page.evaluate(() => {
    Object.defineProperty(window.Notification, "permission", { value: "default", configurable: true });
  });
  expect(
    (
      await request.post("/api/test/notify", {
        data: { kind: "stuck", text: "账号登录过期", groupId: null, at: new Date().toISOString() },
      })
    ).status(),
  ).toBe(204);
  await page.evaluate(() => {
    Object.defineProperty(window.Notification, "permission", { value: "granted", configurable: true });
  });
  expect(
    (
      await request.post("/api/test/notify", {
        data: { kind: "result", text: "后续通知仍然送达", groupId: null, at: new Date().toISOString() },
      })
    ).status(),
  ).toBe(204);
  await expect
    .poll(async () => (await page.evaluate(() => window.__notifications?.sent)) ?? [], {
      message: "后一条已显示，说明前一条权限不足的 notify 已经按顺序处理完",
    })
    .toHaveLength(2);
  expect((await page.evaluate(() => window.__notifications?.sent))?.join("\n")).not.toContain("账号登录过期");
  expect((await page.evaluate(() => window.__notifications?.asked)) ?? 0, "更不该反过来弹权限请求").toBe(0);
});
