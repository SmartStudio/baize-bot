import { expect, login, openTools, test, toolCard } from "./fixtures";

const IMPORTED = "待授权插件";

test("导入的插件卡上显示待授权，补完授权后消失", async ({ page }) => {
  await login(page);
  const imported = await page.request.post("/api/bots/import", {
    data: {
      template: {
        format: 1,
        name: "待授权小助",
        tags: [],
        description: "",
        skills: [],
        plugins: [
          {
            name: IMPORTED,
            url: "https://pending.example.com/mcp",
            operations: [{ name: "lookup", needsApproval: false }],
          },
        ],
        preferences: [],
      },
    },
  });
  expect(imported.status()).toBe(201);
  await page.reload();
  await expect(page.getByTestId("main-window")).toBeVisible();

  await openTools(page);
  const card = toolCard(page, IMPORTED);
  await expect(card.getByTestId("tool-status")).toHaveText("待授权");
  await expect(card.getByTestId("tool-pending")).toContainText("点开填授权，或无凭据再试");
  await expect(toolCard(page, "邮箱").getByTestId("tool-status"), "自己接的连接不标待授权").toHaveCount(0);

  await card.getByTestId("tool-authorize-open").click();
  await card.getByTestId("tool-authorization-patch").fill("Bearer sk-p2-status");
  await card.getByTestId("tool-authorize-save").click();
  await expect(card.getByTestId("tool-status"), "补完授权就不显示待授权").toHaveCount(0);
  await expect(card.getByTestId("tool-pending")).toHaveCount(0);
});
