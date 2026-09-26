import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MessageListResponse, expect, openBot, openSettings, test, login, type Page } from "./fixtures";
import type { TestInfo, WebSocketRoute } from "@playwright/test";

const screenshotPath = async (testInfo: TestInfo, name: string): Promise<string> => {
  const auditDir = process.env["BAIZE_P1_4_AUDIT_DIR"];
  const target = auditDir === undefined ? testInfo.outputPath(name) : join(auditDir, name);
  await mkdir(dirname(target), { recursive: true });
  return target;
};

const PLAN_TITLE = "本周推广计划";
const EDITED = "改过的开头：X3 这周在苏州工厂上线了。";

const pendingRows = (page: Page) => page.getByTestId("today-pending").getByTestId("today-row");
const pendingCount = (page: Page) => page.getByTestId("today-pending").getByTestId("today-section-count");

const expandPlanOnToday = async (page: Page) => {
  const row = pendingRows(page).filter({ hasText: PLAN_TITLE });
  await row.getByTestId("today-expand").click();
  const card = row.getByTestId("plan-card");
  await expect(card, "首页就地展开成计划卡").toHaveAttribute("data-status", "pending");
  return card;
};

const planDrafts = (card: ReturnType<Page["getByTestId"]>) => card.getByTestId("plan-draft");

const openAssistant = async (page: Page) => {
  await page.getByTestId("assistant-nav").click();
  await expect(page.getByTestId("chat-title")).toHaveText("主助理");
};

const REPLY_ID = "draft_today_reply";
const REPLY_TEXT = "能接。飞书的审批和群消息都能进白泽，私信我发你接入文档。";
const MY_REPLY = "能接，飞书审批和群消息都能进白泽。接入文档我私信发你。";
const BOT_REPLY = "能接。飞书审批、群消息、多维表格都能进白泽，接入文档已经私信你了。";

const draftIn = async (page: Page, groupId: string, draftId: string) => {
  const history = MessageListResponse.parse(await (await page.request.get(`/api/groups/${groupId}/messages`)).json());
  const draft = history.drafts.find((item) => item.id === draftId);
  if (draft === undefined) throw new Error(`${groupId} 里没有 ${draftId}`);
  return draft;
};

const replyCard = (page: Page) =>
  page.getByTestId("message-list").getByTestId("draft-card").filter({ hasText: "阿杰的车间" });

test("计划卡里改一条的字再批准，等你确认的数字减一", async ({ page }) => {
  await login(page);
  const before = Number(await pendingCount(page).textContent());
  const card = await expandPlanOnToday(page);
  await expect(card).toContainText("5 条草稿");
  const times = await planDrafts(card).evaluateAll((rows) => rows.map((row) => row.getAttribute("data-scheduled-at")));
  expect(times, "计划卡里的草稿按排期先后排").toEqual([...times].sort());

  const first = planDrafts(card).first();
  await first.getByTestId("plan-draft-toggle").click();
  await expect(first, "每条写平台、账号、从哪台电脑发").toContainText(/X · @baize_x3 · 从本机发出/);
  await first.getByTestId("draft-editor").fill(EDITED);
  await card.getByTestId("plan-approve").click();

  await expect(pendingRows(page).filter({ hasText: PLAN_TITLE }), "整份批完计划行从等你确认消失").toHaveCount(0);
  await expect(pendingCount(page)).toHaveText(String(before - 1));

  const history = MessageListResponse.parse(
    await (await page.request.get("/api/groups/grp_assistant/messages")).json(),
  );
  const edited = history.drafts.find((draft) => draft.content.text === EDITED);
  expect(edited?.status, "改过的正文跟着整份批准一起带上").toBe("approved");
  expect(
    edited?.edits.map((edit) => edit.after),
    "改动记进 edits",
  ).toEqual([EDITED]);
});

test("改过的草稿出现品牌手册那行提示，没改的不出", async ({ page }, testInfo) => {
  await login(page);
  const card = await expandPlanOnToday(page);
  const [first, second] = [planDrafts(card).nth(0), planDrafts(card).nth(1)];
  await first.getByTestId("plan-draft-toggle").click();
  await first.getByTestId("draft-editor").fill(EDITED);
  await second.getByTestId("plan-draft-toggle").click();
  await expect(second.getByTestId("draft-editor")).toBeVisible();

  await expect(first.getByTestId("brand-hint")).toHaveText("改过的地方会记进品牌手册，下次照着写");
  await expect(first, "改过的那条标上已改").toContainText("已改");
  await expect(second.getByTestId("brand-hint"), "没改的不出提示").toHaveCount(0);
  await expect(card.getByTestId("plan-approve")).toHaveText("批准 5 条（改了 1 条）");
  await card.screenshot({ path: await screenshotPath(testInfo, "edit.png") });

  await first
    .getByTestId("draft-editor")
    .fill((await first.getByTestId("draft-editor").getAttribute("data-original")) ?? "");
  await expect(first.getByTestId("brand-hint"), "改回原文提示跟着消失").toHaveCount(0);
});

