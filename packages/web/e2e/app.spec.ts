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

  await page.getByTestId("new-menu").click();
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

// 预置的多 Bot 群只有一条系统消息，谁开口都是被 @ 出来的，数「只有它回了」才数得清。
const TEAM_TITLE = "Globex X3 × 200 订单";

const openTeamGroup = async (page: Page, title: string) => {
  await page.locator(`[data-testid=group-item][data-group-title="${title}"]`).click();
  await expect(page.getByTestId("task-card")).toBeVisible();
};

test("从加号建群后侧栏多一个群，群顶部钉着带编号的任务卡", async ({ page }) => {
  await login(page);
  const groups = page.locator("[data-testid=group-item]");
  await expect(groups, "预置里本来就有一个多 Bot 群").toHaveCount(1);

  await page.getByTestId("new-menu").click();
  await page.getByTestId("new-group").click();
  await expect(page.getByTestId("new-group-dialog")).toBeVisible();
  await page.getByTestId("group-title").fill("Globex X3 × 200 补货");
  await expect(page.getByTestId("group-submit"), "还没拉人进来就不该能提交").toBeDisabled();
  await page.locator('[data-testid=group-member][data-bot-name="小服"]').click();
  await page.locator('[data-testid=group-member][data-bot-name="小采"]').click();
  await page.getByTestId("group-summary").fill("X3 现货不够 200 台，先补货再答复客户。");
  await page.getByTestId("group-submit").click();

  await expect(page.getByTestId("new-group-dialog"), "建完弹层自己收起来").toHaveCount(0);
  await expect(groups).toHaveCount(2);
  await expect(
    page.locator('[data-testid=group-item][data-group-title="Globex X3 × 200 补货"]'),
    "建群的人直接进了这个群",
  ).toHaveClass(/is-selected/);
  await expect(page.getByTestId("chat-title")).toHaveText("Globex X3 × 200 补货");
  await expect(page.getByTestId("chat-subtitle")).toContainText("你 + 2 个 Bot");
  // 编号由服务端发，预置那个是 T-2481，接着往下发。
  await expect(page.getByTestId("task-number"), "任务卡上是系统发的 T- 编号").toHaveText("T-2482");
  await expect(page.getByTestId("task-progress"), "清单等 Bot 接手后自己列").toHaveText("清单 0 / 0");
  await expect(page.getByTestId("task-current")).toHaveText("当前 还没人接手");
  await page.screenshot({ path: `${SHOT}/08.png` });
});

test("群里 @ 一个 Bot，只有它回话，清单第一项跟着勾上", async ({ page }) => {
  await login(page);
  await openTeamGroup(page, TEAM_TITLE);
  await expect(page.getByTestId("task-progress")).toHaveText("清单 0 / 5");
  await expect(page.getByTestId("task-current"), "建好还没人接手").toHaveText("当前 还没人接手");

  const input = page.getByTestId("composer-input");
  await input.fill("@小");
  await expect(page.getByTestId("mention-menu"), "打 @ 就弹成员名单").toBeVisible();
  await page.locator('[data-testid=mention-option][data-bot-name="小销"]').click();
  await expect(input, "选中谁就往输入框里插「@小销 」").toHaveValue("@小销 ");
  await input.fill("@小销 查一下 X3 的现货还有多少");
  await page.getByTestId("composer-send").click();

  const list = page.getByTestId("message-list");
  await expect(list.getByTestId("cost-card"), "花费卡到了就说明这次运行跑完了").toHaveCount(1);
  await expect(list.locator("[data-kind=bot]"), "群里只有被 @ 的那个开口").toHaveCount(1);
  const source = list.getByTestId("bot-source");
  await expect(source, "多 Bot 群里每条 Bot 消息上方写清是谁说的").toHaveCount(1);
  await expect(source).toHaveAttribute("data-bot-name", "小销");
  await expect(source).toContainText("小销 · 销售");
  await expect(page.locator('[data-testid=bot-source][data-bot-name="小服"]'), "没被 @ 的那个一句话都没说").toHaveCount(
    0,
  );

  await expect(page.getByTestId("task-current"), "被 @ 就是接手").toHaveText("当前 小销");
  await expect(page.getByTestId("checklist-item").first(), "接手的 Bot 干完一步就勾掉一项").toBeChecked();
  await expect(page.getByTestId("task-progress")).toHaveText("清单 1 / 5");
  await page.screenshot({ path: `${SHOT}/05.png` });
});

test("在任务卡上勾掉第二项，卡片和任务详情一起跟着变，刷新还在", async ({ page }) => {
  await login(page);
  await openTeamGroup(page, TEAM_TITLE);
  const items = page.getByTestId("checklist-item");
  await expect(items).toHaveCount(5);

  const saved = page.waitForResponse((res) => res.url().includes("/api/tasks/") && res.request().method() === "PATCH");
  // 清单是受控的，勾上要等服务端把整份清单回过来，check() 会因为点完那一下状态还没变而失败。
  await items.nth(1).click();
  await saved;

  await expect(items.nth(1), "勾的是第二项").toBeChecked();
  await expect(items.first(), "别的项不受影响").not.toBeChecked();
  await expect(page.getByTestId("task-progress"), "卡片上的进度跟着走").toHaveText("清单 1 / 5");

  await page.getByTestId("task-open").click();
  const panel = page.getByTestId("task-panel");
  await expect(panel.getByTestId("task-panel-checklist").locator("li").nth(1)).toHaveAttribute("data-done", "true");
  await expect(panel.getByTestId("task-handled"), "还没人接手，经手里两个成员都在等").toContainText("等待接手");
  await page.screenshot({ path: `${SHOT}/5b.png` });

  // 刷新走的是拉历史那条路。整份清单真存到服务端了才留得住。
  await page.reload();
  await openTeamGroup(page, TEAM_TITLE);
  await expect(page.getByTestId("checklist-item").nth(1), "刷新后第二项还是勾着的").toBeChecked();
});

