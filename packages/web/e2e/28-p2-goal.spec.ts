import type { WebSocketRoute } from "@playwright/test";
import { CreateGroupResponse, GroupListResponse, ProjectResponse, type TopicTask } from "@baize/shared";
import {
  EMAIL,
  PASSWORD,
  TEAM_TITLE,
  expect,
  login,
  teamItem,
  test,
  type APIRequestContext,
  type Page,
} from "./fixtures";

// 只扣、只数任务卡补读。重连还会发名单快照和补计数两趟不带参数的群列表，那两类不归这里管。
const TASK_READS = "**/api/groups?for=task";
const isTaskRead = (url: string) => {
  const parsed = new URL(url);
  return parsed.pathname === "/api/groups" && parsed.searchParams.get("for") === "task";
};

const seedProject = async (request: APIRequestContext) => {
  expect((await request.post("/api/test/project")).status(), "订单群里种下三条发布记录和一张待批稿子").toBe(204);
};

const seedGoal = async (request: APIRequestContext) => {
  expect(
    (await request.post("/api/test/project-goal")).status(),
    "订单群定下 1000 星的目标，上周末 375、刚才 412，再交一份周复盘",
  ).toBe(204);
};

const openProject = async (page: Page) => {
  await teamItem(page).click();
  await expect(page).toHaveURL(/\/p\/grp_order$/);
  await expect(page.getByTestId("project-page").getByRole("heading", { name: TEAM_TITLE })).toBeVisible();
};

const topOf = async (page: Page, testId: string): Promise<number> => {
  const box = await page.getByTestId(testId).first().boundingBox();
  if (box === null) throw new Error(`${testId} 没有渲染出来`);
  return box.y;
};

test("项目页头部显示 412 / 1000 和本周 +37", async ({ page, request }) => {
  await seedGoal(request);
  await login(page);
  await openProject(page);

  const head = page.getByTestId("project-progress");
  await expect(head, "当前值对目标，带单位").toContainText("412 / 1000 星");
  const bar = head.locator("progress");
  await expect(bar, "进度条按目标画").toHaveAttribute("max", "1000");
  await expect(bar).toHaveAttribute("value", "412");
  await expect(page.getByTestId("project-goal-week"), "本周变化是 412 减上周最后一个 375").toHaveText("本周 +37");
  await expect(head, "有目标就不再按清单画").not.toContainText("项");
});

test("项目挂了几个指标就列几行：读到的数、读到的时间，账号断了提示去连；目标对其中一个", async ({ page, request }) => {
  expect(
    (await request.post("/api/test/project-metrics")).status(),
    "订单群挂 GitHub 星数、X 粉丝数（账号过期）和 Bot 报的互动率，目标对星数",
  ).toBe(204);
  await login(page);
  await openProject(page);

  await expect(page.getByTestId("project-progress"), "目标进度按星数画").toContainText("412 / 1000 星");
  const rows = page.getByTestId("project-metric");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0), "星数是目标对的那个，本周 +37").toContainText(
    /GitHub 星数 · baize\/order-board目标412本周 \+37读于 \d\d-\d\d \d\d:\d\d/,
  );
  await expect(rows.nth(1), "X 读不到了，留着上次读到的数和时间").toContainText(/X 粉丝数2100读于 \d\d-\d\d \d\d:\d\d/);
  await expect(rows.nth(2), "Bot 报的小数照原样写").toContainText(/互动率3\.5读于/);
  await expect(page.getByTestId("project-metric-connect"), "只有 X 那行要去连账号").toHaveCount(1);
  await expect(rows.nth(1).getByTestId("project-metric-connect")).toHaveText("账号没连上，去连接");

  await page.getByTestId("project-open-group").click();
  await page.getByTestId("task-goal").click();
  const form = page.getByTestId("task-goal-form");
  const metric = form.getByTestId("task-goal-metric");
  await expect(metric, "表单带着目标现在对的指标").toHaveValue("github_stars:baize/order-board");
  await expect(metric.locator("option")).toHaveText([
    "GitHub 星数 · baize/order-board",
    "X 粉丝数",
    "互动率",
    "手记的数",
  ]);
  await metric.selectOption({ label: "X 粉丝数" });
  await form.getByTestId("task-goal-target").fill("5000");
  await form.getByTestId("task-goal-unit").fill("粉丝");
  await form.getByTestId("task-goal-save").click();
  await expect(form).toHaveCount(0);
  await expect(page.getByTestId("task-goal"), "目标改对 X 粉丝数，进度用它上次读到的 2100").toHaveText(
    "目标 2100 / 5000 粉丝",
  );

  await openProject(page);
  await expect(page.getByTestId("project-progress")).toContainText("2100 / 5000 粉丝");
  await expect(rows.nth(1), "目标标签挪到 X 粉丝数那行").toContainText("X 粉丝数目标");
  await rows.nth(1).getByTestId("project-metric-connect").click();
  await expect(page.getByTestId("accounts-page"), "点去连接打开账号页").toBeVisible();
});

test("390px 群页打开目标表单，「对哪个数」和输入框都收在聊天栏里", async ({ page, request }) => {
  expect((await request.post("/api/test/project-metrics")).status()).toBe(204);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByTestId("nav-open").click();
  await openProject(page);
  await page.getByTestId("project-open-group").click();
  await page.getByTestId("task-goal").click();
  const form = page.getByTestId("task-goal-form");
  await expect(form.getByTestId("task-goal-metric")).toHaveValue("github_stars:baize/order-board");

  const overflow = await form.evaluate((el) => {
    const chat = el.closest("section.chat")?.getBoundingClientRect().right ?? 0;
    return [...el.querySelectorAll(".field")].map((field) => Math.round(field.getBoundingClientRect().right - chat));
  });
  expect(overflow, "目标数、单位、期限、对哪个数四格都在").toHaveLength(4);
  expect(Math.max(...overflow), "表单里每一格的右边都不超出聊天栏").toBeLessThanOrEqual(0);
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, "打开目标表单后整页没有横向滚动").toBeLessThanOrEqual(clientWidth);
});

