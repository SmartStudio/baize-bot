import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TestInfo } from "@playwright/test";
import { DecideProjectOfferResponse, GroupListResponse, MessageListResponse } from "@baize/shared";
import { expect, login, openBot, teamCard, test, type Page } from "./fixtures";

const screenshotPath = async (testInfo: TestInfo, name: string): Promise<string> => {
  const auditDir = process.env["BAIZE_P1_9_AUDIT_DIR"];
  const target = auditDir === undefined ? testInfo.outputPath(name) : join(auditDir, name);
  await mkdir(dirname(target), { recursive: true });
  return target;
};

const STAR_GOAL = "推广白泽的开源仓库，年底 1000 星";
const DOUYIN_GOAL = "把抖音号做起来，年底 1000 粉";

const offerCard = (page: Page) => page.getByTestId("message-list").getByTestId("project-offer");

/** 侧栏加号说一句，发完落在主助理单聊里，等主助理回方案卡。 */
const proposeFromSidebar = async (page: Page, text: string) => {
  await page.getByTestId("new-project").click();
  const dialog = page.getByTestId("new-project-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("new-project-input"), "弹出来就能直接打字").toBeFocused();
  await page.getByTestId("new-project-input").fill(text);
  await page.getByTestId("new-project-submit").click();
  await expect(dialog, "发完小窗关掉").toHaveCount(0);
  await expect(page).toHaveURL(/\/g\/grp_assistant$/);
  await expect(page.getByTestId("chat-title")).toHaveText("主助理");
  const card = offerCard(page);
  await expect(card, "主助理回了一张方案卡").toHaveAttribute("data-status", "offered");
  return card;
};

const offerRequests = (page: Page): string[] => {
  const seen: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/project-offer")) seen.push(request.method());
  });
  return seen;
};

test("加号发出的一句话出现在主助理单聊里", async ({ page }, testInfo) => {
  await login(page);
  const groups = page.getByTestId("group-item");
  await expect(groups).toHaveCount(1);

  const card = await proposeFromSidebar(page, STAR_GOAL);
  const list = page.getByTestId("message-list");
  await expect(list.locator("[data-kind=user]", { hasText: STAR_GOAL }), "那句话是单聊里的一条普通消息").toHaveCount(1);
  await expect(groups, "说一句话不另起一个对话，侧栏的项目不多").toHaveCount(1);

  const history = MessageListResponse.parse(
    await (await page.request.get("/api/groups/grp_assistant/messages")).json(),
  ).messages;
  expect(
    history.filter((message) => message.body.kind === "user" && message.body.text === STAR_GOAL),
    "控制面那头也只是主助理单聊里的一条用户消息",
  ).toHaveLength(1);

  await expect(card.getByTestId("project-offer-name")).toHaveText("推广白泽");
  await expect(card.getByTestId("project-offer-goal")).toHaveText("白泽的开源仓库年底 1000 星");
  const members = card.getByTestId("project-offer-member");
  await expect(members, "队伍每人一行").toHaveCount(2);
  await expect(members.nth(0)).toContainText("小内");
  await expect(members.nth(0)).toContainText("写 X 帖子和 GitHub 周报，不回评论");
  await expect(card.getByTestId("project-offer-cadence")).toHaveText("每周 X 发 5 条，GitHub 周报一篇");
  await expect(card.getByTestId("project-offer-first-step")).toHaveText("先把 README 改成一句话讲清楚白泽是什么");
  const platforms = card.getByTestId("project-offer-platform");
  await expect(platforms.filter({ hasText: "GitHub" }), "连着的账号写账号名").toContainText("baize-tech");
  await expect(platforms.filter({ hasText: "X" }), "登录过期的号不算连着").toContainText("第一条内容写好时请你登录");
  await expect(card.getByRole("button"), "没有权限选项，只有项目名、改一下、开始").toHaveText([
    "推广白泽",
    "改一下",
    "开始",
  ]);
  await card.screenshot({ path: await screenshotPath(testInfo, "card.png") });
});

test("方案卡上改项目名后开始，新群的标题是新名字", async ({ page }, testInfo) => {
  await login(page);
  const card = await proposeFromSidebar(page, STAR_GOAL);

  await card.getByTestId("project-offer-name").click();
  const nameInput = card.getByTestId("project-offer-name-input");
  await expect(nameInput, "点名字就地变成输入框").toBeFocused();
  await nameInput.fill("白泽千星");
  await nameInput.press("Enter");
  await expect(card.getByTestId("project-offer-name")).toHaveText("白泽千星");

  await card.getByTestId("project-offer-start").click();
  await expect(page, "开始后跳进新项目的群").toHaveURL(/\/g\/(?!grp_assistant$)[^/]+$/);
  await expect(page.getByTestId("chat-title")).toHaveText("白泽千星");
  await expect(page.getByTestId("chat-subtitle"), "主助理带两个队员").toContainText("你 + 3 个 Bot");
  const created = page.locator('[data-testid=group-item][data-group-title="白泽千星"]');
  await expect(created, "侧栏不刷新就多一行，标题是新名字").toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("group-item")).toHaveCount(2);
  const projectUrl = page.url();

  await page.goto("/g/grp_assistant");
  const started = offerCard(page);
  await expect(started, "卡随重推的消息收成一行").toHaveAttribute("data-status", "started");
  await expect(started).toContainText("项目已开始");
  await expect(started.getByTestId("project-offer-start"), "开始过的卡没有按钮").toHaveCount(0);
  await started.screenshot({ path: await screenshotPath(testInfo, "started.png") });
  await started.getByTestId("project-offer-open").click();
  await expect(page, "去看看回到那个项目").toHaveURL(projectUrl);

  await page.getByTestId("team-nav").click();
  await expect(teamCard(page, "小内"), "新队员推到了前端，团队页认得它").toHaveCount(1);
  await expect(teamCard(page, "小社")).toHaveCount(1);
});

