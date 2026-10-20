import { expect, test, login, openBot, sendText, teamCard, type Page } from "./fixtures";

const knowToggle = (page: Page) => page.getByTestId("bot-know-toggle");
const prefRows = (page: Page) => page.getByTestId("bot-pref");

const openKnow = async (page: Page) => {
  await knowToggle(page).click();
  await expect(knowToggle(page)).toHaveAttribute("aria-expanded", "true");
};

test("在单聊说一句后记住数从 5 变 6", async ({ page }) => {
  await login(page);
  await page.getByTestId("team-nav").click();
  await teamCard(page, "小服").click();
  await expect(page.getByTestId("chat-title"), "点卡片本身就进 Bot 页").toHaveText("小服");
  await expect(knowToggle(page)).toContainText("记住 5 条");

  await sendText(page, "以后回客户先说结论，再说原因");
  await expect(knowToggle(page), "卡还没点，不算记住").toContainText("记住 5 条");
  await page.getByTestId("preference-offer-save").click();
  await expect(knowToggle(page), "点了记住当场多一条，不用刷新").toContainText("记住 6 条");
  await openKnow(page);
  await expect(prefRows(page)).toHaveCount(6);
  await expect(prefRows(page).last()).toContainText("以后回客户先说结论，再说原因");
});

test("忘掉一条后列表少一条且刷新后仍没有", async ({ page }) => {
  await login(page);
  await openBot(page, "小服");
  await openKnow(page);
  await expect(prefRows(page)).toHaveCount(5);
  const first = prefRows(page).first();
  const forgotten = (await first.getByTestId("bot-pref-text").textContent()) ?? "";
  expect(forgotten.length).toBeGreaterThan(0);

  await first.getByTestId("bot-pref-forget").click();
  await expect(prefRows(page)).toHaveCount(4);
  await expect(knowToggle(page)).toContainText("记住 4 条");
  await expect(prefRows(page).filter({ hasText: forgotten })).toHaveCount(0);

  await page.reload();
  await openBot(page, "小服");
  await openKnow(page);
  await expect(prefRows(page)).toHaveCount(4);
  await expect(prefRows(page).filter({ hasText: forgotten }), "删的是服务端那一行").toHaveCount(0);
});

test("编辑弹窗三项全空也能保存", async ({ page }) => {
  await login(page);
  await openBot(page, "小服");
  await page.getByTestId("bot-edit").click();
  const dialog = page.getByTestId("edit-bot-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("都可以不填");

  await dialog.getByTestId("edit-bot-name").fill("");
  await dialog.getByTestId("edit-bot-description").fill("");
  for (const remove of await dialog.getByTestId("edit-bot-tag-remove").all()) await remove.click();
  await expect(dialog.getByTestId("edit-bot-tag")).toHaveCount(0);

  const patched = page.waitForRequest((sent) => sent.url().includes("/api/bots/") && sent.method() === "PATCH");
  await dialog.getByTestId("edit-bot-save").click();
  expect((await patched).postDataJSON(), "名字空着不送，留给系统；标签和描述清空").toEqual({
    tags: [],
    description: "",
  });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("bot-edit-error")).toHaveCount(0);
  await expect(page.getByTestId("chat-title"), "名字不会变成空的").toHaveText("小服");
  await expect(page.getByTestId("bot-header-description")).toHaveCount(0);

  await page.reload();
  await page.getByTestId("team-nav").click();
  await expect(teamCard(page, "小服").locator(".tag"), "刷新后标签仍是空的").toHaveCount(0);
});