test("首页展开计划卡批准后，群里同一张卡也变成已批", async ({ page }, testInfo) => {
  await login(page);
  await openAssistant(page);
  const groupCard = page.getByTestId("message-list").getByTestId("plan-card");
  await expect(groupCard, "群里的计划消息渲染同一张卡").toHaveAttribute("data-status", "pending");
  await expect(groupCard).toContainText(PLAN_TITLE);

  await page.getByTestId("today-nav").click();
  const card = await expandPlanOnToday(page);
  await page.getByTestId("today-pending").screenshot({ path: await screenshotPath(testInfo, "plan.png") });
  await card.getByTestId("plan-approve").click();
  await expect(pendingRows(page).filter({ hasText: PLAN_TITLE })).toHaveCount(0);

  await openAssistant(page);
  await expect(groupCard, "群里那张卡随推送变成已批").toHaveAttribute("data-status", "approved");
  await expect(groupCard).toContainText("已批 5 条");
  await expect(groupCard.getByTestId("plan-approve"), "批完收成一行，不再有按钮").toHaveCount(0);
});

test("回复卡显示对方的原话，发出后刚做完多一行带链接", async ({ page, request }, testInfo) => {
  await login(page);
  const row = pendingRows(page).filter({ hasText: "阿杰的车间" });
  await row.getByTestId("today-expand").click();
  const card = row.getByTestId("draft-card");
  await expect(card.getByTestId("draft-quote")).toContainText("阿杰的车间");
  await expect(card.getByTestId("draft-quote")).toContainText("这个能接飞书吗？");
  await expect(card).toContainText(/小红书 · 白泽工厂日记 · 从远程电脑发出/);
  await page.getByTestId("today-pending").screenshot({ path: await screenshotPath(testInfo, "reply.png") });

  const doneRows = page.getByTestId("today-done").getByTestId("today-row");
  const doneBefore = await doneRows.count();
  await card.getByTestId("draft-approve").click();
  await expect(row, "批完这一行从等你确认消失").toHaveCount(0);

  expect((await request.post("/api/test/drafts/draft_today_reply/publish")).status(), "假装发布循环发出了").toBe(204);
  await expect(doneRows).toHaveCount(doneBefore + 1);
  const published = doneRows.filter({ hasText: "回复 阿杰的车间" });
  await expect(published).toHaveAttribute("href", /^https:\/\/www\.xiaohongshu\.com\//);

  await openAssistant(page);
  const groupCard = page.getByTestId("message-list").getByTestId("draft-card").filter({ hasText: "阿杰的车间" });
  await expect(groupCard, "群里那张回复卡也换成已发").toHaveAttribute("data-status", "published");
  await expect(groupCard.getByTestId("draft-link"), "卡上带原帖链接").toHaveAttribute(
    "href",
    /^https:\/\/www\.xiaohongshu\.com\//,
  );
});

test("可起草档的草稿批完出现复制正文", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  await openBot(page, "小采");
  const drafted = page.getByTestId("message-list").getByTestId("draft-card").filter({ hasText: "X3 现货比价清单" });
  await expect(drafted.getByTestId("draft-copy"), "待批时还没有复制正文").toHaveCount(0);

  await drafted.getByTestId("draft-approve").click();
  await expect(drafted).toHaveAttribute("data-status", "approved");
  await expect(drafted, "可起草档批了也不发").toContainText("不会自动发");
  await drafted.getByTestId("draft-copy").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "三家供应商的现货、到货和报价差异已经整理好。",
  );
  expect(
    (await page.request.post("/api/test/drafts/draft_today_review/publish")).status(),
    "mock 的发布入口和控制面一样，可起草档不发",
  ).toBe(409);

  await openAssistant(page);
  const reply = replyCard(page);
  await reply.getByTestId("draft-approve").click();
  await expect(reply).toHaveAttribute("data-status", "approved");
  await expect(reply.getByTestId("draft-copy"), "发布要确认档不给复制正文").toHaveCount(0);
});

