import { expect, test, login, openBot, teamCard, type Page } from "./fixtures";

const shareDialog = (page: Page) => page.getByTestId("share-dialog");
const summary = (page: Page) => shareDialog(page).getByTestId("share-summary");

const openShare = async (page: Page, name: string) => {
  await login(page);
  await openBot(page, name);
  await page.getByTestId("bot-share").click();
  await expect(shareDialog(page)).toBeVisible();
};

test("分享弹窗默认那段话写明不带登录、对话、文件、项目", async ({ page }) => {
  await openShare(page, "小服");
  await expect(summary(page)).toContainText("对方拿到一个新的小服");
  await expect(summary(page)).toContainText("你的登录、对话、文件和项目不带");
  await expect(summary(page), "两个插件默认带配置").toContainText("2 个插件的配置");
  await expect(summary(page), "五条里四条不私人，默认带四条").toContainText("4 条偏好");
  await expect(summary(page), "私人那条点明留下").toContainText("有 1 条只和你的号有关，自动留下");
});

test("取消勾选技能后那段话跟着变", async ({ page }) => {
  await openShare(page, "小销");
  await expect(summary(page)).toContainText("3 个技能");
  await shareDialog(page).getByTestId("share-more").click();
  const skills = shareDialog(page).getByTestId("share-skills");
  await expect(skills).toBeChecked();

  await skills.uncheck();
  await expect(summary(page), "不带技能就不再提技能").not.toContainText("技能");
  await expect(summary(page)).toContainText("你的登录、对话、文件和项目不带");

  const exported = page.waitForRequest((sent) => sent.url().endsWith("/template") && sent.method() === "POST");
  await shareDialog(page).getByTestId("share-copy").click();
  expect((await exported).postDataJSON(), "导出请求跟着勾选走").toMatchObject({ skills: false, plugins: true });
  await expect(shareDialog(page).getByTestId("share-link")).toHaveValue(/#/);
});

test("私人偏好默认不勾", async ({ page }) => {
  await openShare(page, "小服");
  await shareDialog(page).getByTestId("share-more").click();
  const prefs = shareDialog(page).getByTestId("share-pref");
  await expect(prefs).toHaveCount(5);
  await expect(prefs.filter({ hasText: "Lisa 喜欢先看结论" }).getByRole("checkbox")).not.toBeChecked();
  await expect(prefs.filter({ hasText: "回客户先称呼对方名字" }).getByRole("checkbox")).toBeChecked();

  await prefs.filter({ hasText: "Lisa 喜欢先看结论" }).getByRole("checkbox").check();
  await expect(summary(page), "自己勾上私人那条也能带").toContainText("5 条偏好");
  await expect(summary(page)).not.toContainText("自动留下");
});

test("粘贴链接导入后团队页多一个同名带后缀的 Bot", async ({ page }) => {
  await openShare(page, "小服");
  await shareDialog(page).getByTestId("share-copy").click();
  const link = await shareDialog(page).getByTestId("share-link").inputValue();
  expect(link, "整包在 # 后面").toMatch(/#[A-Za-z0-9_-]+$/);
  await shareDialog(page).getByTestId("share-close").click();

  await page.getByTestId("team-nav").click();
  const cards = page.getByTestId("team-bot");
  const before = await cards.count();
  await page.getByTestId("import-bot").click();
  const dialog = page.getByTestId("import-dialog");
  await dialog.getByTestId("import-link").fill("这不是链接");
  await dialog.getByTestId("import-go").click();
  await expect(dialog.getByRole("alert"), "认不出的链接当场说").toBeVisible();
  await expect(cards).toHaveCount(before);

  const imported = page.waitForRequest((sent) => sent.url().endsWith("/api/bots/import") && sent.method() === "POST");
  await dialog.getByTestId("import-link").fill(link);
  await dialog.getByTestId("import-go").click();
  const body = (await imported).postDataJSON() as { template: { name: string; preferences: unknown[] } };
  expect(body.template.name).toBe("小服");
  expect(body.template.preferences, "默认只带不私人的四条").toHaveLength(4);
  await expect(dialog).toHaveCount(0);

  await expect(cards).toHaveCount(before + 1);
  await expect(teamCard(page, "小服"), "原 Bot 还在").toHaveCount(1);
  const names = await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-bot-name") ?? ""));
  expect(
    names.filter((name) => name.startsWith("小服") && name !== "小服"),
    "同名撞了带后缀",
  ).toHaveLength(1);
});

const decodePack = (link: string) =>
  JSON.parse(Buffer.from(link.split("#")[1] ?? "", "base64url").toString("utf8")) as {
    plugins: unknown[];
    preferences: { text: string }[];
  };

test("复制在途时改了勾选，旧回包不出链接也不进剪贴板，再复制按新勾选打包", async ({ page }) => {
  await page.addInitScript(() => {
    const copied: string[] = [];
    Object.assign(window, { __copied: copied });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void copied.push(text) },
    });
  });
  const copied = () => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
  await openShare(page, "小服");
  const dialog = shareDialog(page);
  await dialog.getByTestId("share-more").click();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let arrived!: () => void;
  const reached = new Promise<void>((resolve) => (arrived = resolve));
  let first = true;
  await page.route("**/api/bots/*/template", async (route) => {
    if (!first) return route.continue();
    first = false;
    const response = await route.fetch();
    arrived();
    await held;
    await route.fulfill({ response });
  });

  await dialog.getByTestId("share-copy").click();
  await reached;
  const pref = dialog.getByTestId("share-pref").filter({ hasText: "回客户先称呼对方名字" }).getByRole("checkbox");
  await pref.uncheck();
  await expect(summary(page)).toContainText("3 条偏好");

  const stale = page.waitForResponse((response) => response.url().endsWith("/template"));
  release();
  await (await stale).finished();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve))));
  await expect(dialog.getByTestId("share-link"), "改勾选之前发出的那次不出链接").toHaveCount(0);
  expect(await copied(), "旧勾选的包不写进剪贴板").toEqual([]);
  await expect(pref).not.toBeChecked();

  await dialog.getByTestId("share-copy").click();
  await expect(dialog.getByTestId("share-link")).toHaveValue(/#/);
  const pack = decodePack(await dialog.getByTestId("share-link").inputValue());
  expect(pack.preferences, "包里跟着新勾选只有三条").toHaveLength(3);
  expect(pack.preferences.map(({ text }) => text)).not.toContain("回客户先称呼对方名字");
  expect(await copied(), "剪贴板里只有新勾选那条").toEqual([await dialog.getByTestId("share-link").inputValue()]);
});

