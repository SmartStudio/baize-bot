import { fileURLToPath } from "node:url";
import {
  expect,
  test as base,
  type APIRequestContext,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { Message, MessageListResponse, ServerPush, SkillResponse, UsageResponse } from "@baize/shared";

export { expect, Message, MessageListResponse, ServerPush, SkillResponse, UsageResponse };
export type { APIRequestContext, Page };

export const EMAIL = "chen@baize.dev";
export const PASSWORD = "baize-dev";
export const SHOT = "e2e/screenshots";
export const AUDIT_SHOT = fileURLToPath(new URL("../../../.audit/v1/p0-5", import.meta.url));

// 产品的 fonts.css 用 @import 引 Google Fonts，load 要等那份 CSS 下完，外网慢时 goto 能被拖过 30 秒。
// 字体文件是这份 CSS 里的 @font-face 才引出来的，CSS 换成空的，fonts.gstatic.com 就不会被请求。
export const stubExternalFonts = (context: BrowserContext) =>
  context.route(/^https:\/\/fonts\.googleapis\.com\//, (route) => route.fulfill({ contentType: "text/css", body: "" }));

export const test = base.extend<{ resetMock: void }>({
  context: async ({ context }, use) => {
    await stubExternalFonts(context);
    await use(context);
  },
  resetMock: [
    async ({ request }, use) => {
      expect((await request.post("/api/test/reset")).status(), "mock 状态倒回预置的四个 Bot").toBe(204);
      await use();
    },
    { auto: true },
  ],
});

export const fillCredentials = async (page: Page, password: string) => {
  await page.goto("/");
  await page.getByTestId("email-input").fill(EMAIL);
  await page.getByTestId("password-input").fill(password);
  await page.getByTestId("login-submit").click();
};

export const login = async (page: Page) => {
  await fillCredentials(page, PASSWORD);
  await expect(page.getByTestId("main-window")).toBeVisible();
};

export const teamCard = (page: Page, name: string) => page.locator(`[data-testid=team-bot][data-bot-name="${name}"]`);

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("元素没有渲染出来");
  return box;
};

export const overlaps = async (a: Locator, b: Locator) => {
  const [x, y] = [await boxOf(a), await boxOf(b)];
  return x.x < y.x + y.width && y.x < x.x + x.width && x.y < y.y + y.height && y.y < x.y + x.height;
};

// 侧栏不再单列 Bot，和队员单聊从团队页的卡片点进去。
export const openBot = async (page: Page, name: string) => {
  await page.getByTestId("team-nav").click();
  await teamCard(page, name).getByTestId("team-bot-chat").click();
  await expect(page.getByTestId("chat-title")).toHaveText(name);
};

// 切过去之后历史才开始拉。不等它到齐就数消息，数到的是一份还没填上的空列表。
export const openSeededBot = async (page: Page, name: string) => {
  await openBot(page, name);
  await expect(page.getByTestId("message-list").getByTestId("message"), "预置的历史到齐了").not.toHaveCount(0);
};

export const sendText = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
};

export type RunTrace = { tool: string[]; activity: boolean[]; streaming: boolean[]; working: boolean[] };

declare global {
  interface Window {
    __runTrace?: RunTrace;
    __notifications?: { sent: string[]; asked: number; closed: number; click: (index: number) => void };
  }
}

