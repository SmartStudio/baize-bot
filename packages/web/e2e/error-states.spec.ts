import { PokerTableResponse } from "@baize/shared";
import { expect, login, openBot, openRoutines, test, type Page } from "./fixtures";

const pageErrors = (page: Page): string[] => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
};

const isRoutine = (url: string) => /\/api\/routines\/[^/]+$/.test(new URL(url).pathname);

test("群历史首次还在路上时说正在加载，不先报「建好了」，到了就换成消息", async ({ page }) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/groups/grp_sales/messages*", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });

  await login(page);
  await openBot(page, "小销");
  await expect(page.getByTestId("history-loading"), "首屏还没到要说在加载").toHaveText("正在加载消息…");
  await expect(page.getByText("建好了。今天把什么活交出去？"), "还没拉到不能当成空群").toHaveCount(0);

  release();
  await expect(page.getByTestId("message-list").getByTestId("message"), "历史到了").not.toHaveCount(0);
  await expect(page.getByTestId("history-loading")).toHaveCount(0);
});

test("今天页首次拉取 500，界面说没取到，点重试后清单出现", async ({ page }) => {
  const errors = pageErrors(page);
  let failing = true;
  await page.route("**/api/today", (route) =>
    failing ? route.fulfill({ status: 500, json: { error: "首页挂了" } }) : route.continue(),
  );

  await login(page);
  await expect(page.getByTestId("today-page"), "没取到要说出来").toContainText("今天的清单没取到。");
  failing = false;
  await page.getByTestId("today-retry").click();
  await expect(page.getByTestId("today-section-count").first(), "重试后清单到了").toBeVisible();
  await expect(page.getByTestId("today-retry")).toHaveCount(0);
  expect(errors, "500 不变成未处理的 Promise").toEqual([]);
});

test("牌桌项目页拉牌桌 500，界面说没取到，点重试后项目页出现", async ({ page }) => {
  const errors = pageErrors(page);
  await login(page);
  const created = await page.request.post("/api/poker/tables", { data: { requestId: `failed-${Date.now()}` } });
  expect(created.status(), "建桌成功").toBe(201);
  const { groupId } = PokerTableResponse.parse(await created.json()).table;
  let failing = true;
  await page.route(`**/api/poker/tables/${groupId}`, (route) =>
    route.request().method() === "GET" && failing
      ? route.fulfill({ status: 500, json: { error: "牌桌服务挂了" } })
      : route.continue(),
  );

  await page.goto(`/p/${groupId}`);
  await expect(page.getByTestId("poker-project-failed"), "不能一直停在正在整理").toContainText("牌桌没取到。");
  await expect(page.getByTestId("poker-project-loading")).toHaveCount(0);
  failing = false;
  await page.getByTestId("poker-project-retry").click();
  await expect(page.getByTestId("poker-project"), "重试后项目页出现").toBeVisible();
  expect(errors, "500 不变成未处理的 Promise").toEqual([]);
});

test("删除例行被服务端拒了，弹出服务端给的中文原因，人还留在编辑器里", async ({ page }) => {
  const errors = pageErrors(page);
  await page.route("**/api/routines/*", (route) =>
    route.request().method() === "DELETE" && isRoutine(route.request().url())
      ? route.fulfill({ status: 500, json: { error: "例行暂时删不掉" } })
      : route.continue(),
  );

  await login(page);
  await openRoutines(page, "小服");
  await page.getByTestId("routine-open").click();
  await page.getByTestId("routine-delete").click();
  await page.getByTestId("routine-delete-confirm").click();

  await expect(page.getByTestId("toast"), "动作没成要告诉人").toHaveText("例行暂时删不掉");
  await expect(page.getByTestId("routine-editor"), "没删掉就不回列表").toBeVisible();
  expect(errors, "失败不变成未处理的 Promise").toEqual([]);
});

test("试跑请求断网，服务端没给原因，弹出兜底的中文提示", async ({ page }) => {
  const errors = pageErrors(page);
  await login(page);
  await openRoutines(page, "小服");
  await page.getByTestId("routine-open").click();
  await page.route("**/api/routines/*/run", (route) => route.abort("failed"));

  await page.getByTestId("routine-run-now").click();

  await expect(page.getByTestId("toast"), "没有服务端原因时说兜底的话").toHaveText("没开始试跑，再试一次");
  expect(errors, "断网不变成未处理的 Promise").toEqual([]);
});