test("导入后不刷新再分享新 Bot，那段话和勾选框算上带过来的插件", async ({ page }) => {
  await openShare(page, "小服");
  await shareDialog(page).getByTestId("share-copy").click();
  const link = await shareDialog(page).getByTestId("share-link").inputValue();
  await shareDialog(page).getByTestId("share-close").click();

  await page.getByTestId("team-nav").click();
  await page.getByTestId("import-bot").click();
  const dialog = page.getByTestId("import-dialog");
  await dialog.getByTestId("import-link").fill(link);
  const imported = page.waitForResponse((response) => response.url().endsWith("/api/bots/import"));
  await dialog.getByTestId("import-go").click();
  const created = (await (await imported).json()) as { bot: { name: string } };
  await expect(dialog).toHaveCount(0);

  await openBot(page, created.bot.name);
  await page.getByTestId("bot-share").click();
  await expect(summary(page), "导入带来的两个插件要说出来").toContainText("2 个插件的配置");
  await shareDialog(page).getByTestId("share-more").click();
  await expect(shareDialog(page).getByTestId("share-plugins").locator("..")).toContainText("插件 2 个");
  await shareDialog(page).getByTestId("share-copy").click();
  await expect(shareDialog(page).getByTestId("share-link")).toHaveValue(/#/);
  expect(decodePack(await shareDialog(page).getByTestId("share-link").inputValue()).plugins).toHaveLength(2);
});

test("超过 131072 字符的链接不解码不请求，直接说太长", async ({ page }) => {
  const imports: string[] = [];
  page.on("request", (sent) => {
    if (sent.url().endsWith("/api/bots/import")) imports.push(sent.url());
  });
  await login(page);
  await page.getByTestId("team-nav").click();
  await page.getByTestId("import-bot").click();
  const dialog = page.getByTestId("import-dialog");
  const pack = {
    format: 1,
    name: "长包",
    tags: [],
    description: "",
    skills: [],
    plugins: [{ name: "插件", url: `https://example.invalid/${"a".repeat(131072)}`, operations: [] }],
    preferences: [],
  };
  const link = `http://127.0.0.1/share#${Buffer.from(JSON.stringify(pack)).toString("base64url")}`;
  expect(link.length, "除了长，这是一条合法的分享包").toBeGreaterThan(131072);

  await dialog.getByTestId("import-link").fill(link);
  await dialog.getByTestId("import-go").click();
  await expect(dialog.getByRole("alert")).toHaveText("链接太长，不像白泽的分享链接");
  await expect(dialog, "没导入，弹窗还开着").toBeVisible();
  expect(imports, "一次导入请求都不发").toEqual([]);
});

test("Bot 内容多到链接超过上限，复制时不写剪贴板，提示精简技能", async ({ page }) => {
  await page.addInitScript(() => {
    const copied: string[] = [];
    Object.assign(window, { __copied: copied });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void copied.push(text) },
    });
  });
  await login(page);
  for (let n = 1; n <= 5; n += 1) {
    const created = await page.request.post("/api/bots/bot_sales/skills", {
      data: { name: `长技能${n}`, steps: Array.from({ length: 20 }, () => "步".repeat(500)) },
    });
    expect(created.status(), "每个技能都在上限以内，是合法的").toBe(201);
  }
  await openBot(page, "小销");
  await page.getByTestId("bot-share").click();
  const dialog = shareDialog(page);
  await expect(summary(page)).toContainText("8 个技能");

  const exported = page.waitForResponse((response) => response.url().endsWith("/template"));
  await dialog.getByTestId("share-copy").click();
  expect((await exported).status()).toBe(200);
  await expect(dialog.getByRole("alert")).toHaveText("这个 Bot 内容太多，分享链接放不下，精简技能后再试");
  await expect(dialog.getByTestId("share-link"), "放不下就不给链接").toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied), "剪贴板什么都没写").toEqual(
    [],
  );
});

