import { expect, login, teamItem, test, type Page } from "./fixtures";

const toggleSecond = async (page: Page) => {
  const saved = page.waitForResponse((res) => res.url().includes("/api/tasks/") && res.request().method() === "PATCH");
  await page.getByTestId("checklist-item").nth(1).click();
  await saved;
};

const backToProject = async (page: Page) => {
  await teamItem(page).click();
  await expect(page.getByTestId("project-page")).toBeVisible();
};

test("群里勾掉一项，项目页本周变化多一句「本周勾掉 1 项」；取消勾选这句就没了", async ({ page }) => {
  await login(page);
  await backToProject(page);
  await expect(page.getByTestId("project-week"), "预置的清单一项没勾，也没发过东西").toHaveCount(0);

  await page.getByTestId("project-open-group").click();
  await toggleSecond(page);
  await expect(page.getByTestId("checklist-item").nth(1)).toBeChecked();

  await backToProject(page);
  await expect(page.getByTestId("project-progress")).toContainText("1 / 5 项");
  await expect(page.getByTestId("project-week"), "进度条后面跟着本周勾掉几项").toHaveText(["本周勾掉 1 项"]);

  await page.getByTestId("project-open-group").click();
  await toggleSecond(page);
  await expect(page.getByTestId("checklist-item").nth(1)).not.toBeChecked();

  await backToProject(page);
  await expect(page.getByTestId("project-progress")).toContainText("0 / 5 项");
  await expect(page.getByTestId("project-week"), "取消勾选清掉勾选时刻，不再算进本周").toHaveCount(0);
});