test("在右侧面板改主助理的形状，侧栏头像同步", async ({ page }) => {
  await login(page);
  const sidebarAvatar = page.getByTestId("assistant-nav").locator("[data-shape]");
  await expect(sidebarAvatar).toHaveAttribute("data-shape", "pillow");
  await page.getByTestId("assistant-nav").click();
  const panel = page.getByTestId("bot-panel");
  await expect(panel.getByTestId("bot-shape-option")).toHaveCount(8);
  const patched = page.waitForRequest(
    (request) => request.url().includes("/api/bots/") && request.method() === "PATCH",
  );
  await panel.locator('[data-testid="bot-shape-option"][data-shape="cloud"]').click();
  expect((await patched).postDataJSON()).toEqual({ shape: "cloud" });
  await expect(panel.locator('[data-testid="bot-shape-option"][data-shape="cloud"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(sidebarAvatar).toHaveAttribute("data-shape", "cloud");
});

test("加第 6 个标签的输入框消失", async ({ page }) => {
  await login(page);
  await openBot(page, "小服");
  await page.getByTestId("bot-edit").click();
  const dialog = page.getByTestId("edit-bot-dialog");
  const input = dialog.getByTestId("edit-bot-tag-input");
  await expect(dialog.getByTestId("edit-bot-tag")).toHaveText(["客服"]);

  for (const tag of ["售后", "退款", "工单"]) {
    await input.fill(tag);
    await input.press("Enter");
  }
  await expect(dialog.getByTestId("edit-bot-tag")).toHaveCount(4);
  await expect(dialog, "回车只加标签，不提交弹窗").toBeVisible();
  await input.fill("交期");
  await input.press("Enter");
  await expect(dialog.getByTestId("edit-bot-tag")).toHaveCount(5);
  await expect(input, "满 5 个就没有地方再加").toHaveCount(0);

  await dialog.getByTestId("edit-bot-tag-remove").first().click();
  await expect(dialog.getByTestId("edit-bot-tag")).toHaveText(["售后", "退款", "工单", "交期"]);
  await expect(input, "点叉删掉一个，输入框回来").toBeVisible();
});

test("Bot 页上技能只在「它知道的」里看，设置栏没有技能入口、插件勾选、模型", async ({ page }) => {
  await login(page);
  await openBot(page, "小销");
  await openKnow(page);
  await expect(page.getByTestId("bot-know-skills")).toContainText("Globex 报价");

  const panel = page.getByTestId("bot-panel");
  await expect(panel.getByRole("tab"), "设置栏只剩一页，不要标签导航").toHaveCount(0);
  await expect(panel, "设置栏没有技能入口").not.toContainText("会做的活");
  await expect(panel.locator("input[type=checkbox]")).toHaveCount(0);
  await expect(page.getByTestId("bot-available-tools")).toHaveCount(0);
  const window = page.getByTestId("main-window");
  for (const word of ["可用工具", "模型"]) {
    await expect(window, `Bot 页上不出现「${word}」`).not.toContainText(word);
  }
});

test("旧长描述只改名字保存后仍是全文", async ({ page }) => {
  const legacy = "旧描述".repeat(34);
  expect(legacy, "比现在的写入上限长").toHaveLength(102);
  await login(page);
  const seeded = await page.request.post("/api/test/bot-description", {
    data: { botId: "bot_service", description: legacy },
  });
  expect(seeded.status()).toBe(204);
  await openBot(page, "小服");
  await expect(page.getByTestId("bot-header-description")).toHaveText(legacy);

  await page.getByTestId("bot-edit").click();
  const dialog = page.getByTestId("edit-bot-dialog");
  await expect(dialog.getByTestId("edit-bot-description"), "弹窗里也是全文").toHaveValue(legacy);
  await dialog.getByTestId("edit-bot-name").fill("小服二号");
  const patched = page.waitForRequest((sent) => sent.url().includes("/api/bots/") && sent.method() === "PATCH");
  await dialog.getByTestId("edit-bot-save").click();
  expect((await patched).postDataJSON(), "没动的描述和标签不送").toEqual({ name: "小服二号" });
  await expect(dialog).toHaveCount(0);

  const listed = (await (await page.request.get("/api/bots")).json()) as {
    items: { bot: { id: string; description: string } }[];
  };
  const stored = listed.items.find((item) => item.bot.id === "bot_service")?.bot.description;
  expect(stored, "服务端那份描述没被截短").toBe(legacy);
});

test("改动过的旧长描述要删到上限内才能存", async ({ page }) => {
  await login(page);
  await page.request.post("/api/test/bot-description", {
    data: { botId: "bot_service", description: "旧描述".repeat(34) },
  });
  await openBot(page, "小服");
  await page.getByTestId("bot-edit").click();
  const dialog = page.getByTestId("edit-bot-dialog");
  const description = dialog.getByTestId("edit-bot-description");
  await description.press("End");
  await description.press("Backspace");
  await expect(dialog.getByTestId("edit-bot-description-too-long")).toBeVisible();
  await expect(dialog.getByTestId("edit-bot-save"), "101 个字送出去只会被拒").toBeDisabled();

  await description.fill("接工单");
  await expect(dialog.getByTestId("edit-bot-description-too-long")).toHaveCount(0);
  const patched = page.waitForRequest((sent) => sent.url().includes("/api/bots/") && sent.method() === "PATCH");
  await dialog.getByTestId("edit-bot-save").click();
  expect((await patched).postDataJSON()).toEqual({ description: "接工单" });
  await expect(page.getByTestId("bot-header-description")).toHaveText("接工单");
});

test("编辑弹窗键盘：开窗焦点进弹窗、Tab 在弹窗里绕、关窗回到编辑按钮", async ({ page }) => {
  await login(page);
  await openBot(page, "小服");
  const edit = page.getByTestId("bot-edit");
  const dialog = page.getByTestId("edit-bot-dialog");

  await edit.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByTestId("edit-bot-name"), "开窗焦点落在名字上").toBeFocused();

  await dialog.getByTestId("edit-bot-save").focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "关闭" }), "Tab 过了最后一个绕回第一个").toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByTestId("edit-bot-save"), "Shift+Tab 从第一个绕到最后一个").toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(edit, "Escape 关窗回到编辑按钮").toBeFocused();

  await page.keyboard.press("Enter");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(edit, "取消回到编辑按钮").toBeFocused();

  await page.keyboard.press("Enter");
  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect(edit, "点叉回到编辑按钮").toBeFocused();

  await page.keyboard.press("Enter");
  await dialog.getByTestId("edit-bot-name").fill("小服二号");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("chat-title")).toHaveText("小服二号");
  await expect(edit, "保存成功回到编辑按钮").toBeFocused();
});

