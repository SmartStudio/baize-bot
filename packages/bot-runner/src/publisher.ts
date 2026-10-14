import {
  type AgentToControl,
  type BotId,
  type BrowserPlatform,
  type ControlToAgent,
  type DraftImage,
  type PublishFailureReason,
} from "@baize/shared";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserConfig } from "./browser.js";
import { acquireBotBrowserMutex, BotPausedError } from "./browser-mutex.js";
import { draftCopyName } from "./drafts.js";
import { botDirs } from "./paths.js";
import { attachmentCopyName, downloadAttachment, type AttachmentLive } from "./attachments.js";

// 发布器：控制面批准草稿后下行 publish_draft，这里在助理 Chrome 的后台标签页里发出去，回 publish_result。
// 不挂在 Runner 上，电脑代理收到报文直接调，不经过群道的 prompt 队列；与 Bot 的浏览器工具共用互斥锁，各用各的标签页。

export type PublishDraftMessage = Extract<ControlToAgent, { type: "publish_draft" }>;
export type PublishResultMessage = Extract<AgentToControl, { type: "publish_result" }>;
type PublishResult = PublishResultMessage["result"];

/** 页面上要找的一个元素。step 是这一步的名字，找不到时写进 page_changed 的 detail。 */
export interface PageElement {
  readonly step: string;
  readonly selector: string;
  /** 同一选择器匹配到好几个时，挑可见文字含这段的那个。 */
  readonly text?: string;
}

/** 小红书创作者中心的页面结构。改版时只改这一张表，出处和哪几条没核实过见 README「小红书发布器」。 */
export interface XiaohongshuPages {
  readonly publishUrl: string;
  readonly manageUrl: string;
  isLoginPage(url: URL): boolean;
  /** 点了发布之后，页面离开发布页就算发出去了。 */
  isPublished(url: URL): boolean;
  readonly imageTab: PageElement;
  /** 不要求可见，小红书的上传框是藏起来的。 */
  readonly imageInput: PageElement;
  /** 每传完一张多一个。 */
  readonly imagePreview: PageElement;
  readonly titleInput: PageElement;
  readonly bodyEditor: PageElement;
  /** clickX 是点在按钮宽度的哪个比例上。 */
  readonly publishButton: PageElement & { readonly clickX: number };
  /**
   * 笔记管理页的笔记卡片，最新的在最前；笔记 id 从 idAttribute 这个属性里按 idPattern 抠。
   * 卡片里 signedLink 匹配到、网址又含这个 id 的链接就是带 xsec_token 的原链接，没有才拿 id 拼 noteUrl。
   */
  readonly noteCard: PageElement & {
    readonly idAttribute: string;
    readonly idPattern: RegExp;
    readonly signedLink: string;
  };
  /** 不带 xsec_token 的笔记链接可能打不开，只在卡片上读不到原链接时兜底。 */
  noteUrl(noteId: string): string;
}

export const XIAOHONGSHU_PAGES: XiaohongshuPages = {
  publishUrl: "https://creator.xiaohongshu.com/publish/publish",
  manageUrl: "https://creator.xiaohongshu.com/new/note-manager",
  isLoginPage: (url) => url.pathname.startsWith("/login"),
  isPublished: (url) => !url.pathname.startsWith("/publish/publish"),
  imageTab: { step: "切到上传图文", selector: "div.creator-tab", text: "上传图文" },
  imageInput: {
    step: "上传图片",
    selector:
      'input.upload-input, input[type="file"][accept*="image"], input[type="file"][accept*=".jpg"], input[type="file"][accept*=".png"]',
  },
  imagePreview: { step: "等图片传完", selector: ".img-preview-area .pr" },
  titleInput: { step: "填标题", selector: "div.d-input input" },
  bodyEditor: {
    step: "填正文",
    selector: 'div[role="textbox"][contenteditable="true"], div.tiptap[contenteditable="true"], div.ql-editor',
  },
  publishButton: {
    step: "点发布",
    selector:
      'xhs-publish-btn:not([is-publish="false"]):not([submit-disabled="true"]), .publish-page-publish-btn button.bg-red:not([disabled])',
    clickX: 0.65,
  },
  noteCard: {
    step: "读笔记链接",
    selector: "div.note[data-impression]",
    idAttribute: "data-impression",
    idPattern: /"noteId":"([0-9a-f]{24})"/,
    // 待实机核：OpenCLI note-helpers 说笔记链接要带 xsec_token 才稳定能打开，卡片上有没有这样的 <a> 没有出处。
    signedLink: 'a[href*="xsec_token"]',
  },
  noteUrl: (noteId) => `https://www.xiaohongshu.com/explore/${noteId}`,
};

