import { expect, test, type Page } from "@playwright/test";

const EMAIL = "chen@baize.dev";
const PASSWORD = "baize-dev";
const SHOT = "e2e/screenshots";

test.beforeEach(async ({ request }) => {
  expect((await request.post("/api/test/reset")).status(), "mock 状态倒回预置的三个 Bot").toBe(204);
});

const fillCredentials = async (page: Page, password: string) => {
  await page.goto("/");
  await page.getByTestId("workspace-input").fill("acme");
  await page.getByTestId("workspace-continue").click();
  await page.getByTestId("email-input").fill(EMAIL);
  await page.getByTestId("password-input").fill(password);
  await page.getByTestId("login-submit").click();
};

const login = async (page: Page) => {
  await fillCredentials(page, PASSWORD);
  await expect(page.getByTestId("main-window")).toBeVisible();
};

const openBot = async (page: Page, name: string) => {
  await page.locator(`[data-testid=bot-item][data-bot-name="${name}"]`).click();
  await expect(page.getByTestId("chat-title")).toHaveText(name);
};

// 切过去之后历史才开始拉。不等它到齐就数消息，数到的是一份还没填上的空列表。
const openSeededBot = async (page: Page, name: string) => {
  await openBot(page, name);
  await expect(page.getByTestId("message-list").getByTestId("message"), "预置的历史到齐了").not.toHaveCount(0);
};

const sendText = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
};

type RunTrace = { tool: string[]; streaming: boolean[]; working: boolean[] };

declare global {
  interface Window {
    __runTrace?: RunTrace;
  }
}

// 运行中、流式光标、「干活中」这三种状态各只活几百毫秒，等轮询断言撞上是在赌运气。
// 装个观察器把每次变化按先后记下来，跑完再断言这串序列。
const traceRun = (page: Page) =>
  page.evaluate(() => {
    const trace: RunTrace = { tool: [], streaming: [], working: [] };
    window.__runTrace = trace;
    const push = <T>(log: T[], value: T) => {
      if (log.at(-1) !== value) log.push(value);
    };
    const sample = () => {
      const status = document.querySelector("[data-testid=tool-call-card]")?.getAttribute("data-status");
      if (typeof status === "string") push(trace.tool, status);
      push(trace.streaming, document.querySelector("[data-testid=bot-bubble][data-streaming=true]") !== null);
      push(trace.working, document.querySelector("[data-testid=bot-working]") !== null);
    };
    sample();
    new MutationObserver(sample).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });

type DeltaFrame = { messageId: string; delta: string; done: boolean };

