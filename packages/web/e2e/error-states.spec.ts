import { PokerTableResponse } from "@baize/shared";
import {
  expect,
  login,
  openBot,
  openRoutines,
  openSeededBot,
  sendForApproval,
  sendText,
  test,
  type Page,
} from "./fixtures";

const pageErrors = (page: Page): string[] => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
};

const isRoutine = (url: string) => /\/api\/routines\/[^/]+$/.test(new URL(url).pathname);

const BAD_GATEWAY = { status: 500, contentType: "text/html", body: "<html><body>Bad Gateway</body></html>" };

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

test("删除例行时服务端回了非 JSON 的 500，弹出按动作写的话，不说请求失败几百", async ({ page }) => {
  const errors = pageErrors(page);
  await page.route("**/api/routines/*", (route) =>
    route.request().method() === "DELETE" && isRoutine(route.request().url())
      ? route.fulfill(BAD_GATEWAY)
      : route.continue(),
  );

  await login(page);
  await openRoutines(page, "小服");
  await page.getByTestId("routine-open").click();
  await page.getByTestId("routine-delete").click();
  await page.getByTestId("routine-delete-confirm").click();

  await expect(page.getByTestId("toast"), "服务端没给原因时说这个动作没成").toHaveText("没删掉，再试一次");
  expect(errors, "失败不变成未处理的 Promise").toEqual([]);
});

test("主输入框发消息失败，弹出提示，字还回输入框", async ({ page }) => {
  const errors = pageErrors(page);
  await login(page);
  await openSeededBot(page, "小销");
  await page.route("**/api/groups/grp_sales/messages", (route) =>
    route.request().method() === "POST" ? route.fulfill(BAD_GATEWAY) : route.continue(),
  );

  await sendText(page, "帮我约下周三的会");

  await expect(page.getByTestId("toast"), "没发出去要告诉人").toHaveText("消息没发出去，再试一次");
  await expect(page.getByTestId("composer-input"), "字还回来，不用重打").toHaveValue("帮我约下周三的会");
  expect(errors, "失败不变成未处理的 Promise").toEqual([]);
});

test("审批卡点批准被服务端拒了，弹出服务端给的原因，按钮放开能再点", async ({ page }) => {
  const errors = pageErrors(page);
  await login(page);
  const card = await sendForApproval(page, "小销");
  await page.route("**/api/approvals/*", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 500, json: { error: "审批暂时记不下来" } })
      : route.continue(),
  );

  await card.getByTestId("approval-approve").click();

  await expect(page.getByTestId("toast"), "决定没记下要告诉人").toHaveText("审批暂时记不下来");
  await expect(card.getByTestId("approval-approve"), "没记下就还能再点").toBeEnabled();
  await expect(card).toHaveAttribute("data-status", "pending");
  expect(errors, "失败不变成未处理的 Promise").toEqual([]);
});

test("新项目小窗发那句话失败，弹出提示，小窗留着能再发", async ({ page }) => {
  const errors = pageErrors(page);
  await login(page);
  await page.route("**/api/groups/*/messages", (route) =>
    route.request().method() === "POST" ? route.fulfill(BAD_GATEWAY) : route.continue(),
  );

  await page.getByTestId("new-project").click();
  await page.getByTestId("new-project-input").fill("把抖音号做起来，年底 1000 粉");
  await page.getByTestId("new-project-submit").click();

  await expect(page.getByTestId("toast"), "没发出去要告诉人").toHaveText("没发给主助理，再试一次");
  await expect(page.getByTestId("new-project-dialog"), "小窗留着").toBeVisible();
  await expect(page.getByTestId("new-project-submit"), "能再发").toBeEnabled();
  expect(errors, "失败不变成未处理的 Promise").toEqual([]);
});

test("方案卡点开始失败，弹出提示，卡还能再点开始", async ({ page }) => {
  const errors = pageErrors(page);
  await login(page);
  await page.getByTestId("new-project").click();
  await page.getByTestId("new-project-input").fill("推广白泽的开源仓库，年底 1000 星");
  await page.getByTestId("new-project-submit").click();
  const card = page.getByTestId("message-list").getByTestId("project-offer");
  await expect(card).toHaveAttribute("data-status", "offered");
  await page.route("**/api/messages/*/project-offer", (route) => route.fulfill(BAD_GATEWAY));

  await card.getByTestId("project-offer-start").click();

  await expect(page.getByTestId("toast"), "没开始要告诉人").toHaveText("项目没开始，再试一次");
  await expect(card.getByTestId("project-offer-start"), "卡还能再点").toBeEnabled();
  expect(errors, "失败不变成未处理的 Promise").toEqual([]);
});

test("牌桌项目页拉牌桌 404，说这桌已经不在了，不一直停在正在整理", async ({ page }) => {
  const errors = pageErrors(page);
  await login(page);
  const created = await page.request.post("/api/poker/tables", { data: { requestId: `gone-${Date.now()}` } });
  expect(created.status(), "建桌成功").toBe(201);
  const { groupId } = PokerTableResponse.parse(await created.json()).table;
  await page.route(`**/api/poker/tables/${groupId}`, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 404, json: { error: "没有这张牌桌" } })
      : route.continue(),
  );

  await page.goto(`/p/${groupId}`);
  await expect(page.getByTestId("poker-project-gone"), "没有这桌要说出来").toHaveText("这桌已经不在了。");
  await expect(page.getByTestId("poker-project-loading")).toHaveCount(0);
  expect(errors, "404 不变成未处理的 Promise").toEqual([]);
});