test("没有目标的项目头部不画进度条", async ({ page, request }) => {
  await seedProject(request);
  await login(page);
  await openProject(page);

  const head = page.getByTestId("project-progress");
  await expect(head, "没目标时头部只写清单勾了几项").toContainText(/\d+ \/ \d+ 项/);
  await expect(head.locator("progress"), "没有目标就不画进度条").toHaveCount(0);
  await expect(page.getByTestId("project-goal-week"), "没有指标也就没有本周变化").toHaveCount(0);
});

test("改目标后进度条跟着变", async ({ page, request }) => {
  await seedGoal(request);
  await login(page);
  await openProject(page);
  await expect(page.getByTestId("project-progress").locator("progress")).toHaveAttribute("max", "1000");

  await page.getByTestId("project-open-group").click();
  const goal = page.getByTestId("task-goal");
  await expect(goal, "任务卡上看得到目标").toHaveText("目标 412 / 1000 星");
  await goal.click();
  const form = page.getByTestId("task-goal-form");
  await expect(form.getByTestId("task-goal-target"), "表单带着现在的目标").toHaveValue("1000");
  await expect(form.getByTestId("task-goal-unit")).toHaveValue("星");
  await form.getByTestId("task-goal-target").fill("0");
  await form.getByTestId("task-goal-save").click();
  await expect(form.getByRole("alert"), "目标数得是正整数").toBeVisible();
  await form.getByTestId("task-goal-target").fill("500");
  await form.getByTestId("task-goal-due").fill("2030-12-31T18:00");
  await form.getByTestId("task-goal-save").click();
  await expect(form, "存好收起表单").toHaveCount(0);
  await expect(goal, "任务卡换成新目标").toHaveText("目标 412 / 500 星");

  await openProject(page);
  const head = page.getByTestId("project-progress");
  await expect(head, "项目页头部跟着推送换了目标").toContainText("412 / 500 星");
  await expect(head.locator("progress")).toHaveAttribute("max", "500");
  await expect(head.locator("progress")).toHaveAttribute("value", "412");
  await expect(head, "截止也写在头部").toContainText("截止 12-31 18:00");

  await page.getByTestId("project-open-group").click();
  await page.getByTestId("task-goal").click();
  await page.getByTestId("task-goal-clear").click();
  await expect(page.getByTestId("task-goal"), "去掉目标后卡上只剩定目标的入口").toHaveText("定目标");
  await openProject(page);
  await expect(page.getByTestId("project-progress").locator("progress"), "目标去掉了，进度条也撤掉").toHaveCount(0);
});

test("成果里复盘一行能展开，在成果里的位置不随对话变", async ({ page, request }) => {
  await seedProject(request);
  await seedGoal(request);
  await login(page);
  await openProject(page);

  const review = page.getByTestId("project-review");
  await expect(review, "成果里有一行周复盘").toHaveCount(1);
  await expect(review).toContainText("第 41 周复盘");
  await expect(page.getByTestId("project-achievement"), "发布记录照旧列着").toHaveCount(3);
  const body = page.getByTestId("project-review-body");
  await expect(body, "复盘正文先收着").toBeHidden();
  const inAchievements = async () =>
    (await topOf(page, "project-review")) - (await topOf(page, "project-achievements"));
  const offset = await inAchievements();

  for (const text of ["这周多写两条小红书，第一条讲交期", "第二条讲排产看板，周四晚上上线"]) {
    const settled = page.waitForResponse(async (response) => {
      if (!response.url().endsWith("/api/projects/grp_order")) return false;
      const turn = ProjectResponse.parse(await response.json()).latestTurn;
      return turn?.said.body.kind === "user" && turn.said.body.text === text && turn.replies.length > 0;
    });
    await page.getByTestId("project-composer-input").fill(text);
    await page.getByTestId("project-composer-send").click();
    await settled;
    await expect(page.getByTestId("project-latest-turn")).toContainText(text);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await inAchievements(), `说了「${text}」，复盘还在成果的同一行`).toBe(offset);
  }

  await review.scrollIntoViewIfNeeded();
  const reviewTop = await topOf(page, "project-review");

  await review.locator("summary").click();
  await expect(body, "点开就是正文").toBeVisible();
  await expect(body).toContainText("星数这周涨了 37");
  expect(await topOf(page, "project-review"), "展开不挪自己的位置").toBe(reviewTop);
  await review.locator("summary").click();
  await expect(body, "再点一下收起").toBeHidden();
});

test("首页在进行一行按目标画进度", async ({ page, request }) => {
  await seedGoal(request);
  await login(page);

  const row = page.getByTestId("today-running").getByTestId("today-row").filter({ hasText: TEAM_TITLE });
  await expect(row, "有目标的项目在「在进行」里有一行").toHaveCount(1);
  await expect(row).toContainText("412 / 1000 星");
  await expect(row.locator("progress")).toHaveAttribute("max", "1000");
  await expect(row.locator("progress")).toHaveAttribute("value", "412");
  await expect(
    page.getByTestId("today-running").getByTestId("today-row").filter({ hasText: "条已发布" }).first(),
    "没目标的计划照旧按稿子数画",
  ).toBeVisible();
});

// request 是和浏览器分开的另一个会话，拿它改数据，浏览器只能靠推送知道。
const otherSession = async (request: APIRequestContext) => {
  expect((await request.post("/api/auth/login", { data: { email: EMAIL, password: PASSWORD } })).status()).toBe(200);
};

const orderTask = async (request: APIRequestContext): Promise<TopicTask> => {
  const list = GroupListResponse.parse(await (await request.get("/api/groups")).json());
  const item = list.items.find((entry) => entry.group.id === "grp_order");
  if (item === undefined) throw new Error("mock 里没有订单群");
  return item.task;
};

const openGoalEditor = async (page: Page) => {
  await openProject(page);
  await page.getByTestId("project-open-group").click();
  await page.getByTestId("task-goal").click();
};

