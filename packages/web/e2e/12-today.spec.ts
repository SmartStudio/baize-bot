import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EMAIL, PASSWORD, expect, test, login, openBot, type APIRequestContext } from "./fixtures";
import type { TestInfo } from "@playwright/test";

const screenshotPath = async (testInfo: TestInfo, name: string): Promise<string> => {
  const auditDir = process.env["BAIZE_P1_7_AUDIT_DIR"];
  const target = auditDir === undefined ? testInfo.outputPath(name) : join(auditDir, name);
  await mkdir(dirname(target), { recursive: true });
  return target;
};

const setTodayMode = async (request: APIRequestContext, mode: string) => {
  expect((await request.post("/api/test/today", { data: { mode } })).status()).toBe(204);
};

test("今天四栏各有内容", async ({ page, request }, testInfo) => {
  await setTodayMode(request, "full");
  await login(page);

  await expect(page.getByTestId("today-page")).toBeVisible();
  for (const column of ["pending", "done", "running", "next"]) {
    await expect(page.getByTestId(`today-${column}`).getByTestId("today-row").first()).toBeVisible();
  }
  await page.getByRole("button", { name: "推广一个产品" }).click();
  await expect(page.getByTestId("today-composer-input")).toHaveValue("这周推广一下我们的新版本，X 和小红书都发");
  await page.getByTestId("today-composer-input").fill("");
  await page.getByRole("button", { name: "运营一个号" }).click();
  await expect(page.getByTestId("today-composer-input")).toHaveValue("把小红书账号做起来，年底做到 1000 粉");
  await page.getByTestId("today-composer-input").fill("");
  const done = page.getByTestId("today-done").getByTestId("today-row").filter({ hasText: "14 张客户工单已经处理完" });
  await expect(done).toContainText("14 张客户工单已经处理完");
  await expect(done).toHaveAttribute("href", "https://x.com/baize/status/today_1");
  await page.screenshot({ path: await screenshotPath(testInfo, "today.png") });
  await page.screenshot({ path: await screenshotPath(testInfo, "walk-1.png") });

  await page.getByTestId("today-running").getByTestId("today-row").first().click();
  const activity = page.getByTestId("activity-toggle");
  await expect(activity).toContainText("做了 4 步");
  await activity.click();
  const tool = page.getByTestId("tool-call-card").first();
  await expect(tool).toBeVisible();
  await page.screenshot({ path: await screenshotPath(testInfo, "walk-2.png") });
  await tool.click();
  await expect(tool).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("tool-inspector-summary")).toBeVisible();
  await expect(page.getByTestId("tool-inspector-raw")).toBeHidden();
  await page.getByTestId("tool-inspector-advanced").click();
  await expect(page.getByTestId("tool-inspector-raw")).toBeVisible();
  await expect(page.getByTestId("tool-inspector")).toContainText("run_service_1");
  await page.screenshot({ path: await screenshotPath(testInfo, "inspector.png") });
  await page.screenshot({ path: await screenshotPath(testInfo, "walk-3.png") });

  await page.goto("/menubar");
  await expect(page.getByTestId("menubar-page")).toContainText("件等你");
  await expect(page.getByTestId("menubar-page")).not.toContainText("在进行");
  await page.screenshot({ path: await screenshotPath(testInfo, "menubar.png") });
  const pending = page.getByTestId("menubar-page").getByTestId("today-row");
  const before = await pending.count();
  await page.getByTestId("menubar-page").getByRole("button", { name: "批准" }).click();
  await expect(pending, "菜单栏里可以直接批准待确认事项").toHaveCount(before - 1);
});

test("今天四栏各为空", async ({ page, request }) => {
  await setTodayMode(request, "empty");
  await login(page);

  await expect(page.getByTestId("today-page")).toBeVisible();
  for (const column of ["pending", "done", "running", "next"]) {
    await expect(page.getByTestId(`today-${column}`).getByTestId("today-row")).toHaveCount(0);
    await expect(page.getByTestId(`today-${column}`).getByTestId("today-empty")).toBeVisible();
  }
  await expect(page.getByTestId("today-composer-input")).toBeDisabled();
  await expect(page.getByTestId("today-composer-input")).toHaveAttribute("placeholder", "主助理还没准备好");
});

test("菜单栏登录后回到菜单栏", async ({ page }) => {
  await page.goto("/menubar");
  await expect(page).toHaveURL(/\/login\?next=%2Fmenubar|\/login\?next=\/menubar/);
  await page.getByTestId("email-input").fill(EMAIL);
  await page.getByTestId("password-input").fill(PASSWORD);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/menubar$/);
  await expect(page.getByTestId("menubar-page")).toBeVisible();
});

test("首页不露出 runId、模型名和 T 编号", async ({ page, request }) => {
  await setTodayMode(request, "full");
  await login(page);

  const text = await page.getByTestId("today-page").innerText();
  expect(text).not.toMatch(/run[_ -]?id/i);
  expect(text).not.toContain("模型");
  expect(text).not.toMatch(/T-\d{4}/);
});

