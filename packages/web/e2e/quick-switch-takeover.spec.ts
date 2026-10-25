import { LiveFromViewer, type LiveInput } from "@baize/shared";
import { z } from "zod";
import { expect, login, openSeededBot, SHOT, TEAM_TITLE, test, type APIRequestContext, type Page } from "./fixtures";

const SWITCH = "ControlOrMeta+k";
const SHEET = "ControlOrMeta+Slash";

const Created = z.object({ liveId: z.string() });
const Received = z.object({ received: z.array(z.object({ liveId: z.string(), message: LiveFromViewer })) });

const takeover = async (request: APIRequestContext) => {
  const response = await request.post("/api/test/live/takeover", {
    data: { computerId: "cmp_remote", botId: "bot_service", groupId: "grp_service", reason: "请你登一下", hold: false },
  });
  expect(response.status(), "mock 造出一次接手").toBe(200);
  return Created.parse(await response.json()).liveId;
};

const received = async (request: APIRequestContext, liveId: string) =>
  Received.parse(await (await request.get("/api/test/live/received")).json()).received.filter(
    (entry) => entry.liveId === liveId,
  );

const keysSent = async (request: APIRequestContext, liveId: string): Promise<LiveInput[]> =>
  (await received(request, liveId)).flatMap(({ message }) =>
    message.t === "input" && message.input.kind === "key" ? [message.input] : [],
  );

const typedSent = async (request: APIRequestContext, liveId: string) =>
  (await keysSent(request, liveId)).flatMap((input) =>
    input.kind === "key" && input.phase === "down" && input.text !== null ? [input.text] : [],
  );

const panel = (page: Page) => page.getByTestId("live-panel");

const openPanel = async (page: Page, request: APIRequestContext) => {
  await login(page);
  await openSeededBot(page, "小服");
  const liveId = await takeover(request);
  await page.locator(`[data-testid=takeover-card][data-live-id="${liveId}"]`).getByTestId("takeover-open").click();
  await expect(panel(page)).toHaveAttribute("data-state", "live");
  await expect(page.getByTestId("live-keys"), "面板一开键盘就发到画面").toBeFocused();
  return liveId;
};

// 落点上最上面那个元素属于谁：被别的层盖住时拿到的是盖在上面的那层。
const topmostAt = (page: Page, testId: string) =>
  page
    .getByTestId(testId)
    .first()
    .evaluate((element, id) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit?.closest(`[data-testid="${id}"]`) === element;
    }, testId);

test("画面接管开着时 ⌘K 拉起快速切换，盖在画面上；⌘K 和快速切换里打的字都不发到电脑，Esc 关掉后焦点回到画面、字母接着发过去", async ({
  page,
  request,
}) => {
  const liveId = await openPanel(page, request);
  await page.keyboard.type("a");
  await expect.poll(() => typedSent(request, liveId), "开快速切换之前打的字发到了电脑").toEqual(["a"]);

  await page.keyboard.press(SWITCH);
  await expect(page.getByTestId("quick-switch")).toBeVisible();
  await expect(page.getByTestId("quick-switch-input"), "一打开就能打字").toBeFocused();
  expect(await topmostAt(page, "quick-switch"), "快速切换正中点到的是它自己，不是画面").toBe(true);
  await page.keyboard.type("qw");
  await expect(page.getByTestId("quick-switch-input")).toHaveValue("qw");

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("quick-switch")).toHaveCount(0);
  await expect(panel(page), "接管没结束").toHaveAttribute("data-state", "live");
  await expect(page.getByTestId("live-keys"), "焦点回到画面").toBeFocused();
  await page.keyboard.type("z");

  await expect.poll(() => typedSent(request, liveId), "关掉之后字母接着发过去，中间打的字一个没发").toEqual(["a", "z"]);
  const keys = await keysSent(request, liveId);
  expect(
    keys.filter((input) => input.kind === "key" && input.code === "KeyK"),
    "⌘K 留在 App 这边",
  ).toEqual([]);
  expect(
    keys.filter((input) => input.kind === "key" && input.phase === "up" && input.key === "Escape"),
    "关快速切换的 Esc 也不发",
  ).toEqual([]);
  const ends = (await received(request, liveId)).filter(({ message }) => message.t === "end");
  expect(ends, "网页没替用户结束接管").toEqual([]);
});

