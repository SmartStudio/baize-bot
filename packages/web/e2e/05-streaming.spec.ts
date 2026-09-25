import {
  expect,
  test,
  AUDIT_SHOT,
  SHOT,
  login,
  openBot,
  openSeededBot,
  recordDeltas,
  sendForApproval,
  sendText,
  traceRun,
} from "./fixtures";

test("Bot 的回复分多段 delta 推回来，在同一个气泡里拼成一条完整消息", async ({ page }) => {
  const deltas = recordDeltas(page);
  await login(page);
  await openSeededBot(page, "小销");
  await traceRun(page);
  const list = page.getByTestId("message-list");
  const botsBefore = await list.locator("[data-kind=bot]").count();

  await sendText(page, "把 Globex 的报价单再核一遍");
  await expect(page.getByTestId("composer-input"), "点了发送输入框就空，不等服务端回话").toHaveValue("");
  await expect(list.getByTestId("cost-card"), "花费摘要到了就说明这次运行跑完了").toHaveCount(1);

  expect(deltas.length, "回复至少分三段推回来").toBeGreaterThanOrEqual(3);
  expect(new Set(deltas.map((d) => d.messageId)).size, "这些段属于同一条消息").toBe(1);
  expect(deltas.at(-1)?.done, "最后一段带 done").toBe(true);
  await expect(list.locator("[data-kind=bot]"), "多段 delta 只长出一条 Bot 消息").toHaveCount(botsBefore + 1);
  await expect(list.getByTestId("bot-bubble").last(), "气泡里是各段原样拼起来的全文").toHaveText(
    deltas.map((d) => d.delta).join(""),
  );

  const trace = await page.evaluate(() => window.__runTrace);
  expect(trace?.streaming, "拼的过程中气泡带光标").toContain(true);
  await expect(page.getByTestId("streaming-caret"), "拼完光标收起").toHaveCount(0);
});

test("工具调用卡在同一张卡上从运行中变完成", async ({ page }) => {
  await login(page);
  await openBot(page, "小销");
  await traceRun(page);
  const list = page.getByTestId("message-list");

  await sendText(page, "查一下 X3 还有多少现货");
  await expect(list.getByTestId("cost-card")).toHaveCount(1);

  const card = list.getByTestId("tool-call-card");
  await expect(card, "同一个 id 重推是改这张卡，不是再添一张").toHaveCount(1);
  const trace = await page.evaluate(() => window.__runTrace);
  expect(trace?.tool, "这张卡先运行中后完成").toEqual(["running", "ok"]);
  expect(trace?.activity, "运行中的工具活动保持展开").toContain(true);
  await expect(list.getByTestId("activity-toggle"), "工具默认收起").toHaveAttribute("aria-expanded", "false");
  await list.getByTestId("activity-toggle").click();
  await expect(card, "展开后显示工具名、参数摘要、耗时和状态").toBeVisible();
  await expect(card).toContainText("调用 ERP · query");
  await expect(card).toContainText("请求=查一下 X3 还有多少");
  await expect(card).toContainText("1.0s");
  await expect(card.getByRole("img", { name: "完成" })).toBeVisible();
});

test("审批卡和工具行里没有 `{`", async ({ page }) => {
  await login(page);
  await page.getByTestId("overnight-card").getByRole("button", { name: "知道了" }).click();
  await openSeededBot(page, "小服");
  const list = page.getByTestId("message-list");
  await list.getByTestId("activity-toggle").click();
  const tools = list.getByTestId("tool-call-card");
  await expect(tools, "mock 覆盖 bash、write、edit、mcp 四种工具视图").toHaveCount(4);
  await expect(tools.nth(0)).toContainText("pnpm check");
  await expect(tools.nth(1)).toContainText("周报.md");
  await expect(tools.nth(1)).toContainText("本周完成");
  await expect(tools.nth(2)).toContainText("改 3 行");
  await expect(tools.nth(3)).toContainText("库存与排产计划");
  for (const tool of await tools.all()) await expect(tool).not.toContainText("{");

  const approval = await sendForApproval(page, "小销");
  await expect(approval).not.toContainText("{");
  await page.screenshot({ path: `${SHOT}/p0-5-approval-mock.png` });
  await page.screenshot({ path: `${AUDIT_SHOT}/approval-mock.png` });
});

test("点工具行，检查器高级里有原始参数", async ({ page }) => {
  await login(page);
  await page.getByTestId("overnight-card").getByRole("button", { name: "知道了" }).click();
  await openSeededBot(page, "小服");
  await page.getByTestId("activity-toggle").click();
  const bash = page.locator('[data-testid="tool-call-card"][data-view-kind="bash"]');

  await bash.click();
  await expect(page.getByTestId("tool-inspector")).toBeVisible();
  await page.getByTestId("tool-inspector-close").click();
  await expect(page.getByTestId("tool-inspector")).toHaveCount(0);

  await bash.click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tool-inspector")).toHaveCount(0);

  await bash.click();
  await page.getByTestId("tool-inspector-advanced").click();
  await expect(page.getByTestId("tool-inspector-raw")).toContainText('"command": "pnpm check"');
  await page.screenshot({ path: `${SHOT}/p0-5-inspector-mock.png` });
  await page.screenshot({ path: `${AUDIT_SHOT}/inspector-mock.png` });
});

test("运行结束出现花费摘要，侧栏摘要跟着换，跑的过程中标「干活中」", async ({ page }) => {
  await login(page);
  await openBot(page, "小采");
  await traceRun(page);
  const item = page.locator('[data-testid=bot-item][data-bot-name="小采"]');
  const cost = page.getByTestId("message-list").getByTestId("cost-card");

  await sendText(page, "再找三家供应商询个价");
  await expect(cost).toHaveCount(1);
  await expect(cost, "花费摘要只显示金额").toContainText("约 ¥0.8");
  await expect(cost).not.toContainText("步");

  const trace = await page.evaluate(() => window.__runTrace);
  expect(trace?.working, "跑的过程中侧栏这个 Bot 标着干活中").toContain(true);
  await expect(item.getByTestId("bot-working"), "跑完就不标了").toHaveCount(0);
  await expect(item, "侧栏摘要停在最后那条上").toContainText("本次花费 ¥0.8");
});
