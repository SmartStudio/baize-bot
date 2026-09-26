import { GroupListResponse, ProjectResponse } from "@baize/shared";
import { TEAM_TITLE, expect, login, teamItem, test, type APIRequestContext, type Page } from "./fixtures";

const seedProject = async (request: APIRequestContext) => {
  expect((await request.post("/api/test/project")).status(), "订单群里种下三条发布记录和一张待批稿子").toBe(204);
};

const openProject = async (page: Page) => {
  await teamItem(page).click();
  await expect(page).toHaveURL(/\/p\/grp_order$/);
  await expect(page.getByTestId("project-page").getByRole("heading", { name: TEAM_TITLE })).toBeVisible();
  await expect(page.getByTestId("project-achievement")).toHaveCount(3);
  await expect(page.getByTestId("project-pending").getByTestId("today-row")).toHaveCount(1);
};

const topOf = async (page: Page, testId: string): Promise<number> => {
  const box = await page.getByTestId(testId).boundingBox();
  if (box === null) throw new Error(`${testId} 没有渲染出来`);
  return box.y;
};

const bottomOf = async (page: Page, selector: string): Promise<number> => {
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error(`${selector} 没有渲染出来`);
  return box.y + box.height;
};

test("在项目页连说两句，最新一轮贴着输入框，等你和成果的位置不变", async ({ page, request }) => {
  await seedProject(request);
  await login(page);
  await openProject(page);
  const pendingTop = await topOf(page, "project-pending");
  const achievementsTop = await topOf(page, "project-achievements");

  const said = ["这周多发两条小红书，第一条讲交期", "第二条讲排产看板，周四晚上发"];
  for (const [index, text] of said.entries()) {
    // 说完之后项目页会防抖重拉，重拉回来的数据可能再改版面。等到带着这句和它的回应的那次返回落了地，页面才算定下来。
    const settled = page.waitForResponse(async (response) => {
      if (!response.url().endsWith("/api/projects/grp_order")) return false;
      const turn = ProjectResponse.parse(await response.json()).latestTurn;
      return (
        turn?.said.body.kind === "user" &&
        turn.said.body.text === text &&
        turn.replies.some((reply) => reply.body.kind === "system" && reply.body.text.includes("@ 一个 Bot 派活"))
      );
    });
    await page.getByTestId("project-composer-input").fill(text);
    await page.getByTestId("project-composer-send").click();
    await settled;
    const latest = page.getByTestId("project-latest-turn");
    await expect(latest, "刚说的这句就是最新一轮").toContainText(text);
    await expect(latest.getByText("@ 一个 Bot 派活"), "群里对这句的回应也在这一轮里").toBeVisible();
    if (index > 0) await expect(latest, "上一句折进更早的轮次").not.toContainText(said[0] ?? "");
    await expect(page.getByTestId("project-composer-input")).toHaveValue("");
    await expect(page.getByTestId("project-older"), "更早的轮数到位").toHaveText(
      index === 0 ? "完整对话在项目群里" : `更早 ${index} 轮 · 完整对话在项目群里`,
    );
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    const composerBottom = await bottomOf(page, "form.project-composer");
    const latestTop = await topOf(page, "project-latest-turn");
    expect(latestTop - composerBottom, "最新一轮紧贴输入框").toBeGreaterThanOrEqual(0);
    expect(latestTop - composerBottom, "最新一轮紧贴输入框").toBeLessThanOrEqual(16);
    expect(await topOf(page, "project-pending"), `说完第 ${index + 1} 句，等你的位置不动`).toBe(pendingTop);
    expect(await topOf(page, "project-achievements"), `说完第 ${index + 1} 句，成果的位置不动`).toBe(achievementsTop);
  }

  const older = page.getByTestId("project-older");
  await expect(older).toHaveText("更早 1 轮 · 完整对话在项目群里");
  await older.click();
  await expect(page, "点折叠行进项目群").toHaveURL(/\/g\/grp_order$/);
  for (const text of said) {
    await expect(page.getByTestId("message-list").getByText(text), "项目页说的话落在项目群里").toBeVisible();
  }
});

test("成果每一条都有链接", async ({ page, request }) => {
  await seedProject(request);
  await login(page);
  await openProject(page);

  const rows = page.getByTestId("project-achievement");
  await expect(rows.nth(0), "按发布时间倒序，最新的在上").toContainText("三张图看懂 X3 交期");
  await expect(rows.nth(1)).toContainText("X3 交付节奏公开");
  await expect(rows.nth(2)).toContainText("X3 × 200 台签约");
  await expect(rows.nth(0), "读不到笔记 id 的小红书也给管理页链接").toHaveAttribute(
    "href",
    "https://creator.xiaohongshu.com/new/note-manager",
  );
  await expect(rows.nth(1)).toHaveAttribute("href", "https://github.com/globex/x3/issues/200");
  await expect(rows.nth(2)).toHaveAttribute("href", "https://x.com/globex/status/1");
  for (const row of await rows.all()) {
    await expect(row, "每一条都在新标签页打开原帖").toHaveAttribute("target", "_blank");
    await expect(row).toContainText("已发布");
  }
});

test("推 task_updated 改了节奏，项目页节奏行跟着变，不重拉", async ({ page, request }) => {
  await seedProject(request);
  await page.clock.install();
  await login(page);
  await openProject(page);
  await expect(page.getByTestId("project-cadence"), "订单群还没定节奏，不出这一行").toHaveCount(0);
  const groups = GroupListResponse.parse(await (await page.request.get("/api/groups")).json());
  const taskId = groups.items.find((item) => item.group.id === "grp_order")?.task.id;
  if (taskId === undefined) throw new Error("mock 里没有订单群的任务卡");

  // 项目页重拉有 100ms 防抖。停住页面时钟，节奏行变了之后再把时钟往前拨，挂着的重拉在这时一定发出去。
  await page.clock.pauseAt(Date.now() + 60_000);
  const refetched: string[] = [];
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    if (path.startsWith("/api/projects/") || path === "/api/today" || path.startsWith("/api/groups"))
      refetched.push(path);
  });
  const patched = await page.request.patch(`/api/tasks/${taskId}`, { data: { cadence: "每周一、四各发一条" } });
  expect(patched.status(), "别处改了节奏").toBe(200);
  await expect(page.getByTestId("project-cadence")).toHaveText("节奏：每周一、四各发一条");
  await page.clock.runFor(1_000);
  await page.evaluate(() => fetch("/api/health").then(() => undefined));
  expect(refetched, "节奏读的是推送换好的任务卡，不重拉项目页、首页和群").toEqual([]);
});

test("项目页回 401 时切回登录页", async ({ page }) => {
  await login(page);
  await page.route("**/api/projects/**", (route) => route.fulfill({ status: 401, json: { error: "没登录" } }));
  await teamItem(page).click();
  await expect(page.getByTestId("login-submit"), "会话过期，项目页这一路也把界面切回登录").toBeVisible();
  await expect(page.getByTestId("main-window")).toHaveCount(0);
});
