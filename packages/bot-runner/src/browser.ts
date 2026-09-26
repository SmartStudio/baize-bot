import type { ActionKind, ToolView } from "@baize/shared";
import { setTimeout as delay } from "node:timers/promises";
import { type Static, Type } from "typebox";
import type { RunnerTool } from "./bot-session.js";
import type { CdpConnection } from "./cdp.js";

// 助理浏览器：每个 Bot 在助理 Chrome 里有一个自己的后台标签页。只有本机电脑代理给 browser，远程电脑和测试不给就没有这组工具。
// 标签页各用各的，但 Chrome 和 profile 是所有 Bot 共用的：cookie 和登录态互通，谁都能打开别人登录过的网站。
// 助理 Chrome 不开调试端口，只有电脑代理手里的那条管道能列出、关掉、接管标签页，页面和 bash 都够不着。

export interface BrowserConfig {
  /** 整个目录是禁区，闸门和两种沙箱都按它挡。 */
  readonly profileDir: string;
  /** 每次用都重新取。Chrome 退了会按需重起，缓存的连接已经断了。 */
  connection(): Promise<CdpConnection>;
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
const PAGE_TEXT_MAX = 8_000;
const ELEMENTS_MAX = 200;
const APPROVAL_TEXT_MAX = 80;
const APPROVAL_SERVER = "助理浏览器";

type Tab =
  | { readonly kind: "closed" }
  | {
      readonly kind: "open";
      readonly connection: CdpConnection;
      readonly sessionId: string;
      readonly targetId: string;
      readonly unsubscribe: () => void;
    };
type OpenTab = Extract<Tab, { kind: "open" }>;

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

// 编号表和暂存的密码值挂在页面的 window 上，下一次 snapshot 重建。
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

const hostOf = (url: string | null): string => {
  if (url === null) return "（空白页）";
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
};

const send = (open: OpenTab, method: string, params: Record<string, unknown> = {}) =>
  open.connection.send(method, params, open.sessionId);

const textResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export interface BotBrowser {
  readonly tools: readonly RunnerTool[];
  /** 点和填的审批卡：当前页的域名和 snapshot 里那个元素，别的工具给 null。 */
  approvalView(toolName: string, input: unknown): ToolView | null;
  close(): Promise<void>;
}

const withNotice = (notice: string | null, text: string): string => (notice === null ? text : `${notice}\n\n${text}`);

export function createBotBrowser(config: BrowserConfig): BotBrowser {
  let tab: Tab = { kind: "closed" };
  let seen: Seen = NOTHING_SEEN;
  let lastConnection: CdpConnection | null = null;
  const loadWaiters = new Set<() => void>();
  // 一个 Bot 的浏览器调用排成一队，重建标签页和导航不交叠。
  let queue: Promise<unknown> = Promise.resolve();

  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const remember = (url: string | null, elements?: readonly string[]): void => {
    const next = url === "about:blank" ? null : url;
    seen = { url: next, elements: elements ?? (next === seen.url ? seen.elements : []) };
  };

  // 管道已断时这一页跟着 Chrome 一起没了，关不关得掉都不用记。
  const retire = async (open: OpenTab): Promise<void> => {
    if (tab === open) tab = { kind: "closed" };
    open.unsubscribe();
    await open.connection.send("Target.closeTarget", { targetId: open.targetId }).catch(() => undefined);
  };

  const evaluate = async (open: OpenTab, expression: string): Promise<unknown> => {
    const result = await send(open, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails !== undefined) throw new Error("页面里的脚本出错了，先 browser_snapshot 再试");
    return (result.result as { value?: unknown } | undefined)?.value;
  };

  const navigate = async (open: OpenTab, url: string): Promise<void> => {
    let loaded!: () => void;
    const fired = new Promise<void>((resolve) => (loaded = resolve));
    loadWaiters.add(loaded);
    try {
      const result = await send(open, "Page.navigate", { url });
      if (typeof result.errorText === "string") throw new Error(`没打开：${result.errorText}`);
      // 同一文档里的跳转没有 loaderId，也不会再有 load 事件。
      if (result.loaderId === undefined) return;
      await Promise.race([fired, delay(LOAD_TIMEOUT_MS)]);
    } finally {
      loadWaiters.delete(loaded);
    }
  };

  const openTab = async (connection: CdpConnection): Promise<OpenTab> => {
    let targetId: string | null = null;
    let unsubscribe: (() => void) | null = null;
    try {
      const created = await connection.send("Target.createTarget", { url: "about:blank", background: true });
      targetId = String(created.targetId);
      const attached = await connection.send("Target.attachToTarget", { targetId, flatten: true });
      const sessionId = String(attached.sessionId);
      // 管道上是所有 Bot、发布器和登录窗口的事件，只认自己这一页的 session。
      unsubscribe = connection.onEvent((event) => {
        if (event.sessionId !== sessionId && event.params.sessionId !== sessionId) return;
        if (event.method === "Target.detachedFromTarget" && tab.kind === "open" && tab.sessionId === sessionId) {
          tab.unsubscribe();
          tab = { kind: "closed" };
        }
        if (event.method === "Page.loadEventFired") {
          for (const waiter of loadWaiters) waiter();
        }
      });
      const opened: OpenTab = { kind: "open", connection, sessionId, targetId, unsubscribe };
      // 后台标签页里 document.hasFocus() 是 false，不少页面据此不响应输入。焦点模拟只骗这一页，不碰桌面焦点。
      await send(opened, "Emulation.setFocusEmulationEnabled", { enabled: true });
      await send(opened, "Page.enable");
      return opened;
    } catch (error) {
      unsubscribe?.();
      if (targetId !== null) await connection.send("Target.closeTarget", { targetId }).catch(() => undefined);
      throw error;
    }
  };

  /**
   * 拿当前能用的标签页。Chrome 重起过或标签页断了就关掉旧页、开一页新的停在空白页：
   * 上次的网址可能是一次提交或一次性链接，替 Bot 再 GET 一遍会重复动作，只在结果里告诉模型上次在哪。
   */
  const ensureTab = async (): Promise<{ readonly open: OpenTab; readonly notice: string | null }> => {
    const connection = await config.connection();
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
    return { open: opened, notice };
  };

  /** 点和填照着编号动手，标签页重开过就不能接着点。 */
  const tabForRef = async (): Promise<OpenTab> => {
    const { open, notice } = await ensureTab();
    if (notice !== null) throw new Error(notice);
    return open;
  };

  const settle = async (open: OpenTab): Promise<void> => {
    await delay(300);
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    while (Date.now() < deadline && (await evaluate(open, "document.readyState")) !== "complete") await delay(100);
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

  const tools: RunnerTool[] = [
    {
      name: "browser_open",
      label: "打开网页",
      description:
        "在你自己的后台标签页里打开一个网址。用户看不到这一页，焦点也不会被抢。打开后用 browser_snapshot 读内容。",
      parameters: OPEN_PARAMS,
      execute: (_callId, params) =>
        serial(async () => {
          const { open } = await ensureTab();
          const url = checkedUrl((params as Static<typeof OPEN_PARAMS>).url);
          await navigate(open, url);
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
      execute: () =>
        serial(async () => {
          const { open, notice } = await ensureTab();
          const snapshot = (await evaluate(open, SNAPSHOT_SCRIPT)) as {
            title: string;
            url: string;
            text: string;
            elements: string[];
          };
          remember(snapshot.url, snapshot.elements);
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
      execute: () =>
        serial(async () => {
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
      execute: (_callId, params) =>
        serial(async () => {
          const { ref } = params as Static<typeof CLICK_PARAMS>;
          const open = await tabForRef();
          const { x, y } = await pointOf(open, ref);
          await send(open, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
          await send(open, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
          await send(open, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
          await settle(open);
          await rememberUrl(open);
          return textResult(`点了 [${ref}]。要看结果用 browser_snapshot。`);
        }),
    },
    {
      name: "browser_type",
      label: "填网页",
      description: "往后台标签页里的输入框填字，替换原有内容，编号来自最近一次 browser_snapshot。默认要用户点头。",
      parameters: TYPE_PARAMS,
      execute: (_callId, params) =>
        serial(async () => {
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
            await settle(open);
            await rememberUrl(open);
          }
          return textResult(`在 [${ref}] 填了 ${[...text].length} 个字${submit === true ? "，按了回车" : ""}。`);
        }),
    },
  ];

  const elementOf = (ref: unknown): string => {
    const line = typeof ref === "number" ? seen.elements[ref - 1] : undefined;
    if (line === undefined) return `编号 ${String(ref)}，最近一次 browser_snapshot 里没有`;
    return clip(line.replace(/^\[\d+\] /, ""), APPROVAL_TEXT_MAX);
  };

  return {
    tools,
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
    close: () =>
      serial(async () => {
        if (tab.kind === "open") await retire(tab);
      }),
  };
}