// 让 PATCH 落到 mock 上、推送照常发，只把 HTTP 回包扣在浏览器外面，等测试放行。
const holdTaskReply = async (page: Page) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/tasks/*", async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  return release;
};

test("旧的保存回包不盖掉更新的推送", async ({ page, request }) => {
  await seedGoal(request);
  await otherSession(request);
  await login(page);
  await openGoalEditor(page);
  const release = await holdTaskReply(page);
  try {
    await page.getByTestId("task-goal-target").fill("500");
    await page.getByTestId("task-goal-save").click();
    await expect(page.getByTestId("task-goal"), "自己这次保存的推送先到").toHaveText("目标 412 / 500 星");
    const task = await orderTask(request);
    const goal = { target: 800, unit: "星", dueAt: null };
    expect((await request.patch(`/api/tasks/${task.id}`, { data: { goal } })).status()).toBe(200);
    await expect(page.getByTestId("task-goal"), "另一个会话改成 800，推送也到了").toHaveText("目标 412 / 800 星");
  } finally {
    release();
  }
  await expect(page.getByTestId("task-goal-form"), "旧回包到了，表单照常收起").toHaveCount(0);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByTestId("task-goal"), "旧回包里的 500 不能盖掉推送来的 800").toHaveText("目标 412 / 800 星");
  expect((await orderTask(request)).goal?.target, "服务端也是 800").toBe(800);
});

test("停在首页时别处记了数，在进行那一行跟着变", async ({ page, request }) => {
  await seedGoal(request);
  await otherSession(request);
  await login(page);
  const row = page.getByTestId("today-running").getByTestId("today-row").filter({ hasText: TEAM_TITLE });
  await expect(row).toContainText("412 / 1000 星");

  expect((await request.post("/api/projects/grp_order/metric", { data: { value: 900 } })).status()).toBe(200);
  await expect(row, "task_updated 推到就重拉首页").toContainText("900 / 1000 星");
  await expect(row.locator("progress")).toHaveAttribute("value", "900");
});

test("目标对的指标还没读到数：首页、项目页、群页任务卡都写「还没读到数」，不画 0 的进度条", async ({
  page,
  request,
}) => {
  expect((await request.post("/api/test/project-metrics")).status()).toBe(204);
  await otherSession(request);
  const task = await orderTask(request);
  const fans = { kind: "reported", platform: "xiaohongshu", label: "粉丝" } as const;
  const patched = await request.patch(`/api/tasks/${task.id}`, {
    data: {
      metricSources: [...task.metricSources, fans],
      goal: { target: 5000, unit: "粉丝", dueAt: null, metric: "reported:粉丝" },
    },
  });
  expect(patched.status(), "挂上一个 Bot 还没报过的数，目标对它").toBe(200);
  await login(page);

  const row = page.getByTestId("today-running").getByTestId("today-row").filter({ hasText: TEAM_TITLE });
  await expect(row, "首页在进行那一行").toContainText("还没读到数");
  await expect(row).not.toContainText("0 /");
  await expect(row.locator("progress"), "没读到数不画进度条").toHaveCount(0);

  await openProject(page);
  const head = page.getByTestId("project-progress");
  await expect(head, "项目页头部").toContainText("还没读到数");
  await expect(head).toContainText("5000 粉丝");
  await expect(head).not.toContainText("0 /");
  await expect(head.locator("progress")).toHaveCount(0);
  await expect(page.getByTestId("project-metric").nth(3), "指标列表里那一行也这么写").toContainText(
    "粉丝目标还没读到数",
  );

  await page.getByTestId("project-open-group").click();
  await expect(page.getByTestId("task-goal"), "群页任务卡").toHaveText("目标 5000 粉丝 · 还没读到数");
});

test("换「对哪个数」时表单下面说清进度改从哪条读数算，存好就不再提示", async ({ page, request }) => {
  expect((await request.post("/api/test/project-metrics")).status()).toBe(204);
  await login(page);
  await openGoalEditor(page);
  const form = page.getByTestId("task-goal-form");
  const metric = form.getByTestId("task-goal-metric");
  const notice = form.getByTestId("task-goal-metric-switch");
  await expect(notice, "没换就不提示").toHaveCount(0);

  await metric.selectOption({ label: "X 粉丝数" });
  await expect(notice).toHaveText("进度改从「X 粉丝数」的读数算，之前记的数留在原来那条");
  await metric.selectOption({ label: "手记的数" });
  await expect(notice).toHaveText("进度改从「手记的数」的读数算，之前记的数留在原来那条");
  await metric.selectOption({ label: "GitHub 星数 · baize/order-board" });
  await expect(notice, "换回现在对的那个就不提示").toHaveCount(0);

  await metric.selectOption({ label: "X 粉丝数" });
  await form.getByTestId("task-goal-target").fill("5000");
  await form.getByTestId("task-goal-unit").fill("粉丝");
  await form.getByTestId("task-goal-save").click();
  await expect(form).toHaveCount(0);
  await expect(page.getByTestId("task-goal")).toHaveText("目标 2100 / 5000 粉丝");
  await page.getByTestId("task-goal").click();
  await expect(page.getByTestId("task-goal-metric"), "表单带着刚存的 X 粉丝数").toHaveValue(/^x_followers:/);
  await expect(page.getByTestId("task-goal-metric-switch"), "存好之后对的就是它，不再提示").toHaveCount(0);
});

test("复盘里一长串字不撑破成果栏，代码围栏自己横向滚", async ({ page, request }) => {
  await seedGoal(request);
  // 正文上限 8000 字，五段长串各 1400 字，合法且每段都比成果栏宽得多。
  const longLine = "X".repeat(1400);
  await page.route("**/api/projects/grp_order", async (route) => {
    const response = await route.fetch();
    const data = ProjectResponse.parse(await response.json());
    const achievements = data.achievements.map((item) =>
      item.kind === "review"
        ? {
            ...item,
            body: `## 长复盘\n\n${longLine}\n\n[${longLine}](https://example.com/${longLine})\n\n\`${longLine}\`\n\n\`\`\`\n${longLine}\n\`\`\``,
          }
        : item,
    );
    await route.fulfill({ response, json: { ...data, achievements } });
  });
  await login(page);
  await openProject(page);
  const review = page.getByTestId("project-review");
  await review.scrollIntoViewIfNeeded();
  await review.locator("summary").click();
  const body = page.getByTestId("project-review-body");
  await expect(body).toBeVisible();

  const width = await body.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
  expect(width.scroll, "正文、链接、行内代码都折行，不比正文容器宽").toBeLessThanOrEqual(width.client);
  const fence = await body.locator("pre").evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
    overflow: getComputedStyle(element).overflowX,
  }));
  expect(fence.overflow, "代码围栏保留横向滚动").toBe("auto");
  expect(fence.scroll, "代码围栏里的长行不折，在框里滚").toBeGreaterThan(fence.client);
});