test("别处退回的草稿随推送换成已退回", async ({ page }) => {
  await login(page);
  await openBot(page, "小采");
  const drafted = page.getByTestId("message-list").getByTestId("draft-card").filter({ hasText: "X3 现货比价清单" });
  await expect(drafted).toHaveAttribute("data-status", "pending");
  const history = MessageListResponse.parse(await (await page.request.get("/api/groups/grp_buy/messages")).json());
  const target = history.drafts.find(
    (draft) => draft.content.kind === "post" && draft.content.title === "X3 现货比价清单",
  );
  expect(target, "预置的那条待批草稿").toBeDefined();
  const res = await page.request.post(`/api/drafts/${target?.id ?? ""}`, { data: { decision: "return" } });
  expect(res.status()).toBe(200);
  await expect(drafted, "卡片状态只随推送换").toHaveAttribute("data-status", "returned");
  await expect(drafted).toContainText("已退回");
});

test("别处批准的计划随推送收成已批 5 条", async ({ page }) => {
  await login(page);
  await openAssistant(page);
  const plan = page.getByTestId("message-list").getByTestId("plan-card");
  await expect(plan).toHaveAttribute("data-status", "pending");

  const res = await page.request.post("/api/plans/plan_today_content/approve", { data: { edits: [] } });
  expect(res.status(), "不经这一页，直接调接口批准").toBe(200);
  await expect(plan, "卡片只靠 plan_updated 推送收起").toHaveAttribute("data-status", "approved");
  await expect(plan).toContainText("已批 5 条");
});

test("回复卡上改字单条批准，改后的正文和 edits 一起落库", async ({ page }) => {
  await login(page);
  await openAssistant(page);
  const reply = replyCard(page);
  await reply.getByTestId("draft-editor").fill(MY_REPLY);
  await expect(reply.getByTestId("brand-hint")).toBeVisible();
  await reply.getByTestId("draft-approve").click();
  await expect(reply).toHaveAttribute("data-status", "approved");

  const draft = await draftIn(page, "grp_assistant", REPLY_ID);
  expect(draft.content.text, "单条批准带上改后的正文").toBe(MY_REPLY);
  expect(
    draft.edits.map(({ before, after }) => ({ before, after })),
    "改动记进 edits",
  ).toEqual([{ before: REPLY_TEXT, after: MY_REPLY }]);
});

test("改字批准后 Bot 改稿打回待批，卡上和再批准的都是 Bot 的新正文", async ({ page }) => {
  await login(page);
  await openAssistant(page);
  const reply = replyCard(page);
  await reply.getByTestId("draft-editor").fill(MY_REPLY);
  await reply.getByTestId("draft-approve").click();
  await expect(reply).toHaveAttribute("data-status", "approved");

  const revised = await page.request.post(`/api/test/drafts/${REPLY_ID}/revise`, { data: { text: BOT_REPLY } });
  expect(revised.status(), "Bot 改稿，已批的草稿回到待批").toBe(204);
  await expect(reply).toHaveAttribute("data-status", "pending");
  await expect(reply.getByTestId("draft-editor"), "卡上是 Bot 的新正文，不是上次改的字").toHaveValue(BOT_REPLY);
  await expect(reply.getByTestId("brand-hint"), "本地改字作废，品牌手册提示跟着消失").toHaveCount(0);

  await reply.getByTestId("draft-approve").click();
  await expect(reply).toHaveAttribute("data-status", "approved");
  const draft = await draftIn(page, "grp_assistant", REPLY_ID);
  expect(draft.content.text, "再批准发出去的是 Bot 的新正文").toBe(BOT_REPLY);
  expect(
    draft.edits.map(({ after }) => after),
    "第二次没改字，edits 只有第一次那一对",
  ).toEqual([MY_REPLY]);
});

test("计划卡里改着字时 Bot 改了这一条，改字作废换成新正文", async ({ page }) => {
  await login(page);
  const card = await expandPlanOnToday(page);
  const first = planDrafts(card).first();
  await first.getByTestId("plan-draft-toggle").click();
  await first.getByTestId("draft-editor").fill(EDITED);
  await expect(card.getByTestId("plan-approve")).toHaveText("批准 5 条（改了 1 条）");

  const botText = "X3 这周在苏州工厂上线，排产会从两小时缩到二十分钟，现场照片见下。";
  const revised = await page.request.post("/api/test/drafts/draft_today_plan_1/revise", { data: { text: botText } });
  expect(revised.status()).toBe(204);
  await expect(first.getByTestId("draft-editor"), "展开的那条换成 Bot 的新正文").toHaveValue(botText);
  await expect(first.getByTestId("brand-hint")).toHaveCount(0);
  await expect(card.getByTestId("plan-approve"), "改字作废，批准时不再带 edits").toHaveText("批准 5 条");
});

