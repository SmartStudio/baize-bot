import type { ActionKind, ToolView } from "@baize/shared";
import { setTimeout as delay } from "node:timers/promises";
import { type Static, Type } from "typebox";
import type { RunnerTool } from "./bot-session.js";
import type { CdpConnection } from "./cdp.js";
import { BrowserMutex } from "./browser-mutex.js";
import type { PresentPage } from "./live-port.js";

// 助理浏览器：每个 Bot 在助理 Chrome 里有一个自己的后台标签页。电脑代理给了 browser 才有这组工具，测试大多不给。
// 标签页各用各的，但 Chrome 和 profile 是所有 Bot 共用的：cookie 和登录态互通，谁都能打开别人登录过的网站。
// 助理 Chrome 不开调试端口，只有电脑代理手里的那条管道能列出、关掉、接管标签页，页面和 bash 都够不着。

export interface BrowserConfig {
  /** 整个目录是禁区，闸门和两种沙箱都按它挡。 */
  readonly profileDir: string;
  /** 每次用都重新取。Chrome 退了会按需重起，缓存的连接已经断了。 */
  connection(): Promise<CdpConnection>;
  /** 把 Bot 的页摆到用户眼前，`browser_ask_user` 用。由电脑代理的屏实现，见 `src/live-port.ts`。 */
  readonly present: PresentPage;
  /** `browser_ask_user` 等用户的时限，省略是 30 分钟。只有测试缩短它。 */
  readonly takeoverLimitMs?: number;
}

// 读页面归 read。点和填会替归属人在网站上留下动作，归 engage，默认问。没有发布工具，发帖只走草稿加发布器。
export const BROWSER_TOOL_ACTIONS: ReadonlyMap<string, ActionKind> = new Map<string, ActionKind>([
  ["browser_open", "read"],
  ["browser_snapshot", "read"],
  ["browser_screenshot", "read"],
  ["browser_click", "engage"],
  ["browser_type", "engage"],
]);

export const BROWSER_TOOL_NAMES: readonly string[] = [...BROWSER_TOOL_ACTIONS.keys()];

const LOAD_TIMEOUT_MS = 15_000;
/**
 * 关标签页最多等这么久，所有发 Target.closeTarget 的地方都按它。Chrome 关一页正常几十毫秒，2 秒盖得住它忙的时候；
 * 关页是清理，排在 serial 队列里，它无界等待就会挡住后面的 close()，停机整体要秒级结束（用例预算 5 秒），
 * 其余时间留给 abort、dispose 这些收尾，不能等 CDP 的 30 秒命令超时。
 */
const CLOSE_BUDGET_MS = 2_000;
const PAGE_TEXT_MAX = 8_000;
const ELEMENTS_MAX = 200;
const APPROVAL_TEXT_MAX = 80;
const APPROVAL_SERVER = "助理浏览器";

type OpenTab = {
  readonly kind: "open";
  readonly connection: CdpConnection;
  readonly sessionId: string;
  readonly targetId: string;
  readonly unsubscribe: () => void;
};
/** lent：这一页正借给用户操作（`browser_ask_user`），Bot 的工具碰它一律立刻报错，交还后换回 open。 */
type Tab = { readonly kind: "closed" } | OpenTab | { readonly kind: "lent"; readonly page: OpenTab };

/** 不管是 Bot 自己在用还是借给了用户，底下那一页；没开页是 null。 */
const pageOf = (tab: Tab): OpenTab | null => (tab.kind === "open" ? tab : tab.kind === "lent" ? tab.page : null);

export const LENT_ERROR = "这一页正交给用户操作，等他交还之后再用浏览器。";
const NO_PAGE_ERROR = "你还没打开要接手的那一页，先 browser_open";
const REFS_AFTER_LOAN = "用户接手过这一页，之前的编号都作废了，先 browser_snapshot 看一眼再动手";

/** 借出去的一页。`giveBack` 可以重复调；页在借出期间被关掉了也照样清掉编号和隔离世界。 */
export interface PageLoan {
  readonly targetId: string;
  giveBack(): void;
}