test("浏览器历史跳回别的项目群，不带着上一个项目的目标草稿", async ({ page, request }) => {
  await seedGoal(request);
  await otherSession(request);
  const created = CreateGroupResponse.parse(
    await (
      await request.post("/api/groups", { data: { title: "另一项目", botIds: ["bot_service", "bot_sales"] } })
    ).json(),
  );
  const goal = { target: 800, unit: "篇", dueAt: null };
  expect((await request.patch(`/api/tasks/${created.task.id}`, { data: { goal } })).status()).toBe(200);
  await login(page);
  await openProject(page);
  await page.getByTestId("project-open-group").click();
  await expect(page).toHaveURL(/\/g\/grp_order$/);
  await page.getByTestId("group-item").filter({ hasText: "另一项目" }).click();
  await page.getByTestId("project-open-group").click();
  await page.getByTestId("task-goal").click();
  await expect(page.getByTestId("task-goal-target")).toHaveValue("800");

  await page.evaluate(() => history.go(-2));
  await expect(page).toHaveURL(/\/g\/grp_order$/);
  await expect(page.getByTestId("task-goal")).toHaveText("目标 412 / 1000 星");
  await expect(page.getByTestId("task-goal-form"), "换了任务卡，另一项目开着的表单不跟过来").toHaveCount(0);
  await page.getByTestId("task-goal").click();
  await expect(page.getByTestId("task-goal-target"), "重新打开是这个项目自己的目标").toHaveValue("1000");
  await expect(page.getByTestId("task-goal-unit")).toHaveValue("星");
  await page.getByTestId("task-goal-save").click();
  await expect(page.getByTestId("task-goal-form")).toHaveCount(0);
  expect((await orderTask(request)).goal, "订单项目的目标没被另一项目的草稿覆盖").toMatchObject({
    target: 1000,
    unit: "星",
  });
});

test("保存目标期间表单和目标入口都锁住，存完才收起", async ({ page, request }) => {
  await seedGoal(request);
  await otherSession(request);
  await login(page);
  await openGoalEditor(page);
  const release = await holdTaskReply(page);
  try {
    await page.getByTestId("task-goal-target").fill("500");
    await page.getByTestId("task-goal-save").click();
    await expect(page.getByTestId("task-goal")).toHaveText("目标 412 / 500 星");
    for (const testId of ["task-goal-target", "task-goal-unit", "task-goal-due", "task-goal-save", "task-goal-clear"])
      await expect(page.getByTestId(testId), `保存中 ${testId} 不能动`).toBeDisabled();
    await expect(page.getByTestId("task-goal"), "保存中卡头的目标入口也锁住，关不掉也重开不了").toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByTestId("task-goal-form"), "回包到了才收起").toHaveCount(0);
  await expect(page.getByTestId("task-goal")).toBeEnabled();
  await page.getByTestId("task-goal").click();
  await expect(page.getByTestId("task-goal-form"), "存完再开的表单不会被谁关掉").toBeVisible();
  await expect(page.getByTestId("task-goal-target")).toHaveValue("500");
  expect((await orderTask(request)).goal?.target).toBe(500);
});

// 推送走一层代理：offline 时服务端的推送不转给页面。关掉页面这一侧就是断线，应用自己重连，新连接连上才恢复转发。
type PushProxy = { offline: boolean; sides: WebSocketRoute[] };

const proxyPush = async (page: Page): Promise<PushProxy> => {
  const socket: PushProxy = { offline: false, sides: [] };
  await page.routeWebSocket("**/api/ws", (ws) => {
    const server = ws.connectToServer();
    const side = socket.sides.length;
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (!socket.offline && side === socket.sides.length - 1) ws.send(message);
    });
    socket.sides.push(ws);
  });
  return socket;
};

test("断线期间别处改了目标、记了数，重连后项目头部补上", async ({ page, request }) => {
  const socket = await proxyPush(page);
  await seedGoal(request);
  await otherSession(request);
  await login(page);
  await openProject(page);
  const head = page.getByTestId("project-progress");
  await expect(head).toContainText("412 / 1000 星");

  socket.offline = true;
  expect((await request.post("/api/projects/grp_order/metric", { data: { value: 900 } })).status()).toBe(200);
  const task = await orderTask(request);
  const goal = { target: 800, unit: "星", dueAt: null };
  expect((await request.patch(`/api/tasks/${task.id}`, { data: { goal } })).status()).toBe(200);
  const count = socket.sides.length;
  await socket.sides.at(-1)?.close();
  await expect.poll(() => socket.sides.length, "推送重连上了").toBe(count + 1);
  socket.offline = false;

  await expect(head, "断线期间漏掉的目标和指标，重连后补拉回来").toContainText("900 / 800 星");
  await expect(head.locator("progress")).toHaveAttribute("max", "800");
});

