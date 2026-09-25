import {
  expect,
  test,
  NEEDS_APPROVAL,
  SHOT,
  dndAround,
  login,
  openBot,
  openSettings,
  sendForApproval,
  sendText,
  setDnd,
  stubNotifications,
} from "./fixtures";

test("要点头的工具让群里出一张审批卡，侧栏记一笔「等你点头 1」", async ({ page }) => {
  await login(page);
  const card = await sendForApproval(page, "小销");

  await expect(card.getByTestId("approval-reject"), "拒绝按钮在卡上").toBeVisible();
  await expect(card.getByTestId("approval-approve"), "批准按钮在卡上").toBeVisible();
  await expect(card, "卡上写清楚要点头的是哪一类").toContainText("对外发送");
  await expect(card, "卡上写清楚这次要做什么").toContainText(NEEDS_APPROVAL);

  const item = page.locator('[data-testid=bot-item][data-bot-name="小销"]');
  await expect(item.getByTestId("bot-pending"), "一条 pending 审批在侧栏就是「等你点头 1」").toHaveText("等你点头 1");

  // 没点头之前这一步不许往下走，工具卡得停在运行中，不能自己变完成。
  await expect(page.getByTestId("tool-call-card"), "等结论的工具卡停在运行中").toHaveAttribute(
    "data-status",
    "running",
  );
  await expect(page.getByTestId("cost-card"), "还没点头就不该结账").toHaveCount(0);

  // 刷新走的是拉历史那条路。历史里的审批只填表不动计数，不然 GET /api/bots 已经数过的这一条会被加第二遍。
  await page.reload();
  await openBot(page, "小销");
  // 先等审批卡从历史里回来。它出现才说明 approvals_loaded 已经派发过，这时候数角标才数得到多加的那一下。
  await expect(page.getByTestId("approval-card"), "历史里的审批卡也带着状态").toHaveAttribute("data-status", "pending");
  await expect(page.getByTestId("approval-approve"), "还没点头，按钮还在").toBeVisible();
  await expect(item.getByTestId("bot-pending"), "刷新后还是 1，历史没有把它再加一遍").toHaveText("等你点头 1");
});

test("点拒绝后卡片留下结论、角标归零、这一步被拦下", async ({ page }) => {
  await login(page);
  const card = await sendForApproval(page, "小销");

  await card.getByTestId("approval-reject").click();

  await expect(card, "结论落在卡上，状态从服务端推回来").toHaveAttribute("data-status", "rejected");
  await expect(card.getByTestId("approval-decided"), "有结论的卡只剩一行记录").toHaveText("不同意");
  await expect(card.getByTestId("approval-reject"), "有结论就不该还留着按钮").toHaveCount(0);

  const item = page.locator('[data-testid=bot-item][data-bot-name="小销"]');
  await expect(item.getByTestId("bot-pending"), "没有 pending 审批了角标整个不渲染").toHaveCount(0);

  await expect(page.getByTestId("cost-card"), "拒绝之后这次运行照样收尾结账").toHaveCount(1);
  await expect(page.getByTestId("tool-call-card"), "拒绝把这一步拦下，工具卡终态是 blocked").toHaveAttribute(
    "data-status",
    "blocked",
  );
  const trace = await page.evaluate(() => window.__runTrace);
  expect(trace?.tool, "同一张工具卡先运行中再被拦下，中间没有自己变完成").toEqual(["running", "blocked"]);
});

test("在群里回一句「批准」和点批准按钮是同一件事", async ({ page }) => {
  await login(page);
  const card = await sendForApproval(page, "小销");

  await sendText(page, "批准");

  await expect(card, "群里回的一句话也作用到那条 pending 审批上").toHaveAttribute("data-status", "approved");
  await expect(card.getByTestId("approval-decided")).toHaveText("同意");

  const item = page.locator('[data-testid=bot-item][data-bot-name="小销"]');
  await expect(item.getByTestId("bot-pending"), "点头之后角标归零").toHaveCount(0);

  await expect(page.getByTestId("tool-call-card"), "批准让这一步真的跑完").toHaveAttribute("data-status", "ok");
  await expect(page.getByTestId("cost-card")).toHaveCount(1);
  // 「批准」这四个字本身是结论不是新任务，不该再引出一次运行。
  await expect(page.getByTestId("message-list").locator("[data-kind=tool_call]"), "没有多起一次运行").toHaveCount(1);
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

test("免打扰时段外弹通知，时段内只记角标", async ({ page }) => {
  await stubNotifications(page);
  await login(page);

  // 整段都排在一小时以后，当下在它前面。按跨午夜读这段会一路盖到午夜，把当下也圈进去。
  await setDnd(page, await dndAround(page, 1, 2));
  await sendForApproval(page, "小销");

  await expect
    .poll(async () => (await page.evaluate(() => window.__notifications?.sent)) ?? [], {
      message: "不在免打扰里，要你点头的事该弹到系统通知上",
    })
    .toHaveLength(1);
  expect(
    (await page.evaluate(() => window.__notifications?.sent))?.[0],
    "通知正文就是这条审批要你点头的那件事",
  ).toContain("把报价单发给 Lisa");

  // from 比 to 晚，就是「22:00–08:00」那种跨午夜的写法：它盖的是 from 到午夜、午夜到 to 这两段，当下落在
  // 前一段里。按同一天的区间读，from > to 是个空区间，当下就漏在外面了。
  await setDnd(page, await dndAround(page, -1, -2));
  await sendText(page, NEEDS_APPROVAL);

  const item = page.locator('[data-testid=bot-item][data-bot-name="小销"]');
  await expect(item.getByTestId("bot-pending"), "免打扰期间事情照样攒在角标上").toHaveText("等你点头 2");
  expect(
    (await page.evaluate(() => window.__notifications?.sent))?.length,
    "免打扰期间不打断你，通知还是刚才那一条",
  ).toBe(1);
  expect((await page.evaluate(() => window.__notifications?.asked)) ?? 0, "任何时候都不该弹权限请求").toBe(0);
});

test("免打扰只设了一头等于没设；权限没给就安静跳过，不弹权限请求", async ({ page }) => {
  await stubNotifications(page);
  await login(page);

  // 只留一头划不出区间。把它当成免打扰开着，等于把另外那半天也算进去，该响的时候不响。
  await openSettings(page);
  await page.getByTestId("dnd-from").fill("");
  await expect(page.getByTestId("dnd-from")).toHaveValue("");
  await page.getByTestId("settings-close").click();

  await sendForApproval(page, "小销");
  await expect
    .poll(async () => (await page.evaluate(() => window.__notifications?.sent)) ?? [], {
      message: "免打扰只设了一头就是没开，通知照发",
    })
    .toHaveLength(1);

  // 用户还没给过通知权限。这时候弹权限请求等于拿一个系统弹窗拦住人，角标已经把事情说清楚了。
  await page.evaluate(() => {
    Object.defineProperty(window.Notification, "permission", { value: "default", configurable: true });
  });
  await sendText(page, NEEDS_APPROVAL);

  const item = page.locator('[data-testid=bot-item][data-bot-name="小销"]');
  await expect(item.getByTestId("bot-pending"), "通知发不出去也不影响这件事攒在角标上").toHaveText("等你点头 2");
  expect((await page.evaluate(() => window.__notifications?.sent))?.length, "权限不是 granted 就不发通知").toBe(1);
  expect((await page.evaluate(() => window.__notifications?.asked)) ?? 0, "更不该反过来弹权限请求").toBe(0);
});
