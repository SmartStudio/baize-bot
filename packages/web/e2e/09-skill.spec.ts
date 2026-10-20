import type { SkillChange } from "@baize/shared";
import type { z } from "zod";
import {
  expect,
  test,
  SHOT,
  SkillResponse,
  login,
  openBot,
  openSeededBot,
  openSkills,
  skillRow,
  type Page,
} from "./fixtures";

const offerCard = async (page: Page, change: z.input<typeof SkillChange>) => {
  const sent = await page.request.post("/api/test/skill-offer", {
    data: { groupId: "grp_sales", botId: "bot_sales", change },
  });
  expect(sent.status()).toBe(204);
  // 小销群里本来就有一张存技能的卡，新造的那张在最后。
  const card = page.locator(`[data-testid=skill-offer][data-op=${change.op}]`).last();
  await expect(card).toBeVisible();
  return card;
};

test("存下 Bot 提议的 skill，卡片变已存且「它知道的」多一条", async ({ page }) => {
  await login(page);
  await openSeededBot(page, "小销");
  const card = page.getByTestId("skill-offer");
  await expect(card).toHaveAttribute("data-status", "offered");
  await expect(card.getByTestId("skill-offer-title")).toHaveText("存成技能「Initech 报价」？");
  await expect(card.getByTestId("skill-offer-step")).toHaveCount(3);
  await card.getByTestId("skill-offer-save").click();
  await expect(card).toHaveAttribute("data-status", "saved");
  await expect(card.getByTestId("skill-offer-decided")).toHaveText("已存");
  await expect(card.getByTestId("skill-offer-save")).toHaveCount(0);

  await page.getByTestId("bot-know-toggle").click();
  await expect(page.getByTestId("bot-know-toggle")).toContainText("会 4 件事");
  const saved = skillRow(page, "Initech 报价");
  await saved.getByTestId("bot-skill-toggle").click();
  await expect(saved.getByTestId("bot-skill-meta")).toHaveText("对话里存的 · 用过 0 次");
  await page.screenshot({ path: `${SHOT}/10a.png` });

  await page.reload();
  await openSkills(page, "小销");
  await expect(skillRow(page, "Initech 报价"), "刷新后仍从服务端读到刚存的 skill").toHaveCount(1);
});

test("「它知道的」里点开技能，看到编号步骤、来源和用过几次，没有改删入口", async ({ page }) => {
  await login(page);
  await openSkills(page, "小销");
  await expect(page.getByTestId("bot-skill"), "小销预置三条 skill").toHaveCount(3);
  await expect(page.getByTestId("bot-skills-hint")).toHaveText("想加、想改、想删，直接跟它说");

  const quote = skillRow(page, "Globex 报价");
  const toggle = quote.getByTestId("bot-skill-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(quote.getByTestId("bot-skill-step"), "收着时不列步骤").toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(quote.getByTestId("bot-skill-step")).toHaveText([
    "在 ERP 按客户建报价单",
    "折扣沿用上季度口径，不确定时问你",
    "生成 PDF，附上保修条款",
    "发邮件前停下等你点头",
  ]);
  await expect(quote.getByTestId("bot-skill-meta")).toHaveText("对话里存的 · 用过 3 次");

  const digest = skillRow(page, "线索跟进早报");
  await digest.getByTestId("bot-skill-toggle").click();
  await expect(digest.getByTestId("bot-skill-meta")).toHaveText("例行里存的 · 用过 21 次");
  const contract = skillRow(page, "合同条款比对");
  await contract.getByTestId("bot-skill-toggle").click();
  await expect(contract.getByTestId("bot-skill-meta")).toHaveText("你教的 · 用过 1 次");
  await page.screenshot({ path: `${SHOT}/10b.png` });

  const skills = page.getByTestId("bot-know-skills");
  for (const word of ["新建", "教它", "编辑", "删掉", "复制"]) {
    await expect(skills.getByRole("button", { name: word }), `没有「${word}」按钮`).toHaveCount(0);
  }
  await toggle.click();
  await expect(quote.getByTestId("bot-skill-step"), "再点一下收起").toHaveCount(0);
});

test("没有技能的 Bot 在「它知道的」里说怎么让它学", async ({ page }) => {
  await login(page);
  await openSkills(page, "小采");
  await expect(page.getByTestId("bot-skills-empty")).toHaveText(
    "还没存会做的事。跟它说「把刚才的做法存成技能」，或「去找个做周报的技能装上」",
  );
  await expect(page.getByTestId("bot-skills-hint")).toHaveCount(0);
});

