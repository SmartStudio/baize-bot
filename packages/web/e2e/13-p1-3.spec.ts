import { expect, test, login, openBot, openSettings, openTeamGroup } from "./fixtures";

const AUDIT_DIR = process.env.P1_3_AUDIT_DIR;

const WORKSPACE = { kind: "path", computerId: "cmp_local", prefix: "/workspace" } as const;

type Page = Parameters<typeof login>[0];

const postApproval = async (page: Page, data: { action: string; groupId?: string; target: unknown }) => {
  const response = await page.request.post("/api/test/approval", { data: { groupId: "grp_order", ...data } });
  expect(response.ok(), "mock 能创建指定动作的审批").toBe(true);
  return ((await response.json()) as { approval: { id: string } }).approval.id;
};

const addApproval = async (
  page: Page,
  action: string,
  options: { target?: unknown; groupId?: string; open?: (page: Page) => Promise<void> } = {},
) => {
  const target =
    options.target !== undefined
      ? options.target
      : action === "write_workspace" || action === "write_outside"
        ? WORKSPACE
        : null;
  await postApproval(page, { action, target, ...(options.groupId === undefined ? {} : { groupId: options.groupId }) });
  await page.reload();
  await (options.open ?? ((p) => openTeamGroup(p, "Globex X3 × 200 订单")))(page);
  await expect(page.getByTestId("approval-card")).toHaveAttribute("data-status", "pending");
  return page.getByTestId("approval-card");
};

const openGrants = async (page: Page) => {
  await openSettings(page);
  await page.getByTestId("settings-nav-accounts").click();
};

test("spend 审批卡只有这一次和拒绝", async ({ page }) => {
  await login(page);
  await openTeamGroup(page, "Globex X3 × 200 订单");
  const card = await addApproval(page, "spend");

  await expect(card.getByTestId("approval-scope-once")).toBeVisible();
  await expect(card.getByTestId("approval-scope-project")).toHaveCount(0);
  await expect(card.getByTestId("approval-scope-forever")).toHaveCount(0);
  await expect(card.getByTestId("approval-reject")).toBeVisible();
  await expect(card).not.toContainText("spend");
  if (AUDIT_DIR !== undefined) await card.screenshot({ path: `${AUDIT_DIR}/card-spend.png` });
});

test("write_outside 审批卡不显示一直", async ({ page }) => {
  await login(page);
  await openTeamGroup(page, "Globex X3 × 200 订单");
  const card = await addApproval(page, "write_outside");

  await expect(card.getByTestId("approval-scope-once")).toBeVisible();
  await expect(card.getByTestId("approval-scope-project")).toBeVisible();
  await expect(card.getByTestId("approval-scope-forever")).toHaveCount(0);
  if (AUDIT_DIR !== undefined) await card.screenshot({ path: `${AUDIT_DIR}/card-write-outside.png` });
});

test("每个范围的按钮都叫「批准」，范围写成副文案，批完结论是「已批准」", async ({ page }) => {
  await login(page);
  await openTeamGroup(page, "Globex X3 × 200 订单");
  const card = await addApproval(page, "write_workspace");

  await expect(card.getByTestId("approval-scope-once").getByRole("button")).toHaveText("批准仅这一次");
  await expect(card.getByTestId("approval-scope-project").getByRole("button")).toHaveText("批准这个项目里");
  await expect(card.getByTestId("approval-scope-forever").getByRole("button")).toHaveText("批准一直");

  await card.getByTestId("approval-approve").click();
  await expect(card.getByTestId("approval-decided"), "结论和按钮用同一个动词").toHaveText("已批准");
});

test("普通写操作显示三种授权范围", async ({ page }) => {
  await login(page);
  await openTeamGroup(page, "Globex X3 × 200 订单");
  const card = await addApproval(page, "write_workspace");

  await expect(card.getByTestId("approval-scope-once")).toBeVisible();
  await expect(card.getByTestId("approval-scope-project")).toBeVisible();
  await expect(card.getByTestId("approval-scope-forever")).toBeVisible();
  if (AUDIT_DIR !== undefined) await card.screenshot({ path: `${AUDIT_DIR}/card-write-workspace.png` });
});