const recordClipboard = (page: Page) =>
  page.addInitScript(() => {
    const copied: string[] = [];
    Object.assign(window, { __copied: copied });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void copied.push(text) },
    });
  });
const copiedLinks = (page: Page) => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);

const holdFirst = async (page: Page, pattern: string) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let arrived!: () => void;
  const reached = new Promise<void>((resolve) => (arrived = resolve));
  let calls = 0;
  await page.route(pattern, async (route) => {
    calls += 1;
    if (calls > 1) return route.continue();
    const response = await route.fetch();
    arrived();
    await held;
    await route.fulfill({ response });
  });
  return { reached, release, calls: () => calls };
};

const memberCount = async (page: Page) => {
  const listed = (await (await page.request.get("/api/bots")).json()) as { items: { bot: { role: string } }[] };
  return listed.items.filter(({ bot }) => bot.role === "member").length;
};

const linkOf = async (page: Page, name: string) => {
  await openShare(page, name);
  await shareDialog(page).getByTestId("share-copy").click();
  const link = await shareDialog(page).getByTestId("share-link").inputValue();
  await shareDialog(page).getByTestId("share-close").click();
  return link;
};

test("导入建好了但插件没同步上，Bot 留着，只重试同步，不再导入一次", async ({ page }) => {
  const link = await linkOf(page, "小服");
  await page.getByTestId("team-nav").click();
  const cards = page.getByTestId("team-bot");
  const before = await cards.count();
  const members = await memberCount(page);
  let failTools = true;
  await page.route("**/api/tools", (route) => {
    if (!failTools) return route.continue();
    failTools = false;
    return route.fulfill({ status: 500, json: { error: "插件列表暂时拉不到" } });
  });
  const imports: string[] = [];
  page.on("request", (sent) => {
    if (sent.url().endsWith("/api/bots/import")) imports.push(sent.url());
  });

  await page.getByTestId("import-bot").click();
  const dialog = page.getByTestId("import-dialog");
  await dialog.getByTestId("import-link").fill(link);
  await dialog.getByTestId("import-go").click();
  await expect(dialog.getByRole("alert"), "导入成了，只是插件没同步").toContainText("已导入");
  await expect(dialog.getByRole("alert")).not.toContainText("没导入成");
  await expect(cards, "建好的 Bot 已经进团队").toHaveCount(before + 1);
  await expect(dialog.getByTestId("import-go"), "不再引导重新导入").toHaveCount(0);

  await dialog.getByTestId("import-retry-tools").click();
  await expect(dialog).toHaveCount(0);
  await expect(cards).toHaveCount(before + 1);
  expect(imports, "整个过程只 POST 导入一次").toHaveLength(1);
  expect(await memberCount(page), "服务端只多一个 Bot").toBe(members + 1);

  const names = await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-bot-name") ?? ""));
  const created = names.find((name) => name.startsWith("小服") && name !== "小服") ?? "";
  await openBot(page, created);
  await page.getByTestId("bot-share").click();
  await expect(summary(page), "重试同步后插件补进来了").toContainText("2 个插件的配置");
});