// 模拟断线窗口里错过的删除推送：页面收不到 preference_deleted，只能靠 DELETE 的回包。
const dropPreferenceDeletedPushes = async (page: Page) => {
  await page.addInitScript(() => {
    const original = WebSocket.prototype.addEventListener;
    WebSocket.prototype.addEventListener = function (
      this: WebSocket,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type !== "message") return original.call(this, type, listener, options);
      const filtered = (event: Event) => {
        const data: unknown = JSON.parse(String((event as MessageEvent).data));
        if (typeof data === "object" && data !== null && "type" in data && data.type === "preference_deleted") return;
        if (typeof listener === "function") listener.call(this, event);
        else listener.handleEvent(event);
      };
      return original.call(this, type, filtered, options);
    };
  });
};

test("更新推送插在删除发出与 204 之间也能删掉", async ({ page }) => {
  await dropPreferenceDeletedPushes(page);
  await login(page);
  await openBot(page, "小服");
  await openKnow(page);
  await expect(prefRows(page)).toHaveCount(5);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const held = new Promise<void>((resolve) => (reached = resolve));
  await page.route("**/api/preferences/prf_seed_1", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    reached();
    await gate;
    return route.continue();
  });
  const reply = page.waitForResponse(
    (res) => res.url().endsWith("/preferences/prf_seed_1") && res.request().method() === "DELETE",
  );
  try {
    await prefRows(page).first().getByTestId("bot-pref-forget").click();
    await held;
    expect((await page.request.patch("/api/preferences/prf_seed_1", { data: { private: true } })).status()).toBe(200);
    await expect(prefRows(page).first().locator("em"), "更新推送先到了").toHaveText("私人");
  } finally {
    release();
  }
  expect((await reply).status()).toBe(204);

  await expect(prefRows(page), "确认删掉的那条不被先到的更新挡住").toHaveCount(4);
  await expect(knowToggle(page)).toContainText("记住 4 条");
  await expect(page.locator("[data-testid=bot-pref-forget]:disabled"), "没有按钮停在忙").toHaveCount(0);
  const stored = (await (await page.request.get("/api/bots/bot_service/preferences")).json()) as { items: unknown[] };
  expect(stored.items).toHaveLength(4);
});

