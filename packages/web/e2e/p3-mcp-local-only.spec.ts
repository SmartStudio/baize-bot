import { BotTemplate, CreateBotResponse, ToolListResponse } from "@baize/shared";
import { expect, fillTool, login, openTools, test, toolCard } from "./fixtures";

test("新插件默认供本机与远程电脑使用，勾选只在本机后创建并保留", async ({ page }) => {
  await login(page);
  await openTools(page);
  const toggle = page.getByTestId("tool-create-local-only-switch");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("tool-create-form")).toContainText(
    "凭据只发给这台 Mac，远程电脑上的 Bot 用不了这个插件",
  );
  await toggle.click();
  const sent = page.waitForRequest((request) => request.url().endsWith("/api/tools") && request.method() === "POST");
  await fillTool(page, "本机插件", "https://local.example.com/mcp");
  expect((await sent).postDataJSON()).toMatchObject({ localOnly: true });
  const card = toolCard(page, "本机插件");
  await expect(card.getByTestId("tool-local-only-status")).toHaveText("只在本机用");
  await expect(card.getByTestId("tool-local-only-switch")).toHaveAttribute("aria-checked", "true");
  await expect(toggle, "创建成功后恢复新连接默认值").toHaveAttribute("aria-checked", "false");

  await page.reload();
  await openTools(page);
  await expect(card.getByTestId("tool-local-only-status"), "收起的卡片也能看出保存后的范围").toHaveText("只在本机用");
  await expect(card.getByTestId("tool-details")).toHaveCount(0);
  await card.getByTestId("tool-edit-assignment").click();
  await expect(card.getByTestId("tool-local-only-switch")).toHaveAttribute("aria-checked", "true");
});

test("卡上的只在本机开关双向写入 PATCH，刷新后保留", async ({ page }) => {
  await login(page);
  await openTools(page);
  const card = toolCard(page, "工单系统");
  await expect(card.getByTestId("tool-local-only-status")).toHaveText("本机与远程电脑可用");
  await card.getByTestId("tool-edit-assignment").click();
  const toggle = card.getByTestId("tool-local-only-switch");
  const enabled = page.waitForRequest(
    (request) => request.url().endsWith("/api/tools/tool_tickets") && request.method() === "PATCH",
  );
  await toggle.click();
  expect((await enabled).postDataJSON()).toEqual({ localOnly: true });
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  await page.reload();
  await openTools(page);
  await expect(card.getByTestId("tool-local-only-status")).toHaveText("只在本机用");
  await card.getByTestId("tool-edit-assignment").click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  const disabled = page.waitForRequest(
    (request) => request.url().endsWith("/api/tools/tool_tickets") && request.method() === "PATCH",
  );
  await toggle.click();
  expect((await disabled).postDataJSON()).toEqual({ localOnly: false });
  await expect(card.getByTestId("tool-local-only-status")).toHaveText("本机与远程电脑可用");

  await page.reload();
  await openTools(page);
  await card.getByTestId("tool-edit-assignment").click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
});

test("开关保存失败时保留原范围，375px 展开的插件页没有横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);
  await openTools(page);
  const card = toolCard(page, "工单系统");
  await card.getByTestId("tool-edit-assignment").click();
  await page.route("**/api/tools/tool_tickets", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await route.fulfill({ status: 500, json: { error: "插件保存失败" } });
  });
  await card.getByTestId("tool-local-only-switch").click();
  await expect(card.getByRole("alert")).toHaveText("插件保存失败");
  await expect(card.getByTestId("tool-local-only-switch")).toHaveAttribute("aria-checked", "false");
  await expect(card.getByTestId("tool-local-only-switch")).toBeEnabled();
  await expect(card.getByTestId("tool-local-only-status")).toHaveText("本机与远程电脑可用");
  expect(await page.getByTestId("tools-page").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );
  expect(await page.locator(".settings").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("本机插件导出后再导入，新连接统一供本机与远程电脑使用", async ({ page }) => {
  await login(page);
  const updated = await page.request.patch("/api/tools/tool_tickets", { data: { localOnly: true } });
  expect(updated.status()).toBe(200);
  const exported = await page.request.post("/api/bots/bot_service/template", {
    data: { skills: false, plugins: true, preferences: false },
  });
  expect(exported.status()).toBe(200);
  const template = BotTemplate.parse(await exported.json());
  const imported = await page.request.post("/api/bots/import", {
    data: { template: { ...template, name: "分享小助" } },
  });
  expect(imported.status()).toBe(201);
  const created = CreateBotResponse.parse(await imported.json());
  const connections = ToolListResponse.parse(await (await page.request.get("/api/tools")).json());
  expect(connections.items.find((tool) => tool.id === "tool_tickets")?.localOnly, "原连接仍只在本机用").toBe(true);
  const importedConnections = connections.items.filter((tool) => tool.assignedBotIds.includes(created.bot.id));
  expect(importedConnections).toHaveLength(2);
  expect(
    importedConnections.map((tool) => tool.localOnly),
    "分享导入不沿用原连接的本机范围",
  ).toEqual([false, false]);
  await page.reload();
  await openTools(page);
  const card = toolCard(page, "工单系统").filter({ hasText: "分享小助 在用" });
  await expect(card.getByTestId("tool-local-only-status")).toHaveText("本机与远程电脑可用");
  await card.getByTestId("tool-authorize-open").click();
  await expect(card.getByTestId("tool-local-only-switch")).toHaveAttribute("aria-checked", "false");
});
