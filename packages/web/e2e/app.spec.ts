import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { OvernightResponse, SkillResponse, UsageResponse } from "@baize/shared";

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

// 小服在群里干完这一段就把供货交给小采。@ 的这句话不含「发」「付」，不会岔进审批那条序列。
const handoffFromService = async (page: Page, request: APIRequestContext) => {
  expect((await request.post("/api/test/handoff/hold")).status(), "交接确认由用例主动触发").toBe(204);
  await openTeamGroup(page, TEAM_TITLE);
  await sendText(page, "@小服 查一下 Globex 的 X3 库存和排产");
  const card = page.getByTestId("handoff-card");
  await expect(card, "小服干完活就在群里发一张交接报文卡").toBeVisible();
  return card;
};

const teamItem = (page: Page) => page.locator(`[data-testid=group-item][data-group-title="${TEAM_TITLE}"]`);

test("登录前已有的交接在未打开群时收到确认推送，侧栏角标归零", async ({ page, request }) => {
  expect((await request.post("/api/test/handoff/pending")).status()).toBe(201);
  await login(page);
  const badge = teamItem(page).getByTestId("bot-handoff");
  await expect(badge, "登录列表带回待确认计数").toHaveText("等 Bot 确认 1");

  expect((await request.post("/api/test/handoff/accept")).status()).toBe(204);
  await expect(badge, "未拉群历史也能按终态推送清掉角标").toHaveCount(0);
});

test("小服干完活发一张交接报文卡，侧栏记一笔「等 Bot 确认 1」", async ({ page, request }) => {
  await login(page);
  const card = await handoffFromService(page, request);

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
  const sidebarItem = teamItem(page);
  const handoffBadge = sidebarItem.getByTestId("bot-handoff");
  await expect(handoffBadge, "一条没确认的交接在侧栏就是「等 Bot 确认 1」").toHaveText("等 Bot 确认 1");
  const title = sidebarItem.locator(".bot-item-top b");
  const titleMetrics = await title.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
  }));
  expect(titleMetrics.height, "有角标时群标题仍只有一行").toBeLessThan(titleMetrics.lineHeight * 2);
  const titleBox = await title.boundingBox();
  const badgeBox = await handoffBadge.boundingBox();
  if (titleBox === null || badgeBox === null) throw new Error("群标题或交接角标没有可测量的布局框");
  expect(badgeBox.y, "角标单独排在标题下一行").toBeGreaterThan(titleBox.y + titleBox.height / 2);

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

