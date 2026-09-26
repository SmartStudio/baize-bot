import { expect, test, SHOT, login, openRoutines, openSeededBot } from "./fixtures";

test("在例行页新建一条每分钟的例行任务，存下来就出现在列表里", async ({ page }) => {
  await login(page);
  await openRoutines(page, "小服");
  await expect(page.getByTestId("routine-row"), "预置的只有「每日工单早报」一条").toHaveCount(1);

  await page.getByTestId("routine-new").click();
  await page.getByTestId("routine-bot-select").selectOption({ label: "小服" });
  await page.getByTestId("routine-name-input").fill("每分钟看一眼工单");
  await page.getByTestId("routine-instruction-input").fill("看一眼有没有新工单，有紧急的就告诉我。");
  await page.getByTestId("trigger-add").click();
  await page.getByTestId("trigger-preset-minutely").click();
  await expect(page.getByTestId("trigger-chip"), "挑完预设先落在编辑器里").toHaveText(/每分钟/);

  const saved = page.waitForResponse(
    (res) => res.url().endsWith("/routines") && res.request().method() === "POST" && res.status() === 201,
  );
  await page.getByTestId("routine-save").click();
  await saved;

  const created = page.locator('[data-testid=routine-row][data-routine-name="每分钟看一眼工单"]');
  await expect(page.getByTestId("routine-row")).toHaveCount(2);
  await expect(created, "存到选中的那个 Bot 名下").toHaveAttribute("data-bot-name", "小服");
  await expect(created.getByTestId("routine-row-note"), "列表上的下次触发是从表达式反推的文案").toHaveText("每分钟");

  // 刷新才分得清「存住了」和「界面自己记了一笔」。
  await page.reload();
  await openRoutines(page, "小服");
  await expect(page.getByTestId("routine-row")).toHaveCount(2);
  await expect(created.getByTestId("routine-row-note")).toHaveText("每分钟");
});

test("试跑一次后群里出现「自动运行」那条 system，运行记录多一条", async ({ page }) => {
  await login(page);
  await openRoutines(page, "小服");
  await page.getByTestId("routine-open").click();
  const runs = page.getByTestId("run-row");
  await expect(runs, "预置了三条运行记录").toHaveCount(3);
  await expect(runs.nth(0).locator("small"), "停下时 note 已经说清原因，不重复状态词").toHaveText(
    "1 条等你点头 · ¥0.8",
  );
  await expect(runs.nth(0).locator("small")).not.toContainText("停下等你");
  await expect(runs.nth(1).locator("small"), "正常完成仍保留状态词和花费").toHaveText("完成 · ¥0.7");
  await expect(runs.nth(2).locator("small"), "失败时直接显示控制面给的原因").toHaveText("工单系统登录过期 · ¥0.2");

  await page.getByTestId("routine-run-now").click();

  await expect(runs, "触发那一刻就落一条").toHaveCount(4);
  // 刚触发的还没有 note，状态文案后面不该拖一个孤零零的点。
  await expect(runs.first().locator("small"), "刚触发的那条停在运行中").toHaveText("运行中");
  await page.getByTestId("run-row").last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOT}/2c-runs.png` });

  // 例行页不带对话，这次运行在群里说的话要回小服的单 Bot 群看。
  await openSeededBot(page, "小服");
  const thread = page.getByTestId("message-list");
  await expect(thread.getByText("例行任务「每日工单早报」自动运行"), "一次运行先在群里说一声").toBeVisible();
  await expect(thread.getByText("按紧急度排序"), "再落一条 user 消息，正文就是每次运行做什么").toBeVisible();
  await page.screenshot({ path: `${SHOT}/2c.png` });
});

test("删除例行任务要二次确认，取消和超时都不删除", async ({ page }) => {
  await login(page);
  await openRoutines(page, "小服");
  const rows = page.getByTestId("routine-row");
  await expect(rows).toHaveCount(1);
  await page.getByTestId("routine-open").click();
  await page.clock.install();
  await page.clock.pauseAt(new Date());

  await page.getByTestId("routine-delete").click();
  await expect(page.getByTestId("routine-delete-confirm")).toBeVisible();
  await expect(page.getByTestId("routine-delete-cancel")).toBeVisible();
  await page.screenshot({ path: `${SHOT}/2d.png` });
  await page.getByTestId("routine-delete-cancel").click();
  await expect(page.getByTestId("routine-delete")).toBeVisible();

  await page.getByTestId("routine-delete").click();
  await expect(page.getByTestId("routine-delete-confirm")).toBeVisible();
  await page.clock.runFor(3_000);
  await expect(page.getByTestId("routine-delete"), "三秒不确认就恢复成普通删除按钮").toBeVisible({
    timeout: 4_000,
  });
  await page.getByTestId("routine-back").click();
  await expect(rows, "取消或超时都没有删除列表项").toHaveCount(1);

  await page.getByTestId("routine-open").click();
  await page.getByTestId("routine-delete").click();
  const deleted = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" && /\/api\/routines\/[^/]+$/.test(new URL(response.url()).pathname),
  );
  await page.getByTestId("routine-delete-confirm").click();
  await deleted;
  await expect(page.getByTestId("routine-list")).toBeVisible();
  await expect(rows, "确认删除后列表少一条").toHaveCount(0);
});

test("在列表里停用一条例行任务，那一行的状态变「已停用」", async ({ page }) => {
  await login(page);
  await openRoutines(page, "小服");
  const row = page.getByTestId("routine-row").first();
  await expect(row.getByTestId("routine-row-note"), "启用着就说下次什么时候跑").toHaveText("工作日 09:00");

  await row.getByTestId("routine-switch").click();

  await expect(row.getByTestId("routine-switch")).toHaveAttribute("aria-checked", "false");
  await expect(row.getByTestId("routine-row-note"), "停用的不触发，列表上就别再说下次什么时候跑").toHaveText("已停用");

  await page.reload();
  await openRoutines(page, "小服");
  await expect(page.getByTestId("routine-row").first().getByTestId("routine-row-note")).toHaveText("已停用");
});

test("给 webhook 地址打一下，群里照样跑起来，运行记录靠推送回到列表", async ({ page }) => {
  await login(page);
  await openRoutines(page, "小服");
  await page.getByTestId("routine-open").click();
  await expect(page.getByTestId("run-row")).toHaveCount(3);

  await page.getByTestId("trigger-add").click();
  await page.getByTestId("trigger-preset-webhook").click();
  const url = await page.getByTestId("webhook-url").textContent();
  expect(url ?? "", "地址里的 token 是服务端发的，客户端挑不了").toMatch(/\/api\/hooks\/[0-9a-f]{32}$/);

  const fired = await page.request.post(url ?? "");
  expect(fired.status(), "打进来就收下，回 202").toBe(202);

  // 这一路没经过界面上的任何一个按钮，列表能动只能是 routine_updated 推回来的。
  await expect(page.getByTestId("run-row"), "webhook 触发的运行记法一样").toHaveCount(4);
  await expect(page.getByTestId("run-row").first().locator("small")).toHaveText("运行中");
  await openSeededBot(page, "小服");
  await expect(
    page.getByTestId("message-list").getByText("例行任务「每日工单早报」自动运行"),
    "从哪儿触发的，群里都是同样两条消息",
  ).toBeVisible();
});