// 小服在群里干完这一段就把供货交给小采，两秒后小采确认。@ 的这句话不含「发」「付」，不会岔进审批那条序列。
const handoffFromService = async (page: Page) => {
  await openTeamGroup(page, TEAM_TITLE);
  await sendText(page, "@小服 查一下 Globex 的 X3 库存和排产");
  const card = page.getByTestId("handoff-card");
  await expect(card, "小服干完活就在群里发一张交接报文卡").toBeVisible();
  return card;
};

const teamItem = (page: Page) => page.locator(`[data-testid=group-item][data-group-title="${TEAM_TITLE}"]`);

test("小服干完活发一张交接报文卡，侧栏记一笔「等 Bot 确认 1」", async ({ page, request }) => {
  await login(page);
  const card = await handoffFromService(page);

  await expect(card, "小采还没确认").toHaveAttribute("data-status", "pending");
  const pair = card.getByTestId("handoff-pair");
  await expect(pair, "卡头写清这一份从谁手上交出去").toContainText("小服");
  await expect(pair, "也写清交到谁手上").toContainText("小采");
  await expect(card.getByTestId("handoff-status"), "没确认之前卡上写的是在等谁").toHaveText("等小采确认");
  await expect(card.getByTestId("handoff-done"), "做了什么").toContainText("10 月 20 日能先交 120 台");
  await expect(card.getByTestId("handoff-not-done"), "没做什么").toContainText("三家供应商的现货和到货期");
  await expect(card.getByTestId("handoff-next"), "下一步").toContainText("最早到货日");
  // 小服接手时勾掉了第一项，指针指的是下一个人该接着做的那一项，卡上写的是那一项的正文而不只是个序号。
  await expect(card.getByTestId("handoff-checklist"), "清单指针指到具体哪一项").toHaveText(
    "第 2 项 · 出 200 台 X3 的报价单",
  );

  await expect(page.getByTestId("task-current"), "还没确认，任务卡上仍是小服").toHaveText("当前 小服");
  await expect(teamItem(page).getByTestId("bot-handoff"), "一条没确认的交接在侧栏就是「等 Bot 确认 1」").toHaveText(
    "等 Bot 确认 1",
  );

  // 角标这一路是推送加出来的。刷新后它只能从列表接口的计数里来，两个接口没数上的话一刷新角标就没了。
  await request.post("/api/auth/login", { data: { email: EMAIL, password: PASSWORD } });
  const listed = (await (await request.get("/api/groups")).json()) as { items: { pendingHandoffs: number }[] };
  expect(
    listed.items.map((entry) => entry.pendingHandoffs),
    "没确认的交接进 GET /api/groups 的计数",
  ).toEqual([1]);
  const listedBots = (await (await request.get("/api/bots")).json()) as { items: { pendingHandoffs: number }[] };
  expect(
    listedBots.items.map((entry) => entry.pendingHandoffs),
    "交接记在群那本账上，不串到三个单 Bot 群里",
  ).toEqual([0, 0, 0]);
  await page.screenshot({ path: `${SHOT}/5c.png` });
});

test("小采确认之后卡片变已接手、角标归零、任务卡当前经手换成小采", async ({ page }) => {
  await login(page);
  const card = await handoffFromService(page);

  await expect(card, "两秒后小采确认，状态从服务端推回来").toHaveAttribute("data-status", "accepted");
  await expect(card.getByTestId("handoff-status"), "接手了就写上时刻").toContainText("已接手 · ");
  await expect(teamItem(page).getByTestId("bot-handoff"), "没有在等确认的交接了，角标整个不渲染").toHaveCount(0);
  await expect(page.getByTestId("task-current"), "接手就是换经手人").toHaveText("当前 小采");

  await page.getByTestId("task-open").click();
  const handled = page.getByTestId("task-panel").getByTestId("task-handled").locator("li");
  await expect(handled.nth(0), "小服那一条在接手的时刻收了尾").not.toContainText("当前");
  await expect(handled.nth(1), "经手记录随 task_updated 长出新的一条").toContainText("小采");
  await expect(handled.nth(1), "小采是当前那一位").toContainText("当前");
  await page.screenshot({ path: `${SHOT}/5d.png` });

  // 刷新走的是拉历史那条路。卡的状态得跟着 GET /messages 的 handoffs 回来，不能只活在推送攒出来的内存里。
  await page.reload();
  await openTeamGroup(page, TEAM_TITLE);
  await expect(page.getByTestId("handoff-card"), "刷新后交接卡还带着已接手").toHaveAttribute("data-status", "accepted");
  await expect(page.getByTestId("task-current"), "换过的经手人也存住了").toHaveText("当前 小采");
});

test("交接是 Bot 等 Bot：不占「等你点头」那个角标，也不弹通知", async ({ page }) => {
  await stubNotifications(page);
  await login(page);
  await handoffFromService(page);

  const item = teamItem(page);
  await expect(item.getByTestId("bot-handoff"), "交接记在自己那本账上").toHaveText("等 Bot 确认 1");
  await expect(item.getByTestId("bot-pending"), "Bot 之间的确认不是你的审批，不该混进「等你点头」").toHaveCount(0);
  expect(
    (await page.evaluate(() => window.__notifications?.sent)) ?? [],
    "这件事不用你动手，不该拿系统通知把你从别的事上拽回来",
  ).toHaveLength(0);
});