test("保存在途时先到别处的推送、再断线，重连后任务卡认回服务端的值", async ({ page, request }) => {
  const socket = await proxyPush(page);
  await seedGoal(request);
  await otherSession(request);
  await login(page);
  await openGoalEditor(page);
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = false;
  await page.route("**/api/tasks/*", async (route) => {
    held = true;
    await gate;
    await route.fulfill({ response: await route.fetch() });
  });
  try {
    await page.getByTestId("task-goal-target").fill("500");
    await page.getByTestId("task-goal-save").click();
    await expect.poll(() => held, "500 的 PATCH 扣在写入之前").toBe(true);
    const task = await orderTask(request);
    const goal = { target: 800, unit: "星", dueAt: null };
    expect((await request.patch(`/api/tasks/${task.id}`, { data: { goal } })).status()).toBe(200);
    await expect(page.getByTestId("task-goal")).toHaveText("目标 412 / 800 星");
    socket.offline = true;
  } finally {
    release();
  }
  await expect(page.getByTestId("task-goal-form")).toHaveCount(0);
  expect((await orderTask(request)).goal?.target, "500 晚于 800 写进去").toBe(500);

  const count = socket.sides.length;
  await socket.sides.at(-1)?.close();
  await expect.poll(() => socket.sides.length, "推送重连上了").toBe(count + 1);
  socket.offline = false;
  await expect(page.getByTestId("task-goal"), "断线时漏掉自己那条推送，重连后按服务端认回 500").toHaveText(
    "目标 412 / 500 星",
  );
});

// A 提交目标 500，PATCH 扣在 mock 之前；B 先写 800，推送到了 A；之后推送通道对 A 不再转发，但连接不关，所以也不会触发重连补读。
// 返回的 release 放行 A 的 PATCH，写入落在 800 之后，服务端终值是 500。
const holdSaveBehindNewerPush = async (page: Page, request: APIRequestContext, socket: PushProxy) => {
  await openGoalEditor(page);
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = false;
  await page.route("**/api/tasks/*", async (route) => {
    held = true;
    await gate;
    await route.fulfill({ response: await route.fetch() });
  });
  await page.getByTestId("task-goal-target").fill("500");
  await page.getByTestId("task-goal-save").click();
  await expect.poll(() => held, "500 的 PATCH 扣在写入之前").toBe(true);
  const task = await orderTask(request);
  const goal = { target: 800, unit: "星", dueAt: null };
  expect((await request.patch(`/api/tasks/${task.id}`, { data: { goal } })).status()).toBe(200);
  await expect(page.getByTestId("task-goal"), "B 的 800 推到了 A").toHaveText("目标 412 / 800 星");
  socket.offline = true;
  return release;
};

const settleRender = (page: Page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

test("保存回包因较早的推送被丢后补读群列表，推送一直不通也认回服务端的值", async ({ page, request }) => {
  const socket = await proxyPush(page);
  await seedGoal(request);
  await otherSession(request);
  await login(page);
  const release = await holdSaveBehindNewerPush(page, request, socket);
  const sides = socket.sides.length;
  release();
  await expect(page.getByTestId("task-goal-form"), "保存成功，表单收起").toHaveCount(0);
  expect((await orderTask(request)).goal?.target, "500 晚于 800 写进去").toBe(500);
  await expect(page.getByTestId("task-goal"), "自己那条推送被吞掉，回包也被丢，补读后认回 500").toHaveText(
    "目标 412 / 500 星",
  );
  expect(socket.sides.length, "推送连接一直没断，认回来靠的不是重连").toBe(sides);
});

test("补读群列表期间又来了同卡推送，补读到的旧值不盖掉推送", async ({ page, request }) => {
  const socket = await proxyPush(page);
  await seedGoal(request);
  await otherSession(request);
  await login(page);
  const release = await holdSaveBehindNewerPush(page, request, socket);
  let releaseReload = () => {};
  const reloadGate = new Promise<void>((resolve) => (releaseReload = resolve));
  let armed = false;
  let reloadHeld = false;
  await page.route(TASK_READS, async (route) => {
    if (!armed) return route.fallback();
    const response = await route.fetch();
    reloadHeld = true;
    await reloadGate;
    await route.fulfill({ response });
  });
  armed = true;
  release();
  await expect.poll(() => reloadHeld, "补读的群列表按 500 取到，扣在页面外").toBe(true);

  socket.offline = false;
  const task = await orderTask(request);
  const goal = { target: 900, unit: "星", dueAt: null };
  expect((await request.patch(`/api/tasks/${task.id}`, { data: { goal } })).status()).toBe(200);
  await expect(page.getByTestId("task-goal"), "补读在途时 B 又写了 900，推送到了").toHaveText("目标 412 / 900 星");
  const answered = page.waitForResponse((response) => isTaskRead(response.url()));
  releaseReload();
  await answered;
  await settleRender(page);
  await expect(page.getByTestId("task-goal"), "补读回来的 500 比推送旧，丢掉").toHaveText("目标 412 / 900 星");
  await expect(page.getByTestId("task-goal-form"), "补读发出后又接受了推送，卡已认回服务端，保存算成").toHaveCount(0);
  await expect(page.getByTestId("task-refresh-failed"), "补读被推送取代不是刷新失败").toHaveCount(0);
  expect((await orderTask(request)).goal?.target, "服务端是 900").toBe(900);
});

test("停在首页时项目成员被删空，在进行那一行撤掉", async ({ page, request }) => {
  await otherSession(request);
  const created = CreateGroupResponse.parse(
    await (
      await request.post("/api/groups", { data: { title: "删空成员项目", botIds: ["bot_sales", "bot_service"] } })
    ).json(),
  );
  const goal = { target: 500, unit: "篇", dueAt: null };
  expect((await request.patch(`/api/tasks/${created.task.id}`, { data: { goal } })).status()).toBe(200);
  await login(page);
  const row = page.getByTestId("today-running").getByTestId("today-row").filter({ hasText: "删空成员项目" });
  await expect(row).toContainText("500 篇 · 还没读到数");

  for (const botId of ["bot_sales", "bot_service"])
    expect((await request.delete(`/api/bots/${botId}`)).status(), `删掉 ${botId}`).toBe(204);
  await expect(row, "成员都删了，服务端不再算它在进行，首页跟着撤行").toHaveCount(0);
});

test("只改目标数，含秒和毫秒的截止原样存回", async ({ page, request }) => {
  await seedGoal(request);
  await otherSession(request);
  const dueAt = "2026-12-31T10:20:45.123Z";
  const task = await orderTask(request);
  const goal = { target: 1000, unit: "星", dueAt };
  expect((await request.patch(`/api/tasks/${task.id}`, { data: { goal } })).status()).toBe(200);
  await login(page);
  await openGoalEditor(page);
  await page.getByTestId("task-goal-target").fill("500");
  await page.getByTestId("task-goal-save").click();
  await expect(page.getByTestId("task-goal-form")).toHaveCount(0);
  expect((await orderTask(request)).goal, "没碰截止，截止不被截到分钟").toEqual({
    target: 500,
    unit: "星",
    dueAt,
    metric: null,
  });
});

test.describe("纽约时区", () => {
  test.use({ timezoneId: "America/New_York" });

  test("只改目标数，夏令时回拨那一小时里的截止不被挪走", async ({ page, request }) => {
    await seedGoal(request);
    await otherSession(request);
    // 2026-11-01 纽约 01:00 到 02:00 过两遍，06:30Z 是第二遍的 01:30。
    const dueAt = "2026-11-01T06:30:00.000Z";
    const task = await orderTask(request);
    const goal = { target: 1000, unit: "星", dueAt };
    expect((await request.patch(`/api/tasks/${task.id}`, { data: { goal } })).status()).toBe(200);
    await login(page);
    await openGoalEditor(page);
    await expect(page.getByTestId("task-goal-due")).toHaveValue("2026-11-01T01:30");
    await page.getByTestId("task-goal-target").fill("500");
    await page.getByTestId("task-goal-save").click();
    await expect(page.getByTestId("task-goal-form")).toHaveCount(0);
    expect((await orderTask(request)).goal, "没碰截止，不能被换成第一遍的 01:30").toEqual({
      target: 500,
      unit: "星",
      dueAt,
      metric: null,
    });
  });
});

// 补读回包扣在页面外，release 放行之后等它真的进到页面、渲染过两帧再断言，免得把「还没落地」当成「被丢掉」。
const holdGroupsRead = async (page: Page) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reads = 0;
  let held = false;
  await page.route(TASK_READS, async (route) => {
    reads += 1;
    if (reads !== 1) return route.fallback();
    const response = await route.fetch();
    held = true;
    await gate;
    await route.fulfill({ response });
  });
  return {
    held: () => held,
    settle: async () => {
      const answered = page.waitForResponse((response) => isTaskRead(response.url()));
      release();
      await answered;
      await settleRender(page);
    },
  };
};

