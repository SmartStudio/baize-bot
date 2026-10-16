import {
  SHOT,
  TEAM_TITLE,
  expect,
  login,
  openBot,
  openTeamGroup,
  sendText,
  test,
  type APIRequestContext,
  type Page,
} from "./fixtures";

// 群头的电脑选择器：某个 Bot 在某个群里用云电脑还是你的电脑。mock 预置你的电脑和云电脑两台，都在线；
// 用例按需摘掉一台或改状态。

const removeComputer = async (request: APIRequestContext, computerId: string) => {
  expect((await request.delete(`/api/test/computers/${computerId}`)).status(), `mock 摘掉 ${computerId}`).toBe(204);
};

const setComputer = async (request: APIRequestContext, computerId: string, status: string) => {
  const response = await request.post(`/api/test/computers/${computerId}/status`, { data: { status } });
  expect(response.status(), `mock 把 ${computerId} 改成 ${status}`).toBe(204);
};

const soloPicker = (page: Page) => page.getByTestId("bot-header").getByTestId("computer-picker");
const teamRow = (page: Page, botId: string) => page.locator(`[data-testid=team-computer-row][data-bot-id=${botId}]`);
const option = (page: Page, kind: string) => page.locator(`[data-testid=computer-picker-option][data-kind=${kind}]`);

const choose = async (picker: ReturnType<typeof soloPicker>, kind: "local" | "remote") => {
  await picker.getByTestId("computer-picker-trigger").click();
  await expect(picker.getByTestId("computer-picker-menu")).toBeVisible();
  await picker.locator(`[data-testid=computer-picker-option][data-kind=${kind}]`).click();
};

const systemLine = (page: Page, text: string) =>
  page.getByTestId("message-list").locator("[data-kind=system]").filter({ hasText: text });

test("两台电脑：单聊头部和项目群的成员菜单里都有选择器，没选过写默认；项目群原来的成员条一个不少", async ({ page }) => {
  await login(page);
  await openBot(page, "小服");
  const picker = soloPicker(page);
  await expect(picker.getByTestId("computer-picker-label"), "没选过走默认，你的电脑在线就是它").toHaveText(
    "默认：你的电脑",
  );
  await picker.getByTestId("computer-picker-trigger").click();
  await expect(picker.getByTestId("computer-picker-option"), "两台两个选项，你的电脑在前").toHaveText([
    "你的电脑",
    "云电脑",
  ]);
  // 菜单是浮层，盖在对话区上，截整个对话区才截得全。
  await page.getByTestId("chat").screenshot({ path: `${SHOT}/p3-computer-picker-solo.png` });
  await page.keyboard.press("Escape");
  await expect(picker.getByTestId("computer-picker-menu"), "Esc 收起").toHaveCount(0);

  await openTeamGroup(page, TEAM_TITLE);
  await expect(page.getByTestId("chat-member"), "成员条不动").toHaveCount(3);
  await expect(page.getByTestId("chat-member").locator(".avatar")).toHaveCount(3);
  await page.getByTestId("team-computers").click();
  const menu = page.getByTestId("team-computer-menu");
  await expect(menu.getByTestId("team-computer-row"), "每个成员一行，按成员顺序").toHaveCount(3);
  await expect(menu.getByTestId("team-computer-row").locator(".team-computer-name")).toHaveText([
    "小服",
    "小销",
    "小采",
  ]);
  await expect(teamRow(page, "bot_sales").getByTestId("computer-picker-label")).toHaveText("默认：你的电脑");
  await page.getByTestId("chat").screenshot({ path: `${SHOT}/p3-computer-picker-team.png` });

  await choose(teamRow(page, "bot_sales").getByTestId("computer-picker"), "remote");
  await expect(teamRow(page, "bot_sales").getByTestId("computer-picker-label"), "选完按钮跟着换").toHaveText("云电脑");
  await expect(systemLine(page, "小销之后在这个群里用云电脑"), "群里落一条说明").toHaveCount(1);
  await expect(teamRow(page, "bot_service").getByTestId("computer-picker-label"), "别的成员不受影响").toHaveText(
    "默认：你的电脑",
  );

  await openBot(page, "小销");
  await expect(soloPicker(page).getByTestId("computer-picker-label"), "单聊里各选各的").toHaveText("默认：你的电脑");
});

test("只有一台电脑：单聊头部和项目群头部都不多任何东西", async ({ page, request }) => {
  await removeComputer(request, "cmp_remote");
  await login(page);
  await openBot(page, "小服");
  await expect(page.getByTestId("bot-know-toggle"), "头部画完了").toContainText("记住");
  await expect(page.getByTestId("computer-picker"), "一台电脑没得选").toHaveCount(0);
  await page.getByTestId("bot-header").screenshot({ path: `${SHOT}/p3-computer-picker-single-solo.png` });

  await openTeamGroup(page, TEAM_TITLE);
  await expect(page.getByTestId("chat-member")).toHaveCount(3);
  await expect(page.getByTestId("team-computers"), "项目群头部也不出入口").toHaveCount(0);
  await expect(page.getByTestId("team-computer-note")).toHaveCount(0);
  await page.locator(".chat-header").screenshot({ path: `${SHOT}/p3-computer-picker-single-team.png` });
});