test("从 GitHub 装技能的卡列出来源和全部步骤，点装后「它知道的」写着从哪装的", async ({ page }) => {
  const origin = "https://github.com/anthropics/skills/blob/main/weekly-report/SKILL.md";
  await login(page);
  await openSeededBot(page, "小销");
  const card = await offerCard(page, {
    op: "add",
    name: "周报",
    steps: ["收集本周完成的事", "按项目分组写成三段", "发我过目"],
    origin,
  });
  await expect(card.getByTestId("skill-offer-title")).toHaveText("从 github.com 装技能「周报」？");
  const source = card.getByTestId("skill-offer-source");
  await expect(source).toHaveAttribute("href", origin);
  await expect(source).toHaveAttribute("rel", "noreferrer");
  await expect(source).toHaveAttribute("target", "_blank");
  await expect(card.getByTestId("skill-offer-step")).toHaveText(["收集本周完成的事", "按项目分组写成三段", "发我过目"]);
  await expect(card.getByTestId("skill-offer-dismiss")).toHaveText("不存");
  await card.getByTestId("skill-offer-save").click();
  await expect(card).toHaveAttribute("data-status", "saved");
  await expect(card.getByTestId("skill-offer-decided")).toHaveText("已存");
  await page.screenshot({ path: `${SHOT}/10d.png` });

  await page.getByTestId("bot-know-toggle").click();
  const installed = skillRow(page, "周报");
  await installed.getByTestId("bot-skill-toggle").click();
  await expect(installed.getByTestId("bot-skill-meta")).toHaveText("从 github.com 装的 · 用过 0 次");
  const link = installed.getByTestId("bot-skill-origin");
  await expect(link).toHaveAttribute("href", origin);
  await expect(link).toHaveAttribute("rel", "noreferrer");
  await expect(link).toHaveAttribute("target", "_blank");
});

test("改技能的卡写出改名前后，点改后「它知道的」里名字和步骤都换了，用过几次留着", async ({ page }) => {
  await login(page);
  await openSeededBot(page, "小销");
  const card = await offerCard(page, {
    op: "edit",
    targetId: "skl_quote",
    fromName: "Globex 报价",
    name: "Globex 报价单",
    steps: ["确认客户与数量", "按最新口径计算折扣", "生成 PDF 等我检查"],
  });
  await expect(card.getByTestId("skill-offer-title")).toHaveText("改技能「Globex 报价」→「Globex 报价单」？");
  await expect(card.getByTestId("skill-offer-step")).toHaveCount(3);
  await expect(card.getByTestId("skill-offer-dismiss")).toHaveText("不改");
  await expect(card.getByTestId("skill-offer-save")).toHaveText("改");
  await card.getByTestId("skill-offer-save").click();
  await expect(card).toHaveAttribute("data-status", "saved");
  await expect(card.getByTestId("skill-offer-decided")).toHaveText("已改");

  await page.getByTestId("bot-know-toggle").click();
  await expect(skillRow(page, "Globex 报价"), "旧名字不在了").toHaveCount(0);
  const edited = skillRow(page, "Globex 报价单");
  await edited.getByTestId("bot-skill-toggle").click();
  await expect(edited.getByTestId("bot-skill-step")).toHaveText([
    "确认客户与数量",
    "按最新口径计算折扣",
    "生成 PDF 等我检查",
  ]);
  await expect(edited.getByTestId("bot-skill-meta")).toHaveText("对话里存的 · 用过 3 次");
});

test("改完以后历史卡仍显示旧名到新名，刷新后也一样", async ({ page }) => {
  await login(page);
  await openSeededBot(page, "小销");
  const card = await offerCard(page, {
    op: "edit",
    targetId: "skl_quote",
    fromName: "Globex 报价",
    name: "Globex 报价单",
    steps: ["确认客户与数量", "生成 PDF 等我检查"],
  });
  await card.getByTestId("skill-offer-save").click();
  await expect(card).toHaveAttribute("data-status", "saved");
  await expect(card.getByTestId("skill-offer-title"), "技能已经改名，卡上照旧写改之前的名字").toHaveText(
    "改技能「Globex 报价」→「Globex 报价单」？",
  );

  await page.reload();
  const history = page.locator("[data-testid=skill-offer][data-op=edit]").last();
  await expect(history).toHaveAttribute("data-status", "saved");
  await expect(history.getByTestId("skill-offer-title"), "刷新后历史卡仍读得出改的是哪条").toHaveText(
    "改技能「Globex 报价」→「Globex 报价单」？",
  );
});

test("改技能的卡点不改，技能原样", async ({ page }) => {
  await login(page);
  await openSeededBot(page, "小销");
  const card = await offerCard(page, {
    op: "edit",
    targetId: "skl_quote",
    fromName: "Globex 报价",
    name: "Globex 报价",
    steps: ["确认客户与数量", "生成 PDF 等我检查"],
  });
  await expect(card.getByTestId("skill-offer-title"), "没改名只写一个名字").toHaveText("改技能「Globex 报价」？");
  await card.getByTestId("skill-offer-dismiss").click();
  await expect(card).toHaveAttribute("data-status", "dismissed");
  await expect(card.getByTestId("skill-offer-decided")).toHaveText("没改");

  await page.getByTestId("bot-know-toggle").click();
  const quote = skillRow(page, "Globex 报价");
  await quote.getByTestId("bot-skill-toggle").click();
  await expect(quote.getByTestId("bot-skill-step")).toHaveCount(4);
});