test("首页快照晚到，也不把刚批的卡打回待批", async ({ page }) => {
  await login(page);
  await openAssistant(page);
  const reply = replyCard(page);
  const plan = page.getByTestId("message-list").getByTestId("plan-card");
  await expect(reply).toHaveAttribute("data-status", "pending");
  await expect(plan).toHaveAttribute("data-status", "pending");

  const conflicts: string[] = [];
  page.on("response", (res) => {
    if (res.status() === 409) conflicts.push(res.url());
  });
  let armed = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let snapshotTaken = () => {};
  const taken = new Promise<void>((resolve) => (snapshotTaken = resolve));
  let staleServed = () => {};
  const served = new Promise<void>((resolve) => (staleServed = resolve));
  await page.route("**/api/today", async (route) => {
    if (!armed) return route.continue();
    armed = false;
    const response = await route.fetch();
    snapshotTaken();
    await gate;
    await route.fulfill({ response });
    staleServed();
  });

  armed = true;
  await reply.getByTestId("draft-approve").click();
  await expect(reply).toHaveAttribute("data-status", "approved");
  await taken;
  await plan.getByTestId("plan-approve").click();
  await expect(plan, "第二张卡先随接口和推送变成已批").toHaveAttribute("data-status", "approved");

  release();
  await served;
  await page.evaluate(() => fetch("/api/health").then(() => undefined));
  await expect(plan, "批第二张之前生成的首页快照晚到，不把它打回待批").toHaveAttribute("data-status", "approved");
  await expect(plan).toContainText("已批 5 条");
  await expect(plan.getByTestId("plan-approve"), "没有闪回，也就没有能再点的批准").toHaveCount(0);
  expect(conflicts, "没有撞上 409").toEqual([]);
});

test("断线期间漏掉的改稿，重连后的首页快照补上", async ({ page, request }) => {
  let offline = false;
  const pageSides: WebSocketRoute[] = [];
  await page.routeWebSocket("**/api/ws", (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (!offline) ws.send(message);
    });
    pageSides.push(ws);
  });
  await login(page);
  await openAssistant(page);
  const reply = replyCard(page);
  await expect(reply.getByTestId("draft-editor")).toHaveValue(REPLY_TEXT);
  await expect.poll(() => pageSides.length, "推送连上了").toBe(1);

  offline = true;
  const revised = await request.post(`/api/test/drafts/${REPLY_ID}/revise`, { data: { text: BOT_REPLY } });
  expect(revised.status()).toBe(204);
  const reconnected = page.waitForRequest("**/api/today");
  offline = false;
  await pageSides[0]?.close();
  await reconnected;
  await expect(reply.getByTestId("draft-editor"), "断线时漏掉的 draft_updated 由重连后的首页快照补上").toHaveValue(
    BOT_REPLY,
  );
});

test("账号没取到时写没取到，点重试再拉", async ({ page }) => {
  await page.route("**/api/accounts", (route) => route.fulfill({ status: 500, json: { error: "账号表挂了" } }));
  await login(page);
  await openSettings(page);
  await page.getByTestId("settings-nav-accounts").click();
  await expect(page.getByTestId("accounts-failed")).toContainText("账号没取到");
  await expect(page.getByTestId("accounts-empty"), "拉失败不能说成没有账号").toHaveCount(0);

  await page.unroute("**/api/accounts");
  await page.getByTestId("accounts-retry").click();
  await expect(page.getByTestId("accounts-page").getByTestId("account-row")).toHaveCount(4);
});

test("账号页小红书的可直接发布置灰", async ({ page }, testInfo) => {
  await login(page);
  await openSettings(page);
  await page.getByTestId("settings-nav-accounts").click();
  const rows = page.getByTestId("accounts-page").getByTestId("account-row");
  await expect(rows).toHaveCount(4);
  const xhs = rows.filter({ hasText: "要务机械星球" });
  await expect(xhs, "平台、名字、在哪台电脑、当前档").toContainText(/小红书.*要务机械星球.*本机.*可起草/);

  await xhs.getByTestId("account-tier-toggle").click();
  const direct = xhs.locator("[data-testid=account-tier-option][data-tier=direct_publish] input");
  await expect(direct).toBeDisabled();
  await expect(xhs.getByTestId("account-tier-reason")).toHaveText("平台 2026-03-10 起封 AI 托管账号");
  await page.getByTestId("settings-window").screenshot({ path: await screenshotPath(testInfo, "accounts.png") });

  await xhs.locator("[data-testid=account-tier-option][data-tier=confirm_publish] input").click();
  await expect(xhs.getByTestId("account-tier"), "换档走 PATCH，回来的账号落进列表").toHaveText("发布要确认");

  const x = rows.filter({ hasText: "@baize_x3" });
  await x.getByTestId("account-tier-toggle").click();
  await expect(x.locator("[data-testid=account-tier-option][data-tier=direct_publish] input")).toBeEnabled();
  await expect(x.getByTestId("account-tier-reason")).toHaveCount(0);
});