// 运行中、流式光标、「干活中」这三种状态各只活几百毫秒，等轮询断言撞上是在赌运气。
// 装个观察器把每次变化按先后记下来，跑完再断言这串序列。
export const traceRun = (page: Page) =>
  page.evaluate(() => {
    const trace: RunTrace = { tool: [], activity: [], streaming: [], working: [] };
    window.__runTrace = trace;
    const push = <T>(log: T[], value: T) => {
      if (log.at(-1) !== value) log.push(value);
    };
    const sample = () => {
      const status = document.querySelector("[data-testid=tool-call-card]")?.getAttribute("data-status");
      if (typeof status === "string") push(trace.tool, status);
      push(
        trace.activity,
        document.querySelector("[data-testid=activity-toggle]")?.getAttribute("aria-expanded") === "true",
      );
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

export type DeltaFrame = { messageId: string; delta: string; done: boolean };

// 推送经 Vite 的 /api 代理走同一条 WebSocket，抓帧就能看见控制面真的分了几段推。
export const recordDeltas = (page: Page): DeltaFrame[] => {
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

export const openSettings = async (page: Page) => {
  await page.getByTestId("account-button").click();
  await expect(page.getByTestId("account-menu")).toBeVisible();
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("settings-window")).toBeVisible();
};

export const toolCard = (page: Page, name: string) => page.locator(`[data-testid=tool-card][data-tool-name="${name}"]`);

export const openTools = async (page: Page) => {
  await openSettings(page);
  await page.getByTestId("settings-nav-tools").click();
  await expect(page.getByTestId("tools-page")).toBeVisible();
};

export const fillTool = async (page: Page, name: string, url: string) => {
  await page.getByTestId("tool-name-input").fill(name);
  await page.getByTestId("tool-url-input").fill(url);
  await page.getByTestId("tool-connect").click();
};

// 「发」让 mock 走要点头的那条序列（镜像 bot-runner 的 send_ 前缀规则），工具卡会停在 running 上等结论。
export const NEEDS_APPROVAL = "把报价单发给 Lisa";

export const sendForApproval = async (page: Page, name: string) => {
  await openSeededBot(page, name);
  await traceRun(page);
  await sendText(page, NEEDS_APPROVAL);
  const card = page.getByTestId("approval-card");
  await expect(card, "审批卡到了才谈得上点头").toHaveAttribute("data-status", "pending");
  return card;
};

// 测试浏览器里 Notification.permission 是 default，真代码会安静跳过，什么都断言不到。换成一个记账的桩，
// 既数得出弹了几条，也数得出权限弹窗被请求过几次——除了用户在设置里点「允许通知」，一次都不该有。
// permission 是一开始的授权状态，answer 是权限弹窗里用户选的；click 模拟用户点第几条通知。
export const stubNotifications = (
  page: Page,
  {
    permission = "granted",
    answer = "granted",
  }: { permission?: NotificationPermission; answer?: NotificationPermission } = {},
) =>
  page.addInitScript(
    ([initial, reply]) => {
      const shown: { onclick: (() => void) | null }[] = [];
      const log = {
        sent: [] as string[],
        asked: 0,
        closed: 0,
        click: (index: number) => shown[index]?.onclick?.(),
      };
      window.__notifications = log;
      class Stub {
        static permission = initial;
        static requestPermission() {
          log.asked += 1;
          Stub.permission = reply;
          return Promise.resolve(reply);
        }
        onclick: (() => void) | null = null;
        constructor(title: string, options?: { body?: string }) {
          log.sent.push(`${title} · ${options?.body ?? ""}`);
          shown.push(this);
        }
        close() {
          log.closed += 1;
        }
      }
      Object.defineProperty(window, "Notification", { value: Stub, configurable: true, writable: true });
    },
    [permission, answer] as const,
  );

// 免打扰按浏览器当下的钟算，测试没法挑时辰，所以区间用「现在」推算出来。两段区间都特意让「同一天」和
// 「跨午夜」两种读法在当下这一刻结论相反：判错的那版会把该弹的压掉、把该压的弹出来。
export const dndAround = (page: Page, hoursFrom: number, hoursTo: number) =>
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

export const setDnd = async (page: Page, window: { from: string; to: string }) => {
  await openSettings(page);
  await page.getByTestId("dnd-from").fill(window.from);
  await page.getByTestId("dnd-to").fill(window.to);
  await expect(page.getByTestId("dnd-to"), "设置存住了才谈得上按它判").toHaveValue(window.to);
  await page.getByTestId("settings-close").click();
};

// 预置的多 Bot 群只有一条系统消息，谁开口都是被 @ 出来的，数「只有它回了」才数得清。
export const TEAM_TITLE = "Globex X3 × 200 订单";

// 侧栏的项目先到项目页，项目页一步进项目群。
export const openTeamGroup = async (page: Page, title: string) => {
  await page.locator(`[data-testid=group-item][data-group-title="${title}"]`).click();
  await expect(page.getByTestId("project-page")).toBeVisible();
  await page.getByTestId("project-open-group").click();
  await expect(page.getByTestId("task-card")).toBeVisible();
};

// 小服在群里干完这一段就把供货交给小采。@ 的这句话不含「发」「付」，不会岔进审批那条序列。
export const handoffFromService = async (page: Page, request: APIRequestContext) => {
  expect((await request.post("/api/test/handoff/hold")).status(), "交接确认由用例主动触发").toBe(204);
  await openTeamGroup(page, TEAM_TITLE);
  await sendText(page, "@小服 查一下 Globex 的 X3 库存和排产");
  const card = page.getByTestId("handoff-card");
  await expect(card, "小服干完活就在群里发一张交接报文卡").toBeVisible();
  return card;
};

export const teamItem = (page: Page) => page.locator(`[data-testid=group-item][data-group-title="${TEAM_TITLE}"]`);

export const routineRows = (page: Page, botName: string) =>
  page.locator(`[data-testid=routine-row][data-bot-name="${botName}"]`);

export const openRoutines = async (page: Page, botName: string) => {
  await page.getByTestId("routines-nav").click();
  // 切过去才开始拉。不等预置那条到齐就数行数，数到的是一份还没填上的空列表。
  await expect(routineRows(page, botName)).not.toHaveCount(0);
};

// 技能只在 Bot 头部「它知道的」里看。展开后等「正在拉…」退场，不然数到的是还没到的空列表。
export const openSkills = async (page: Page, botName: string) => {
  await openBot(page, botName);
  await page.getByTestId("bot-know-toggle").click();
  await expect(page.getByTestId("bot-know-skills")).not.toContainText("正在拉");
};

export const skillRow = (page: Page, name: string) =>
  page.locator(`[data-testid=bot-skill][data-skill-name="${name}"]`);
