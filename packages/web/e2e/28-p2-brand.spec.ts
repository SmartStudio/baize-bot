import { BrandResponse, type Draft, type Grant } from "@baize/shared";
import type { Route } from "@playwright/test";
import { expect, test, login, type Page } from "./fixtures";

const REPLY_TEXT = "能接。飞书的审批和群消息都能进白泽，私信我发你接入文档。";
const MY_REPLY = "能接，飞书审批和群消息都能进白泽。接入文档我私信发你。";
const VOICE = "像老同事聊天，先说结论，不用感叹号。";

const dialog = (page: Page) => page.getByTestId("brand-dialog");
const editRows = (page: Page) => dialog(page).getByTestId("brand-edit");

const openBrandFromTeam = async (page: Page) => {
  await page.getByTestId("team-nav").click();
  await page.getByTestId("team-page").getByTestId("brand-open").click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page), "手册读回来之前不让改").toHaveAttribute("data-state", "ready");
};

const openAssistant = async (page: Page) => {
  await page.getByTestId("assistant-nav").click();
  await expect(page.getByTestId("chat-title")).toHaveText("主助理");
};

const replyCard = (page: Page) =>
  page.getByTestId("message-list").getByTestId("draft-card").filter({ hasText: "阿杰的车间" });

const brandOnServer = async (page: Page) =>
  BrandResponse.parse(await (await page.request.get("/api/brand")).json()).brand;

test("团队页打开品牌手册改口吻后保存，重开还在", async ({ page }) => {
  await login(page);
  await openBrandFromTeam(page);
  await dialog(page).getByTestId("brand-voice").fill(VOICE);
  await dialog(page).getByTestId("brand-save").click();
  await expect(dialog(page), "存上就关").toHaveCount(0);
  expect((await brandOnServer(page))?.voice, "整本落到控制面").toBe(VOICE);

  await page.getByTestId("team-page").getByTestId("brand-open").click();
  await expect(dialog(page).getByTestId("brand-voice")).toHaveValue(VOICE);
  await dialog(page).getByTestId("brand-close").click();

  await page.reload();
  await openBrandFromTeam(page);
  await expect(dialog(page).getByTestId("brand-voice"), "刷新整页后读回来还是它").toHaveValue(VOICE);
});

test("批一条改过字的草稿后手册的改动列表多一条", async ({ page }, testInfo) => {
  await login(page);
  await openBrandFromTeam(page);
  await expect(editRows(page)).toHaveCount(0);
  await expect(dialog(page).getByTestId("brand-edits-empty")).toBeVisible();
  await dialog(page).getByTestId("brand-close").click();

  await openAssistant(page);
  const reply = replyCard(page);
  await reply.getByTestId("draft-editor").fill(MY_REPLY);
  await reply.getByTestId("brand-hint").getByRole("button", { name: "品牌手册" }).click();
  await expect(dialog(page), "草稿卡上那行提示点得进手册").toBeVisible();
  await dialog(page).getByTestId("brand-close").click();
  await expect(reply.getByTestId("draft-editor"), "开关手册不丢草稿上改的字").toHaveValue(MY_REPLY);
  await reply.getByTestId("draft-approve").click();
  await expect(reply).toHaveAttribute("data-status", "approved");

  await openBrandFromTeam(page);
  await expect(editRows(page)).toHaveCount(1);
  await expect(editRows(page).first().getByTestId("brand-edit-before")).toHaveText(REPLY_TEXT);
  await expect(editRows(page).first().getByTestId("brand-edit-after")).toHaveText(MY_REPLY);
  await expect(dialog(page).getByTestId("brand-edits-empty")).toHaveCount(0);
  await editRows(page).first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("brand-dialog.png") });
});

test("删掉一条改过的地方，保存后重开不再有", async ({ page }) => {
  await login(page);
  await openAssistant(page);
  const reply = replyCard(page);
  await reply.getByTestId("draft-editor").fill(MY_REPLY);
  await reply.getByTestId("draft-approve").click();
  await expect(reply).toHaveAttribute("data-status", "approved");

  await openBrandFromTeam(page);
  await expect(editRows(page)).toHaveCount(1);
  await editRows(page).first().getByTestId("brand-edit-remove").click();
  await expect(editRows(page), "点删先从列表里拿掉").toHaveCount(0);
  await dialog(page).getByTestId("brand-save").click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await brandOnServer(page))?.edits, "保存时少传这一条").toEqual([]);

  await page.getByTestId("team-page").getByTestId("brand-open").click();
  await expect(dialog(page)).toHaveAttribute("data-state", "ready");
  await expect(editRows(page)).toHaveCount(0);
});

