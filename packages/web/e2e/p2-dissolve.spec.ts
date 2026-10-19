import { GroupListResponse, PokerTableResponse } from "@baize/shared";
import { TEAM_TITLE, expect, login, teamItem, test, type Page } from "./fixtures";

const listedTitles = async (page: Page): Promise<string[]> =>
  GroupListResponse.parse(await (await page.request.get("/api/groups")).json()).items.map((item) => item.task.title);

test("项目页解散群：先确认，确认后回首页，侧栏和列表里都没了", async ({ page }) => {
  await login(page);
  await teamItem(page).click();
  await expect(page.getByTestId("project-page").getByRole("heading", { name: TEAM_TITLE })).toBeVisible();

  await page.getByTestId("archive-group").click();
  const dialog = page.getByTestId("archive-group-dialog");
  await expect(dialog, "说清楚解散的后果").toContainText("群会从侧栏消失，正在做的活和挂着的审批都会停下");
  await expect(dialog, "不是牌桌不提作废").not.toContainText("这手作废");
  await dialog.getByTestId("archive-group-cancel").click();
  await expect(dialog, "取消就什么都不动").toHaveCount(0);
  await expect(teamItem(page)).toHaveCount(1);

  await page.getByTestId("archive-group").click();
  await page.getByTestId("archive-group-confirm").click();
  await expect(page, "开着的就是这个群，解散后回首页").toHaveURL(/\/$/);
  await expect(teamItem(page), "侧栏里没了").toHaveCount(0);
  expect(await listedTitles(page), "群列表里也没了").not.toContain(TEAM_TITLE);
});

test("别的窗口解散了正开着的群，推送到了也回首页", async ({ page }) => {
  await login(page);
  await teamItem(page).click();
  await expect(page.getByTestId("project-page")).toBeVisible();
  const groupId = /\/p\/([^/]+)$/.exec(page.url())?.[1];
  expect(groupId, "项目页网址带群 id").toBeDefined();

  expect((await page.request.post(`/api/groups/${groupId}/archive`)).status()).toBe(204);
  await expect(page).toHaveURL(/\/$/);
  await expect(teamItem(page)).toHaveCount(0);
});

test("牌桌正打着一手时解散，确认框说这手作废，解散后桌也读不到了", async ({ page }) => {
  await login(page);
  const created = await page.request.post("/api/poker/tables", { data: { requestId: `dissolve-${Date.now()}` } });
  expect(created.status(), "建桌成功").toBe(201);
  const { groupId } = PokerTableResponse.parse(await created.json()).table;
  expect((await page.request.post(`/api/poker/tables/${groupId}/hands`)).ok(), "开一手").toBe(true);
  await page.goto(`/p/${groupId}`);
  await expect(page.getByTestId("poker-project")).toBeVisible();

  await page.getByTestId("archive-group").click();
  await expect(page.getByTestId("archive-group-dialog")).toContainText("正在打的这手作废");
  await page.getByTestId("archive-group-confirm").click();
  await expect(page).toHaveURL(/\/$/);
  expect((await page.request.get(`/api/poker/tables/${groupId}`)).status(), "桌跟着群一起没了").toBe(404);
});