test("云电脑不在线照样能选：选上之后头部明说不会改派到你的电脑；它回来了小字就收起", async ({ page, request }) => {
  await setComputer(request, "cmp_remote", "sleeping");
  await login(page);
  await openBot(page, "小服");
  const picker = soloPicker(page);
  await picker.getByTestId("computer-picker-trigger").click();
  await expect(option(page, "remote").getByTestId("computer-picker-down"), "离线那台标出来但不灰").toHaveText("不在线");
  await expect(option(page, "local").getByTestId("computer-picker-down")).toHaveCount(0);
  await option(page, "remote").click();

  await expect(picker.getByTestId("computer-picker-label")).toHaveText("云电脑");
  await expect(systemLine(page, "小服之后在这个群里用云电脑")).toHaveCount(1);
  await expect(picker.getByTestId("computer-picker-offline")).toHaveText("云电脑不在线，发消息不会改派到你的电脑");

  await setComputer(request, "cmp_remote", "online");
  await expect(picker.getByTestId("computer-picker-offline"), "能派了就不再提醒").toHaveCount(0);
  await expect(picker.getByTestId("computer-picker-label")).toHaveText("云电脑");
});

test("项目群里有成员选的那台不在线，菜单收着时头部也写出是谁", async ({ page, request }) => {
  await login(page);
  await openTeamGroup(page, TEAM_TITLE);
  await page.getByTestId("team-computers").click();
  await choose(teamRow(page, "bot_buy").getByTestId("computer-picker"), "remote");
  await expect(teamRow(page, "bot_buy").getByTestId("computer-picker-label")).toHaveText("云电脑");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("team-computer-menu")).toHaveCount(0);

  await setComputer(request, "cmp_remote", "sleeping");
  await expect(page.getByTestId("team-computer-note")).toHaveText(["小采：云电脑不在线，发消息不会改派到你的电脑"]);
});

test("账号下其实已经没有云电脑：选它回 409，原文照登", async ({ page, request }) => {
  await login(page);
  await openBot(page, "小服");
  const picker = soloPicker(page);
  await expect(picker.getByTestId("computer-picker-label")).toHaveText("默认：你的电脑");
  // 摘电脑不推送，网页手里还是两台。
  await removeComputer(request, "cmp_remote");
  await choose(picker, "remote");
  await expect(picker.getByTestId("computer-picker-error")).toHaveText("你还没有云电脑，选不了");
  await expect(picker.getByTestId("computer-picker-label"), "没选成，按钮不换").toHaveText("默认：你的电脑");
  await expect(systemLine(page, "之后在这个群里用")).toHaveCount(0);
});

test("别处换了选择，推送一到选择器就跟着换", async ({ page }) => {
  await login(page);
  await openBot(page, "小服");
  const picker = soloPicker(page);
  await expect(picker.getByTestId("computer-picker-label")).toHaveText("默认：你的电脑");

  const response = await page.request.put("/api/groups/grp_service/bots/bot_service/computer", {
    data: { kind: "remote" },
  });
  expect(response.status(), "另一个客户端选了云电脑").toBe(204);
  await expect(picker.getByTestId("computer-picker-label")).toHaveText("云电脑");
  await expect(systemLine(page, "小服之后在这个群里用云电脑")).toHaveCount(1);
});

test("这一轮还在你的电脑上时换到云电脑：头部说这一轮跑完下一条才换，跑完小字就收", async ({ page }) => {
  await login(page);
  await openBot(page, "小服");
  const picker = soloPicker(page);
  await expect(picker.getByTestId("computer-picker-label")).toHaveText("默认：你的电脑");
  await sendText(page, "帮我退款");
  await expect(page.getByTestId("approval-card"), "停在审批上，这一轮没跑完").toHaveAttribute("data-status", "pending");

  await choose(picker, "remote");
  await expect(picker.getByTestId("computer-picker-running")).toHaveText("这一轮还在你的电脑上跑完，下一条起用云电脑");

  await sendText(page, "批准");
  await expect(page.getByTestId("approval-card")).toHaveAttribute("data-status", "approved");
  await expect(page.getByTestId("message-list"), "回复说完了，这一轮快收尾").toContainText("已经办了");
  // 花费卡不在对话里画，但它的推送会让头部重拉；小字收起靠的就是这一下。
  await expect(picker.getByTestId("computer-picker-running"), "跑完了就不再说").toHaveCount(0);
  await expect(picker.getByTestId("computer-picker-label")).toHaveText("云电脑");
});