test("错过删除推送后 404 收敛", async ({ page }) => {
  await dropPreferenceDeletedPushes(page);
  await login(page);
  await openBot(page, "小服");
  await openKnow(page);
  await expect(prefRows(page)).toHaveCount(5);

  expect((await page.request.delete("/api/preferences/prf_seed_1")).status(), "别处先删了").toBe(204);
  await expect(prefRows(page), "推送被丢，页面还留着旧行").toHaveCount(5);

  const deleted = page.waitForResponse(
    (res) => res.url().endsWith("/preferences/prf_seed_1") && res.request().method() === "DELETE",
  );
  await prefRows(page).first().getByTestId("bot-pref-forget").click();
  expect((await deleted).status()).toBe(404);
  await expect(prefRows(page), "404 就是已经没了，本地去掉").toHaveCount(4);
  await expect(page.getByTestId("bot-know").getByRole("alert"), "不报没忘掉").toHaveCount(0);
});

test("忘掉失败不是 404 时照旧报错可重试", async ({ page }) => {
  await login(page);
  await openBot(page, "小服");
  await openKnow(page);
  let failures = 1;
  await page.route("**/api/preferences/prf_seed_1", async (route) => {
    if (route.request().method() !== "DELETE" || failures-- <= 0) return route.continue();
    return route.fulfill({ status: 500, json: { error: "出错了" } });
  });
  const row = prefRows(page).first();
  await row.getByTestId("bot-pref-forget").click();
  await expect(row.getByRole("alert")).toHaveText("没忘掉，再试一次");
  await expect(prefRows(page)).toHaveCount(5);

  await row.getByTestId("bot-pref-forget").click();
  await expect(prefRows(page), "重试成功就删掉").toHaveCount(4);
});

type HeldPreferencePushes = {
  seen: string[];
  release: (kind: string) => void;
};

// 把 preference_updated / preference_deleted 扣在浏览器里，由测试按次序放行，摆出「旧更新帧晚于删除确认才处理」的局面。
// dropDeleted 还会把 preference_deleted 直接丢掉，模拟断线窗口里错过的删除推送。
const holdPreferencePushes = async (page: Page, options: { dropDeleted: boolean }) => {
  await page.addInitScript((dropDeleted: boolean) => {
    const held: { kind: string; deliver: () => void }[] = [];
    const pushes: HeldPreferencePushes = {
      seen: [],
      release: (kind) => {
        const at = held.findIndex((frame) => frame.kind === kind);
        if (at < 0) throw new Error(`没有扣着的 ${kind} 帧`);
        held.splice(at, 1)[0]?.deliver();
      },
    };
    Object.assign(window, { heldPreferencePushes: pushes });
    const original = WebSocket.prototype.addEventListener;
    WebSocket.prototype.addEventListener = function (
      this: WebSocket,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type !== "message") return original.call(this, type, listener, options);
      const intercept = (event: Event) => {
        const data: unknown = JSON.parse(String((event as MessageEvent).data));
        const kind = typeof data === "object" && data !== null && "type" in data ? String(data.type) : "";
        const deliver = () =>
          typeof listener === "function" ? listener.call(this, event) : listener.handleEvent(event);
        if (kind !== "preference_updated" && kind !== "preference_deleted") return deliver();
        pushes.seen.push(kind);
        if (kind === "preference_deleted" && dropDeleted) return;
        held.push({ kind, deliver });
      };
      return original.call(this, type, intercept, options);
    };
  }, options.dropDeleted);
};

const seenPreferencePushes = (page: Page) =>
  page.evaluate(() => (window as unknown as { heldPreferencePushes: HeldPreferencePushes }).heldPreferencePushes.seen);

const releasePreferencePush = (page: Page, kind: "preference_updated" | "preference_deleted") =>
  page.evaluate(
    (frame) =>
      (window as unknown as { heldPreferencePushes: HeldPreferencePushes }).heldPreferencePushes.release(frame),
    kind,
  );

// 放行旧更新帧之后，让另一条偏好再更新一次当哨兵：哨兵的「私人」显示出来，前面放行的帧就一定已经处理完，
// 这时再断言「没加回来」才不是在帧还没落地时空过。
const expectStaleUpdateIgnored = async (page: Page) => {
  const seenBefore = (await seenPreferencePushes(page)).length;
  expect((await page.request.patch("/api/preferences/prf_seed_2", { data: { private: true } })).status()).toBe(200);
  await expect.poll(async () => (await seenPreferencePushes(page)).length).toBe(seenBefore + 1);
  await releasePreferencePush(page, "preference_updated");
  await expect(prefRows(page).filter({ hasText: "交期只说确定的日子" }).locator("em"), "哨兵帧已处理").toHaveText(
    "私人",
  );

  await expect(prefRows(page), "删掉的偏好没被旧更新帧加回来").toHaveCount(4);
  await expect(prefRows(page).filter({ hasText: "回客户先称呼对方名字" })).toHaveCount(0);
  await expect(knowToggle(page)).toContainText("记住 4 条");
  const stored = (await (await page.request.get("/api/bots/bot_service/preferences")).json()) as { items: unknown[] };
  expect(stored.items, "服务端也是 4 条").toHaveLength(4);
};