export interface PublishLimits {
  /** 一整条发布从连上 Chrome 到读完笔记链接的总时限，到了就停，记 error。 */
  readonly totalMs: number;
  /** 等某一个元素出现的时限，到了记 page_changed。 */
  readonly stepMs: number;
}

export const PUBLISH_LIMITS: PublishLimits = { totalMs: 180_000, stepMs: 60_000 };

export interface PublisherDeps {
  /** 配图缓存只放在 `<dataDir>/<publish_draft.botId>/drafts/`。 */
  readonly dataDir: string;
  /** 每次下载才读，hello 轮换网关 key 后不能继续用旧 key。 */
  readonly liveHub?: () => AttachmentLive;
  /** 本机电脑代理给的助理浏览器。远程电脑没有。 */
  readonly browser: Pick<BrowserConfig, "connection"> | null;
  readonly xiaohongshu?: XiaohongshuPages;
  readonly limits?: PublishLimits;
}

const DETAIL_MAX = 200;
const POLL_MS = 200;

class PublishFailure extends Error {
  constructor(
    readonly reason: PublishFailureReason,
    detail: string,
  ) {
    super(detail);
  }
}

class TabClosed extends Error {}

const failed = (reason: PublishFailureReason, detail: string): PublishResult => ({
  status: "failed",
  reason,
  detail: detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX - 1)}…` : detail,
});

const sha256Of = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/**
 * 草稿配图只从这个 Bot 的 drafts 目录取；附件缺少有效缓存时先下载校验，旧 path 仍按 realpath 验拷贝。
 * Bot 删了就没有哪个目录算它的，一张都不认。
 */
async function draftFiles(
  dataDir: string,
  botId: BotId | null,
  images: readonly DraftImage[],
  liveHub: PublisherDeps["liveHub"],
): Promise<string[]> {
  if (botId === null) throw new PublishFailure("error", "起草这条的 Bot 已经删了，配图认不出是谁拷的，没有上传");
  const root = await realpath(dataDir).catch(() => {
    throw new PublishFailure("error", "这台电脑的数据目录不在了");
  });
  const { draftsDir } = botDirs(root, botId);
  const files: string[] = [];
  for (const image of images) {
    if (image.kind === "attachment") {
      await mkdir(draftsDir, { recursive: true });
      if ((await realpath(draftsDir)) !== draftsDir) {
        throw new PublishFailure("error", "这个 Bot 的配图目录被换成了符号链接，没有上传");
      }
      const copy = join(draftsDir, attachmentCopyName(image.sha256, image.mime));
      const real = await realpath(copy).catch(() => null);
      const cached = real === copy ? await readFile(copy).catch(() => null) : null;
      if (cached === null || sha256Of(cached) !== image.sha256) {
        const bytes = await downloadAttachment(liveHub, image.attachmentId);
        if (sha256Of(bytes) !== image.sha256) {
          throw new PublishFailure("error", "配图附件的 SHA-256 和起草时不一致，下载的字节被改过，没有上传");
        }
        const temporary = `${copy}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, bytes, { flag: "wx", mode: 0o444 });
          await rename(temporary, copy);
        } finally {
          await rm(temporary, { force: true });
        }
      }
      files.push(copy);
      continue;
    }
    const name = basename(image.path);
    const real = await realpath(image.path).catch(() => null);
    const inCopies =
      real !== null && dirname(real) === draftsDir && basename(real) === draftCopyName(image.sha256, real);
    if (!inCopies) throw new PublishFailure("error", `配图「${name}」不是这个 Bot 起草时拷下来的那份，没有上传`);
    if (sha256Of(await readFile(real)) !== image.sha256) {
      throw new PublishFailure("error", `配图「${name}」和起草时的字节对不上，没有上传`);
    }
    files.push(real);
  }
  return files;
}