test("选这个项目里后设置里有授权，撤销后消失", async ({ page }) => {
  await login(page);
  await openTeamGroup(page, "Globex X3 × 200 订单");
  const card = await addApproval(page, "write_workspace");
  await card.getByTestId("approval-scope-project").click();

  await openSettings(page);
  await page.getByTestId("settings-nav-accounts").click();
  const grant = page.getByTestId("grant-row");
  await expect(grant).toContainText("Globex X3 × 200 订单");
  await expect(grant).toContainText("这个项目里");
  if (AUDIT_DIR !== undefined)
    await page.getByTestId("settings-window").screenshot({ path: `${AUDIT_DIR}/grants-mock.png` });
  await grant.getByTestId("grant-revoke").click();
  await expect(grant).toHaveCount(0);
});

test("另一个标签页撤销授权后本页靠推送立即消失", async ({ page, context }) => {
  await login(page);
  await openTeamGroup(page, "Globex X3 × 200 订单");
  const card = await addApproval(page, "write_workspace");
  await card.getByTestId("approval-scope-project").click();
  await openSettings(page);
  await page.getByTestId("settings-nav-accounts").click();
  await expect(page.getByTestId("grant-row")).toHaveCount(1);

  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByTestId("main-window")).toBeVisible();
  await openSettings(other);
  await other.getByTestId("settings-nav-accounts").click();
  await expect(other.getByTestId("grant-row")).toHaveCount(1);
  await other.getByTestId("grant-revoke").click();

  await expect(page.getByTestId("grant-row"), "另一个标签页的撤销通过 grant_deleted 推送同步").toHaveCount(0);
  await other.close();
});

test("暂停和继续只显示当前可用的一个按钮", async ({ page }) => {
  await login(page);
  await openBot(page, "小服");
  await expect(page.getByTestId("bot-pause")).toBeVisible();
  await expect(page.getByTestId("bot-resume")).toHaveCount(0);

  let releasePause = () => {};
  const heldPause = new Promise<void>((resolve) => {
    releasePause = resolve;
  });
  await page.route("**/api/bots/*/pause", async (route) => {
    await heldPause;
    await route.continue();
  });
  await page.getByTestId("bot-pause").click();
  await expect(page.getByTestId("bot-pause"), "接口返回前保留原状态，不做乐观更新").toBeDisabled();
  await expect(page.getByTestId("bot-resume")).toHaveCount(0);
  releasePause();
  await expect(page.getByTestId("bot-resume")).toBeVisible();
  await expect(page.getByTestId("bot-pause")).toHaveCount(0);
  await expect(page.getByTestId("bot-paused-note")).toBeVisible();
  if (AUDIT_DIR !== undefined) await page.getByTestId("bot-panel").screenshot({ path: `${AUDIT_DIR}/pause-mock.png` });

  await page.getByTestId("bot-resume").click();
  await expect(page.getByTestId("bot-pause")).toBeVisible();
  await expect(page.getByTestId("bot-resume")).toHaveCount(0);
});

test("目标为空的运行命令卡只有这一次，点了之后没有新授权", async ({ page }) => {
  await login(page);
  const card = await addApproval(page, "shell", { target: null });

  await expect(card.getByTestId("approval-scope-once")).toBeVisible();
  await expect(card.getByTestId("approval-scope-project"), "没有目标就存不下项目授权，不给这个选项").toHaveCount(0);
  await expect(card.getByTestId("approval-scope-forever"), "没有目标就存不下长期授权，不给这个选项").toHaveCount(0);
  await expect(card.getByTestId("approval-reject")).toBeVisible();

  await card.getByTestId("approval-scope-once").click();
  await expect(card).toHaveAttribute("data-status", "approved");
  await openGrants(page);
  await expect(page.getByTestId("grants-empty"), "批了这一次不留授权").toBeVisible();
  const grants = (await (await page.request.get("/api/grants")).json()) as { grants: unknown[] };
  expect(grants.grants, "服务端也没有多出授权").toEqual([]);
});

test("mock 对存不下的授权范围回 400，不静默成功", async ({ page }) => {
  await login(page);
  const shell = await postApproval(page, { action: "shell", target: null });
  const noTarget = await page.request.post(`/api/approvals/${shell}`, {
    data: { decision: "approved", scope: "forever" },
  });
  expect(noTarget.status(), "目标为空又要一直，回 400").toBe(400);

  const spend = await postApproval(page, { action: "spend", target: { kind: "domain", domain: "pay.example.com" } });
  const notGrantable = await page.request.post(`/api/approvals/${spend}`, {
    data: { decision: "approved", scope: "forever" },
  });
  expect(notGrantable.status(), "付钱只能这一次，要一直回 400").toBe(400);

  const grants = (await (await page.request.get("/api/grants")).json()) as { grants: unknown[] };
  expect(grants.grants, "两次都没写进授权").toEqual([]);
  const once = await page.request.post(`/api/approvals/${shell}`, { data: { decision: "approved", scope: "once" } });
  expect(once.status(), "被拒的请求没有把审批用掉，这一次还能批").toBe(200);
});