test("点两次开始只跳一次，卡只变一次", async ({ page }) => {
  await login(page);
  const card = await proposeFromSidebar(page, STAR_GOAL);
  const requests = offerRequests(page);

  await page.evaluate(() => {
    const trace: string[] = [];
    (window as unknown as { __offerTrace: string[] }).__offerTrace = trace;
    const sample = () => {
      const status = document.querySelector("[data-testid=project-offer]")?.getAttribute("data-status");
      if (typeof status === "string" && trace.at(-1) !== status) trace.push(status);
    };
    sample();
    new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, attributes: true });
  });
  const historyBefore = await page.evaluate(() => history.length);

  // 同一个任务里连点两下，按钮来不及变灰，靠卡自己挡住第二下。
  await card.getByTestId("project-offer-start").evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect(page).toHaveURL(/\/g\/(?!grp_assistant$)[^/]+$/);
  await expect(page.getByTestId("chat-title")).toHaveText("推广白泽");
  const projectUrl = page.url();
  expect(requests, "点两下只发一次开始").toEqual(["POST"]);
  expect(await page.evaluate(() => history.length), "只跳一次").toBe(historyBefore + 1);

  const offerId = MessageListResponse.parse(
    await (await page.request.get("/api/groups/grp_assistant/messages")).json(),
  ).messages.find((message) => message.body.kind === "project_offer")?.id;
  if (offerId === undefined) throw new Error("主助理单聊里没有方案卡");
  const again = await page.request.post(`/api/messages/${offerId}/project-offer`, { data: { decision: "start" } });
  expect(again.status(), "已经开始过的卡再点回 200，不是错").toBe(200);
  const settled = DecideProjectOfferResponse.parse(await again.json());
  expect(settled.message.body).toMatchObject({ status: "started" });
  expect(projectUrl.endsWith(`/g/${settled.group?.id ?? "没有群"}`), "回的还是那个项目").toBe(true);
  const projects = GroupListResponse.parse(await (await page.request.get("/api/groups")).json()).items;
  expect(projects, "只建出一个项目").toHaveLength(2);
  await expect(page.getByTestId("group-item")).toHaveCount(2);

  await page.goBack();
  await expect(offerCard(page)).toHaveAttribute("data-status", "started");
  expect(
    await page.evaluate(() => (window as unknown as { __offerTrace: string[] }).__offerTrace),
    "卡只从等你确认变成已开始一次",
  ).toEqual(["offered", "started"]);
});

test("抖音那一行写着暂不支持", async ({ page }, testInfo) => {
  await login(page);
  const card = await proposeFromSidebar(page, DOUYIN_GOAL);
  const requests = offerRequests(page);

  const platforms = card.getByTestId("project-offer-platform");
  const douyin = platforms.filter({ hasText: "抖音" });
  await expect(douyin).toHaveText("抖音暂不支持");
  await expect(douyin).toHaveAttribute("data-supported", "false");
  const supported = platforms.filter({ hasText: "小红书" });
  await expect(supported, "连着的小红书号写账号名").toContainText("白泽工厂日记");
  const color = (row: typeof douyin) => row.evaluate((element) => getComputedStyle(element).color);
  expect(await color(douyin), "暂不支持的那行灰掉").not.toBe(await color(supported));
  await card.screenshot({ path: await screenshotPath(testInfo, "second.png") });

  await card.getByTestId("project-offer-revise").click();
  const input = page.getByTestId("composer-input");
  await expect(input, "改一下把焦点放回输入框").toBeFocused();
  await expect(input).toHaveValue("改一下：");
  await expect(card, "改一下不动这张卡").toHaveAttribute("data-status", "offered");
  expect(requests, "改一下不调接口").toEqual([]);
});

test("草稿没发出去时卡上写原因", async ({ page }) => {
  await login(page);
  await openBot(page, "小采");
  const failed = page.getByTestId("message-list").getByTestId("draft-card").filter({ hasText: "X3 交期答疑" });
  await expect(failed).toHaveAttribute("data-status", "failed");
  await expect(failed.getByTestId("draft-failure")).toHaveText("账号登录过期了，重新登录后再发");
});

test("刷新之后已发出的草稿卡还带原帖链接", async ({ page, request }) => {
  await login(page);
  const approved = await page.request.post("/api/drafts/draft_today_reply", { data: { decision: "approve" } });
  expect(approved.status()).toBe(200);
  expect((await request.post("/api/test/drafts/draft_today_reply/publish")).status()).toBe(204);

  await page.reload();
  await page.goto("/g/grp_assistant");
  const card = page.getByTestId("message-list").getByTestId("draft-card").filter({ hasText: "阿杰的车间" });
  await expect(card).toHaveAttribute("data-status", "published");
  await expect(card.getByTestId("draft-link"), "链接来自消息分页带回的 publications").toHaveAttribute(
    "href",
    /^https:\/\/www\.xiaohongshu\.com\//,
  );
});