test("画面接管开着时在快速切换里选别的群：跳过去，画面照旧摆着不结束，焦点回到画面", async ({ page, request }) => {
  const liveId = await openPanel(page, request);
  await page.keyboard.press(SWITCH);
  await expect(page.getByTestId("quick-switch")).toBeVisible();
  await page.getByTestId("quick-switch-input").fill(TEAM_TITLE);
  await page.locator(`[data-testid=quick-switch-option][data-kind=group][data-name="${TEAM_TITLE}"]`).click();

  await expect(page.getByTestId("quick-switch")).toHaveCount(0);
  await expect(page).toHaveURL(/\/g\//);
  await expect(panel(page), "画面是整页的，换群不收").toHaveAttribute("data-live-id", liveId);
  await expect(panel(page)).toHaveAttribute("data-state", "live");
  await expect(page.getByTestId("live-keys")).toBeFocused();
  await page.keyboard.type("b");
  await expect.poll(() => typedSent(request, liveId)).toEqual(["b"]);
  const ends = (await received(request, liveId)).filter(({ message }) => message.t === "end");
  expect(ends, "换群不替用户结束接管").toEqual([]);
});

test("画面开着、另一个 Bot 请人接手时按 ⌘K：右下角的接手提示不被快速切换的遮罩盖住，点得到", async ({
  page,
  request,
}) => {
  await openPanel(page, request);
  const waiting = await takeover(request);
  const hint = page.locator(`[data-testid=takeover-hint][data-live-id="${waiting}"]`);
  await expect(hint).toBeVisible();

  await page.keyboard.press(SWITCH);
  await expect(page.getByTestId("quick-switch")).toBeVisible();
  expect(await topmostAt(page, "quick-switch"), "快速切换在画面上面").toBe(true);
  expect(await topmostAt(page, "takeover-hint"), "提示在遮罩上面").toBe(true);
  await page.screenshot({ path: `${SHOT}/quick-switch-over-takeover.png` });
  await hint.getByTestId("takeover-hint-later").click();
  await expect(hint).toHaveCount(0);
});

test("快速切换开着时点接手提示的「打开画面」：快速切换收起，画面在最上面，打的字发到电脑", async ({
  page,
  request,
}) => {
  await login(page);
  await openSeededBot(page, "小服");
  await page.keyboard.press(SWITCH);
  await expect(page.getByTestId("quick-switch-input")).toBeFocused();
  const liveId = await takeover(request);
  const hint = page.locator(`[data-testid=takeover-hint][data-live-id="${liveId}"]`);
  await hint.getByTestId("takeover-hint-open").click();

  await expect(panel(page)).toHaveAttribute("data-state", "live");
  await expect(page.getByTestId("quick-switch"), "画面打开时快速切换收起，不压在画面上面").toHaveCount(0);
  expect(await topmostAt(page, "live-panel"), "画面正中点到的是画面").toBe(true);
  await expect(page.getByTestId("live-keys"), "焦点在画面上").toBeFocused();
  await page.keyboard.type("c");
  await expect.poll(() => typedSent(request, liveId), "字发到看得见的那块画面").toEqual(["c"]);
});

test("快捷键表关掉后焦点回到打开之前的地方，不落到 body：从快速切换里按 ⌘/ 换过去也一样", async ({ page }) => {
  await login(page);
  await openSeededBot(page, "小服");
  const composer = page.getByTestId("composer-input");
  await composer.click();

  await page.keyboard.press(SWITCH);
  await expect(page.getByTestId("quick-switch-input")).toBeFocused();
  await page.keyboard.press(SHEET);
  await expect(page.getByTestId("quick-switch"), "⌘/ 换成快捷键表").toHaveCount(0);
  await expect(page.getByTestId("shortcut-sheet")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("shortcut-sheet")).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.tagName), "焦点不在 body 上").not.toBe("BODY");
  await expect(composer, "回到开快速切换之前的输入框").toBeFocused();

  await page.keyboard.press(SHEET);
  await expect(page.getByTestId("shortcut-sheet")).toBeVisible();
  await page.getByTestId("shortcut-sheet-scrim").click({ position: { x: 8, y: 8 } });
  await expect(page.getByTestId("shortcut-sheet")).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.tagName), "点遮罩关掉，焦点也不在 body 上").not.toBe("BODY");
  await expect(composer).toBeFocused();

  await page.keyboard.press(SHEET);
  await page.getByTestId("shortcut-sheet-close").click();
  await expect(page.getByTestId("shortcut-sheet")).toHaveCount(0);
  await expect(composer, "点关闭钮关掉也回到输入框").toBeFocused();
});
