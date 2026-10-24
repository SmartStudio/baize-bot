import {
  expect,
  test,
  Message,
  MessageListResponse,
  login,
  openBot,
  sendText,
  type APIRequestContext,
  type Page,
} from "./fixtures";

const GROUP = "grp_sales";
const HISTORY = `**/api/groups/${GROUP}/messages*`;
const label = (n: number) => `第 ${String(n).padStart(3, "0")} 条`;

type Seeding = { botSays?: (n: number) => boolean; approvalAt?: number };

const seedHistory = async (
  request: APIRequestContext,
  count: number,
  { botSays = (n) => n % 2 === 0, approvalAt }: Seeding = {},
) => {
  const start = Date.now() - (count + 5) * 60_000;
  for (let n = 1; n <= count; n += 1) {
    const createdAt = new Date(start + n * 60_000).toISOString();
    if (n === approvalAt) {
      const approval = await request.post("/api/test/approval", {
        data: { groupId: GROUP, action: "shell", createdAt },
      });
      expect(approval.status(), `第 ${n} 条造成审批卡`).toBe(201);
      continue;
    }
    const response = await request.post("/api/test/messages", {
      data: { groupId: GROUP, text: label(n), createdAt, silent: true, ...(botSays(n) ? { botId: "bot_sales" } : {}) },
    });
    expect(response.status(), `造第 ${n} 条历史`).toBe(204);
  }
};

const olderRequests = (page: Page) => {
  const befores: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" || !request.url().includes(`/api/groups/${GROUP}/messages`)) return;
    const before = new URL(request.url()).searchParams.get("before");
    if (before !== null) befores.push(before);
  });
  return befores;
};

const shown = (page: Page, n: number) => page.getByTestId("message-list").getByText(label(n), { exact: true });

// 这一条离列表可见区顶边多远。滚动条位置一设就同步量，赶在滚动事件触发拉取之前。
const offsetOf = (page: Page, target: number | "approval", scrollTop?: number) =>
  page.getByTestId("message-list").evaluate(
    (list, [text, top]) => {
      if (top !== null) list.scrollTop = top;
      const found = [...list.querySelectorAll<HTMLElement>("[data-testid=message]")].find((element) =>
        text === null ? element.dataset.kind === "approval" : element.textContent?.trim() === text,
      );
      if (found === undefined) throw new Error(`${text ?? "审批卡"} 不在列表里`);
      return found.getBoundingClientRect().top - list.getBoundingClientRect().top;
    },
    [target === "approval" ? null : label(target), scrollTop ?? null] as const,
  );

const distanceToBottom = (page: Page) =>
  page.getByTestId("message-list").evaluate((list) => list.scrollHeight - list.scrollTop - list.clientHeight);

test("打开群只有最近一页，滚到顶往上翻，正看着的那条不跳，到头了提示且不再请求", async ({ page }) => {
  await seedHistory(page.request, 120);
  const befores = olderRequests(page);
  await login(page);
  await openBot(page, "小销");

  await expect(shown(page, 120), "最新一条在").toBeVisible();
  await expect(shown(page, 71), "最近一页从第 71 条起").toBeAttached();
  await expect(shown(page, 70), "更早的还没拉").toHaveCount(0);
  expect(await distanceToBottom(page), "打开时停在最底下").toBeLessThan(24);
  expect(befores, "打开群不带 before").toEqual([]);

  const before = await offsetOf(page, 71, 0);
  await expect(shown(page, 70), "滚到顶接出了更早的一页").toBeAttached();
  await expect(shown(page, 21)).toBeAttached();
  await expect(page.getByTestId("older-loading")).toHaveCount(0);
  expect(Math.abs((await offsetOf(page, 71)) - before), "接上更早的一页之后，原来顶上那条没挪").toBeLessThan(2);
  expect(befores).toHaveLength(1);

  await offsetOf(page, 21, 0);
  await expect(shown(page, 1), "再翻一页到了最早的第 1 条").toBeAttached();
  await expect(page.getByTestId("history-start")).toHaveText("已经是最早的消息了");
  expect(befores).toHaveLength(2);
  expect(new Set(befores).size, "每页的 before 都不一样").toBe(2);

  await offsetOf(page, 1, 400);
  await offsetOf(page, 1, 0);
  await sendText(page, "到头了还会再拉吗");
  await expect(page.getByTestId("message-list").getByText("到头了还会再拉吗")).toBeAttached();
  expect(befores, "到头之后滚到顶不再请求").toHaveLength(2);

  for (const n of [1, 20, 21, 70, 71, 120]) await expect(shown(page, n), `${label(n)} 只出现一次`).toHaveCount(1);

  await page.getByTestId("message-list").evaluate((list) => {
    list.scrollTop = list.scrollHeight;
  });
  await expect(shown(page, 120)).toBeInViewport();
  await expect.poll(() => distanceToBottom(page), "滚到底就停在底，不往回弹").toBeLessThan(24);
  await page.getByTestId("chat").screenshot({ path: "test-results/chat-history-bottom.png" });
});