test("删技能的卡不列步骤，点删掉后「它知道的」少一条", async ({ page }) => {
  await login(page);
  await openSeededBot(page, "小销");
  const card = await offerCard(page, { op: "remove", targetId: "skl_contract_diff", name: "合同条款比对" });
  await expect(card.getByTestId("skill-offer-title")).toHaveText("删掉技能「合同条款比对」？");
  await expect(card.getByTestId("skill-offer-step")).toHaveCount(0);
  await expect(card.getByTestId("skill-offer-dismiss")).toHaveText("留着");
  await expect(card.getByTestId("skill-offer-save")).toHaveText("删掉");
  await page.getByTestId("bot-know-toggle").click();
  await expect(page.getByTestId("bot-know-toggle")).toContainText("会 3 件事");

  await card.getByTestId("skill-offer-save").click();
  await expect(card).toHaveAttribute("data-status", "saved");
  await expect(card.getByTestId("skill-offer-decided")).toHaveText("已删");
  await expect(skillRow(page, "合同条款比对")).toHaveCount(0);
  await expect(page.getByTestId("bot-know-toggle")).toContainText("会 2 件事");
  await page.screenshot({ path: `${SHOT}/10e.png` });
});

test("删技能的卡点留着，技能还在", async ({ page }) => {
  await login(page);
  await openSeededBot(page, "小销");
  const card = await offerCard(page, { op: "remove", targetId: "skl_contract_diff", name: "合同条款比对" });
  await card.getByTestId("skill-offer-dismiss").click();
  await expect(card).toHaveAttribute("data-status", "dismissed");
  await expect(card.getByTestId("skill-offer-decided")).toHaveText("留着");
  await page.getByTestId("bot-know-toggle").click();
  await expect(skillRow(page, "合同条款比对")).toHaveCount(1);
});

test("要改的技能已经被删了，点改说技能不在了，卡留着", async ({ page }) => {
  await login(page);
  await openSeededBot(page, "小销");
  const card = await offerCard(page, {
    op: "edit",
    targetId: "skl_lead_digest",
    fromName: "线索跟进早报",
    name: "线索早报",
    steps: ["拉昨天的线索", "汇总发我"],
  });
  expect((await page.request.delete("/api/skills/skl_lead_digest")).status()).toBe(204);
  await card.getByTestId("skill-offer-save").click();
  await expect(card.getByTestId("skill-offer-error")).toContainText("这个技能已经不在了");
  await expect(card).toHaveAttribute("data-status", "offered");
  await expect(card.getByTestId("skill-offer-save"), "卡留着可以再点").toBeEnabled();
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

test("不存 Bot 的提议，卡片变没存且技能数不变", async ({ page }) => {
  await login(page);
  await openSeededBot(page, "小销");
  const card = page.getByTestId("skill-offer");
  await card.getByTestId("skill-offer-dismiss").click();
  await expect(card).toHaveAttribute("data-status", "dismissed");
  await expect(card.getByTestId("skill-offer-decided")).toHaveText("没存");
  await page.getByTestId("bot-know-toggle").click();
  await expect(page.getByTestId("bot-skill")).toHaveCount(3);
});

test("另一个请求新增和删除 skill，已展开的「它知道的」随推送更新", async ({ page }) => {
  await login(page);
  await openSkills(page, "小销");
  await expect(page.getByTestId("bot-skill")).toHaveCount(3);
  const created = await page.request.post("/api/bots/bot_sales/skills", {
    data: { name: "外部同步演示", steps: ["先核对客户名称"] },
  });
  expect(created.status()).toBe(201);
  const { skill } = SkillResponse.parse(await created.json());
  const pushed = skillRow(page, "外部同步演示");
  await expect(pushed, "没经过本页操作也能收到新增推送").toBeVisible();
  await expect(page.getByTestId("bot-skill")).toHaveCount(4);
  await page.screenshot({ path: `${SHOT}/10f.png` });

  const deleted = await page.request.delete(`/api/skills/${skill.id}`);
  expect(deleted.status()).toBe(204);
  await expect(pushed, "没经过本页操作也能收到删除推送").toHaveCount(0);
  await expect(page.getByTestId("bot-skill")).toHaveCount(3);
});

test("右侧设置栏没有技能入口，也没有标签导航", async ({ page }) => {
  await login(page);
  await openBot(page, "小销");
  const panel = page.getByTestId("bot-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("tablist")).toHaveCount(0);
  await expect(panel.getByRole("tab")).toHaveCount(0);
  for (const word of ["会做的活", "教它一个", "技能"]) {
    await expect(panel, `设置栏不出现「${word}」`).not.toContainText(word);
  }
});
