import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountId, ControlToAgent, type DraftContent, DraftId } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PublishDraftMessage, publishDraft, type PublisherDeps, X_PAGES } from "../src/publisher.js";
import { chromeBinary, launchTestChrome, type TestChrome } from "./helpers/chrome.js";

type SiteMode = "normal" | "logged-out" | "no-button" | "no-toast";

interface Post {
  readonly text: string;
  readonly replyTo: string | null;
  /** 点发布之前传上来的图片的 sha256，按上传顺序。 */
  readonly images: readonly string[];
}

const ATTEMPT = "2026-10-19T08:00:00.000Z";
const FIRST_ID = 1900000000000000001n;

// 按 X_PAGES 写的结构搭的假 X：发帖和回复都是 dialog 里的弹窗，详情页底下另有一个常驻的内嵌回复框，
// 发布器要是没框在 dialog 里就会填到它上面。图片没传完、正文空着时发布按钮是 aria-disabled。
// 发出去弹窗收起，弹一条带「View」链接的提示。正文框照 Draft.js 的脾气：一次 insertText 里的换行被吞掉，回车才分段。
const COMPOSER = `
function paragraphs(editor) {
  const lines = [""];
  for (const node of editor.childNodes) {
    if (node.nodeName === "DIV") lines.push(node.textContent);
    else lines[lines.length - 1] += node.textContent;
  }
  return lines.join("\\n");
}
function openComposer(replyTo) {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.innerHTML = '<div data-testid="tweetTextarea_0" contenteditable="true" role="textbox"></div>' +
    '<input data-testid="fileInput" type="file" accept="image/*" multiple style="display:none">' +
    '<div data-testid="attachments"></div>' +
    (MODE === "no-button" ? "" : '<button data-testid="tweetButton" aria-disabled="true">Post</button>');
  document.body.append(dialog);
  const editor = dialog.querySelector('[data-testid="tweetTextarea_0"]');
  const button = dialog.querySelector("button");
  const uploads = [];
  let pending = 0;
  const refresh = () => button?.setAttribute("aria-disabled", String(pending > 0 || editor.textContent === ""));
  editor.addEventListener("beforeinput", (event) => {
    if (event.inputType !== "insertText" || !event.data?.includes("\\n")) return;
    event.preventDefault();
    document.execCommand("insertText", false, event.data.replaceAll("\\n", ""));
  });
  editor.addEventListener("input", refresh);
  const input = dialog.querySelector("input");
  input.addEventListener("change", async () => {
    pending += 1;
    refresh();
    for (const file of input.files) {
      const response = await fetch("/upload", { method: "POST", body: await file.arrayBuffer() });
      uploads.push(await response.text());
      const img = document.createElement("img");
      dialog.querySelector('[data-testid="attachments"]').append(img);
    }
    pending -= 1;
    refresh();
  });
  button?.addEventListener("click", async () => {
    if (button.getAttribute("aria-disabled") === "true") return;
    const response = await fetch("/post", {
      method: "POST",
      body: JSON.stringify({ text: paragraphs(editor), replyTo, images: uploads }),
    });
    const id = await response.text();
    dialog.remove();
    if (MODE === "no-toast") return;
    const toast = document.createElement("div");
    toast.setAttribute("data-testid", "toast");
    toast.innerHTML = 'Your post was sent. <a href="https://x.com/baize_x/status/' + id + '">View</a>';
    document.body.append(toast);
  });
}`;

const page = (mode: SiteMode, body: string, script: string): string =>
  `<!doctype html><meta charset="utf-8"><title>X</title><body>${body}<script>const MODE = ${JSON.stringify(mode)};${COMPOSER}${script}</script></body>`;

const INLINE_REPLY = '<div data-testid="tweetTextarea_0" contenteditable="true" role="textbox" id="inline"></div>';

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