test("更早的一页以同一个 Bot 的话结尾，并进最近一页打头的那段回答，正看着的那条不跳", async ({ page }) => {
  await seedHistory(page.request, 120, { botSays: (n) => (n >= 60 && n <= 85) || n % 2 === 0 });
  await login(page);
  await openBot(page, "小销");
  await expect(shown(page, 120)).toBeVisible();
  await expect(shown(page, 70)).toHaveCount(0);

  const before = await offsetOf(page, 75, 0);
  await expect(shown(page, 60), "接出了更早的一页").toBeAttached();
  await expect(page.getByTestId("older-loading")).toHaveCount(0);
  await expect(page.getByTestId("bot-turn").filter({ hasText: label(60) }), "第 60 到 85 条并成一个回合").toContainText(
    label(85),
  );
  expect(Math.abs((await offsetOf(page, 75)) - before), "第 75 条离可见区顶的距离没变").toBeLessThan(2);
});

test("最近一页以审批卡打头、更早的一页以 Bot 的话结尾，卡并进回答之后正看着的那条不跳", async ({ page }) => {
  await seedHistory(page.request, 120, { approvalAt: 71 });
  await login(page);
  await openBot(page, "小销");
  await expect(shown(page, 120)).toBeVisible();
  await expect(page.getByTestId("message-list").getByTestId("approval-card")).toHaveCount(1);
  await expect(shown(page, 70)).toHaveCount(0);

  const before = await offsetOf(page, "approval", 0);
  await expect(shown(page, 70), "接出了更早的一页").toBeAttached();
  await expect(page.getByTestId("older-loading")).toHaveCount(0);
  await expect(
    page
      .getByTestId("bot-turn")
      .filter({ hasText: label(70) })
      .getByTestId("approval-card"),
    "审批卡并进了第 70 条那段回答",
  ).toHaveCount(1);
  expect(Math.abs((await offsetOf(page, "approval")) - before), "顶上那张审批卡离可见区顶的距离没变").toBeLessThan(2);
});

test("往上读的时候，可见区上方的审批卡改了高度，正看着的那条不跳", async ({ page }) => {
  await seedHistory(page.request, 120, { approvalAt: 100 });
  await login(page);
  await openBot(page, "小销");
  await expect(shown(page, 120)).toBeVisible();
  const card = page.getByTestId("message-list").getByTestId("approval-card");
  await expect(card).toHaveAttribute("data-status", "pending");

  await page.getByTestId("message-list").evaluate((list) => {
    const approval = list.querySelector<HTMLElement>("[data-testid=message][data-kind=approval]");
    if (approval === null) throw new Error("审批卡不在列表里");
    list.scrollTop += approval.getBoundingClientRect().bottom - list.getBoundingClientRect().top + 40;
  });
  await expect(card, "审批卡在可见区上方").not.toBeInViewport();
  const before = await offsetOf(page, 103);
  const height = await card.evaluate((element) => element.getBoundingClientRect().height);

  expect((await page.request.post("/api/test/approval/timeout")).status()).toBe(204);
  await expect(card).not.toHaveAttribute("data-status", "pending");
  expect(await card.evaluate((element) => element.getBoundingClientRect().height), "审批卡确实变了高度").not.toBe(
    height,
  );
  expect(Math.abs((await offsetOf(page, 103)) - before), "第 103 条离可见区顶的距离没变").toBeLessThan(2);
});

test("往上读历史时来了新消息，照常追加但不把视图拽到底；回到底部后新消息跟着走", async ({ page }) => {
  await seedHistory(page.request, 120);
  await login(page);
  await openBot(page, "小销");
  await expect(shown(page, 120)).toBeVisible();

  const before = await offsetOf(page, 71, 0);
  await expect(shown(page, 70)).toBeAttached();
  await expect(page.getByTestId("older-loading")).toHaveCount(0);

  const pushed = await page.request.post("/api/test/messages", {
    data: { groupId: GROUP, text: "读历史时来的新消息", botId: "bot_sales" },
  });
  expect(pushed.status()).toBe(204);
  await expect(page.getByTestId("message-list").getByText("读历史时来的新消息"), "推送照常追加").toBeAttached();
  expect(Math.abs((await offsetOf(page, 71)) - before), "推送没把正看着的那条挪走").toBeLessThan(2);
  expect(await distanceToBottom(page), "没被拽到底").toBeGreaterThan(500);
  await expect(page.getByTestId("scroll-to-bottom")).toBeVisible();

  await page.getByTestId("scroll-to-bottom").click();
  await page.request.post("/api/test/messages", { data: { groupId: GROUP, text: "回到底部之后的新消息" } });
  await expect(page.getByTestId("message-list").getByText("回到底部之后的新消息")).toBeInViewport();
  expect(await distanceToBottom(page), "在底部时新消息跟着滚下来").toBeLessThan(24);
});