/** Bot 最近一次看到的页面：审批卡按它写域名和元素，标签页重开后告诉模型上次在哪。 */
interface Seen {
  /** about:blank 记成 null。 */
  readonly url: string | null;
  /** 最近一次 browser_snapshot 的元素行，下标是编号减一。换了页就清空。 */
  readonly elements: readonly string[];
}
const NOTHING_SEEN: Seen = { url: null, elements: [] };

// type=password 之外，autocomplete 标成密码的普通输入框也是密码框。
const PASSWORD_SELECTOR =
  'input[type="password" i], input[autocomplete~="current-password" i], input[autocomplete~="new-password" i]';

// 所有脚本都在 Page.createIsolatedWorld 建的隔离世界里跑：页面脚本改不了这个世界的全局和 DOM 原型，
// 编号表和暂存的密码值也挂在这个世界的 window 上，页面拿不到。换了文档世界就没了，下一次 snapshot 重建。
const WORLD_NAME = "baize";
const STALE_CONTEXT = "Cannot find context with specified id";
const REFS_KEY = 'Symbol.for("baize.browser.refs")';
const PASSWORDS_KEY = 'Symbol.for("baize.browser.passwords")';

// 只读 innerText 和元素的标签文字。密码框只报「密码框」不报 value，document.cookie 不碰。
const SNAPSHOT_SCRIPT = `(() => {
  const clip = (value, max) => { const text = String(value ?? "").replace(/\\s+/g, " ").trim(); return text.length > max ? text.slice(0, max) + "…" : text; };
  const labelOf = (el) => clip(el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("title") || el.getAttribute("alt") || "", 80);
  const fieldLabel = (el) => clip(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || el.getAttribute("title") || "", 80);
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "链接「" + labelOf(el) + "」→ " + clip(el.href, 200);
    if (tag === "select") return "下拉框「" + fieldLabel(el) + "」，选中「" + clip(el.selectedOptions[0]?.textContent, 80) + "」";
    if (tag === "textarea") return "文本框「" + fieldLabel(el) + "」" + (el.value ? "，已填「" + clip(el.value, 100) + "」" : "");
    if (el.matches(${JSON.stringify(PASSWORD_SELECTOR)})) return "密码框「" + fieldLabel(el) + "」";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (["submit", "button", "reset", "image"].includes(type)) return "按钮「" + clip(el.value || fieldLabel(el), 80) + "」";
      if (type === "checkbox" || type === "radio") return "勾选框「" + fieldLabel(el) + "」" + (el.checked ? "（已勾）" : "（没勾）");
      return "输入框「" + fieldLabel(el) + "」" + (el.value ? "，已填「" + clip(el.value, 100) + "」" : "");
    }
    if (tag === "button" || el.getAttribute("role") === "button") return "按钮「" + labelOf(el) + "」";
    if (el.isContentEditable) return "编辑区「" + fieldLabel(el) + "」";
    return "可点「" + labelOf(el) + "」";
  };
  const selector = 'a[href], button, input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [onclick], [contenteditable=""], [contenteditable="true"]';
  const refs = [...document.querySelectorAll(selector)].filter((el) => el.getClientRects().length > 0).slice(0, ${ELEMENTS_MAX});
  window[${REFS_KEY}] = refs;
  return {
    title: document.title,
    url: location.href,
    text: clip(document.body ? document.body.innerText : "", ${PAGE_TEXT_MAX}),
    elements: refs.map((el, index) => "[" + (index + 1) + "] " + describe(el)),
  };
})()`;

const elementScript = (ref: number, body: string): string => `((ref) => {
  const el = (window[${REFS_KEY}] || [])[ref - 1];
  if (!el || !el.isConnected) return null;
  ${body}
})(${JSON.stringify(ref)})`;

const CLEAR_PASSWORDS = `(() => {
  const saved = [...document.querySelectorAll(${JSON.stringify(PASSWORD_SELECTOR)})].map((el) => [el, el.value]);
  for (const [el] of saved) el.value = "";
  window[${PASSWORDS_KEY}] = saved;
})()`;

const RESTORE_PASSWORDS = `(() => {
  for (const [el, value] of window[${PASSWORDS_KEY}] || []) el.value = value;
  delete window[${PASSWORDS_KEY}];
})()`;