test("超长时保存按钮不可点并说明上限", async ({ page }) => {
  await login(page);
  await openBrandFromTeam(page);
  await dialog(page).getByTestId("brand-facts").fill("厂".repeat(7990));
  await dialog(page).getByTestId("brand-voice").fill("短句".repeat(5));
  await expect(dialog(page).getByTestId("brand-save"), "四段合计 8000 字正好能存").toBeEnabled();
  await expect(dialog(page).getByTestId("brand-too-long")).toHaveCount(0);

  await dialog(page).getByTestId("brand-taboo").fill("不");
  await expect(dialog(page).getByTestId("brand-save")).toBeDisabled();
  await expect(dialog(page).getByTestId("brand-too-long")).toHaveText(
    "四段加起来最多 8000 字，现在 8001 字，删短一些再存",
  );
  expect(await brandOnServer(page), "没存过就还是没有手册").toBeNull();
});

const EMPTY_BOOK = { facts: "", voice: "", taboo: "", assetsDir: null, edits: [], version: 0 };

const putBrand = async (page: Page, body: object) => {
  const response = await page.request.put("/api/brand", { data: { ...EMPTY_BOOK, ...body } });
  expect(response.status(), "直接写手册").toBe(200);
  const brand = BrandResponse.parse(await response.json()).brand;
  if (brand === null) throw new Error("写完手册还是空");
  return brand;
};

type Observed = { brand: { version: number } | null; content: { drafts: Record<string, Draft> } };
const observed = (page: Page) =>
  page.evaluate(() => (window as Window & { __baizeState?: Observed }).__baizeState as Observed);

const focusInDialog = (page: Page) =>
  page.evaluate(() => document.activeElement?.closest("[data-testid=brand-dialog]") !== null);

/** 扣住下一次 GET /api/brand，等测试放行再回。 */
const holdBrandGet = async (page: Page, reply: (route: Route) => Promise<void>) => {
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let arrived = () => {};
  const asked = new Promise<void>((resolve) => (arrived = resolve));
  await page.route("**/api/brand", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    arrived();
    await released;
    await reply(route);
  });
  return { asked, release };
};

test("草稿推送换了正文，开着的手册不关，没存的口吻还在", async ({ page }) => {
  await login(page);
  await openAssistant(page);
  const reply = replyCard(page);
  await reply.getByTestId("draft-editor").fill(MY_REPLY);
  await reply.getByTestId("brand-hint").getByRole("button", { name: "品牌手册" }).click();
  await expect(dialog(page)).toHaveAttribute("data-state", "ready");
  await dialog(page).getByTestId("brand-voice").fill(VOICE);

  const draft = Object.values((await observed(page)).content.drafts).find(
    (item) => item.content.kind === "reply" && item.content.text === REPLY_TEXT,
  );
  if (draft === undefined) throw new Error("没找到阿杰的车间那条回复稿");
  const revised = await page.request.post(`/api/test/drafts/${draft.id}/revise`, { data: { text: "Bot 换过的正文" } });
  expect(revised.status()).toBe(204);
  await expect(reply.getByTestId("draft-editor"), "草稿卡收到新正文").toHaveValue("Bot 换过的正文");
  await expect(reply.getByTestId("brand-hint"), "改字作废，提示行跟着收起").toHaveCount(0);

  await expect(dialog(page), "手册不跟着提示行一起关").toHaveAttribute("data-state", "ready");
  await expect(dialog(page).getByTestId("brand-voice"), "没存的口吻还在").toHaveValue(VOICE);
  await dialog(page).getByTestId("brand-save").click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await brandOnServer(page))?.voice).toBe(VOICE);
});

test("手册还在读和读失败时焦点都在弹窗里，关掉回到入口", async ({ page }) => {
  await login(page);
  const held = await holdBrandGet(page, (route) => route.fulfill({ status: 500, json: { error: "故障" } }));
  await page.getByTestId("team-nav").click();
  await page.getByTestId("team-page").getByTestId("brand-open").click();
  await held.asked;
  await expect(dialog(page)).toHaveAttribute("data-state", "loading");
  expect(await focusInDialog(page), "读的时候焦点进弹窗").toBe(true);
  await page.keyboard.press("Tab");
  expect(await focusInDialog(page), "读的时候 Tab 出不去").toBe(true);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  expect(await focusInDialog(page), "读的时候反向 Tab 也出不去").toBe(true);

  held.release();
  await expect(dialog(page).getByTestId("brand-load-error")).toBeVisible();
  expect(await focusInDialog(page), "读失败焦点还在弹窗里").toBe(true);
  await page.keyboard.press("Tab");
  expect(await focusInDialog(page), "读失败 Tab 出不去").toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByTestId("team-page").getByTestId("brand-open"), "关掉焦点回到入口").toBeFocused();

  await page.unroute("**/api/brand");
  await page.getByTestId("team-page").getByTestId("brand-open").click();
  await expect(dialog(page)).toHaveAttribute("data-state", "ready");
  await expect(dialog(page).getByTestId("brand-facts"), "读回来焦点进第一段").toBeFocused();
  await dialog(page).getByTestId("brand-close").click();
  await expect(page.getByTestId("team-page").getByTestId("brand-open"), "点关闭也回到入口").toBeFocused();
});