test("导入在途时改输入框，导入按钮不解锁，不会再建一个", async ({ page }) => {
  const link = await linkOf(page, "小销");
  await page.getByTestId("team-nav").click();
  const members = await memberCount(page);
  const importing = await holdFirst(page, "**/api/bots/import");
  await page.getByTestId("import-bot").click();
  const dialog = page.getByTestId("import-dialog");
  await dialog.getByTestId("import-link").fill(link);
  await dialog.getByTestId("import-go").click();
  await importing.reached;

  await dialog.getByTestId("import-link").press("End");
  await dialog.getByTestId("import-link").pressSequentially(" ");
  await expect(dialog.getByTestId("import-go"), "在途时改输入也不解锁").toBeDisabled();
  await dialog.getByTestId("import-go").click({ force: true });

  importing.release();
  await expect(dialog).toHaveCount(0);
  expect(importing.calls(), "只发了一次导入").toBe(1);
  expect(await memberCount(page), "只多一个 Bot").toBe(members + 1);
});

test("关掉分享弹窗再打开，旧弹窗晚到的导出不写剪贴板", async ({ page }) => {
  await recordClipboard(page);
  await openShare(page, "小服");
  const exporting = await holdFirst(page, "**/api/bots/*/template");
  await shareDialog(page).getByTestId("share-copy").click();
  await exporting.reached;
  await shareDialog(page).getByTestId("share-close").click();

  await page.getByTestId("bot-share").click();
  const dialog = shareDialog(page);
  await dialog.getByTestId("share-more").click();
  await dialog.getByTestId("share-pref").filter({ hasText: "回客户先称呼对方名字" }).getByRole("checkbox").uncheck();
  await dialog.getByTestId("share-copy").click();
  await expect(dialog.getByTestId("share-link")).toHaveValue(/#/);
  const latest = await dialog.getByTestId("share-link").inputValue();

  const stale = page.waitForResponse((response) => response.url().endsWith("/template"));
  exporting.release();
  await (await stale).finished();
  await page.evaluate(() => fetch("/api/bots/bot_service/profile"));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve))));
  expect(await copiedLinks(page), "剪贴板里只有新弹窗那一条").toEqual([latest]);
  await expect(dialog.getByTestId("share-link")).toHaveValue(latest);
});

test("分享弹窗开着切到别的 Bot 单聊，勾选和链接按新 Bot 重来", async ({ page }) => {
  await recordClipboard(page);
  await login(page);
  await openBot(page, "小服");
  await expect(page.getByTestId("bot-share")).toBeEnabled();
  await page.getByTestId("assistant-nav").click();
  const assistant = (await page.getByTestId("chat-title").textContent()) ?? "";
  expect(assistant).not.toBe("小服");
  await page.getByTestId("bot-share").click();
  await shareDialog(page).getByTestId("share-copy").click();
  await expect(shareDialog(page).getByTestId("share-link")).toHaveValue(/#/);

  await page.goBack();
  await expect(page.getByTestId("chat-title")).toHaveText("小服");
  const dialog = shareDialog(page);
  await expect(dialog.getByRole("dialog")).toHaveAttribute("aria-label", "分享 小服");
  await expect(dialog.getByTestId("share-link"), "上一个 Bot 的链接不留").toHaveCount(0);
  await expect(summary(page), "小服的默认勾选是四条不私人的").toContainText("4 条偏好");
  await dialog.getByTestId("share-copy").click();
  await expect(dialog.getByTestId("share-link")).toHaveValue(/#/);
  const pack = decodePack(await dialog.getByTestId("share-link").inputValue()) as unknown as {
    name: string;
    preferences: unknown[];
  };
  expect(pack.name).toBe("小服");
  expect(pack.preferences, "带的是小服自己的四条偏好").toHaveLength(4);
});

const twoPlugins = {
  format: 1,
  name: "带插件的包",
  tags: [],
  description: "",
  skills: [],
  preferences: [],
  plugins: [
    { name: "包里插件甲", url: "https://example.invalid/a", operations: [] },
    { name: "包里插件乙", url: "https://example.invalid/b", operations: [] },
  ],
};
const twoPluginsLink = `http://127.0.0.1/share#${Buffer.from(JSON.stringify(twoPlugins)).toString("base64url")}`;

const openImportWithPack = async (page: Page) => {
  await login(page);
  await page.getByTestId("team-nav").click();
  await page.getByTestId("import-bot").click();
  await page.getByTestId("import-link").fill(twoPluginsLink);
};

const settle = async (page: Page) => {
  await page.evaluate(() => fetch("/api/health"));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve))));
};

