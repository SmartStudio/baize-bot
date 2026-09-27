import { MessageListResponse, RoutineListResponse } from "@baize/shared";
import { expect, login, openSettings, test, type Page } from "./fixtures";

const GREETING = "想让我帮你做成什么事？说一句就行";
const SAID = "这周推广一下新版本";

const apiRequests = (page: Page): string[] => {
  const seen: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/api/") && !pathname.startsWith("/api/ws")) seen.push(`${request.method()} ${pathname}`);
  });
  return seen;
};

test("电脑 hello 补建主助理后，开着的首页不刷新就能用输入框，主助理进的是单聊", async ({ page }) => {
  expect((await page.request.post("/api/test/without-assistant")).status(), "mock 造一个还没有主助理的账号").toBe(204);
  await login(page);
  const input = page.getByTestId("today-composer-input");
  await expect(input, "没有主助理时输入框禁用").toBeDisabled();
  await expect(page.getByTestId("today-assistant-latest"), "没有主助理就没有最近一句").toHaveCount(0);
  const groups = await page.getByTestId("group-item").count();

  expect((await page.request.post("/api/test/assistant-hello")).status()).toBe(204);

  await expect(input, "补建的推送到了就解禁，不用刷新").toBeEnabled();
  await expect(page.getByTestId("today-assistant-text"), "首页跟着显示主助理的开场白").toHaveText(GREETING);
  await expect(page.getByTestId("assistant-nav"), "侧栏出了主助理").toBeVisible();
  await expect(page.getByTestId("group-item"), "主助理的单聊不当成项目列进侧栏").toHaveCount(groups);

  await input.fill(SAID);
  await page.getByTestId("today-composer-send").click();
  await expect(input, "发出去了就清空").toHaveValue("");
  await expect
    .poll(async () => {
      const history = MessageListResponse.parse(
        await (await page.request.get("/api/groups/grp_assistant/messages")).json(),
      ).messages;
      return history.some((message) => message.body.kind === "user" && message.body.text === SAID);
    }, "输入框发进补建出来的主助理单聊")
    .toBe(true);
});

test("首页显示主助理最近一句，点它进主助理单聊", async ({ page }) => {
  await login(page);
  const latest = page.getByTestId("today-assistant-latest");
  await expect(latest.getByTestId("today-assistant-text")).toHaveText(GREETING);
  await latest.click();
  await expect(page).toHaveURL(/\/g\/grp_assistant$/);
});

test("例行页一次拉全部例行，不再按 Bot 一个个拉", async ({ page }) => {
  const seen = apiRequests(page);
  await login(page);
  const expected = RoutineListResponse.parse(await (await page.request.get("/api/routines")).json()).items;
  expect(expected.length, "mock 里预置了例行").toBeGreaterThan(0);

  await page.getByTestId("routines-nav").click();
  await expect(page.getByTestId("routine-row")).toHaveCount(expected.length);
  expect(seen.filter((line) => line === "GET /api/routines")).toHaveLength(1);
  expect(
    seen.filter((line) => /^GET \/api\/bots\/[^/]+\/routines$/.test(line)),
    "不再按 Bot 拉",
  ).toEqual([]);
});

test("方案卡点开始后，新项目用回包里的群和任务卡，不另拉群列表", async ({ page }) => {
  await login(page);
  await page.getByTestId("new-project").click();
  await page.getByTestId("new-project-input").fill("推广白泽的开源仓库，年底 1000 星");
  await page.getByTestId("new-project-submit").click();
  const card = page.getByTestId("message-list").getByTestId("project-offer");
  await expect(card).toHaveAttribute("data-status", "offered");

  const seen = apiRequests(page);
  await card.getByTestId("project-offer-start").click();
  await expect(
    page.getByTestId("project-page").getByRole("heading", { name: "推广白泽", exact: true }),
    "回包里的任务卡直接画出项目页",
  ).toBeVisible();
  expect(
    seen.filter((line) => line === "GET /api/groups"),
    "开始之后不再另拉群列表",
  ).toEqual([]);
});

test("设置的账号页点接入 GitHub，授权回来首页提示接好了，地址栏的查询串清掉，刷新不再提示", async ({ page }) => {
  await login(page);
  await openSettings(page);
  await page.getByTestId("settings-nav-accounts").click();
  const github = page.locator("[data-testid=account-connect-link][data-platform=github]");
  await expect(github).toHaveAttribute("href", "/api/oauth/github/start");
  await expect(page.locator("[data-testid=account-connect-link][data-platform=x]")).toHaveAttribute(
    "href",
    "/api/oauth/x/start",
  );

  await github.click();
  const notice = page.getByTestId("oauth-notice");
  await expect(notice).toHaveText(/GitHub 账号接好了/);
  await expect(page, "读完就把 oauth 和 result 从地址栏清掉").toHaveURL(/\/$/);

  await notice.getByTestId("oauth-notice-accounts").click();
  await expect(
    page.getByTestId("account-row").filter({ hasText: "GitHub · mock_github" }),
    "接好的号出现在账号页",
  ).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("main-window")).toBeVisible();
  await expect(page.getByTestId("oauth-notice"), "刷新之后不再提示").toHaveCount(0);
});