test("改动里的长英文不撑破弹窗，原文换行照样分行", async ({ page }) => {
  await login(page);
  await putBrand(page, {
    edits: [
      { draftId: "drf_long", before: "A".repeat(4000), after: "first line\nsecond line", at: new Date().toISOString() },
    ],
  });
  await openBrandFromTeam(page);
  await expect(editRows(page)).toHaveCount(1);
  const sizes = await page.evaluate(() => {
    const form = document.querySelector(".brand-dialog") as HTMLElement;
    const row = document.querySelector("[data-testid=brand-edit]") as HTMLElement;
    return { form: form.scrollWidth - form.clientWidth, row: row.scrollWidth - row.clientWidth };
  });
  expect(sizes, "弹窗和改动行都没有横向溢出").toEqual({ form: 0, row: 0 });
  const after = editRows(page).first().getByTestId("brand-edit-after");
  const lineHeight = await after.evaluate((node) => parseFloat(getComputedStyle(node).lineHeight));
  const height = (await after.boundingBox())?.height ?? 0;
  expect(height, "两行原文占两行高").toBeGreaterThanOrEqual(lineHeight * 2 - 1);
  await expect(editRows(page).first().getByTestId("brand-edit-remove"), "删除按钮还在视野里").toBeInViewport();
});

test("素材文件夹换了才给本机建一条永久读授权", async ({ page }) => {
  await login(page);
  const grantsNow = async () => ((await (await page.request.get("/api/grants")).json()) as { grants: Grant[] }).grants;
  const read = (prefix: string) => ({
    scope: "forever",
    action: "read",
    target: { kind: "path", computerId: "cmp_local", prefix },
  });
  const before = await grantsNow();
  const first = await putBrand(page, { assetsDir: "/tmp/品牌素材" });
  const added = (await grantsNow()).filter((grant) => !before.some((old) => old.id === grant.id));
  expect(added, "设了素材文件夹，多一条本机读授权").toEqual([expect.objectContaining(read("/tmp/品牌素材"))]);

  const [grant] = added;
  if (grant === undefined) throw new Error("没建出授权");
  expect((await page.request.delete(`/api/grants/${grant.id}`)).status()).toBeLessThan(300);
  const second = await putBrand(page, { assetsDir: "/tmp/品牌素材", voice: "只改口吻", version: first.version });
  expect(await grantsNow(), "文件夹没换，删掉的授权不被一次无关的保存建回来").toEqual(before);

  await putBrand(page, { assetsDir: "/tmp/新素材", version: second.version });
  expect(
    (await grantsNow()).filter((item) => !before.some((old) => old.id === item.id)),
    "换了文件夹，给新路径建一条",
  ).toEqual([expect.objectContaining(read("/tmp/新素材"))]);
});

test("开窗时那次读回来得晚，比手上旧就不拿它填表", async ({ page }) => {
  await login(page);
  const first = await putBrand(page, { voice: "旧口吻" });
  await expect.poll(async () => (await observed(page)).brand?.version, "推送先送到旧口吻那本").toBe(first.version);
  const held = await holdBrandGet(page, (route) => route.fulfill({ status: 200, json: { brand: first } }));
  await page.getByTestId("team-nav").click();
  await page.getByTestId("team-page").getByTestId("brand-open").click();
  await held.asked;

  const newest = await putBrand(page, { voice: "新口吻", version: first.version });
  await expect.poll(async () => (await observed(page)).brand?.version, "推送先把新口吻送到").toBe(newest.version);
  held.release();
  await expect(dialog(page)).toHaveAttribute("data-state", "ready");
  await expect(dialog(page).getByTestId("brand-voice"), "表单用手上更新的那本").toHaveValue("新口吻");

  await dialog(page).getByTestId("brand-taboo").fill("不说竞品");
  await dialog(page).getByTestId("brand-save").click();
  await expect(dialog(page), "底稿是新版，存得上").toHaveCount(0);
  const saved = await brandOnServer(page);
  expect([saved?.voice, saved?.taboo]).toEqual(["新口吻", "不说竞品"]);
});