test("旧补读扣在途中，卸载重开再存一次成功，放行旧补读也不回退", async ({ page, request }) => {
  const socket = await proxyPush(page);
  await seedGoal(request);
  await otherSession(request);
  await login(page);
  const release = await holdSaveBehindNewerPush(page, request, socket);
  const stale = await holdGroupsRead(page);
  release();
  await expect.poll(stale.held, "500 回包被丢，补读按 500 取到，扣在页面外").toBe(true);

  await page.getByTestId("today-nav").click();
  await expect(page.getByTestId("task-goal-form"), "离开群，目标编辑器卸载").toHaveCount(0);
  await openGoalEditor(page);
  await page.getByTestId("task-goal-target").fill("600");
  await page.getByTestId("task-goal-save").click();
  await expect(page.getByTestId("task-goal-form"), "重开后的第二次保存成功").toHaveCount(0);
  await expect(page.getByTestId("task-goal")).toHaveText("目标 412 / 600 星");
  expect((await orderTask(request)).goal?.target, "服务端是 600").toBe(600);

  await stale.settle();
  await expect(page.getByTestId("task-goal"), "补读发出之后这张卡又接受过 600 的回包，500 丢掉").toHaveText(
    "目标 412 / 600 星",
  );
});

test("两次重连的补读倒序回来，先发的旧群列表不盖掉后发的", async ({ page, request }) => {
  const socket = await proxyPush(page);
  await seedGoal(request);
  await otherSession(request);
  await login(page);
  await openProject(page);
  socket.offline = true;
  const task = await orderTask(request);
  const reconnect = async () => {
    const count = socket.sides.length;
    await socket.sides.at(-1)?.close();
    await expect.poll(() => socket.sides.length, "推送重连上了").toBe(count + 1);
  };
  const stale = await holdGroupsRead(page);

  expect(
    (
      await request.patch(`/api/tasks/${task.id}`, { data: { goal: { target: 500, unit: "星", dueAt: null } } })
    ).status(),
  ).toBe(200);
  await reconnect();
  await expect.poll(stale.held, "第一次重连的补读按 500 取到，扣在页面外").toBe(true);
  expect(
    (
      await request.patch(`/api/tasks/${task.id}`, { data: { goal: { target: 800, unit: "星", dueAt: null } } })
    ).status(),
  ).toBe(200);
  await reconnect();
  const head = page.getByTestId("project-progress");
  await expect(head, "第二次重连的补读先回来").toContainText("412 / 800 星");

  await stale.settle();
  await expect(head, "第一次补读之后又发过补读，它的 500 丢掉").toContainText("412 / 800 星");
  expect((await orderTask(request)).goal?.target, "服务端是 800").toBe(800);
});

test("先发的补读在后发的补读回来之前到，先落地，后发的回来照样按票号落地", async ({ page, request }) => {
  const socket = await proxyPush(page);
  await seedGoal(request);
  await otherSession(request);
  await login(page);
  await openProject(page);
  socket.offline = true;
  const task = await orderTask(request);
  const reconnect = async () => {
    const count = socket.sides.length;
    await socket.sides.at(-1)?.close();
    await expect.poll(() => socket.sides.length, "推送重连上了").toBe(count + 1);
  };
  const gates: (() => void)[] = [];
  await page.route(TASK_READS, async (route) => {
    const response = await route.fetch();
    await new Promise<void>((resolve) => gates.push(resolve));
    await route.fulfill({ response });
  });
  const settle = async (at: number) => {
    const answered = page.waitForResponse((response) => isTaskRead(response.url()));
    gates[at]?.();
    await answered;
    await settleRender(page);
  };
  const head = page.getByTestId("project-progress");

  expect(
    (
      await request.patch(`/api/tasks/${task.id}`, { data: { goal: { target: 500, unit: "星", dueAt: null } } })
    ).status(),
  ).toBe(200);
  await reconnect();
  await expect.poll(() => gates.length, "第一次重连的补读按 500 取到，扣在页面外").toBe(1);
  expect(
    (
      await request.patch(`/api/tasks/${task.id}`, { data: { goal: { target: 800, unit: "星", dueAt: null } } })
    ).status(),
  ).toBe(200);
  await reconnect();
  await expect.poll(() => gates.length, "第二次重连的补读按 800 取到，也扣着").toBe(2);

  await settle(0);
  await expect(head, "先回来的 500 是服务端确实有过的值，没有更晚的落地挡着就落地").toContainText("412 / 500 星");
  await settle(1);
  await expect(head, "后发的补读票号更大，500 落地不挡它，认回服务端的 800").toContainText("412 / 800 星");
});