test("审批推送后首页自动重拉", async ({ page, request }) => {
  await setTodayMode(request, "full");
  await login(page);

  expect((await request.post("/api/test/today/pending", { data: { title: "新来的合同发送确认" } })).status()).toBe(204);
  await expect(page.getByTestId("today-pending")).toContainText("新来的合同发送确认");

  await page.goto("/menubar");
  await expect(page.getByTestId("menubar-page")).toContainText("新来的合同发送确认");
  expect((await request.post("/api/test/today/pending", { data: { title: "菜单栏里的新待办" } })).status()).toBe(204);
  await expect(page.getByTestId("menubar-page")).toContainText("菜单栏里的新待办");
  await page.goto("/");
  await expect(page.getByTestId("today-pending")).toContainText("菜单栏里的新待办");

  await page.route("**/api/today", (route) => route.abort());
  expect((await request.post("/api/test/today/pending", { data: { title: "刷新失败时的新待办" } })).status()).toBe(204);
  await expect(page.getByRole("status")).toHaveText("今天的清单刷新失败。");
  await expect(page.getByTestId("today-pending"), "刷新失败时保留已经显示的数据").toContainText("新来的合同发送确认");
});

test("首页审批能拒绝且计划、稿子、账号行都去正确页面", async ({ page, request }) => {
  await setTodayMode(request, "full");
  await login(page);

  const approval = page.getByTestId("today-pending").getByTestId("today-row").filter({ hasText: "发送 Globex" });
  await approval.getByRole("button", { name: "拒绝" }).click();
  await expect(approval).toHaveCount(0);

  const plan = page.getByTestId("today-pending").getByTestId("today-row").filter({ hasText: "本周推广计划" });
  await plan.getByTestId("today-expand").click();
  await plan.getByTestId("today-open-group").click();
  await expect(page.getByTestId("chat-title"), "计划行展开后去群里，进的是出计划的主助理群").toHaveText("主助理");
  await page.getByTestId("today-nav").click();
  const draft = page.getByTestId("today-pending").getByTestId("today-row").filter({ hasText: "X3 现货比价清单" });
  await draft.getByTestId("today-expand").click();
  await draft.getByTestId("today-open-group").click();
  await expect(page.getByTestId("chat-title"), "稿子行进的是起草它的小采群，不是一律进主助理").toHaveText("小采");
  await page.getByTestId("today-nav").click();
  await page.getByTestId("today-pending").getByTestId("today-row").filter({ hasText: "@baize_x3" }).click();
  await expect(page.getByTestId("accounts-page"), "账号行直接进设置里的账号页").toBeVisible();
});

test("推送的新待办追加在最后，旧行相对顺序不变", async ({ page, request }) => {
  await setTodayMode(request, "full");
  await login(page);

  const rows = page.getByTestId("today-pending").getByTestId("today-row");
  const before = await rows.allTextContents();
  expect((await request.post("/api/test/today/pending", { data: { title: "最后到的付款确认" } })).status()).toBe(204);
  await expect(rows.filter({ hasText: "最后到的付款确认" })).toHaveCount(1);
  const after = await rows.allTextContents();
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.at(-1)).toContain("最后到的付款确认");
});

test("群里批过的审批会从首页消失", async ({ page, request }) => {
  await setTodayMode(request, "full");
  await login(page);

  expect((await request.post("/api/test/today/pending", { data: { title: "群里联动的发送确认" } })).status()).toBe(204);
  await expect(page.getByTestId("today-pending")).toContainText("群里联动的发送确认");
  await openBot(page, "小销");
  const card = page.getByTestId("approval-card").filter({ hasText: "群里联动的发送确认" });
  await card.getByTestId("approval-scope-once").click();
  await expect(card).toHaveAttribute("data-status", "approved");
  await page.getByTestId("today-nav").click();
  await expect(page.getByTestId("today-pending")).not.toContainText("群里联动的发送确认");
});

test("窄窗首页和两种输入框的焦点环不横向溢出", async ({ page, request }) => {
  await page.setViewportSize({ width: 780, height: 720 });
  await setTodayMode(request, "full");
  await login(page);

  const todayInput = page.getByTestId("today-composer-input");
  await todayInput.focus();
  expect(await todayInput.evaluate((element) => getComputedStyle(element).boxShadow)).toBe("none");
  expect(await todayInput.locator("..").evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
  expect(await page.getByTestId("today-page").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );

  await page.getByTestId("nav-open").click();
  await openBot(page, "小服");
  const chatInput = page.getByTestId("composer-input");
  await chatInput.focus();
  expect(await chatInput.evaluate((element) => getComputedStyle(element).boxShadow)).toBe("none");
  expect(await chatInput.locator("..").evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
});

test("记录首页 50 条数据的渲染中位数", async ({ page, request }) => {
  await setTodayMode(request, "performance");
  await login(page);

  const samples: number[] = [];
  for (let index = 0; index < 10; index += 1) {
    await page.goto("/");
    await expect(page.getByTestId("today-pending").getByTestId("today-row").first()).toBeVisible();
    samples.push(await page.evaluate(() => performance.now()));
  }
  samples.sort((left, right) => left - right);
  const median = samples[4];
  if (median === undefined) throw new Error("性能探针没有取到中位数");
  console.log(`TODAY_MEDIAN_MS=${median.toFixed(1)}`);
  expect(Number.isFinite(median)).toBe(true);
});

test("今天页第三个模板「和 AI 打一局」直接开一桌，进牌桌的项目页", async ({ page }) => {
  await login(page);
  await expect(page.getByTestId("today-page")).toBeVisible();
  await expect(page.getByTestId("today-templates").getByRole("button")).toHaveText([
    "推广一个产品",
    "运营一个号",
    "和 AI 打一局",
  ]);

  await page.getByRole("button", { name: "和 AI 打一局" }).click();
  await expect(page, "进新桌的项目页").toHaveURL(/\/p\/grp_poker_/);
  await expect(page.getByTestId("poker-project")).toBeVisible();
  await expect(page.getByTestId("poker-seat-name")).toHaveText(["阿豹", "茉莉", "大刘", "老白"]);
});