test("小采确认之后卡片变已接手、角标归零、任务卡当前经手换成小采", async ({ page, request }) => {
  await login(page);
  const card = await handoffFromService(page, request);

  await expect(card, "确认前交接仍在等待").toHaveAttribute("data-status", "pending");
  expect((await request.post("/api/test/handoff/accept")).status(), "小采现在确认").toBe(204);
  await expect(card, "小采确认后状态从服务端推回来").toHaveAttribute("data-status", "accepted");
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

test("交接是 Bot 等 Bot：不占「等你点头」那个角标，也不弹通知", async ({ page, request }) => {
  await stubNotifications(page);
  await login(page);
  await handoffFromService(page, request);

  const item = teamItem(page);
  await expect(item.getByTestId("bot-handoff"), "交接记在自己那本账上").toHaveText("等 Bot 确认 1");
  await expect(item.getByTestId("bot-pending"), "Bot 之间的确认不是你的审批，不该混进「等你点头」").toHaveCount(0);
  expect(
    (await page.evaluate(() => window.__notifications?.sent)) ?? [],
    "这件事不用你动手，不该拿系统通知把你从别的事上拽回来",
  ).toHaveLength(0);
});

const openRoutines = async (page: Page, name: string) => {
  await openBot(page, name);
  await page.getByTestId("bot-tab-routines").click();
  // 切过去才开始拉。不等预置那条到齐就数行数，数到的是一份还没填上的空列表。
  await expect(page.getByTestId("routine-row")).not.toHaveCount(0);
};

test("在例行页新建一条每分钟的例行任务，存下来就出现在列表里", async ({ page }) => {
  await login(page);
  await openRoutines(page, "小服");
  await expect(page.getByTestId("routine-row"), "预置的只有「每日工单早报」一条").toHaveCount(1);

  await page.getByTestId("routine-new").click();
  await page.getByTestId("routine-name-input").fill("每分钟看一眼工单");
  await page.getByTestId("routine-instruction-input").fill("看一眼有没有新工单，有紧急的就告诉我。");
  await page.getByTestId("trigger-add").click();
  await page.getByTestId("trigger-preset-minutely").click();
  await expect(page.getByTestId("trigger-chip"), "挑完预设先落在编辑器里").toHaveText(/每分钟/);

  const saved = page.waitForResponse(
    (res) => res.url().endsWith("/routines") && res.request().method() === "POST" && res.status() === 201,
  );
  await page.getByTestId("routine-save").click();
  await saved;

  const created = page.locator('[data-testid=routine-row][data-routine-name="每分钟看一眼工单"]');
  await expect(page.getByTestId("routine-row")).toHaveCount(2);
  await expect(created.getByTestId("routine-row-note"), "列表上的下次触发是从表达式反推的文案").toHaveText("每分钟");

  // 刷新才分得清「存住了」和「界面自己记了一笔」。
  await page.reload();
  await openRoutines(page, "小服");
  await expect(page.getByTestId("routine-row")).toHaveCount(2);
  await expect(created.getByTestId("routine-row-note")).toHaveText("每分钟");
});

test("试跑一次后群里出现「自动运行」那条 system，运行记录多一条", async ({ page }) => {
  await login(page);
  await openSeededBot(page, "小服");
  await page.getByTestId("bot-tab-routines").click();
  await page.getByTestId("routine-open").click();
  const runs = page.getByTestId("run-row");
  await expect(runs, "预置了三条运行记录").toHaveCount(3);
  await expect(runs.nth(0).locator("small"), "停下时 note 已经说清原因，不重复状态词").toHaveText(
    "1 条等你点头 · ¥0.8",
  );
  await expect(runs.nth(0).locator("small")).not.toContainText("停下等你");
  await expect(runs.nth(1).locator("small"), "正常完成仍保留状态词和花费").toHaveText("完成 · ¥0.7");
  await expect(runs.nth(2).locator("small"), "失败时直接显示控制面给的原因").toHaveText("工单系统登录过期 · ¥0.2");

  await page.getByTestId("routine-run-now").click();

  await expect(runs, "触发那一刻就落一条").toHaveCount(4);
  // 刚触发的还没有 note，状态文案后面不该拖一个孤零零的点。
  await expect(runs.first().locator("small"), "刚触发的那条停在运行中").toHaveText("运行中");
  const thread = page.getByTestId("message-list");
  await expect(thread.getByText("例行任务「每日工单早报」自动运行"), "一次运行先在群里说一声").toBeVisible();
  await expect(thread.getByText("按紧急度排序"), "再落一条 user 消息，正文就是每次运行做什么").toBeVisible();
  await page.screenshot({ path: `${SHOT}/2c.png` });

  await page.getByTestId("run-row").last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOT}/2c-runs.png` });
});

test("删除例行任务要二次确认，取消和超时都不删除", async ({ page }) => {
  await login(page);
  await openRoutines(page, "小服");
  const rows = page.getByTestId("routine-row");
  await expect(rows).toHaveCount(1);
  await page.getByTestId("routine-open").click();
  await page.clock.install();
  await page.clock.pauseAt(new Date());

  await page.getByTestId("routine-delete").click();
  await expect(page.getByTestId("routine-delete-confirm")).toBeVisible();
  await expect(page.getByTestId("routine-delete-cancel")).toBeVisible();
  await page.screenshot({ path: `${SHOT}/2d.png` });
  await page.getByTestId("routine-delete-cancel").click();
  await expect(page.getByTestId("routine-delete")).toBeVisible();

  await page.getByTestId("routine-delete").click();
  await expect(page.getByTestId("routine-delete-confirm")).toBeVisible();
  await page.clock.runFor(3_000);
  await expect(page.getByTestId("routine-delete"), "三秒不确认就恢复成普通删除按钮").toBeVisible({
    timeout: 4_000,
  });
  await page.getByTestId("routine-back").click();
  await expect(rows, "取消或超时都没有删除列表项").toHaveCount(1);

  await page.getByTestId("routine-open").click();
  await page.getByTestId("routine-delete").click();
  const deleted = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" && /\/api\/routines\/[^/]+$/.test(new URL(response.url()).pathname),
  );
  await page.getByTestId("routine-delete-confirm").click();
  await deleted;
  await expect(page.getByTestId("routine-list")).toBeVisible();
  await expect(rows, "确认删除后列表少一条").toHaveCount(0);
});

test("在列表里停用一条例行任务，那一行的状态变「已停用」", async ({ page }) => {
  await login(page);
  await openRoutines(page, "小服");
  const row = page.getByTestId("routine-row").first();
  await expect(row.getByTestId("routine-row-note"), "启用着就说下次什么时候跑").toHaveText("工作日 09:00");

  await row.getByTestId("routine-switch").click();

  await expect(row.getByTestId("routine-switch")).toHaveAttribute("aria-checked", "false");
  await expect(row.getByTestId("routine-row-note"), "停用的不触发，列表上就别再说下次什么时候跑").toHaveText("已停用");

  await page.reload();
  await openRoutines(page, "小服");
  await expect(page.getByTestId("routine-row").first().getByTestId("routine-row-note")).toHaveText("已停用");
});

test("给 webhook 地址打一下，群里照样跑起来，运行记录靠推送回到列表", async ({ page }) => {
  await login(page);
  await openRoutines(page, "小服");
  await page.getByTestId("routine-open").click();
  await expect(page.getByTestId("run-row")).toHaveCount(3);

  await page.getByTestId("trigger-add").click();
  await page.getByTestId("trigger-preset-webhook").click();
  const url = await page.getByTestId("webhook-url").textContent();
  expect(url ?? "", "地址里的 token 是服务端发的，客户端挑不了").toMatch(/\/api\/hooks\/[0-9a-f]{32}$/);

  const fired = await page.request.post(url ?? "");
  expect(fired.status(), "打进来就收下，回 202").toBe(202);

  // 这一路没经过界面上的任何一个按钮，列表能动只能是 routine_updated 推回来的。
  await expect(page.getByTestId("run-row"), "webhook 触发的运行记法一样").toHaveCount(4);
  await expect(page.getByTestId("run-row").first().locator("small")).toHaveText("运行中");
  await expect(
    page.getByTestId("message-list").getByText("例行任务「每日工单早报」自动运行"),
    "从哪儿触发的，群里都是同样两条消息",
  ).toBeVisible();
});

const openSkills = async (page: Page, botName: string) => {
  await openBot(page, botName);
  await page.getByTestId("bot-tab-skills").click();
  await expect(page.getByTestId("skill-list")).toBeVisible();
};

test("存下 Bot 提议的 skill，卡片变已存且小销列表多一条", async ({ page }) => {
  await login(page);
  await openSeededBot(page, "小销");
  const card = page.getByTestId("skill-offer");
  await expect(card).toHaveAttribute("data-status", "offered");
  await expect(card.getByTestId("skill-offer-step")).toHaveCount(3);
  await card.getByTestId("skill-offer-save").click();
  await expect(card).toHaveAttribute("data-status", "saved");
  await expect(card.getByTestId("skill-offer-decided")).toHaveText("已存");
  await expect(card.getByTestId("skill-offer-save")).toHaveCount(0);

  await openSkills(page, "小销");
  await expect(page.getByTestId("skill-row")).toHaveCount(4);
  const saved = page.locator('[data-testid=skill-row][data-skill-name="Initech 报价"]');
  await expect(saved).toContainText("来自对话");
  await page.screenshot({ path: `${SHOT}/10a.png` });

  await page.reload();
  await openSkills(page, "小销");
  await expect(saved, "刷新后列表仍从服务端读到刚存的 skill").toHaveCount(1);
});

test("会做的活详情改步骤后保存，列表与详情都显示新内容", async ({ page }) => {
  await login(page);
  await openSkills(page, "小销");
  await expect(page.getByTestId("skill-row"), "小销预置三条 skill").toHaveCount(3);
  const quote = page.locator('[data-testid=skill-row][data-skill-name="Globex 报价"]');
  await expect(quote.getByTestId("skill-row-note")).toContainText("来自对话");
  await quote.getByTestId("skill-open").click();
  await expect(page.getByTestId("skill-step")).toHaveCount(4);
  await page.getByTestId("skill-edit").click();
  await page.getByTestId("skill-steps-input").fill("确认客户与数量\n按最新口径计算折扣\n生成 PDF 等我检查");
  await page.getByTestId("skill-save").click();
  await expect(page.getByTestId("skill-detail").getByTestId("skill-step")).toHaveText([
    "确认客户与数量",
    "按最新口径计算折扣",
    "生成 PDF 等我检查",
  ]);
  await page.screenshot({ path: `${SHOT}/10b.png` });

  await page.reload();
  await openSkills(page, "小销");
  await quote.getByTestId("skill-open").click();
  await expect(page.getByTestId("skill-step")).toHaveText([
    "确认客户与数量",
    "按最新口径计算折扣",
    "生成 PDF 等我检查",
  ]);
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

test("教小销一个 skill，再复制给小采并删掉原件", async ({ page }) => {
  await login(page);
  await openSkills(page, "小销");
  await page.getByTestId("skill-new").click();
  await expect(page.getByTestId("skill-save"), "名称和步骤都不能为空").toBeDisabled();
  await page.getByTestId("skill-name-input").fill("客户回访清单");
  await page
    .getByTestId("skill-steps-input")
    .fill(Array.from({ length: 21 }, (_, index) => `步骤 ${index + 1}`).join("\n"));
  await expect(page.getByTestId("skill-save"), "最多 20 步").toBeDisabled();
  await page.getByTestId("skill-steps-input").fill("整理本周客户问题\n列出需要跟进的负责人");
  await expect(page.getByTestId("skill-save")).toBeEnabled();
  await page.getByTestId("skill-save").click();
  const taught = page.locator('[data-testid=skill-row][data-skill-name="客户回访清单"]');
  await expect(taught).toContainText("你教的");
  await expect(page.getByTestId("skill-row")).toHaveCount(4);
  await taught.getByTestId("skill-open").click();
  await expect(page.getByTestId("skill-detail").getByTestId("skill-step")).toHaveText([
    "整理本周客户问题",
    "列出需要跟进的负责人",
  ]);
  await page.getByTestId("skill-copy").click();
  await page.locator('[data-testid=skill-copy-option][data-bot-name="小采"]').click();
  await page.screenshot({ path: `${SHOT}/10d.png` });
  await page.getByTestId("skill-delete").click();
  await expect(page.getByTestId("skill-row")).toHaveCount(3);
  await expect(taught).toHaveCount(0);

  await openSkills(page, "小采");
  const copied = page.locator('[data-testid=skill-row][data-skill-name="客户回访清单"]');
  await expect(copied).toContainText("你教的");
  await expect(copied, "复制保留来源，但新 Bot 的使用次数从零算").toContainText("用过 0 次");
});

test("不存 Bot 的提议，卡片变没存且列表不增加", async ({ page }) => {
  await login(page);
  await openSeededBot(page, "小销");
  const card = page.getByTestId("skill-offer");
  await card.getByTestId("skill-offer-dismiss").click();
  await expect(card).toHaveAttribute("data-status", "dismissed");
  await expect(card.getByTestId("skill-offer-decided")).toHaveText("没存");
  await openSkills(page, "小销");
  await expect(page.getByTestId("skill-row")).toHaveCount(3);
  await page.screenshot({ path: `${SHOT}/10e.png` });
});

test("另一个请求新增和删除 skill，已打开的列表随推送更新", async ({ page }) => {
  await login(page);
  await openSkills(page, "小销");
  await expect(page.getByTestId("skill-row")).toHaveCount(3);
  const created = await page.request.post("/api/bots/bot_sales/skills", {
    data: { name: "外部同步演示", steps: ["先核对客户名称"] },
  });
  expect(created.status()).toBe(201);
  const { skill } = SkillResponse.parse(await created.json());
  const pushed = page.locator('[data-testid=skill-row][data-skill-name="外部同步演示"]');
  await expect(pushed, "没经过本页操作也能收到新增推送").toBeVisible();
  await expect(page.getByTestId("skill-row")).toHaveCount(4);
  await page.screenshot({ path: `${SHOT}/10f.png` });

  const deleted = await page.request.delete(`/api/skills/${skill.id}`);
  expect(deleted.status()).toBe(204);
  await expect(pushed, "没经过本页操作也能收到删除推送").toHaveCount(0);
  await expect(page.getByTestId("skill-row")).toHaveCount(3);
});

test("用量与账单按 Bot 分列本周花费，并列出五条最近任务", async ({ page }) => {
  await login(page);
  await page.getByTestId("overnight-card").getByRole("button", { name: "知道了" }).click();
  await openSettings(page);
  const loaded = page.waitForResponse((response) => response.url().endsWith("/api/usage") && response.ok());
  await page.getByTestId("settings-nav-usage").click();
  await loaded;

  const usage = page.getByTestId("usage-page");
  await expect(usage.getByTestId("usage-total")).toHaveText("¥38.2");
  await expect(usage.getByTestId("usage-bots").locator(".usage-bot")).toHaveCount(3);
  for (const name of ["小销", "小采", "小服"]) {
    await expect(usage.getByTestId("usage-bots")).toContainText(name);
  }
  await expect(usage.getByTestId("usage-recent").locator(".usage-run")).toHaveCount(5);
  await expect(usage).toContainText("Globex X3 × 200 报价");
  await expect(usage).toContainText("周预算 · 后续");
  await expect(usage).toContainText("快用完时提醒 · 后续");
  await expect(usage).toContainText("负责人加额 · 后续");
  await expect(usage).toContainText("默认档位 · 后续");
  await expect(usage).toContainText("导出本月明细 · 后续");
  await expect(usage.getByRole("button")).toHaveCount(0);
  await page.screenshot({ path: `${SHOT}/11a.png` });
});

test("昨夜进展卡点小采，选中对应群并关卡", async ({ page }) => {
  await login(page);
  const card = page.getByTestId("overnight-card");
  await expect(card).toContainText("你下线的时候，活没停");
  await expect(card.getByTestId("overnight-row")).toHaveCount(3);
  await expect(card.getByTestId("overnight-row").filter({ hasText: "小采" })).toContainText("完成");
  await expect(card.getByTestId("overnight-row").filter({ hasText: "小服" })).toContainText("等你");
  await expect(card.getByTestId("overnight-row").filter({ hasText: "小销" })).toContainText("在干活");
  await page.screenshot({ path: `${SHOT}/11b.png` });
  await card.getByTestId("overnight-row").filter({ hasText: "小采" }).click();
  await expect(page.getByTestId("chat-title")).toHaveText("小采");
  await expect(card).toHaveCount(0);
});

test("账户菜单显示接口合计而非写死的金额，点开用量页", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/usage", async (route) => {
    calls += 1;
    const response = await route.fetch();
    const usage = UsageResponse.parse(await response.json());
    await route.fulfill({ response, json: { ...usage, total: 47.3 } });
  });
  await login(page);
  await page.getByTestId("account-button").click();
  await expect(page.getByTestId("account-usage-total")).toHaveText("¥47.3");
  expect(calls, "进入应用时拉一次用量").toBe(1);
  await page.getByTestId("open-usage").click();
  await expect(page.getByTestId("usage-page")).toBeVisible();
  await expect(page.getByTestId("usage-total")).toHaveText("¥47.3");
  await expect.poll(() => calls, "打开用量页再拉一次").toBe(2);
  await page.screenshot({ path: `${SHOT}/11c.png` });
});

test("昨夜进展只在进入应用时拉取，关卡后本会话不再弹", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/overnight", async (route) => {
    calls += 1;
    await route.continue();
  });
  await login(page);
  expect(calls).toBe(1);
  await page.getByTestId("overnight-card").getByRole("button", { name: "知道了" }).click();
  await openSettings(page);
  await page.getByTestId("settings-close").click();
  await expect(page.getByTestId("overnight-card")).toHaveCount(0);
  expect(calls, "关卡和开关设置不重新拉取").toBe(1);
  await page.reload();
  await expect(page.getByTestId("main-window")).toBeVisible();
  await expect.poll(() => calls, "保持登录的冷启动重新进入应用").toBe(2);
});

test("昨夜没有进展时不弹卡", async ({ page }) => {
  await page.route("**/api/overnight", async (route) => {
    const response = await route.fetch();
    const overnight = OvernightResponse.parse(await response.json());
    await route.fulfill({ response, json: { ...overnight, items: [] } });
  });
  await login(page);
  await expect(page.getByTestId("overnight-card")).toHaveCount(0);
});

test("窄屏用量页仍能看到合计和任务，不横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);
  await page.getByTestId("overnight-card").getByRole("button", { name: "知道了" }).click();
  await openSettings(page);
  await page.getByTestId("settings-nav-usage").click();
  const usage = page.getByTestId("usage-page");
  await expect(usage.getByTestId("usage-total")).toHaveText("¥38.2");
  await expect(usage.getByTestId("usage-recent").locator(".usage-run")).toHaveCount(5);
  expect(await usage.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: `${SHOT}/11d.png` });
});