test("写入成功但补读失败，说已存上、刷新没成功，重新读取不再写一遍", async ({ page, request }) => {
  const socket = await proxyPush(page);
  await seedGoal(request);
  await otherSession(request);
  await login(page);
  const release = await holdSaveBehindNewerPush(page, request, socket);
  let patches = 0;
  page.on("request", (sent) => {
    if (sent.method() === "PATCH" && sent.url().includes("/api/tasks/")) patches += 1;
  });
  await page.route(TASK_READS, (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "补读失败" }) }),
  );
  release();

  const notice = page.getByTestId("task-refresh-failed");
  await expect(notice, "写入已成功，只是最新数据没取到").toContainText("目标已存上，刷新没成功");
  await expect(page.getByTestId("task-goal-form"), "写入成功就收起表单，不再催着重存").toHaveCount(0);
  expect((await orderTask(request)).goal?.target, "500 确实写进去了").toBe(500);
  await expect(page.getByTestId("task-goal"), "补读没回来，卡上还是推送来的 800").toHaveText("目标 412 / 800 星");

  await page.unroute(TASK_READS);
  await notice.getByRole("button", { name: "重新读取" }).click();
  await expect(page.getByTestId("task-goal"), "重新读取认回服务端的 500").toHaveText("目标 412 / 500 星");
  await expect(notice, "读到了就撤掉提示").toHaveCount(0);
  expect(patches, "重新读取只读群列表，不重发已成功的 PATCH").toBe(0);
});

const reconnectPush = async (socket: PushProxy) => {
  const count = socket.sides.length;
  await socket.sides.at(-1)?.close();
  await expect.poll(() => socket.sides.length, "推送重连上了").toBe(count + 1);
};

const failGroups = { status: 503, contentType: "application/json", body: JSON.stringify({ error: "补读失败" }) };

// 第一趟群列表读按真实数据取到后扣在页面外，第二趟直接 503。first 决定第一趟放行时给真实数据还是 503。
const holdFirstFailSecond = async (page: Page, first: "data" | "fail" = "data") => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reads = 0;
  let held = false;
  await page.route(TASK_READS, async (route) => {
    reads += 1;
    if (reads === 2) return route.fulfill(failGroups);
    if (reads !== 1) return route.fallback();
    const response = await route.fetch();
    held = true;
    await gate;
    if (first === "data") await route.fulfill({ response });
    else await route.fulfill(failGroups);
  });
  return {
    held: () => held,
    replaceWithFailedReconnect: async (socket: PushProxy) => {
      const failed = page.waitForResponse((response) => isTaskRead(response.url()) && response.status() === 503);
      await reconnectPush(socket);
      await failed;
    },
    settle: async () => {
      const answered = page.waitForResponse((response) => isTaskRead(response.url()));
      release();
      await answered;
      await settleRender(page);
    },
  };
};

test("先发的重连补读被后发的取代，后发那趟 503，先发读到的仍落地", async ({ page, request }) => {
  const socket = await proxyPush(page);
  await seedGoal(request);
  await otherSession(request);
  await login(page);
  await openProject(page);
  socket.offline = true;
  const task = await orderTask(request);
  expect(
    (
      await request.patch(`/api/tasks/${task.id}`, { data: { goal: { target: 800, unit: "星", dueAt: null } } })
    ).status(),
  ).toBe(200);
  const reads = await holdFirstFailSecond(page);
  await reconnectPush(socket);
  await expect.poll(reads.held, "第一次重连的补读按 800 取到，扣在页面外").toBe(true);
  await reads.replaceWithFailedReconnect(socket);
  await reads.settle();
  await expect(page.getByTestId("project-progress"), "接替的那趟失败了，先发读到的 800 是手里最新的确认").toContainText(
    "412 / 800 星",
  );
});

test("保存补读被后发的重连补读取代，后发那趟 503，保存读到的仍认回服务端", async ({ page, request }) => {
  const socket = await proxyPush(page);
  await seedGoal(request);
  await otherSession(request);
  await login(page);
  const release = await holdSaveBehindNewerPush(page, request, socket);
  const reads = await holdFirstFailSecond(page);
  release();
  await expect.poll(reads.held, "500 回包被丢，补读按 500 取到，扣在页面外").toBe(true);
  await reads.replaceWithFailedReconnect(socket);
  await reads.settle();
  await expect(page.getByTestId("task-goal"), "保存自己的补读读到 500，接替的失败了就认它").toHaveText(
    "目标 412 / 500 星",
  );
  await expect(page.getByTestId("task-goal-form"), "认回了服务端的值，保存算成").toHaveCount(0);
  await expect(page.getByTestId("task-refresh-failed"), "卡上已是最新确认，不报刷新失败").toHaveCount(0);
  expect((await orderTask(request)).goal?.target, "服务端是 500").toBe(500);
});

