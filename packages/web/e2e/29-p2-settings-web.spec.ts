import { readFile } from "node:fs/promises";
import { ComputerListResponse } from "@baize/shared";
import { expect, login, openSettings, test, SHOT } from "./fixtures";

test("设置只有五个导航项", async ({ page }) => {
  await login(page);
  await openSettings(page);
  await expect(page.locator("[data-testid^=settings-nav-]")).toHaveText([
    "通用",
    "账号与电脑",
    "插件",
    "用量",
    "数据与隐私",
  ]);
  await page.screenshot({ path: `${SHOT}/29a.png` });
});

test("账号按电脑分组，每个号只显示当前那一档", async ({ page }) => {
  await login(page);
  await openSettings(page);
  await page.getByTestId("settings-nav-accounts").click();

  const groups = page.getByTestId("accounts-page").getByTestId("account-group");
  await expect(groups.getByTestId("account-group-head")).toHaveText(["本机在线", "远程电脑 remote.baize.dev在线"]);
  const rows = page.getByTestId("account-row");
  await expect(rows).toHaveCount(4);
  for (const row of await rows.all()) {
    await expect(row.getByTestId("account-tier"), "每个号一枚档位标").toHaveCount(1);
    await expect(row.getByTestId("account-tier-option"), "没点开不列其他档").toHaveCount(0);
  }
  await expect(page.getByTestId("computer-row")).toHaveText(["本机在线", "远程电脑在线"]);
  await expect(page.getByTestId("always-ask")).toContainText(
    "花钱，改密码或绑定手机，授权第三方应用，删除你电脑上的文件",
  );
  await page.screenshot({ path: `${SHOT}/29b.png`, fullPage: true });
});

test("改预算后用量页显示 / 预算 ¥300", async ({ page }) => {
  await login(page);
  await openSettings(page);
  await page.getByTestId("settings-nav-usage").click();
  const usage = page.getByTestId("usage-page");
  await expect(usage.getByTestId("usage-budget")).toHaveText("没设预算");

  await usage.getByTestId("budget-edit").click();
  await usage.getByTestId("budget-input").fill("300");
  const saved = page.waitForResponse(
    (response) => response.url().endsWith("/api/settings") && response.request().method() === "PATCH",
  );
  await usage.getByTestId("budget-save").click();
  expect((await saved).request().postDataJSON(), "预算按元每月写进设置").toEqual({ budget: 300 });
  await expect(usage.getByTestId("usage-budget")).toHaveText("/ 预算 ¥300");
  await expect(usage.getByTestId("usage-meter")).toHaveAttribute("aria-valuemax", "300");

  await page.reload();
  await openSettings(page);
  await page.getByTestId("settings-nav-usage").click();
  await expect(page.getByTestId("usage-budget"), "刷新后预算还在").toHaveText("/ 预算 ¥300");
  await page.screenshot({ path: `${SHOT}/29c.png` });
});

test("点加一台远程电脑后出现 token 只显示一次", async ({ page }) => {
  let paired = false;
  await page.route("**/api/computers", async (route) => {
    const response = await route.fetch();
    const list = ComputerListResponse.parse(await response.json());
    const computers = paired ? list.computers : list.computers.filter((computer) => computer.kind !== "remote");
    await route.fulfill({ response, json: { computers } });
  });
  await login(page);
  await openSettings(page);
  await page.getByTestId("settings-nav-accounts").click();
  await expect(page.getByTestId("computer-row")).toHaveText(["本机在线"]);

  const created = page.waitForResponse(
    (response) => response.url().endsWith("/api/computers/remote") && response.request().method() === "POST",
  );
  paired = true;
  await page.getByTestId("computer-add-remote").click();
  const { token } = (await (await created).json()) as { token: string };
  expect(token.length).toBeGreaterThan(0);
  await expect(page.getByTestId("computer-pairing-token")).toHaveText(token);
  await expect(page.getByTestId("computer-row")).toHaveCount(2);
  await expect(page.getByTestId("computer-add-remote"), "已有远程电脑就不再给按钮，免得换掉在用的 token").toHaveCount(
    0,
  );
  await page.screenshot({ path: `${SHOT}/29d.png` });

  await page.getByTestId("settings-nav-usage").click();
  await page.getByTestId("settings-nav-accounts").click();
  await expect(page.getByTestId("computer-row")).toHaveCount(2);
  await expect(page.getByTestId("computer-pairing"), "离开再回来 token 不再出现").toHaveCount(0);
  await expect(page.getByTestId("settings-window")).not.toContainText(token);
});

test("数据与隐私页导出按钮能下载", async ({ page }) => {
  await login(page);
  await openSettings(page);
  await page.getByTestId("settings-nav-privacy").click();

  const downloading = page.waitForEvent("download");
  await page.getByTestId("privacy-export").click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^baize-export-\d{4}-\d{2}-\d{2}\.json$/);
  const exported = JSON.parse(await readFile(await download.path(), "utf8")) as { user: { email: string } };
  expect(exported.user.email, "导出的是当前账号").toBe("chen@baize.dev");

  await page.getByTestId("privacy-delete").click();
  await page.getByTestId("privacy-delete-email").fill("someone@else.dev");
  await expect(page.getByTestId("privacy-delete-confirm"), "邮箱对不上不让删").toBeDisabled();
  await page.screenshot({ path: `${SHOT}/29e.png` });
});