test("单 Bot 群里批这个项目里，授权行写 Bot 名，不露群 id", async ({ page }) => {
  await login(page);
  const card = await addApproval(page, "write_workspace", {
    groupId: "grp_sales",
    open: (p) => openBot(p, "小销"),
  });
  await card.getByTestId("approval-scope-project").click();
  await expect(card).toHaveAttribute("data-status", "approved");

  await openGrants(page);
  const grant = page.getByTestId("grant-row");
  await expect(grant).toContainText("这个项目里");
  await expect(grant, "单 Bot 群的项目名就是 Bot 名").toContainText("项目：小销");
  await expect(grant, "群 id 不上屏").not.toContainText("grp_");
});

test("账号目标写这个账号，卡上和授权列表都不露账号 id", async ({ page }) => {
  await login(page);
  const card = await addApproval(page, "publish", { target: { kind: "account", accountId: "acc_today_x" } });
  await expect(card).toContainText("这个账号");
  await expect(card, "卡上不露账号 id").not.toContainText("acc_");

  await card.getByTestId("approval-scope-forever").click();
  await expect(card).toHaveAttribute("data-status", "approved");
  await openGrants(page);
  const grant = page.getByTestId("grant-row");
  await expect(grant).toContainText("这个账号");
  await expect(grant, "授权列表不露账号 id").not.toContainText("acc_");
});

test("撤销失败时行上写没撤掉，按钮解锁能再点", async ({ page }) => {
  await login(page);
  const card = await addApproval(page, "write_workspace");
  await card.getByTestId("approval-scope-forever").click();
  await expect(card).toHaveAttribute("data-status", "approved");
  await openGrants(page);
  const grant = page.getByTestId("grant-row");
  await expect(grant).toHaveCount(1);

  await page.route("**/api/grants/*", (route) =>
    route.request().method() === "DELETE" ? route.fulfill({ status: 500, body: "{}" }) : route.continue(),
  );
  await grant.getByTestId("grant-revoke").click();
  await expect(grant.getByTestId("grant-revoke-error")).toHaveText("没撤掉，再试一次");
  await expect(grant.getByTestId("grant-revoke"), "失败后可以再点").toBeEnabled();

  await page.unroute("**/api/grants/*");
  await grant.getByTestId("grant-revoke").click();
  await expect(grant).toHaveCount(0);
});

test("暂停失败时面板写一句，按钮解锁，状态不变", async ({ page }) => {
  await login(page);
  await openBot(page, "小服");
  await page.route("**/api/bots/*/pause", (route) => route.fulfill({ status: 500, body: "{}" }));
  await page.getByTestId("bot-pause").click();
  await expect(page.getByTestId("bot-run-state-error")).toHaveText("没停下来，再试一次");
  await expect(page.getByTestId("bot-pause")).toBeEnabled();
  await expect(page.getByTestId("bot-resume")).toHaveCount(0);

  await openBot(page, "小销");
  await expect(page.getByTestId("bot-run-state-error"), "换了 Bot 不带上一个的报错").toHaveCount(0);
});

test("Bot 设置存不上时弹提示、开关不变，再点能存上", async ({ page }) => {
  await login(page);
  await openBot(page, "小服");
  const notify = page.getByTestId("bot-notify-switch");
  const before = await notify.getAttribute("aria-checked");
  await page.route("**/api/bots/*", (route) =>
    route.request().method() === "PATCH" ? route.fulfill({ status: 500, body: "{}" }) : route.fallback(),
  );
  await notify.click();
  await expect(page.getByTestId("toast"), "没存上要告诉人").toHaveText("Bot 设置没存上，再试一次");
  await expect(notify, "没存上就不改开关").toHaveAttribute("aria-checked", before ?? "");

  await page.unroute("**/api/bots/*");
  await notify.click();
  await expect(notify, "再点一次存上了").not.toHaveAttribute("aria-checked", before ?? "");
});