const focusInside = (page: Page, testId: string) =>
  page.getByTestId(testId).evaluate((node) => node.contains(document.activeElement));

test("同步在途关掉导入弹窗再开一个，旧同步收尾不关新弹窗，插件照样补进来", async ({ page }) => {
  await openImportWithPack(page);
  const sync = await holdFirst(page, "**/api/tools");
  await page.getByTestId("import-go").click();
  await sync.reached;
  await expect(teamCard(page, twoPlugins.name)).toHaveCount(1);
  await page.getByTestId("import-link").press("Escape");
  await expect(page.getByTestId("import-dialog")).toHaveCount(0);

  await page.getByTestId("import-bot").click();
  await page.getByTestId("import-link").fill("新弹窗里还没提交的输入");
  const synced = page.waitForResponse((response) => response.url().endsWith("/api/tools"));
  sync.release();
  await (await synced).finished();
  await settle(page);
  await expect(page.getByTestId("import-dialog"), "旧弹窗的同步收尾碰不到新弹窗").toBeVisible();
  await expect(page.getByTestId("import-link"), "新弹窗的输入不丢").toHaveValue("新弹窗里还没提交的输入");

  await page.getByTestId("import-link").press("Escape");
  await openBot(page, twoPlugins.name);
  await page.getByTestId("bot-share").click();
  await expect(summary(page), "后台同步照样更新了工具表").toContainText("2 个插件的配置");
});