test("更早的一页和已有的消息重叠，按 id 只留一条", async ({ page }) => {
  await seedHistory(page.request, 120);
  await page.route(HISTORY, async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || url.searchParams.get("before") === null) return route.continue();
    const response = await route.fetch();
    const older = MessageListResponse.parse(await response.json());
    const latest = MessageListResponse.parse(await (await page.request.get(`/api/groups/${GROUP}/messages`)).json());
    const overlap = [...older.messages, ...older.messages.slice(-3), ...latest.messages.slice(0, 3)];
    await route.fulfill({ response, json: { ...older, messages: overlap } });
  });
  await login(page);
  await openBot(page, "小销");
  await expect(shown(page, 120)).toBeVisible();

  await offsetOf(page, 71, 0);
  await expect(shown(page, 21)).toBeAttached();
  for (const n of [21, 68, 69, 70, 71, 72, 73]) await expect(shown(page, n), `${label(n)} 只出现一次`).toHaveCount(1);
});

test("更早的一页没拉下来，顶上给重试，不自己反复拉；点重试接上", async ({ page }) => {
  await seedHistory(page.request, 120);
  const befores = olderRequests(page);
  let failures = 1;
  await page.route(HISTORY, async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || url.searchParams.get("before") === null || failures === 0)
      return route.continue();
    failures -= 1;
    await route.fulfill({ status: 503, json: { error: "上游忙" } });
  });
  await login(page);
  await openBot(page, "小销");
  await expect(shown(page, 120)).toBeVisible();

  await offsetOf(page, 71, 0);
  await expect(page.getByTestId("older-failed")).toContainText("更早的消息没拉下来");
  await offsetOf(page, 71, 300);
  await offsetOf(page, 71, 0);
  await sendText(page, "失败之后滚到顶");
  await expect(page.getByTestId("message-list").getByText("失败之后滚到顶")).toBeAttached();
  expect(befores, "失败之后滚动不自己重拉").toHaveLength(1);
  await expect(shown(page, 70)).toHaveCount(0);

  await page.getByTestId("older-retry").click();
  await expect(shown(page, 70), "重试接上了更早的一页").toBeAttached();
  await expect(page.getByTestId("older-failed")).toHaveCount(0);
  expect(befores).toHaveLength(2);
});

// 最近一页里第 from 到 to 条 Bot 的话换成工具调用，收进那段回答的「做了几步」。返回每条的消息 id。
const toolsAt = async (page: Page, from: number, to: number) => {
  const ids = new Map<number, string>();
  await page.route(HISTORY, async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || url.searchParams.get("before") !== null) return route.continue();
    const response = await route.fetch();
    const latest = MessageListResponse.parse(await response.json());
    const messages = latest.messages.map((message) => {
      const n = message.body.kind === "bot" ? Number(/第 (\d+) 条/.exec(message.body.text)?.[1]) : NaN;
      if (!(n >= from && n <= to)) return message;
      ids.set(n, message.id);
      const command = `echo ${label(n)}`;
      return Message.parse({
        ...message,
        body: {
          kind: "tool_call",
          runId: "",
          botId: "bot_sales",
          tool: "bash",
          view: { kind: "bash", command, raw: { command } },
          status: "ok",
          durationMs: 1000,
        },
      });
    });
    await route.fulfill({ response, json: { ...latest, messages } });
  });
  return (n: number) => {
    const id = ids.get(n);
    if (id === undefined) throw new Error(`${label(n)} 没换成工具调用`);
    return id;
  };
};

// 按消息 id 量离可见区顶边多远。给了 top 就先把这条的顶边摆到可见区顶边下 top 处，同步量，赶在滚动事件之前。
const offsetOfId = (page: Page, id: string, top?: number) =>
  page.getByTestId("message-list").evaluate(
    (list, [messageId, at]) => {
      const found = list.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
      if (found === null) throw new Error(`${messageId} 不在列表里`);
      if (found.getClientRects().length === 0) return { offset: NaN, scrollTop: list.scrollTop };
      const offset = () => found.getBoundingClientRect().top - list.getBoundingClientRect().top;
      if (at !== null) list.scrollTop += offset() - at;
      return { offset: offset(), scrollTop: list.scrollTop };
    },
    [id, top ?? null] as const,
  );

