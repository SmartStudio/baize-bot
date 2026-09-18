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
    __notifications?: { sent: string[]; asked: number };
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

// 「发」让 mock 走要点头的那条序列（镜像 bot-runner 的 send_ 前缀规则），工具卡会停在 running 上等结论。
const NEEDS_APPROVAL = "把报价单发给 Lisa";

const sendForApproval = async (page: Page, name: string) => {
  await openSeededBot(page, name);
  await traceRun(page);
  await sendText(page, NEEDS_APPROVAL);
  const card = page.getByTestId("approval-card");
  await expect(card, "审批卡到了才谈得上点头").toHaveAttribute("data-status", "pending");
  return card;
};

test("要点头的工具让群里出一张审批卡，侧栏记一笔「等你点头 1」", async ({ page }) => {
  await login(page);
  const card = await sendForApproval(page, "小销");

  await expect(card.getByTestId("approval-reject"), "拒绝按钮在卡上").toBeVisible();
  await expect(card.getByTestId("approval-approve"), "批准按钮在卡上").toBeVisible();
  await expect(card, "卡上写清楚要点头的是哪一类").toContainText("对外发送");
  await expect(card, "卡上写清楚这次要做什么").toContainText(NEEDS_APPROVAL);

  const item = page.locator('[data-testid=bot-item][data-bot-name="小销"]');
  await expect(item.getByTestId("bot-pending"), "一条 pending 审批在侧栏就是「等你点头 1」").toHaveText("等你点头 1");

  // 没点头之前这一步不许往下走，工具卡得停在运行中，不能自己变完成。
  await expect(page.getByTestId("tool-call-card"), "等结论的工具卡停在运行中").toHaveAttribute(
    "data-status",
    "running",
  );
  await expect(page.getByTestId("cost-card"), "还没点头就不该结账").toHaveCount(0);

  // 刷新走的是拉历史那条路。历史里的审批只填表不动计数，不然 GET /api/bots 已经数过的这一条会被加第二遍。
  await page.reload();
  await openBot(page, "小销");
  // 先等审批卡从历史里回来。它出现才说明 approvals_loaded 已经派发过，这时候数角标才数得到多加的那一下。
  await expect(page.getByTestId("approval-card"), "历史里的审批卡也带着状态").toHaveAttribute("data-status", "pending");
  await expect(page.getByTestId("approval-approve"), "还没点头，按钮还在").toBeVisible();
  await expect(item.getByTestId("bot-pending"), "刷新后还是 1，历史没有把它再加一遍").toHaveText("等你点头 1");
});

test("点拒绝后卡片留下结论、角标归零、这一步被拦下", async ({ page }) => {
  await login(page);
  const card = await sendForApproval(page, "小销");

  await card.getByTestId("approval-reject").click();

  await expect(card, "结论落在卡上，状态从服务端推回来").toHaveAttribute("data-status", "rejected");
  await expect(card.getByTestId("approval-decided"), "有结论的卡只剩一行记录").toContainText("已拒绝");
  await expect(card.getByTestId("approval-reject"), "有结论就不该还留着按钮").toHaveCount(0);

  const item = page.locator('[data-testid=bot-item][data-bot-name="小销"]');
  await expect(item.getByTestId("bot-pending"), "没有 pending 审批了角标整个不渲染").toHaveCount(0);

  await expect(page.getByTestId("cost-card"), "拒绝之后这次运行照样收尾结账").toHaveCount(1);
  await expect(page.getByTestId("tool-call-card"), "拒绝把这一步拦下，工具卡终态是 blocked").toHaveAttribute(
    "data-status",
    "blocked",
  );
  const trace = await page.evaluate(() => window.__runTrace);
  expect(trace?.tool, "同一张工具卡先运行中再被拦下，中间没有自己变完成").toEqual(["running", "blocked"]);
});

test("在群里回一句「批准」和点批准按钮是同一件事", async ({ page }) => {
  await login(page);
  const card = await sendForApproval(page, "小销");

  await sendText(page, "批准");

  await expect(card, "群里回的一句话也作用到那条 pending 审批上").toHaveAttribute("data-status", "approved");
  await expect(card.getByTestId("approval-decided")).toContainText("已批准");

  const item = page.locator('[data-testid=bot-item][data-bot-name="小销"]');
  await expect(item.getByTestId("bot-pending"), "点头之后角标归零").toHaveCount(0);

  await expect(page.getByTestId("tool-call-card"), "批准让这一步真的跑完").toHaveAttribute("data-status", "ok");
  await expect(page.getByTestId("cost-card")).toHaveCount(1);
  // 「批准」这四个字本身是结论不是新任务，不该再引出一次运行。
  await expect(page.getByTestId("message-list").locator("[data-kind=tool_call]"), "没有多起一次运行").toHaveCount(1);
});

// 测试浏览器里 Notification.permission 是 default，真代码会安静跳过，什么都断言不到。换成一个记账的桩，
// 既数得出弹了几条，也数得出权限弹窗被请求过几次——一次都不该有。
const stubNotifications = (page: Page) =>
  page.addInitScript(() => {
    const log = { sent: [] as string[], asked: 0 };
    window.__notifications = log;
    class Stub {
      static permission = "granted";
      static requestPermission() {
        log.asked += 1;
        return Promise.resolve("granted");
      }
      constructor(title: string, options?: { body?: string }) {
        log.sent.push(`${title} · ${options?.body ?? ""}`);
      }
    }
    Object.defineProperty(window, "Notification", { value: Stub, configurable: true, writable: true });
  });