// 推送经 Vite 的 /api 代理走同一条 WebSocket，抓帧就能看见控制面真的分了几段推。
const recordDeltas = (page: Page): DeltaFrame[] => {
  const seen: DeltaFrame[] = [];
  page.on("websocket", (socket) =>
    socket.on("framereceived", (frame) => {
      let push: Record<string, unknown>;
      try {
        push = JSON.parse(String(frame.payload)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (push["type"] !== "message_delta") return;
      seen.push({
        messageId: String(push["messageId"]),
        delta: String(push["delta"]),
        done: push["done"] === true,
      });
    }),
  );
  return seen;
};

const openSettings = async (page: Page) => {
  await page.getByTestId("account-button").click();
  await expect(page.getByTestId("account-menu")).toBeVisible();
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("settings-window")).toBeVisible();
};

test("密码不对时登录页留在原地并说明原因", async ({ page }) => {
  await fillCredentials(page, "wrong-password");
  await expect(page.getByTestId("login-error")).toHaveText("邮箱或密码不对");
  await expect(page.getByTestId("main-window")).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/login");
  await page.screenshot({ path: `${SHOT}/01.png` });
});

test("登录成功进主窗口，侧栏列出预置的三个 Bot", async ({ page }) => {
  await login(page);
  const names = page.locator("[data-testid=bot-item]");
  await expect(names).toHaveCount(3);
  for (const name of ["小服", "小销", "小采"]) {
    await expect(page.locator(`[data-testid=bot-item][data-bot-name="${name}"]`)).toHaveCount(1);
  }
  await page.screenshot({ path: `${SHOT}/02.png` });
});

test("小服的对话里 bot、tool_call、cost 三种消息各渲染成一张卡", async ({ page }) => {
  await login(page);
  await openBot(page, "小服");
  const list = page.getByTestId("message-list");
  await expect(list.getByTestId("message")).toHaveCount(6);
  await expect(list.locator("[data-kind=user]")).toHaveCount(1);
  await expect(list.locator("[data-kind=bot]")).toHaveCount(2);
  await expect(list.locator("[data-kind=system]")).toHaveCount(1);
  await expect(list.locator("[data-kind=tool_call]").getByTestId("tool-call-card")).toHaveCount(1);
  await expect(list.locator("[data-kind=cost]").getByTestId("cost-card")).toHaveCount(1);
  await expect(list.getByTestId("cost-card")).toContainText("约 ¥4.6");
  await expect(list.getByTestId("message").first()).toHaveAttribute("data-kind", "user");
  // 登录后本来就选中第一个 Bot，整窗截图会和 02 一模一样，所以 2a 只截对话这一栏。
  await page.getByTestId("chat").screenshot({ path: `${SHOT}/2a.png` });
});

test("发一条消息后它出现在列表里，Bot 的回复从 WebSocket 推回来", async ({ page }) => {
  await login(page);
  await openSeededBot(page, "小销");
  const list = page.getByTestId("message-list");
  const botsBefore = await list.locator("[data-kind=bot]").count();
  const text = "把 Globex 的报价单再核一遍";

  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();

  await expect(list.locator("[data-kind=user]", { hasText: text })).toHaveCount(1);
  await expect(list.locator("[data-kind=bot]")).toHaveCount(botsBefore + 1);
  // Bot 回完会紧跟一张花费卡，侧栏摘要停在最后那条上。
  await expect(page.locator('[data-testid=bot-item][data-bot-name="小销"]')).toContainText("本次花费");
});

test("点加号建的新 Bot 进侧栏并直接进入它的对话", async ({ page }) => {
  await login(page);
  const items = page.locator("[data-testid=bot-item]");
  const before = await items.count();

  await page.getByTestId("new-bot").click();

  await expect(items).toHaveCount(before + 1);
  const created = await page.getByTestId("chat-title").textContent();
  expect(created).toMatch(/^新 Bot/);
  await expect(page.locator(`[data-testid=bot-item][data-bot-name="${created}"]`)).toHaveClass(/is-selected/);
  await expect(page.getByTestId("message-list").getByTestId("message")).toHaveCount(0);
  await expect(page.getByTestId("bot-name-input")).toHaveValue(String(created));
  await page.screenshot({ path: `${SHOT}/2b.png` });
});

test("改完描述刷新页面还在", async ({ page }) => {
  await login(page);
  await openBot(page, "小采");
  const description = "只比价和询价，下单和付钱先找我点头。";

  const saved = page.waitForResponse((res) => res.url().includes("/api/bots/") && res.request().method() === "PATCH");
  await page.getByTestId("bot-description-input").fill(description);
  await page.getByTestId("bot-name-input").click();
  await saved;

  await page.reload();
  await openBot(page, "小采");
  await expect(page.getByTestId("bot-description-input")).toHaveValue(description);
});

test("设置通用页切到深色，html 的 data-theme 变 dark", async ({ page }) => {
  await login(page);
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", "dark");

  await openSettings(page);
  await page.getByTestId("theme-select").selectOption("dark");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByTestId("notify-switch")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("dnd-from")).toHaveValue("22:00");
  await page.screenshot({ path: `${SHOT}/07.png` });

  await page.getByTestId("settings-nav-computer").click();
  await expect(page.getByTestId("settings-later")).toHaveText("电脑 · 后续");

  // 刷新才分得清「存住了」和「服务端把 patch 原样回了一遍」。
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("退出登录回到登录页", async ({ page }) => {
  await login(page);
  await page.getByTestId("account-button").click();
  await page.getByTestId("logout").click();

  await expect(page.getByTestId("login")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/login");
  await expect(page.getByTestId("main-window")).toHaveCount(0);

  // 服务端会话真作废了才算退出，光清 cookie 的话刷新会把人放回主窗口。
  await page.reload();
  await expect(page.getByTestId("login")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/login");
});

test("Bot 的回复分多段 delta 推回来，在同一个气泡里拼成一条完整消息", async ({ page }) => {
  const deltas = recordDeltas(page);
  await login(page);
  await openSeededBot(page, "小销");
  await traceRun(page);
  const list = page.getByTestId("message-list");
  const botsBefore = await list.locator("[data-kind=bot]").count();

  await sendText(page, "把 Globex 的报价单再核一遍");
  await expect(page.getByTestId("composer-input"), "点了发送输入框就空，不等服务端回话").toHaveValue("");
  await expect(list.getByTestId("cost-card"), "花费卡到了就说明这次运行跑完了").toHaveCount(1);

  expect(deltas.length, "回复至少分三段推回来").toBeGreaterThanOrEqual(3);
  expect(new Set(deltas.map((d) => d.messageId)).size, "这些段属于同一条消息").toBe(1);
  expect(deltas.at(-1)?.done, "最后一段带 done").toBe(true);
  await expect(list.locator("[data-kind=bot]"), "多段 delta 只长出一条 Bot 消息").toHaveCount(botsBefore + 1);
  await expect(list.getByTestId("bot-bubble").last(), "气泡里是各段原样拼起来的全文").toHaveText(
    deltas.map((d) => d.delta).join(""),
  );

  const trace = await page.evaluate(() => window.__runTrace);
  expect(trace?.streaming, "拼的过程中气泡带光标").toContain(true);
  await expect(page.getByTestId("streaming-caret"), "拼完光标收起").toHaveCount(0);
});

test("工具调用卡在同一张卡上从运行中变完成", async ({ page }) => {
  await login(page);
  await openBot(page, "小销");
  await traceRun(page);
  const list = page.getByTestId("message-list");

  await sendText(page, "查一下 X3 还有多少现货");
  await expect(list.getByTestId("cost-card")).toHaveCount(1);

  const card = list.getByTestId("tool-call-card");
  await expect(card, "同一个 id 重推是改这张卡，不是再添一张").toHaveCount(1);
  const trace = await page.evaluate(() => window.__runTrace);
  expect(trace?.tool, "这张卡先运行中后完成").toEqual(["running", "ok"]);
  await expect(card, "工具名、参数摘要、耗时、状态都在卡上").toContainText("erp.query");
  await expect(card).toContainText("ERP · 查一下 X3 还有多少");
  await expect(card).toContainText("1s");
  await expect(card).toContainText("完成");
});

test("运行结束出现花费卡，侧栏摘要跟着换，跑的过程中标「干活中」", async ({ page }) => {
  await login(page);
  await openBot(page, "小采");
  await traceRun(page);
  const item = page.locator('[data-testid=bot-item][data-bot-name="小采"]');
  const cost = page.getByTestId("message-list").getByTestId("cost-card");

  await sendText(page, "再找三家供应商询个价");
  await expect(cost).toHaveCount(1);
  await expect(cost, "花费卡上是金额和步数").toContainText("约 ¥0.8");
  await expect(cost).toContainText("4 步");

  const trace = await page.evaluate(() => window.__runTrace);
  expect(trace?.working, "跑的过程中侧栏这个 Bot 标着干活中").toContain(true);
  await expect(item.getByTestId("bot-working"), "跑完就不标了").toHaveCount(0);
  await expect(item, "侧栏摘要停在最后那条上").toContainText("本次花费 ¥0.8");
});