const nextFrame = (page: Page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

test("点开最近一页打头回合的「做了几步」，锚在工具行上往上翻，接页之后还展开着、那一行不跳", async ({ page }) => {
  await seedHistory(page.request, 120, { botSays: (n) => (n >= 60 && n <= 85) || (n % 2 === 0 && n !== 86) });
  const toolId = await toolsAt(page, 72, 85);
  await login(page);
  await openBot(page, "小销");
  await expect(shown(page, 120)).toBeVisible();
  await expect(shown(page, 70)).toHaveCount(0);

  const head = page.getByTestId("bot-turn").filter({ hasText: label(71) });
  await expect(head.getByTestId("activity-toggle"), "第 72 到 85 条收进打头回合的「做了几步」").toHaveText(
    "做了 14 步",
  );
  // 用 click() 的话 Playwright 先把开关滚进可见区，打头回合就在顶上，一滚就先翻了页。
  await head.getByTestId("activity-toggle").dispatchEvent("click");
  await expect(head.getByTestId("activity-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(shown(page, 70), "点开时还没往上翻").toHaveCount(0);

  const placed = await offsetOfId(page, toolId(72), -4);
  expect(placed.scrollTop, "第 72 条那行工具贴顶时已经进了往上翻的范围").toBeLessThan(200);

  await expect(shown(page, 60), "接出了更早的一页").toBeAttached();
  await expect(page.getByTestId("older-loading")).toHaveCount(0);
  const merged = page.getByTestId("bot-turn").filter({ hasText: label(60) });
  await expect(merged, "更早一页的第 60 到 70 条并进了打头回合").toContainText(label(71));
  await expect
    .soft(merged.getByTestId("activity-toggle"), "并页之后「做了几步」还展开着")
    .toHaveAttribute("aria-expanded", "true");
  const after = await offsetOfId(page, toolId(72));
  expect(Math.abs(after.offset - placed.offset), "第 72 条那行工具离可见区顶的距离没变").toBeLessThan(2);
});

test("正看着的工具行被收起来了，退到下面那条钉住，不跳", async ({ page }) => {
  await seedHistory(page.request, 40, { botSays: (n) => (n >= 10 && n <= 25) || (n % 2 === 0 && n !== 26) });
  const toolId = await toolsAt(page, 12, 25);
  await login(page);
  await openBot(page, "小销");
  await expect(shown(page, 40)).toBeVisible();
  await expect(page.getByTestId("history-start"), "40 条一页装得下").toBeVisible();

  const toggle = page
    .getByTestId("bot-turn")
    .filter({ hasText: label(11) })
    .getByTestId("activity-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  // 最后一行工具往上滚出去一点，它下面是第 26 条，开关在可见区上方。这时离底不到十四行工具那么高，
  // 一收起来浏览器先把滚动位置夹到新的底，不能把这当成人滚过。
  await offsetOfId(page, toolId(25), -6);
  await nextFrame(page);
  await expect(toggle).not.toBeInViewport();
  const before = await offsetOf(page, 26);
  const height = () => page.getByTestId("message-list").evaluate((list) => list.scrollHeight);
  const [tall, distance] = [await height(), await distanceToBottom(page)];

  await toggle.dispatchEvent("click");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(distance, "离底比收掉的工具行矮，滚动位置会被夹").toBeLessThan(tall - (await height()));
  expect(Math.abs((await offsetOf(page, 26)) - before), "第 26 条离可见区顶的距离没变").toBeLessThan(2);
});

test("刚滚过、滚动事件还没到时界面重画，不把视图拽回滚之前", async ({ page }) => {
  await seedHistory(page.request, 120);
  await login(page);
  await openBot(page, "小销");
  await expect(shown(page, 120)).toBeVisible();
  await page.getByTestId("message-list").evaluate((list) => {
    list.scrollTop = list.scrollHeight / 2;
  });
  await expect(page.getByTestId("scroll-to-bottom"), "滚动事件到了，已经离开底部").toBeVisible();

  // 同一个任务里先往上滚 300px，再在输入框打字让面板重画，这时滚动事件还没派发。
  const scrolled = await page.getByTestId("message-list").evaluate(async (list) => {
    const input = document.querySelector<HTMLTextAreaElement>("[data-testid=composer-input]");
    if (input === null) throw new Error("输入框不在");
    const before = list.scrollTop;
    list.scrollTop = before - 300;
    const intended = list.scrollTop;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, "滚的同时打字");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const rendered = list.scrollTop;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { before, intended, rendered, after: list.scrollTop };
  });
  await expect(page.getByTestId("composer-input")).toHaveValue("滚的同时打字");
  expect(scrolled.intended, "确实往上滚了").toBeLessThan(scrolled.before - 200);
  expect(Math.abs(scrolled.after - scrolled.intended), `重画没把视图拽回去 ${JSON.stringify(scrolled)}`).toBeLessThan(
    1,
  );
});