async function startX(mode: SiteMode) {
  const posts: Post[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const html = (body: string): void => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(body);
      };
      if (mode === "logged-out" && (url.pathname === "/compose/post" || url.pathname.startsWith("/i/status/"))) {
        response.writeHead(302, { location: "/i/flow/login?redirect_after_login=%2Fcompose%2Fpost" });
        response.end();
        return;
      }
      if (url.pathname === "/compose/post") {
        html(page(mode, "", "openComposer(null);"));
        return;
      }
      const status = /^\/i\/status\/(\d+)$/.exec(url.pathname)?.[1];
      if (status !== undefined) {
        // 上面一条是它回复的祖先帖，不带 tabindex；主帖带 tabindex="-1"。点错了回复的就是祖先帖。
        html(
          page(
            mode,
            `<article data-testid="tweet" id="ancestor"><p>祖先帖</p><button data-testid="reply">回复</button></article>` +
              `<article data-testid="tweet" tabindex="-1" id="focal"><p>主帖</p><button data-testid="reply">回复</button></article>` +
              INLINE_REPLY,
            `document.querySelector("#ancestor button").addEventListener("click", () => openComposer("ancestor"));
document.querySelector("#focal button").addEventListener("click", () => openComposer(${JSON.stringify(status)}));`,
          ),
        );
        return;
      }
      if (url.pathname === "/upload" && request.method === "POST") {
        response.end(
          createHash("sha256")
            .update(await readBody(request))
            .digest("hex"),
        );
        return;
      }
      if (url.pathname === "/post" && request.method === "POST") {
        posts.push(JSON.parse((await readBody(request)).toString("utf8")) as Post);
        response.end(String(FIRST_ID + BigInt(posts.length - 1)));
        return;
      }
      if (url.pathname === "/i/flow/login") {
        html("<!doctype html><meta charset='utf-8'><title>登录</title><p>Sign in to X</p>");
        return;
      }
      response.writeHead(404);
      response.end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("假 X 没有端口");
  return {
    url: `http://127.0.0.1:${address.port}`,
    posts,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type FakeX = Awaited<ReturnType<typeof startX>>;

const sha256Of = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function draftCopy(dataDir: string, label: string): { kind: "path"; path: string; sha256: string } {
  const bytes = Buffer.from(`假 PNG：${label}`);
  const sha256 = sha256Of(bytes);
  const dir = join(dataDir, "bot-1", "drafts");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sha256}.png`);
  writeFileSync(path, bytes);
  return { kind: "path", path, sha256 };
}

function xMessage(draftId: string, content: DraftContent): PublishDraftMessage {
  const parsed = ControlToAgent.parse({
    type: "publish_draft",
    draftId: DraftId.parse(draftId),
    botId: "bot-1",
    accountId: AccountId.parse("acc-x-web"),
    platform: "x",
    content,
    attempt: ATTEMPT,
  });
  if (parsed.type !== "publish_draft") throw new Error("不是 publish_draft");
  return parsed;
}

const post = (text: string, images: DraftContent["images"] = []): DraftContent => ({
  kind: "post",
  title: null,
  text,
  images,
  github: null,
});

describe("X 页面表", () => {
  it("回复只认 x.com 和 twitter.com 的帖子链接，一律按 id 打开 x.com 的详情页", () => {
    expect(X_PAGES.statusPage("https://x.com/someone/status/123?s=20")).toBe("https://x.com/i/status/123");
    expect(X_PAGES.statusPage("https://twitter.com/someone/status/456")).toBe("https://x.com/i/status/456");
    expect(X_PAGES.statusPage("https://evil.example/someone/status/789")).toBeNull();
    expect(X_PAGES.statusPage("https://x.com.evil.example/a/status/1")).toBeNull();
    expect(X_PAGES.statusPage("https://x.com/someone")).toBeNull();
  });

  it("/login 和 /i/flow/login 都算登录页", () => {
    expect(X_PAGES.isLoginPage(new URL("https://x.com/i/flow/login?x=1"))).toBe(true);
    expect(X_PAGES.isLoginPage(new URL("https://x.com/login"))).toBe(true);
    expect(X_PAGES.isLoginPage(new URL("https://x.com/compose/post"))).toBe(false);
  });
});

describe("X 发布器先验草稿，不碰浏览器", () => {
  let dataDir = "";
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "baize-x-publisher-check-"));
  });
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  const untouched = (): { deps: PublisherDeps; calls: () => number } => {
    let calls = 0;
    return {
      deps: {
        dataDir,
        browser: {
          connection: async () => {
            calls += 1;
            throw new Error("不该碰浏览器");
          },
        },
      },
      calls: () => calls,
    };
  };

  it("回复的不是 X 帖子链接、图超过 4 张，都回 error", async () => {
    const probe = untouched();
    const reply = await publishDraft(
      xMessage("x-bad-reply", {
        kind: "reply",
        text: "谢谢",
        images: [],
        replyTo: { url: "https://evil.example/a/status/1", author: "a", quote: "q" },
      }),
      probe.deps,
    );
    const images = Array.from({ length: 5 }, (_, index) => draftCopy(dataDir, `第 ${index} 张`));
    const many = await publishDraft(xMessage("x-many", post("五张图", images)), probe.deps);

    expect(reply.result).toEqual({ status: "failed", reason: "error", detail: "X 只能回复帖子的链接" });
    expect(many.result).toEqual({ status: "failed", reason: "error", detail: "X 一条帖子最多带 4 张图" });
    expect(probe.calls()).toBe(0);
  });
});

describe.skipIf(chromeBinary === null)("X 发布器（真 Chrome 加假 X）", () => {
  let chrome: TestChrome;
  let profileDir = "";
  let dataDir = "";
  const sites: FakeX[] = [];

  beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), "baize-x-publisher-chrome-"));
    dataDir = mkdtempSync(join(tmpdir(), "baize-x-publisher-data-"));
    chrome = await launchTestChrome(profileDir);
  }, 30_000);

  afterAll(async () => {
    await chrome?.stop();
    await Promise.all(sites.map((site) => site.close()));
    rmSync(profileDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  const site = async (mode: SiteMode): Promise<FakeX> => {
    const started = await startX(mode);
    sites.push(started);
    return started;
  };
  const depsFor = (x: FakeX, stepMs = 3_000): PublisherDeps => ({
    dataDir,
    browser: { connection: async () => chrome.connection },
    x: {
      ...X_PAGES,
      composeUrl: `${x.url}/compose/post`,
      statusPage: (replyTo) => X_PAGES.statusPage(replyTo)?.replace("https://x.com", x.url) ?? null,
    },
    limits: { totalMs: 30_000, stepMs },
  });

  it("发一条带图的帖子，正文按行分好段，回 ok 带提示条上的帖子链接", async () => {
    const x = await site("normal");
    const images = [draftCopy(dataDir, "封面"), draftCopy(dataDir, "第二张")];
    const text = "第一行\n第二行\n\n空一行之后";

    const reply = await publishDraft(xMessage("x-ok", post(text, images)), depsFor(x));

    expect(reply).toEqual({
      type: "publish_result",
      draftId: "x-ok",
      attempt: ATTEMPT,
      result: { status: "ok", url: `https://x.com/baize_x/status/${FIRST_ID}`, externalId: String(FIRST_ID) },
    });
    expect(x.posts).toEqual([{ text, replyTo: null, images: images.map((image) => image.sha256) }]);
  });

  it("回复先打开原帖，点主帖的回复，填进弹窗而不是页面底下的内嵌框", async () => {
    const x = await site("normal");

    const { result } = await publishDraft(
      xMessage("x-reply", {
        kind: "reply",
        text: "谢谢推荐",
        images: [],
        replyTo: { url: "https://twitter.com/someone/status/1234567890", author: "someone", quote: "好用" },
      }),
      depsFor(x),
    );

    expect(result).toMatchObject({ status: "ok", externalId: String(FIRST_ID) });
    expect(x.posts, "回的是主帖，不是上面那条祖先帖").toEqual([
      { text: "谢谢推荐", replyTo: "1234567890", images: [] },
    ]);
  });

  it("被踢到 /i/flow/login 回 login_expired", async () => {
    const x = await site("logged-out");

    const { result } = await publishDraft(xMessage("x-login", post("正文")), depsFor(x));

    expect(result).toMatchObject({ status: "failed", reason: "login_expired" });
    expect(result.status === "failed" ? result.detail : "").toContain("X 登录过期了");
    expect(x.posts).toEqual([]);
  });

  it("发布按钮不见了回 page_changed，detail 说是哪一步", async () => {
    const x = await site("no-button");

    const { result } = await publishDraft(xMessage("x-changed", post("正文")), depsFor(x, 1_500));

    expect(result).toMatchObject({ status: "failed", reason: "page_changed" });
    expect(result.status === "failed" ? result.detail : "").toContain("点发布");
    expect(x.posts).toEqual([]);
  });

  it("发出去了但没弹提示条，回 ok 带 X 主页，不让用户重发", async () => {
    const x = await site("no-toast");

    const { result } = await publishDraft(xMessage("x-no-toast", post("读不到链接")), depsFor(x, 1_500));

    expect(x.posts, "帖子确实发出去了").toHaveLength(1);
    expect(result).toEqual({ status: "ok", url: "https://x.com/home", externalId: null });
  });
});