// 免打扰按浏览器当下的钟算，测试没法挑时辰，所以区间用「现在」推算出来。两段区间都特意让「同一天」和
// 「跨午夜」两种读法在当下这一刻结论相反：判错的那版会把该弹的压掉、把该压的弹出来。
const dndAround = (page: Page, hoursFrom: number, hoursTo: number) =>
  page.evaluate(
    ([from, to]) => {
      const clock = (shift: number) => {
        const at = new Date(Date.now() + shift * 3600_000);
        return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
      };
      return { from: clock(from ?? 0), to: clock(to ?? 0) };
    },
    [hoursFrom, hoursTo],
  );

const setDnd = async (page: Page, window: { from: string; to: string }) => {
  await openSettings(page);
  await page.getByTestId("dnd-from").fill(window.from);
  await page.getByTestId("dnd-to").fill(window.to);
  await expect(page.getByTestId("dnd-to"), "设置存住了才谈得上按它判").toHaveValue(window.to);
  await page.getByTestId("settings-close").click();
};

test("点过按钮就锁住，一次点击只发得出一个结论", async ({ page }) => {
  await login(page);
  const card = await sendForApproval(page, "小销");

  // 把结论请求按住，卡片就停在「点过了但结论还没回来」这一刻，否则它几十毫秒就过去了。
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/approvals/*", async (route) => {
    await held;
    await route.continue();
  });

  await page.getByTestId("approval-reject").click();

  await expect(card.getByTestId("approval-reject"), "点过的那颗立刻锁住，连点两下只算一次").toBeDisabled();
  await expect(
    card.getByTestId("approval-approve"),
    "另一颗也一起锁住，免得同一条审批收到两个相反的结论",
  ).toBeDisabled();

  release();
  await expect(card, "结论回来了卡片才落到已拒绝").toHaveAttribute("data-status", "rejected");
});

test("免打扰时段外弹通知，时段内只记角标", async ({ page }) => {
  await stubNotifications(page);
  await login(page);

  // 整段都排在一小时以后，当下在它前面。按跨午夜读这段会一路盖到午夜，把当下也圈进去。
  await setDnd(page, await dndAround(page, 1, 2));
  await sendForApproval(page, "小销");

  await expect
    .poll(async () => (await page.evaluate(() => window.__notifications?.sent)) ?? [], {
      message: "不在免打扰里，要你点头的事该弹到系统通知上",
    })
    .toHaveLength(1);
  expect(
    (await page.evaluate(() => window.__notifications?.sent))?.[0],
    "通知正文就是这条审批要你点头的那件事",
  ).toContain("把报价单发给 Lisa");

  // from 比 to 晚，就是「22:00–08:00」那种跨午夜的写法：它盖的是 from 到午夜、午夜到 to 这两段，当下落在
  // 前一段里。按同一天的区间读，from > to 是个空区间，当下就漏在外面了。
  await setDnd(page, await dndAround(page, -1, -2));
  await sendText(page, NEEDS_APPROVAL);

  const item = page.locator('[data-testid=bot-item][data-bot-name="小销"]');
  await expect(item.getByTestId("bot-pending"), "免打扰期间事情照样攒在角标上").toHaveText("等你点头 2");
  expect(
    (await page.evaluate(() => window.__notifications?.sent))?.length,
    "免打扰期间不打断你，通知还是刚才那一条",
  ).toBe(1);
  expect((await page.evaluate(() => window.__notifications?.asked)) ?? 0, "任何时候都不该弹权限请求").toBe(0);
});

test("免打扰只设了一头等于没设；权限没给就安静跳过，不弹权限请求", async ({ page }) => {
  await stubNotifications(page);
  await login(page);

  // 只留一头划不出区间。把它当成免打扰开着，等于把另外那半天也算进去，该响的时候不响。
  await openSettings(page);
  await page.getByTestId("dnd-from").fill("");
  await expect(page.getByTestId("dnd-from")).toHaveValue("");
  await page.getByTestId("settings-close").click();

  await sendForApproval(page, "小销");
  await expect
    .poll(async () => (await page.evaluate(() => window.__notifications?.sent)) ?? [], {
      message: "免打扰只设了一头就是没开，通知照发",
    })
    .toHaveLength(1);

  // 用户还没给过通知权限。这时候弹权限请求等于拿一个系统弹窗拦住人，角标已经把事情说清楚了。
  await page.evaluate(() => {
    Object.defineProperty(window.Notification, "permission", { value: "default", configurable: true });
  });
  await sendText(page, NEEDS_APPROVAL);

  const item = page.locator('[data-testid=bot-item][data-bot-name="小销"]');
  await expect(item.getByTestId("bot-pending"), "通知发不出去也不影响这件事攒在角标上").toHaveText("等你点头 2");
  expect((await page.evaluate(() => window.__notifications?.sent))?.length, "权限不是 granted 就不发通知").toBe(1);
  expect((await page.evaluate(() => window.__notifications?.asked)) ?? 0, "更不该反过来弹权限请求").toBe(0);
});