const OPEN_PARAMS = Type.Object({ url: Type.String({ description: "要打开的网址，只认 http 和 https" }) });
const EMPTY_PARAMS = Type.Object({});
const CLICK_PARAMS = Type.Object({ ref: Type.Integer({ description: "browser_snapshot 里元素前面的编号" }) });
const TYPE_PARAMS = Type.Object({
  ref: Type.Integer({ description: "browser_snapshot 里输入框前面的编号" }),
  text: Type.String({ description: "要填的字，会替换框里原有的内容" }),
  submit: Type.Optional(Type.Boolean({ description: "填完按回车" })),
});

function checkedUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`「${raw}」不是完整的网址，要带 https://`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`只能打开 http 和 https 网址，「${raw}」不行`);
  return url.href;
}

const clip = (text: string, max: number): string => {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
};

const hostnameOf = (url: string | null): string | null => {
  if (url === null) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
};

const hostOf = (url: string | null): string => (url === null ? "（空白页）" : (hostnameOf(url) ?? url));

export const abortedError = (): Error => new Error("这次浏览器操作被中止了");

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw abortedError();
};

const sleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  delay(ms, undefined, signal === undefined ? {} : { signal });

/**
 * 等一个 promise，signal 一响当场以中止结束，不等它。promise 本身留着自己收尾：
 * 中止之后才兑现的结果交给 onLate，不给就丢掉；中止之后才拒绝的错误也吞掉，不冒成未处理的拒绝。
 */
