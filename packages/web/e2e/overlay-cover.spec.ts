import { PokerTableResponse } from "@baize/shared";
import { expect, login, openBot, openSettings, test, type Page } from "./fixtures";

// 遮罩必须铺满整个视口。视口比内容区最大宽度（1120px）宽，遮罩挂在 .page 里被它的子元素规则夹窄就会露白。
test.use({ viewport: { width: 1440, height: 900 } });

const openers: { dialog: string; open: (page: Page) => Promise<void> }[] = [
  {
    dialog: "import-dialog",
    open: async (page) => {
      await page.getByTestId("team-nav").click();
      await page.getByTestId("import-bot").click();
    },
  },
  {
    dialog: "brand-dialog",
    open: async (page) => {
      await page.getByTestId("team-nav").click();
      await page.getByTestId("brand-open").click();
    },
  },
  { dialog: "new-project-dialog", open: (page) => page.getByTestId("new-project").click() },
  { dialog: "settings-window", open: openSettings },
  {
    dialog: "share-dialog",
    open: async (page) => {
      await openBot(page, "小服");
      await page.getByTestId("bot-share").click();
    },
  },
  {
    dialog: "edit-bot-dialog",
    open: async (page) => {
      await openBot(page, "小服");
      await page.getByTestId("bot-edit").click();
    },
  },
  {
    dialog: "swap-seat-dialog",
    open: async (page) => {
      const created = await page.request.post("/api/poker/tables", { data: { requestId: `cover-${Date.now()}` } });
      expect(created.status(), "建桌成功").toBe(201);
      const table = PokerTableResponse.parse(await created.json()).table;
      await page.goto(`/p/${table.groupId}`);
      await page.getByTestId("poker-seat-swap").first().click();
    },
  },
];

for (const { dialog, open } of openers) {
  test(`${dialog} 的遮罩铺满整个视口`, async ({ page }) => {
    await login(page);
    await open(page);
    const scrim = page.getByTestId(dialog);
    await expect(scrim).toBeVisible();

    const viewport = page.viewportSize();
    if (viewport === null) throw new Error("Playwright 没给视口尺寸");
    const box = await scrim.boundingBox();
    expect(box, "遮罩有盒子").not.toBeNull();
    expect(
      { left: box!.x, top: box!.y, right: box!.x + box!.width, bottom: box!.y + box!.height },
      "遮罩四边都到视口边上",
    ).toEqual({ left: 0, top: 0, right: viewport.width, bottom: viewport.height });

    const corners = await scrim.evaluate((node) =>
      [
        { x: 0, y: 0 },
        { x: window.innerWidth - 1, y: 0 },
        { x: 0, y: window.innerHeight - 1 },
        { x: window.innerWidth - 1, y: window.innerHeight - 1 },
      ].map(({ x, y }) => node.contains(document.elementFromPoint(x, y))),
    );
    expect(corners, "视口四个角点到的都是这层遮罩，没被别的层盖住").toEqual([true, true, true, true]);
  });
}
