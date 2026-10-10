import { expect, test, SHOT, SkillResponse, login, openSeededBot, openSkills } from "./fixtures";

test("存下 Bot 提议的 skill，卡片变已存且小销列表多一条", async ({ page }) => {
  await login(page);
  await openSeededBot(page, "小销");
  const card = page.getByTestId("skill-offer");
  await expect(card).toHaveAttribute("data-status", "offered");
  await expect(card.getByTestId("skill-offer-step")).toHaveCount(3);
  await card.getByTestId("skill-offer-save").click();
  await expect(card).toHaveAttribute("data-status", "saved");
  await expect(card.getByTestId("skill-offer-decided")).toHaveText("已存");
  await expect(card.getByTestId("skill-offer-save")).toHaveCount(0);

  await openSkills(page, "小销");
  await expect(page.getByTestId("skill-row")).toHaveCount(4);
  const saved = page.locator('[data-testid=skill-row][data-skill-name="Initech 报价"]');
  await expect(saved, "列表不露来源").toContainText("用过 0 次");
  await page.screenshot({ path: `${SHOT}/10a.png` });

  await page.reload();
  await openSkills(page, "小销");
  await expect(saved, "刷新后列表仍从服务端读到刚存的 skill").toHaveCount(1);
});

test("会做的活详情改步骤后保存，列表与详情都显示新内容", async ({ page }) => {
  await login(page);
  await openSkills(page, "小销");
  await expect(page.getByTestId("skill-row"), "小销预置三条 skill").toHaveCount(3);
  const quote = page.locator('[data-testid=skill-row][data-skill-name="Globex 报价"]');
  await expect(quote.getByTestId("skill-row-note")).toContainText("存的");
  await quote.getByTestId("skill-open").click();
  await expect(page.getByTestId("skill-step")).toHaveCount(4);
  await page.getByTestId("skill-edit").click();
  await page.getByTestId("skill-steps-input").fill("确认客户与数量\n按最新口径计算折扣\n生成 PDF 等我检查");
  await page.getByTestId("skill-save").click();
  await expect(page.getByTestId("skill-detail").getByTestId("skill-step")).toHaveText([
    "确认客户与数量",
    "按最新口径计算折扣",
    "生成 PDF 等我检查",
  ]);
  await page.screenshot({ path: `${SHOT}/10b.png` });

  await page.reload();
  await openSkills(page, "小销");
  await quote.getByTestId("skill-open").click();
  await expect(page.getByTestId("skill-step")).toHaveText([
    "确认客户与数量",
    "按最新口径计算折扣",
    "生成 PDF 等我检查",
  ]);
});

test("输入斜杠选择 Globex 报价，引用插入输入框", async ({ page }) => {
  await login(page);
  await openSeededBot(page, "小销");
  const input = page.getByTestId("composer-input");
  await input.fill("/");
  await expect(page.getByTestId("skill-menu")).toBeVisible();
  await expect(page.getByTestId("skill-option")).toHaveCount(3);
  await page.locator('[data-testid=skill-option][data-skill-name="Globex 报价"]').click();
  await expect(input).toHaveValue("/Globex 报价 ");
  await expect(page.getByTestId("skill-menu")).toHaveCount(0);
  await page.screenshot({ path: `${SHOT}/10c.png` });
});

test("教小销一个 skill，再复制给小采并删掉原件", async ({ page }) => {
  await login(page);
  await openSkills(page, "小销");
  await page.getByTestId("skill-new").click();
  await expect(page.getByTestId("skill-save"), "名称和步骤都不能为空").toBeDisabled();
  await page.getByTestId("skill-name-input").fill("客户回访清单");
  await page
    .getByTestId("skill-steps-input")
    .fill(Array.from({ length: 21 }, (_, index) => `步骤 ${index + 1}`).join("\n"));
  await expect(page.getByTestId("skill-save"), "最多 20 步").toBeDisabled();
  await page.getByTestId("skill-steps-input").fill("整理本周客户问题\n列出需要跟进的负责人");
  await expect(page.getByTestId("skill-save")).toBeEnabled();
  await page.getByTestId("skill-save").click();
  const taught = page.locator('[data-testid=skill-row][data-skill-name="客户回访清单"]');
  await expect(taught).toContainText("用过 0 次");
  await expect(page.getByTestId("skill-row")).toHaveCount(4);
  await taught.getByTestId("skill-open").click();
  await expect(page.getByTestId("skill-detail").getByTestId("skill-step")).toHaveText([
    "整理本周客户问题",
    "列出需要跟进的负责人",
  ]);
  await page.getByTestId("skill-copy").click();
  await page.locator('[data-testid=skill-copy-option][data-bot-name="小采"]').click();
  await page.screenshot({ path: `${SHOT}/10d.png` });
  await page.getByTestId("skill-delete").click();
  await expect(page.getByTestId("skill-row")).toHaveCount(3);
  await expect(taught).toHaveCount(0);

  await openSkills(page, "小采");
  const copied = page.locator('[data-testid=skill-row][data-skill-name="客户回访清单"]');
  await expect(copied, "新 Bot 的使用次数从零算").toContainText("用过 0 次");
});

test("不存 Bot 的提议，卡片变没存且列表不增加", async ({ page }) => {
  await login(page);
  await openSeededBot(page, "小销");
  const card = page.getByTestId("skill-offer");
  await card.getByTestId("skill-offer-dismiss").click();
  await expect(card).toHaveAttribute("data-status", "dismissed");
  await expect(card.getByTestId("skill-offer-decided")).toHaveText("没存");
  await openSkills(page, "小销");
  await expect(page.getByTestId("skill-row")).toHaveCount(3);
  await page.screenshot({ path: `${SHOT}/10e.png` });
});

test("另一个请求新增和删除 skill，已打开的列表随推送更新", async ({ page }) => {
  await login(page);
  await openSkills(page, "小销");
  await expect(page.getByTestId("skill-row")).toHaveCount(3);
  const created = await page.request.post("/api/bots/bot_sales/skills", {
    data: { name: "外部同步演示", steps: ["先核对客户名称"] },
  });
  expect(created.status()).toBe(201);
  const { skill } = SkillResponse.parse(await created.json());
  const pushed = page.locator('[data-testid=skill-row][data-skill-name="外部同步演示"]');
  await expect(pushed, "没经过本页操作也能收到新增推送").toBeVisible();
  await expect(page.getByTestId("skill-row")).toHaveCount(4);
  await page.screenshot({ path: `${SHOT}/10f.png` });

  const deleted = await page.request.delete(`/api/skills/${skill.id}`);
  expect(deleted.status()).toBe(204);
  await expect(pushed, "没经过本页操作也能收到删除推送").toHaveCount(0);
  await expect(page.getByTestId("skill-row")).toHaveCount(3);
});