const raceAbort = <T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
  onLate?: (result: T) => void,
): Promise<T> => {
  if (signal === undefined) return pending;
  return new Promise<T>((resolve, reject) => {
    let abandoned = false;
    const onAbort = (): void => {
      abandoned = true;
      reject(abortedError());
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    void pending
      .then(
        (result) => {
          if (abandoned) onLate?.(result);
          resolve(result);
        },
        (error: unknown) => {
          if (!abandoned) reject(error);
        },
      )
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
};

/**
 * 关一页，最多等 CLOSE_BUDGET_MS，关不掉也不报错：管道已断时这一页跟着 Chrome 一起没了，
 * Chrome 不回包时命令已经发出，它自己会做完。所有关页都走这里，预算是按资源给的，不按路径。
 */
const closeTarget = async (connection: CdpConnection, targetId: string): Promise<void> => {
  const budget = new AbortController();
  const closing = connection.send("Target.closeTarget", { targetId }).then(
    () => undefined,
    () => undefined,
  );
  await Promise.race([
    closing.finally(() => budget.abort()),
    delay(CLOSE_BUDGET_MS, undefined, { signal: budget.signal }).catch(() => undefined),
  ]);
};

const textResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export interface BotBrowser {
  readonly tools: readonly RunnerTool[];
  /** 会话在判断和执行时分别持锁，等待审批时不持锁；这组工具只排标签页自己的操作队列。 */
  readonly toolsWithHeldMutex: readonly RunnerTool[];
  /** 当前页的主机名，点和填按它授权。还没开页、停在空白页或网址没有主机名时是 null。 */
  host(): string | null;
  /** 点和填的审批卡：当前页的域名和 snapshot 里那个元素，别的工具给 null。 */
  approvalView(toolName: string, input: unknown): ToolView | null;
  /**
   * 把当前页借给用户。排进串行队列并取一次锁，等正在跑的浏览器调用做完就借出，锁随即放开：
   * 借出期间这个 Bot 的浏览器工具不等，碰到就报 LENT_ERROR。没有打开的页抛错，不替用户开页。
   */
  lend(signal: AbortSignal | undefined): Promise<PageLoan>;
  close(): Promise<void>;
}

const withNotice = (notice: string | null, text: string): string => (notice === null ? text : `${notice}\n\n${text}`);

export function createBotBrowser(config: BrowserConfig, mutex = new BrowserMutex()): BotBrowser {
  let tab: Tab = { kind: "closed" };
  let seen: Seen = NOTHING_SEEN;
  /** 用户接手过之后编号表对不上页面了，点和填先要一次 snapshot；snapshot 和重建标签页都清掉它。 */
  let refsStale = false;
  let lastConnection: CdpConnection | null = null;
  /** 当前标签页里的隔离世界，换了文档就作废。 */
  let world: { readonly open: OpenTab; readonly contextId: number } | null = null;
  const loadWaiters = new Set<() => void>();
  // 一个 Bot 的浏览器调用排成一队，重建标签页和导航不交叠。
  let queue: Promise<unknown> = Promise.resolve();
  /** 正在跑的那次调用的 signal。调用串行，所以同一时刻最多一个。 */
  let active: AbortSignal | undefined;

  /**
   * 发一条 CDP 命令。当前调用的 signal 一响，这次等待当场以中止结束；命令本身留给 CDP 自己超时。
   * 这样正在跑的调用在下一条命令处停下，队列很快排空，关闭不用等 30 秒的命令超时。
   * 命令已经进了管道，Chrome 照样会做完：中止之后才到的回包交给 onLate，建页这种留下资源的命令靠它收尾，其余丢掉。
   */
  const command = (
    connection: CdpConnection,
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    onLate?: (result: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown>> => raceAbort(connection.send(method, params, sessionId), active, onLate);

  /**
   * 取连接也跟当前调用的 signal 走：Chrome 正在起时 connection() 最长要等启动超时，
   * 停机时会话被 abort，不跟 signal 走的话排在后面的 close() 就得等它起完。
   * 连接是电脑代理那边共享的，起完归它管，这次调用放弃了就不拿它，不用替它收尾。
   */
  const connect = (): Promise<CdpConnection> => raceAbort(config.connection(), active);

  const send = (open: OpenTab, method: string, params: Record<string, unknown> = {}) =>
    command(open.connection, method, params, open.sessionId);

  /**
   * 排队跑一次调用。Pi 的 signal 一响（停机、abort）这次调用当场以中止结束，不等排在前面的做完；
   * 已经在跑的那次在下一条 CDP 命令或下一次 sleep 处收手，队列很快排空。
   */
  const serial = <T>(signal: AbortSignal | undefined, work: () => Promise<T>, lock = true): Promise<T> => {
    const run = async (): Promise<T> => {
      throwIfAborted(signal);
      active = signal;
      try {
        return await work();
      } finally {
        active = undefined;
      }
    };
    const locked = () => (lock ? mutex.run(signal, run) : run());
    const next = queue.then(locked, locked);
    queue = next.catch(() => undefined);
    if (signal === undefined) return next;
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(abortedError());
      signal.addEventListener("abort", onAbort, { once: true });
      void next.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  };

  const remember = (url: string | null, elements?: readonly string[]): void => {
    const next = url === "about:blank" ? null : url;
    seen = { url: next, elements: elements ?? (next === seen.url ? seen.elements : []) };
  };

  const retire = async (open: OpenTab): Promise<void> => {
    if (pageOf(tab) === open) tab = { kind: "closed" };
    open.unsubscribe();
    await closeTarget(open.connection, open.targetId);
  };

  const contextFor = async (open: OpenTab): Promise<number> => {
    if (world?.open === open) return world.contextId;
    const tree = (await send(open, "Page.getFrameTree")) as { frameTree?: { frame?: { id?: string } } };
    const frameId = tree.frameTree?.frame?.id;
    if (frameId === undefined) throw new Error("助理 Chrome 没有回主框架");
    const created = await send(open, "Page.createIsolatedWorld", { frameId, worldName: WORLD_NAME });
    const contextId = created.executionContextId;
    if (typeof contextId !== "number") throw new Error("助理 Chrome 没有建出隔离世界");
    world = { open, contextId };
    return contextId;
  };

  const evaluate = async (open: OpenTab, expression: string, retry = true): Promise<unknown> => {
    const contextId = await contextFor(open);
    let result: Record<string, unknown>;
    try {
      result = await send(open, "Runtime.evaluate", { expression, contextId, returnByValue: true, awaitPromise: true });
    } catch (error) {
      // 页面在这条命令路上换了文档，旧世界没了，重建一次再跑。
      if (retry && String(error).includes(STALE_CONTEXT)) {
        world = null;
        return evaluate(open, expression, false);
      }
      throw error;
    }
    if (result.exceptionDetails !== undefined) throw new Error("页面里的脚本出错了，先 browser_snapshot 再试");
    return (result.result as { value?: unknown } | undefined)?.value;
  };

  /**
   * 对方不回应时 Page.navigate 本身就不回来。signal 一响这边的等待当场结束，
   * 同时让 Chrome 停止加载，免得它替一个已经中止的调用继续等那个站。
   */
  const navigate = async (open: OpenTab, url: string, signal: AbortSignal | undefined): Promise<void> => {
    let loaded!: () => void;
    const fired = new Promise<void>((resolve) => (loaded = resolve));
    loadWaiters.add(loaded);
    const stopLoading = (): void => void send(open, "Page.stopLoading").catch(() => undefined);
    signal?.addEventListener("abort", stopLoading, { once: true });
    try {
      throwIfAborted(signal);
      const result = await send(open, "Page.navigate", { url });
      throwIfAborted(signal);
      if (typeof result.errorText === "string") throw new Error(`没打开：${result.errorText}`);
      // 同一文档里的跳转没有 loaderId，也不会再有 load 事件。
      if (result.loaderId === undefined) return;
      await Promise.race([fired, sleep(LOAD_TIMEOUT_MS, signal)]);
    } finally {
      signal?.removeEventListener("abort", stopLoading);
      loadWaiters.delete(loaded);
    }
  };

  const openTab = async (connection: CdpConnection): Promise<OpenTab> => {
    let targetId: string | null = null;
    let unsubscribe: (() => void) | null = null;
    try {
      // 建页被中止时 Chrome 多半已经建好了页，回包迟到也要接住，把那一页关掉，不然就是一个没人管的后台标签页。
      const created = await command(
        connection,
        "Target.createTarget",
        { url: "about:blank", background: true },
        undefined,
        (late) => void closeTarget(connection, String(late.targetId)),
      );
      targetId = String(created.targetId);
      const attached = await command(connection, "Target.attachToTarget", { targetId, flatten: true });
      const sessionId = String(attached.sessionId);
      // 管道上是所有 Bot、发布器和登录窗口的事件，只认自己这一页的 session。
      unsubscribe = connection.onEvent((event) => {
        if (event.sessionId !== sessionId && event.params.sessionId !== sessionId) return;
        const current = pageOf(tab);
        if (event.method === "Target.detachedFromTarget" && current?.sessionId === sessionId) {
          current.unsubscribe();
          tab = { kind: "closed" };
        }
        if (event.method === "Page.loadEventFired") {
          for (const waiter of loadWaiters) waiter();
        }
        // 主框架换了文档：隔离世界作废；页面自己跳走的也记下来，点和填按跳过去的域名授权。
        if (event.method === "Page.frameNavigated") {
          const frame = event.params.frame as { parentId?: string; url?: string } | undefined;
          if (frame?.parentId === undefined) {
            world = null;
            if (typeof frame?.url === "string") remember(frame.url);
          }
        }
      });
      const opened: OpenTab = { kind: "open", connection, sessionId, targetId, unsubscribe };
      // 后台标签页里 document.hasFocus() 是 false，不少页面据此不响应输入。焦点模拟只骗这一页，不碰桌面焦点。
      await send(opened, "Emulation.setFocusEmulationEnabled", { enabled: true });
      await send(opened, "Page.enable");
      return opened;
    } catch (error) {
      unsubscribe?.();
      if (targetId !== null) await closeTarget(connection, targetId);
      throw error;
    }
  };

  /**
   * 拿当前能用的标签页。Chrome 重起过或标签页断了就关掉旧页、开一页新的停在空白页：
   * 上次的网址可能是一次提交或一次性链接，替 Bot 再 GET 一遍会重复动作，只在结果里告诉模型上次在哪。
   */
  const ensureTab = async (): Promise<{ readonly open: OpenTab; readonly notice: string | null }> => {
    // 借出去的页连 connection() 都不碰：不等 Chrome 起，也不给它重建一页。
    if (tab.kind === "lent") throw new Error(LENT_ERROR);
    const connection = await connect();
    if (tab.kind === "open" && tab.connection === connection && connection.isOpen()) return { open: tab, notice: null };
    if (tab.kind === "open") await retire(tab);
    const opened = await openTab(connection);
    tab = opened;
    const notice =
      seen.url === null
        ? null
        : `${lastConnection === connection ? "标签页断开后重开过" : "Chrome 重启过"}，上次在 ${seen.url}。` +
          "现在是空白页，之前的编号都作废了，要接着看先 browser_open 这个网址。";
    lastConnection = connection;
    seen = NOTHING_SEEN;
    refsStale = false;
    return { open: opened, notice };
  };

  /** 点和填照着编号动手，标签页重开过或用户接手过就不能接着点。 */
  const tabForRef = async (): Promise<OpenTab> => {
    const { open, notice } = await ensureTab();
    if (notice !== null) throw new Error(notice);
    if (refsStale) throw new Error(REFS_AFTER_LOAN);
    return open;
  };

  const lend = (signal: AbortSignal | undefined): Promise<PageLoan> =>
    serial(signal, async () => {
      if (tab.kind === "lent") throw new Error(LENT_ERROR);
      // Chrome 退过的页和空白页都不算「打开了要接手的那一页」，重建标签页是 browser_open 的事。
      if (tab.kind !== "open" || !tab.connection.isOpen() || seen.url === null) throw new Error(NO_PAGE_ERROR);
      const page = tab;
      tab = { kind: "lent", page };
      return {
        targetId: page.targetId,
        giveBack: () => {
          if (tab.kind === "lent" && tab.page === page) tab = page;
          world = null;
          refsStale = true;
          seen = { url: seen.url, elements: [] };
        },
      };
    });

  const settle = async (open: OpenTab, signal: AbortSignal | undefined): Promise<void> => {
    await sleep(300, signal);
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    while (Date.now() < deadline && (await evaluate(open, "document.readyState")) !== "complete") {
      await sleep(100, signal);
    }
  };

  const rememberUrl = async (open: OpenTab): Promise<void> => {
    const href = await evaluate(open, "location.href");
    if (typeof href === "string") remember(href);
  };

  const pointOf = async (open: OpenTab, ref: number): Promise<{ x: number; y: number }> => {
    const point = await evaluate(
      open,
      elementScript(
        ref,
        `el.scrollIntoView({ block: "center", inline: "center" });
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`,
      ),
    );
    if (point === null || typeof point !== "object")
      throw new Error(`编号 ${ref} 找不到了，先 browser_snapshot 看一眼再点`);
    return point as { x: number; y: number };
  };

  const toolsFor = (lock: boolean): RunnerTool[] => {
    const invoke = <T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> =>
      serial(signal, work, lock);
    return [
      {
        name: "browser_open",
        label: "打开网页",
        description:
          "在你自己的后台标签页里打开一个网址。用户看不到这一页，焦点也不会被抢。打开后用 browser_snapshot 读内容。",
        parameters: OPEN_PARAMS,
        execute: (_callId, params, signal) =>
          invoke(signal, async () => {
            const { open } = await ensureTab();
            const url = checkedUrl((params as Static<typeof OPEN_PARAMS>).url);
            await navigate(open, url, signal);
            await rememberUrl(open);
            const title = await evaluate(open, "document.title");
            return textResult(`已打开「${String(title)}」\n地址：${seen.url ?? url}\n要看内容用 browser_snapshot。`);
          }),
      },
      {
        name: "browser_snapshot",
        label: "读网页",
        description: "读后台标签页当前的页面：标题、网址、正文，和带编号的可点元素。点和填都用这里的编号。",
        parameters: EMPTY_PARAMS,
        execute: (_callId, _params, signal) =>
          invoke(signal, async () => {
            const { open, notice } = await ensureTab();
            const snapshot = (await evaluate(open, SNAPSHOT_SCRIPT)) as {
              title: string;
              url: string;
              text: string;
              elements: string[];
            };
            remember(snapshot.url, snapshot.elements);
            refsStale = false;
            const body = [
              `标题：${snapshot.title}`,
              `地址：${snapshot.url}`,
              "",
              `页面文字：${snapshot.text === "" ? "（空）" : snapshot.text}`,
              "",
              "可点的元素：",
              ...(snapshot.elements.length === 0 ? ["（没有）"] : snapshot.elements),
            ].join("\n");
            return textResult(withNotice(notice, body));
          }),
      },
      {
        name: "browser_screenshot",
        label: "截图",
        description: "截后台标签页当前这一屏给自己看。密码框截的时候是空的。",
        parameters: EMPTY_PARAMS,
        execute: (_callId, _params, signal) =>
          invoke(signal, async () => {
            const { open, notice } = await ensureTab();
            await evaluate(open, CLEAR_PASSWORDS);
            let data: unknown;
            try {
              data = (await send(open, "Page.captureScreenshot", { format: "png" })).data;
            } finally {
              await evaluate(open, RESTORE_PASSWORDS);
            }
            if (typeof data !== "string") throw new Error("助理 Chrome 没有回截图");
            const title = await evaluate(open, "document.title");
            return {
              content: [
                { type: "text" as const, text: withNotice(notice, `「${String(title)}」当前这一屏`) },
                { type: "image" as const, data, mimeType: "image/png" },
              ],
              details: {},
            };
          }),
      },
      {
        name: "browser_click",
        label: "点网页",
        description:
          "点后台标签页里的一个元素，编号来自最近一次 browser_snapshot。会替用户在网站上留下动作，默认要用户点头。",
        parameters: CLICK_PARAMS,
        execute: (_callId, params, signal) =>
          invoke(signal, async () => {
            const { ref } = params as Static<typeof CLICK_PARAMS>;
            const open = await tabForRef();
            const { x, y } = await pointOf(open, ref);
            await send(open, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
            await send(open, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
            await send(open, "Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x,
              y,
              button: "left",
              clickCount: 1,
            });
            await settle(open, signal);
            await rememberUrl(open);
            return textResult(`点了 [${ref}]。要看结果用 browser_snapshot。`);
          }),
      },
      {
        name: "browser_type",
        label: "填网页",
        description: "往后台标签页里的输入框填字，替换原有内容，编号来自最近一次 browser_snapshot。默认要用户点头。",
        parameters: TYPE_PARAMS,
        execute: (_callId, params, signal) =>
          invoke(signal, async () => {
            const { ref, text, submit } = params as Static<typeof TYPE_PARAMS>;
            const open = await tabForRef();
            const focused = await evaluate(
              open,
              elementScript(
                ref,
                `el.scrollIntoView({ block: "center" });
  el.focus();
  if (typeof el.select === "function") el.select();
  return document.activeElement === el;`,
              ),
            );
            if (focused === null) throw new Error(`编号 ${ref} 找不到了，先 browser_snapshot 看一眼再填`);
            if (focused !== true) throw new Error(`编号 ${ref} 不是能填字的地方`);
            await send(open, "Input.insertText", { text });
            if (submit === true) {
              const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
              await send(open, "Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...enter });
              await send(open, "Input.dispatchKeyEvent", { type: "keyUp", ...enter });
              await settle(open, signal);
              await rememberUrl(open);
            }
            return textResult(`在 [${ref}] 填了 ${[...text].length} 个字${submit === true ? "，按了回车" : ""}。`);
          }),
      },
    ];
  };
  const tools = toolsFor(true);

  const elementOf = (ref: unknown): string => {
    const line = typeof ref === "number" ? seen.elements[ref - 1] : undefined;
    if (line === undefined) return `编号 ${String(ref)}，最近一次 browser_snapshot 里没有`;
    return clip(line.replace(/^\[\d+\] /, ""), APPROVAL_TEXT_MAX);
  };

  return {
    tools,
    toolsWithHeldMutex: toolsFor(false),
    host: () => hostnameOf(seen.url),
    approvalView: (toolName, input) => {
      if (toolName !== "browser_click" && toolName !== "browser_type") return null;
      const args = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
      return {
        kind: "mcp",
        server: APPROVAL_SERVER,
        tool: toolName,
        params: [
          { key: "域名", value: hostOf(seen.url) },
          { key: "元素", value: elementOf(args.ref) },
          ...(toolName === "browser_type" ? [{ key: "文字", value: String(args.text ?? "") }] : []),
        ],
        raw: args as ToolView["raw"],
      };
    },
    lend,
    close: () =>
      serial(
        undefined,
        async () => {
          const page = pageOf(tab);
          if (page !== null) await retire(page);
        },
        false,
      ),
  };
}