test("插件同步失败后关掉导入弹窗，单聊里还有同步入口，同步前不让分享，同步后摘要和包一致", async ({ page }) => {
  await recordClipboard(page);
  await openImportWithPack(page);
  let failing = true;
  await page.route("**/api/tools", (route) =>
    failing ? route.fulfill({ status: 500, json: { error: "插件列表暂时拉不到" } }) : route.continue(),
  );
  await page.getByTestId("import-go").click();
  await expect(page.getByTestId("import-dialog").getByRole("alert")).toContainText("已导入");
  await page.getByTestId("import-link").press("Escape");
  await expect(page.getByTestId("import-dialog")).toHaveCount(0);

  await openBot(page, twoPlugins.name);
  await expect(page.getByTestId("bot-tools-unsynced"), "关了弹窗恢复入口还在").toContainText("插件还没同步过来");
  await expect(page.getByTestId("bot-share"), "插件没对上之前不出会漏报的摘要").toBeDisabled();

  await page.getByTestId("bot-sync-tools").click();
  await expect(page.getByTestId("bot-tools-unsynced"), "还是失败就留着入口").toBeVisible();
  failing = false;
  await page.getByTestId("bot-sync-tools").click();
  await expect(page.getByTestId("bot-tools-unsynced")).toHaveCount(0);
  await page.getByTestId("bot-share").click();
  await expect(summary(page)).toContainText("2 个插件的配置");
  await shareDialog(page).getByTestId("share-copy").click();
  await expect(shareDialog(page).getByTestId("share-link")).toHaveValue(/#/);
  expect(decodePack(await shareDialog(page).getByTestId("share-link").inputValue()).plugins).toHaveLength(2);
});

test("分享弹窗开着时一条公开偏好被改成私人，默认勾选撤掉、旧链接作废，自己勾的私人偏好保留", async ({ page }) => {
  await recordClipboard(page);
  await openShare(page, "小服");
  const dialog = shareDialog(page);
  await dialog.getByTestId("share-more").click();
  const prefs = dialog.getByTestId("share-pref");
  const turned = prefs.filter({ hasText: "回客户先称呼对方名字" });
  const mine = prefs.filter({ hasText: "Lisa 喜欢先看结论" });
  await mine.getByRole("checkbox").check();
  await dialog.getByTestId("share-copy").click();
  await expect(dialog.getByTestId("share-link")).toHaveValue(/#/);

  const listed = (await (await page.request.get("/api/bots/bot_service/preferences")).json()) as {
    items: { id: string; text: string }[];
  };
  const row = listed.items.find((item) => item.text === "回客户先称呼对方名字");
  expect(row).toBeDefined();
  expect((await page.request.patch(`/api/preferences/${row?.id ?? ""}`, { data: { private: true } })).status()).toBe(
    200,
  );
  await expect(turned).toContainText("只和你的号有关，默认不带");
  await expect(turned.getByRole("checkbox"), "变私人之后默认勾选撤掉").not.toBeChecked();
  await expect(mine.getByRole("checkbox"), "自己勾上的私人偏好不动").toBeChecked();
  await expect(dialog.getByTestId("share-link"), "按旧隐私打的链接作废").toHaveCount(0);

  await dialog.getByTestId("share-copy").click();
  await expect(dialog.getByTestId("share-link")).toHaveValue(/#/);
  const texts = decodePack(await dialog.getByTestId("share-link").inputValue()).preferences.map(({ text }) => text);
  expect(texts).not.toContain("回客户先称呼对方名字");
  expect(texts).toContain("Lisa 喜欢先看结论");
});

test("导入回包晚于删除推送，已删的 Bot 不回到团队里", async ({ page }) => {
  await openImportWithPack(page);
  const importing = await holdFirst(page, "**/api/bots/import");
  await page.getByTestId("import-go").click();
  await importing.reached;
  const listed = (await (await page.request.get("/api/bots")).json()) as {
    items: { bot: { id: string; name: string } }[];
  };
  const created = listed.items.find((item) => item.bot.name === twoPlugins.name);
  expect(created).toBeDefined();
  expect((await page.request.delete(`/api/bots/${created?.bot.id ?? ""}`)).status()).toBe(204);
  await settle(page);

  importing.release();
  await expect(page.getByTestId("import-dialog")).toHaveCount(0);
  await settle(page);
  await expect(teamCard(page, twoPlugins.name), "删除在先，晚到的导入回包不复活它").toHaveCount(0);
  expect(await memberCount(page)).toBe(3);
});

test("分享和导入弹窗打开时焦点移进去，Tab 不出弹窗，关掉后回到入口", async ({ page }) => {
  await openShare(page, "小服");
  expect(await focusInside(page, "share-dialog"), "打开分享焦点进弹窗").toBe(true);
  await shareDialog(page).getByTestId("share-more").click();
  for (let n = 0; n < 12; n += 1) {
    await page.keyboard.press("Tab");
    expect(await focusInside(page, "share-dialog"), `第 ${n + 1} 次 Tab 还在分享弹窗里`).toBe(true);
  }
  for (let n = 0; n < 12; n += 1) {
    await page.keyboard.press("Shift+Tab");
    expect(await focusInside(page, "share-dialog"), `第 ${n + 1} 次 Shift+Tab 还在分享弹窗里`).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("bot-share"), "关掉回到分享按钮").toBeFocused();

  await page.getByTestId("team-nav").click();
  await page.getByTestId("import-bot").click();
  expect(await focusInside(page, "import-dialog"), "打开导入焦点进弹窗").toBe(true);
  await page.getByTestId("import-link").fill(twoPluginsLink);
  for (let n = 0; n < 6; n += 1) {
    await page.keyboard.press("Tab");
    expect(await focusInside(page, "import-dialog"), `第 ${n + 1} 次 Tab 还在导入弹窗里`).toBe(true);
  }
  for (let n = 0; n < 6; n += 1) {
    await page.keyboard.press("Shift+Tab");
    expect(await focusInside(page, "import-dialog"), `第 ${n + 1} 次 Shift+Tab 还在导入弹窗里`).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("import-bot"), "关掉回到导入按钮").toBeFocused();
});

test("导入、同步插件、打包三段在途时有看得见的进度文案，弹窗标 aria-busy", async ({ page }) => {
  await openImportWithPack(page);
  const dialog = page.getByTestId("import-dialog");
  const importing = await holdFirst(page, "**/api/bots/import");
  const sync = await holdFirst(page, "**/api/tools");
  await page.getByTestId("import-go").click();
  await importing.reached;
  await expect(dialog.getByRole("status")).toHaveText("正在导入…");
  await expect(dialog.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
  importing.release();
  await sync.reached;
  await expect(dialog.getByRole("status")).toHaveText("已导入，正在同步插件…");
  await expect(dialog.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
  sync.release();
  await expect(dialog).toHaveCount(0);

  await openBot(page, "小服");
  await page.getByTestId("bot-share").click();
  const exporting = await holdFirst(page, "**/api/bots/*/template");
  await shareDialog(page).getByTestId("share-copy").click();
  await exporting.reached;
  await expect(shareDialog(page).getByRole("status")).toHaveText("正在打包…");
  await expect(shareDialog(page).getByRole("dialog")).toHaveAttribute("aria-busy", "true");
  exporting.release();
  await expect(shareDialog(page).getByTestId("share-link")).toHaveValue(/#/);
  await expect(shareDialog(page).getByRole("dialog")).toHaveAttribute("aria-busy", "false");
});

const tabStaysIn = async (page: Page, testId: string, phase: string) => {
  for (const key of ["Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    expect(await focusInside(page, testId), `${phase}按 ${key} 焦点还在弹窗里`).toBe(true);
  }
  // 焦点停在弹窗容器上（点了空白处）时也一样，Tab 和 Shift+Tab 都进弹窗里的控件。
  for (const key of ["Tab", "Shift+Tab"]) {
    await page.getByTestId(testId).getByRole("dialog").focus();
    expect(await page.evaluate(() => document.activeElement?.getAttribute("role")), `${phase}弹窗容器接得住焦点`).toBe(
      "dialog",
    );
    await page.keyboard.press(key);
    expect(await focusInside(page, testId), `${phase}焦点在容器上按 ${key} 还在弹窗里`).toBe(true);
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute("role")),
      `${phase}焦点在容器上按 ${key} 落到控件上`,
    ).not.toBe("dialog");
  }
};

test("打包、导入、同步重试在途按钮变忙时，Tab 和 Shift+Tab 都不出弹窗", async ({ page }) => {
  await openShare(page, "小服");
  const exporting = await holdFirst(page, "**/api/bots/*/template");
  await shareDialog(page).getByTestId("share-copy").click();
  await exporting.reached;
  await tabStaysIn(page, "share-dialog", "打包中");
  exporting.release();
  await expect(shareDialog(page).getByTestId("share-link")).toHaveValue(/#/);
  await page.keyboard.press("Escape");

  await page.getByTestId("team-nav").click();
  await page.getByTestId("import-bot").click();
  await page.getByTestId("import-link").fill(twoPluginsLink);
  let failTools = true;
  await page.route("**/api/tools", (route) =>
    failTools ? route.fulfill({ status: 500, json: { error: "插件列表暂时拉不到" } }) : route.fallback(),
  );
  const importing = await holdFirst(page, "**/api/bots/import");
  await page.getByTestId("import-go").click();
  await importing.reached;
  await tabStaysIn(page, "import-dialog", "导入中");
  importing.release();
  await expect(page.getByTestId("import-dialog").getByRole("alert")).toContainText("已导入");

  failTools = false;
  const syncing = await holdFirst(page, "**/api/tools");
  await page.getByTestId("import-retry-tools").click();
  await syncing.reached;
  await tabStaysIn(page, "import-dialog", "同步重试中");
  syncing.release();
  await expect(page.getByTestId("import-dialog")).toHaveCount(0);
});

test("编辑保存在途按钮变忙时，Tab 和 Shift+Tab 都不出弹窗", async ({ page }) => {
  await login(page);
  await openBot(page, "小服");
  await page.getByTestId("bot-edit").click();
  const saving = await holdFirst(page, "**/api/bots/bot_service");
  await page.getByTestId("edit-bot-save").click();
  await saving.reached;
  await tabStaysIn(page, "edit-bot-dialog", "保存中");
  saving.release();
  await expect(page.getByTestId("edit-bot-dialog")).toHaveCount(0);
});

test("删掉一条已带上的公开偏好，已出的链接和在途导出都作废，标签条数和包一致", async ({ page }) => {
  await recordClipboard(page);
  await openShare(page, "小服");
  const dialog = shareDialog(page);
  await dialog.getByTestId("share-more").click();
  await dialog.getByTestId("share-copy").click();
  await expect(dialog.getByTestId("share-link")).toHaveValue(/#/);

  const rows = async () =>
    (
      (await (await page.request.get("/api/bots/bot_service/preferences")).json()) as {
        items: { id: string; text: string; private: boolean }[];
      }
    ).items;
  const first = (await rows()).find((row) => row.text === "回客户先称呼对方名字");
  expect((await page.request.delete(`/api/preferences/${first?.id ?? ""}`)).status()).toBe(204);
  await expect(dialog.getByTestId("share-pref").filter({ hasText: "回客户先称呼对方名字" })).toHaveCount(0);
  await expect(dialog.getByTestId("share-link"), "删掉包里的偏好，旧链接作废").toHaveCount(0);

  const next = (await rows()).find((row) => !row.private);
  const exporting = await holdFirst(page, "**/api/bots/*/template");
  await dialog.getByTestId("share-copy").click();
  await exporting.reached;
  expect((await page.request.delete(`/api/preferences/${next?.id ?? ""}`)).status()).toBe(204);
  await expect(dialog.getByTestId("share-pref").filter({ hasText: next?.text ?? "" })).toHaveCount(0);
  const stale = page.waitForResponse((response) => response.url().endsWith("/template"));
  exporting.release();
  await (await stale).finished();
  await settle(page);
  await expect(dialog.getByTestId("share-link"), "在途时删了包里的偏好，这次导出作废").toHaveCount(0);
  expect(await copiedLinks(page), "作废的那包不进剪贴板").toHaveLength(1);

  await dialog.getByTestId("share-copy").click();
  await expect(dialog.getByTestId("share-link")).toHaveValue(/#/);
  const pack = decodePack(await dialog.getByTestId("share-link").inputValue());
  expect(pack.preferences.map(({ text }) => text)).not.toContain(next?.text);
  await expect(dialog, "标签条数就是包里的条数").toContainText(`带 ${pack.preferences.length} 条偏好`);
});

test("同步途中删掉导入的 Bot，晚到的工具快照不带它的 id，改分配只提交还在的 Bot", async ({ page }) => {
  await openImportWithPack(page);
  let failTools = true;
  await page.route("**/api/tools", (route) =>
    failTools ? route.fulfill({ status: 500, json: { error: "插件列表暂时拉不到" } }) : route.fallback(),
  );
  await page.getByTestId("import-go").click();
  await expect(page.getByTestId("import-dialog").getByRole("alert")).toContainText("已导入");
  await page.getByTestId("import-link").press("Escape");
  await openBot(page, twoPlugins.name);
  failTools = false;
  const syncing = await holdFirst(page, "**/api/tools");
  await page.getByTestId("bot-sync-tools").click();
  await syncing.reached;

  const listed = (await (await page.request.get("/api/bots")).json()) as {
    items: { bot: { id: string; name: string } }[];
  };
  const removed = listed.items.find(({ bot }) => bot.name === twoPlugins.name)?.bot.id ?? "";
  expect((await page.request.delete(`/api/bots/${removed}`)).status()).toBe(204);
  await page.getByTestId("team-nav").click();
  await expect(teamCard(page, twoPlugins.name)).toHaveCount(0);
  const synced = page.waitForResponse((response) => response.url().endsWith("/api/tools"));
  syncing.release();
  await (await synced).finished();
  await settle(page);

  await page.getByTestId("account-button").click();
  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-nav-tools").click();
  const card = page.locator('[data-testid="tool-card"][data-tool-name="包里插件甲"]');
  await expect(card).toBeVisible();
  await card.getByTestId("tool-edit-assignment").click();
  const patch = page.waitForRequest((sent) => sent.method() === "PATCH" && sent.url().includes("/api/tools/"));
  const response = page.waitForResponse(
    (answer) => answer.request().method() === "PATCH" && answer.url().includes("/api/tools/"),
  );
  await card.locator('[data-testid="tool-bot-checkbox"][data-bot-name="小服"]').click();
  expect((await patch).postDataJSON().assignedBotIds, "已删 Bot 的 id 不进改分配请求").toEqual(["bot_service"]);
  expect((await response).status()).toBe(200);
  await expect(card.getByRole("alert")).toHaveCount(0);
});

test("偏好超过分享包上限 50 条时只默认带 50 条，到上限后别的勾不上，复制能打包", async ({ page }) => {
  await login(page);
  expect((await page.request.post("/api/test/preferences", { data: { botId: "bot_sales", count: 52 } })).status()).toBe(
    204,
  );
  await openBot(page, "小销");
  await page.getByTestId("bot-share").click();
  const dialog = shareDialog(page);
  await expect(summary(page), "默认只带上限那么多").toContainText("50 条偏好");
  await dialog.getByTestId("share-more").click();
  const boxes = dialog.getByTestId("share-pref").getByRole("checkbox");
  await expect(boxes).toHaveCount(52);
  await expect(dialog.getByTestId("share-pref").getByRole("checkbox", { checked: true })).toHaveCount(50);
  await expect(dialog.getByTestId("share-pref-limit")).toContainText("最多带 50 条");
  await expect(boxes.nth(51), "到上限后没勾的那条勾不上").toBeDisabled();

  await boxes.nth(0).uncheck();
  await expect(boxes.nth(51), "空出一格就能换一条").toBeEnabled();
  await boxes.nth(51).check();
  await expect(summary(page)).toContainText("50 条偏好");

  await dialog.getByTestId("share-copy").click();
  await expect(dialog.getByTestId("share-link"), "不会撞上没打包成").toHaveValue(/#/);
  expect(decodePack(await dialog.getByTestId("share-link").inputValue()).preferences).toHaveLength(50);
});