for (const [result, text] of [
  ["denied", "你在 X 那边没有同意授权，账号没接上"],
  ["invalid_state", "这次 X 授权过期了或不是从这里发起的，再点一次接入"],
  ["failed", "X 授权没成，账号没接上，稍后再试一次"],
] as const) {
  test(`授权回跳带 ${result}，首页给中文提示并清掉查询串`, async ({ page }) => {
    await login(page);
    await page.goto(`/?oauth=x&result=${result}`);
    const notice = page.getByTestId("oauth-notice");
    await expect(notice).toHaveText(text);
    await expect(notice.getByTestId("oauth-notice-accounts"), "没接上就不给看账号").toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
    await notice.getByTestId("oauth-notice-close").click();
    await expect(notice).toHaveCount(0);
  });
}

test("today 回包慢时主助理连说四句，同一时刻最多一个 today 请求在途，放开后只补拉一次并显示最后一句", async ({
  page,
}) => {
  await login(page);
  await expect(page.getByTestId("today-assistant-text"), "首次 today 已经落地").toHaveText(GREETING);

  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  await page.route("**/api/today", async (route) => {
    requests += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const response = await route.fetch();
    await gate;
    inFlight -= 1;
    await route.fulfill({ response });
  });

  const lines = ["第一句", "第二句", "第三句", "第四句"].map((line) => `慢回包时主助理说的${line}`);
  try {
    for (const text of lines) {
      const posted = await page.request.post("/api/test/messages", {
        data: { groupId: "grp_assistant", botId: "bot_assistant", text },
      });
      expect(posted.status()).toBe(204);
      await page.waitForTimeout(250);
    }
    expect(requests, "第一句触发的请求扣着没回，后三句只记一笔，不再发请求").toBe(1);
  } finally {
    release();
  }

  await expect(page.getByTestId("today-assistant-text"), "补拉回来显示最后一句").toHaveText(lines.at(-1) ?? "");
  expect(maxInFlight, "同一时刻最多一个 today 请求在途").toBe(1);
  expect(requests, "放开后只补拉一次").toBe(2);
});

test("today 在途时主助理又说了一句，落后的那趟回包不上屏，只显示补拉回来的最新一句", async ({ page }) => {
  await login(page);
  const text = page.getByTestId("today-assistant-text");
  await expect(text, "首次 today 已经落地").toHaveText(GREETING);
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as Window & { __assistantTexts?: string[] }).__assistantTexts = seen;
    new MutationObserver(() => {
      const current = document.querySelector("[data-testid=today-assistant-text]")?.textContent ?? "";
      if (seen.at(-1) !== current) seen.push(current);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });

  const gates: (() => void)[] = [];
  let requests = 0;
  await page.route("**/api/today", async (route) => {
    requests += 1;
    const response = await route.fetch();
    await new Promise<void>((resolve) => gates.push(resolve));
    await route.fulfill({ response });
  });

  const [stale, latest] = ["在途时先说的一句", "在途时后说的一句"];
  const say = async (line: string) => {
    const posted = await page.request.post("/api/test/messages", {
      data: { groupId: "grp_assistant", botId: "bot_assistant", text: line },
    });
    expect(posted.status()).toBe(204);
  };
  await say(stale);
  await expect.poll(() => gates.length, "第一趟取到只带先说那句的回包后扣住").toBe(1);
  await say(latest);
  await page.waitForTimeout(250);
  expect(requests, "后说那句只记一笔补拉").toBe(1);

  gates[0]?.();
  await expect.poll(() => gates.length, "第一趟落定后补拉也扣住").toBe(2);
  gates[1]?.();
  await expect(text, "补拉回来显示最新一句").toHaveText(latest);
  const seen = await page.evaluate(() => (window as Window & { __assistantTexts?: string[] }).__assistantTexts ?? []);
  expect(seen, "落后的第一趟回包从没上屏").not.toContain(stale);
});

test("today 回包扣住时在首页拒绝审批，按钮在刷新落定前一直禁用，结论只提交一次", async ({ page }) => {
  await login(page);
  const row = page.getByTestId("today-pending").getByTestId("today-row").filter({ hasText: "发送 Globex" });
  const reject = row.getByRole("button", { name: "拒绝" });
  await expect(reject).toBeEnabled();

  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let todayRequests = 0;
  await page.route("**/api/today", async (route) => {
    todayRequests += 1;
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  let decisions = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/approvals/")) decisions += 1;
  });

  try {
    await reject.click();
    await expect.poll(() => todayRequests, "结论提交后刷新 today，回包扣住").toBeGreaterThan(0);
    await page.waitForTimeout(250);
    await expect(reject, "today 没落定前按钮一直禁用").toBeDisabled();
    await reject.click({ force: true });
    expect(decisions, "扣住期间结论只提交一次").toBe(1);
  } finally {
    release();
  }
  await expect(row, "today 落定后这条审批从清单消失").toHaveCount(0);
  expect(decisions).toBe(1);
});