// 小红书同一个号只能登一处，两条同时发会互相挤，所以一台电脑一次只发一条。
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work);
  queue = run.catch(() => undefined);
  return run;
}

type DepsWithBrowser = PublisherDeps & { readonly browser: Pick<BrowserConfig, "connection"> };

interface PublishTab {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  isOpen(): boolean;
}

/** 在一个自己建的后台标签页里跑完 work，到总时限就停；成功、失败、超时、抛错都关掉这个标签页。 */
async function inBackgroundTab<T>(
  deps: DepsWithBrowser,
  totalMs: number,
  onTimeout: () => PublishFailure,
  work: (tab: PublishTab) => Promise<T>,
): Promise<T> {
  let closed = false;
  const opening = deps.browser.connection();
  const creating = opening.then((connection) =>
    connection.send("Target.createTarget", { url: "about:blank", background: true }),
  );
  creating.catch(() => undefined);
  const flow = (async () => {
    const connection = await opening;
    const { targetId } = await creating;
    const attached = await connection.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = String(attached.sessionId);
    const tab: PublishTab = {
      send: (method, params = {}) =>
        closed ? Promise.reject(new TabClosed("发布用的标签页已经关了")) : connection.send(method, params, sessionId),
      isOpen: () => !closed && connection.isOpen(),
    };
    // 后台标签页里 document.hasFocus() 是 false，编辑器可能不认输入。焦点模拟只骗这一页，不碰桌面焦点。
    await tab.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    return work(tab);
  })();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), totalMs);
  });
  try {
    return await Promise.race([flow, timedOut]);
  } finally {
    closed = true;
    clearTimeout(timer);
    // 管道是这台电脑共用的，只关自己这一页，不断连接。
    const connection = await opening.catch(() => null);
    const target = await creating.catch(() => null);
    if (connection !== null && target !== null)
      await connection.send("Target.closeTarget", { targetId: target.targetId }).catch(() => null);
  }
}

// 页面里按选择器挑元素：给了 text 就挑可见文字含它的那个。
const PICK = `((selector, text) => {
  const all = [...document.querySelectorAll(selector)];
  return (text === null ? all : all.filter((el) => (el.innerText || el.textContent || "").includes(text)))[0] ?? null;
})`;
const pick = (element: PageElement): string =>
  `${PICK}(${JSON.stringify(element.selector)}, ${JSON.stringify(element.text ?? null)})`;

/** 发布走到哪了。点过发布再出错，用户重发前得先去看一眼；已经离开发布页就算发出去了。 */
interface Progress {
  phase: "filling" | "submitted" | "published";
  step: string;
}