test("重新读取被后发的重连补读取代，后发那趟 503，重新读取读到的仍落地", async ({ page, request }) => {
  const socket = await proxyPush(page);
  await seedGoal(request);
  await otherSession(request);
  await login(page);
  const release = await holdSaveBehindNewerPush(page, request, socket);
  await page.route(TASK_READS, (route) => route.fulfill(failGroups));
  release();
  const notice = page.getByTestId("task-refresh-failed");
  await expect(notice).toContainText("目标已存上，刷新没成功");
  await page.unroute(TASK_READS);

  const reads = await holdFirstFailSecond(page);
  await notice.getByRole("button", { name: "重新读取" }).click();
  await expect.poll(reads.held, "重新读取按 500 取到，扣在页面外").toBe(true);
  await reads.replaceWithFailedReconnect(socket);
  await reads.settle();
  await expect(page.getByTestId("task-goal"), "重新读取读到的 500 落地").toHaveText("目标 412 / 500 星");
  await expect(notice, "读到了才撤掉提示").toHaveCount(0);
});

test("保存补读和接替它的重连补读都失败，表单收起并留下刷新失败提示", async ({ page, request }) => {
  const socket = await proxyPush(page);
  await seedGoal(request);
  await otherSession(request);
  await login(page);
  const release = await holdSaveBehindNewerPush(page, request, socket);
  const reads = await holdFirstFailSecond(page, "fail");
  release();
  await expect.poll(reads.held, "保存补读扣在页面外").toBe(true);
  await reads.replaceWithFailedReconnect(socket);
  await reads.settle();
  await expect(page.getByTestId("task-refresh-failed"), "两趟都没读到，说已存上、刷新没成功").toContainText(
    "目标已存上，刷新没成功",
  );
  await expect(page.getByTestId("task-goal-form")).toHaveCount(0);
  await expect(page.getByTestId("task-goal"), "没读到就还是推送来的 800").toHaveText("目标 412 / 800 星");
  expect((await orderTask(request)).goal?.target, "500 确实写进去了").toBe(500);
});

test("勾清单写入成功但补读失败，卡上说清单已存上、刷新没成功，没有未处理的拒绝", async ({ page, request }) => {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as Window & { __rejections?: string[] }).__rejections = seen;
    window.addEventListener("unhandledrejection", (event) => {
      seen.push(String((event.reason as Error | undefined)?.name ?? event.reason));
    });
  });
  const socket = await proxyPush(page);
  await seedGoal(request);
  await otherSession(request);
  await login(page);
  await openProject(page);
  await page.getByTestId("project-open-group").click();
  const before = await orderTask(request);
  const first = before.checklist[0];
  if (first === undefined) throw new Error("订单群的清单是空的");
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = false;
  await page.route("**/api/tasks/*", async (route) => {
    held = true;
    await gate;
    await route.fulfill({ response: await route.fetch() });
  });
  const box = page.getByTestId("checklist-item").first();
  await box.click();
  await expect.poll(() => held, "勾选的 PATCH 扣在写入之前").toBe(true);
  expect(
    (
      await request.patch(`/api/tasks/${before.id}`, { data: { goal: { target: 800, unit: "星", dueAt: null } } })
    ).status(),
  ).toBe(200);
  await expect(page.getByTestId("task-goal"), "别处的 800 推到了").toHaveText("目标 412 / 800 星");
  socket.offline = true;
  await page.route(TASK_READS, (route) => route.fulfill(failGroups));
  release();

  const notice = page.getByTestId("task-refresh-failed");
  await expect(notice, "勾选写进去了，只是刷新没成功").toContainText("清单已存上，刷新没成功");
  expect((await orderTask(request)).checklist[0]?.done, "服务端的清单第一项已经翻过来").toBe(!first.done);
  expect(
    await page.evaluate(() => (window as Window & { __rejections?: string[] }).__rejections),
    "TaskRefreshFailed 被卡接住，不漏成未处理的拒绝",
  ).toEqual([]);

  await page.unroute(TASK_READS);
  await notice.getByRole("button", { name: "重新读取" }).click();
  await expect(notice).toHaveCount(0);
  await expect(box, "重新读取后勾选认回服务端").toHaveAttribute("data-done", String(!first.done));
});

test("三趟补读末趟 503，先放的旧 500 落地后，后放的新 900 照样落地", async ({ page, request }) => {
  const socket = await proxyPush(page);
  await seedGoal(request);
  await otherSession(request);
  await login(page);
  const release = await holdSaveBehindNewerPush(page, request, socket);
  const gates: (() => void)[] = [];
  let reads = 0;
  await page.route(TASK_READS, async (route) => {
    reads += 1;
    if (reads === 3) return route.fulfill(failGroups);
    const response = await route.fetch();
    await new Promise<void>((resolve) => gates.push(resolve));
    await route.fulfill({ response });
  });
  const settle = async (at: number) => {
    const answered = page.waitForResponse((response) => isTaskRead(response.url()));
    gates[at]?.();
    await answered;
    await settleRender(page);
  };
  release();
  await expect.poll(() => gates.length, "500 回包被丢，保存补读 R1 按 500 取到，扣在页面外").toBe(1);
  const task = await orderTask(request);
  expect(
    (
      await request.patch(`/api/tasks/${task.id}`, { data: { goal: { target: 900, unit: "星", dueAt: null } } })
    ).status(),
  ).toBe(200);
  await reconnectPush(socket);
  await expect.poll(() => gates.length, "B 写了 900、推送漏掉，重连补读 R2 按 900 取到，也扣着").toBe(2);
  const failed = page.waitForResponse((response) => isTaskRead(response.url()) && response.status() === 503);
  await reconnectPush(socket);
  await failed;

  await settle(0);
  await expect(page.getByTestId("task-goal"), "R1 读到的 500 落地").toHaveText("目标 412 / 500 星");
  await expect(page.getByTestId("task-goal-form"), "保存自己的补读落了地，保存算成").toHaveCount(0);
  await settle(1);
  await expect(page.getByTestId("task-goal"), "R2 票号更大，R1 落地不动推送计数，900 不被挡").toHaveText(
    "目标 412 / 900 星",
  );
  await expect(page.getByTestId("task-refresh-failed")).toHaveCount(0);
  expect((await orderTask(request)).goal?.target, "服务端是 900").toBe(900);
  expect(reads, "三趟补读：500、900、503").toBe(3);
});