for (const dropDeleted of [false, true]) {
  test(`PATCH 已返回、DELETE 204 之后才处理旧更新帧，偏好不回来（删除推送${dropDeleted ? "被丢" : "扣住未放"}）`, async ({
    page,
  }) => {
    await holdPreferencePushes(page, { dropDeleted });
    await login(page);
    await openBot(page, "小服");
    await openKnow(page);
    await expect(prefRows(page)).toHaveCount(5);

    expect((await page.request.patch("/api/preferences/prf_seed_1", { data: { private: true } })).status()).toBe(200);
    await expect.poll(() => seenPreferencePushes(page)).toEqual(["preference_updated"]);
    const written = (await (await page.request.get("/api/bots/bot_service/preferences")).json()) as {
      items: { id: string; private: boolean }[];
    };
    expect(written.items.find((item) => item.id === "prf_seed_1")?.private, "PATCH 已写库").toBe(true);

    const deleted = page.waitForResponse(
      (res) => res.url().endsWith("/preferences/prf_seed_1") && res.request().method() === "DELETE",
    );
    await prefRows(page).first().getByTestId("bot-pref-forget").click();
    expect((await deleted).status()).toBe(204);
    await expect(prefRows(page), "204 就删掉了，不等推送").toHaveCount(4);
    await expect.poll(() => seenPreferencePushes(page)).toEqual(["preference_updated", "preference_deleted"]);

    await releasePreferencePush(page, "preference_updated");
    await expectStaleUpdateIgnored(page);
  });
}

test("收到删除推送后，晚到的旧更新帧不把偏好加回来", async ({ page }) => {
  await holdPreferencePushes(page, { dropDeleted: false });
  await login(page);
  await openBot(page, "小服");
  await openKnow(page);
  await expect(prefRows(page)).toHaveCount(5);

  expect((await page.request.patch("/api/preferences/prf_seed_1", { data: { private: true } })).status()).toBe(200);
  expect((await page.request.delete("/api/preferences/prf_seed_1")).status(), "别处删的").toBe(204);
  await expect.poll(() => seenPreferencePushes(page)).toEqual(["preference_updated", "preference_deleted"]);
  await expect(prefRows(page), "两帧都扣着，页面还没动").toHaveCount(5);

  await releasePreferencePush(page, "preference_deleted");
  await expect(prefRows(page), "删除推送到了就去掉").toHaveCount(4);
  await releasePreferencePush(page, "preference_updated");
  await expectStaleUpdateIgnored(page);
});

test("右侧设置栏能收起、能再打开，换 Bot 和刷新后都记着", async ({ page }) => {
  await login(page);
  await openBot(page, "小服");
  const panel = page.getByTestId("bot-panel");
  const toggle = page.getByTestId("bot-panel-toggle");
  await expect(panel, "第一次进来默认展开").toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  await panel.getByTestId("bot-panel-close").click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId("main-window"), "收起后对话区吃满右栏").toHaveClass(/is-wide/);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  await page.getByTestId("assistant-nav").click();
  await expect(page.getByTestId("bot-panel"), "换个 Bot 不会又弹出来").toHaveCount(0);
  await page.reload();
  await page.getByTestId("assistant-nav").click();
  await expect(page.getByTestId("bot-panel"), "刷新后仍收着").toHaveCount(0);

  await page.getByTestId("bot-panel-toggle").click();
  await expect(page.getByTestId("bot-panel")).toBeVisible();
  await expect(page.getByTestId("main-window")).not.toHaveClass(/is-wide/);
  await page.getByTestId("bot-panel-toggle").click();
  await expect(page.getByTestId("bot-panel"), "头部按钮也能收起").toHaveCount(0);
});