async function fillAndPublish(
  tab: PublishTab,
  pages: XiaohongshuPages,
  stepMs: number,
  post: { readonly title: string | null; readonly text: string },
  files: readonly string[],
  progress: Progress,
): Promise<PublishResult> {
  const evaluate = async (expression: string, returnByValue = true): Promise<Record<string, unknown>> => {
    const result = await tab.send("Runtime.evaluate", { expression, returnByValue, awaitPromise: true });
    if (result.exceptionDetails !== undefined) throw new Error("页面脚本出错");
    return (result.result ?? {}) as Record<string, unknown>;
  };
  const valueOf = async (expression: string): Promise<unknown> => (await evaluate(expression)).value;
  const currentUrl = async (): Promise<URL> => new URL(String(await valueOf("location.href")));

  // 页面还在跳转时脚本会报上下文没了，这一轮当作还没出来；标签页关了或连接断了才往外抛。
  const waitFor = async <T>(step: string, attempt: () => Promise<T | null>): Promise<T> => {
    progress.step = step;
    const deadline = Date.now() + stepMs;
    for (;;) {
      try {
        if (pages.isLoginPage(await currentUrl())) {
          throw new PublishFailure("login_expired", "小红书登录过期了，到账号页重新扫码登录后再发");
        }
        const found = await attempt();
        if (found !== null) return found;
      } catch (error) {
        if (error instanceof PublishFailure || !tab.isOpen()) throw error;
      }
      if (Date.now() > deadline) {
        throw new PublishFailure("page_changed", `小红书页面认不出了，卡在「${step}」这一步，可能改版了`);
      }
      await delay(POLL_MS);
    }
  };

  const navigate = async (url: string): Promise<void> => {
    const result = await tab.send("Page.navigate", { url });
    if (typeof result.errorText === "string") throw new PublishFailure("error", `打不开小红书：${result.errorText}`);
  };

  const click = async (element: PageElement, fraction = 0.5): Promise<void> => {
    const point = await waitFor(element.step, async () => {
      const value = await valueOf(`(() => {
  const el = ${pick(element)};
  if (el === null) return null;
  el.scrollIntoView({ block: "center" });
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? { x: rect.left + rect.width * ${fraction}, y: rect.top + rect.height / 2 } : null;
})()`);
      return (value ?? null) as { x: number; y: number } | null;
    });
    await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
  };

  const pressEnter = async (): Promise<void> => {
    const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await tab.send("Input.dispatchKeyEvent", { type: "keyDown", ...key, text: "\r", unmodifiedText: "\r" });
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  };

  // 选中原有内容再插字，等于替换；输入框用 select()，富文本编辑器用选区。
  // 待实机核：正文编辑器是 tiptap，推断一次 insertText 里带的换行会被吞掉，所以按行插，行与行之间按回车键分段，
  // 空行就是连按两下回车。OpenCLI 的 fillCard 这样填的是文字配图卡片，不是正文。标题是单行输入框，只给一行。
  const typeInto = async (element: PageElement, lines: readonly string[]): Promise<void> => {
    await waitFor(element.step, async () => {
      const focused = await valueOf(`(() => {
  const el = ${pick(element)};
  if (el === null) return null;
  el.scrollIntoView({ block: "center" });
  el.focus();
  if (typeof el.select === "function") el.select();
  else {
    const range = document.createRange();
    range.selectNodeContents(el);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }
  return el === document.activeElement || el.contains(document.activeElement) ? true : null;
})()`);
      return focused === true ? true : null;
    });
    for (const [index, line] of lines.entries()) {
      if (index > 0) await pressEnter();
      if (line !== "") await tab.send("Input.insertText", { text: line });
    }
  };

  await navigate(pages.publishUrl);
  await click(pages.imageTab);
  for (const [index, file] of files.entries()) {
    const objectId = await waitFor(pages.imageInput.step, async () => {
      const found = await evaluate(pick(pages.imageInput), false);
      return typeof found.objectId === "string" ? found.objectId : null;
    });
    await tab.send("DOM.setFileInputFiles", { files: [file], objectId });
    const selector = JSON.stringify(pages.imagePreview.selector);
    await waitFor(pages.imagePreview.step, async () =>
      Number(await valueOf(`document.querySelectorAll(${selector}).length`)) > index ? true : null,
    );
  }
  if (post.title !== null) await typeInto(pages.titleInput, [post.title]);
  await typeInto(pages.bodyEditor, post.text.split("\n"));
  await click(pages.publishButton, pages.publishButton.clickX);
  progress.phase = "submitted";
  await waitFor("等发布完成", async () => (pages.isPublished(await currentUrl()) ? true : null));
  progress.phase = "published";

  await navigate(pages.manageUrl);
  const { selector, idAttribute, idPattern, signedLink } = pages.noteCard;
  const note = await waitFor(pages.noteCard.step, async () => {
    const cards = (await valueOf(
      `[...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => ({ text: el.innerText, attribute: el.getAttribute(${JSON.stringify(idAttribute)}) ?? "", links: [...el.querySelectorAll(${JSON.stringify(signedLink)})].map((a) => a.href) }))`,
    )) as Array<{ text: string; attribute: string; links: string[] }> | undefined;
    // 有标题就按标题认，免得新笔记还没进列表时把上一条当成它；没标题只能取最新一条。
    const card = (cards ?? []).find((one) => post.title === null || one.text.includes(post.title));
    const id = card === undefined ? undefined : idPattern.exec(card.attribute)?.[1];
    return card === undefined || id === undefined ? null : { id, link: card.links.find((href) => href.includes(id)) };
  });
  return { status: "ok", url: note.link ?? pages.noteUrl(note.id), externalId: note.id };
}

type Publisher = (message: PublishDraftMessage, deps: DepsWithBrowser) => Promise<PublishResult>;

async function publishToXiaohongshu(message: PublishDraftMessage, deps: DepsWithBrowser): Promise<PublishResult> {
  const { content } = message;
  if (content.kind !== "post") return failed("error", "小红书发布器只发笔记，回复还没接上");
  if (content.images.length === 0) return failed("error", "小红书笔记至少要一张图");
  const pages = deps.xiaohongshu ?? XIAOHONGSHU_PAGES;
  const limits = deps.limits ?? PUBLISH_LIMITS;
  const progress: Progress = { phase: "filling", step: "连助理 Chrome" };
  try {
    // 验配图也排在队里：入队顺序就是到达顺序，先到的先发，不看谁的文件先读完。
    return await oneAtATime(async () => {
      const files = await draftFiles(deps.dataDir, message.botId, content.images, deps.liveHub);
      return inBackgroundTab(
        deps,
        limits.totalMs,
        () => new PublishFailure("error", `发布超时：${limits.totalMs / 1000} 秒没发完，停在「${progress.step}」`),
        (tab) => fillAndPublish(tab, pages, limits.stepMs, content, files, progress),
      );
    });
  } catch (error) {
    // 已经离开发布页就是发出去了，只是没读到笔记链接。回 failed 会让用户以为没发、再发一遍，所以回 ok 指向笔记管理页。
    if (progress.phase === "published") return { status: "ok", url: pages.manageUrl, externalId: null };
    const failure =
      error instanceof PublishFailure
        ? error
        : new PublishFailure("error", `发布出错：${error instanceof Error ? error.message : String(error)}`);
    const detail =
      progress.phase === "submitted"
        ? `已经点过发布，先去笔记管理看一眼再决定要不要重发。${failure.message}`
        : failure.message;
    return failed(failure.reason, detail);
  }
}

const PUBLISHERS: Record<BrowserPlatform, Publisher> = { xiaohongshu: publishToXiaohongshu };

export async function publishDraft(message: PublishDraftMessage, deps: PublisherDeps): Promise<PublishResultMessage> {
  const { browser } = deps;
  const lease = message.botId === null || browser === null ? null : acquireBotBrowserMutex(deps.dataDir, message.botId);
  let result: PublishResult;
  try {
    result =
      browser === null
        ? failed("error", "这台电脑没有助理浏览器")
        : await (lease === null
            ? PUBLISHERS[message.platform](message, { ...deps, browser })
            : lease.run(() => PUBLISHERS[message.platform](message, { ...deps, browser })));
  } catch (error) {
    result =
      error instanceof BotPausedError
        ? failed("paused", error.message)
        : failed("error", error instanceof Error ? error.message : String(error));
  } finally {
    lease?.release();
  }
  return { type: "publish_result", draftId: message.draftId, attempt: message.attempt, result };
}
