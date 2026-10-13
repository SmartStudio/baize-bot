import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AccountId, ControlToAgent, DraftId } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBotBrowser } from "../src/browser.js";
import type { CdpConnection } from "../src/cdp.js";
import { type PublishDraftMessage, publishDraft, type PublisherDeps, XIAOHONGSHU_PAGES } from "../src/publisher.js";
import {
  chromeBinary,
  evaluateIn,
  launchTestChrome,
  openUserTab,
  type PageTarget,
  pageTargets,
  settledPages,
  type TestChrome,
} from "./helpers/chrome.js";

type SiteMode = "normal" | "logged-out" | "no-button" | "hang" | "no-notes" | "no-token";

interface SiteEvent {
  readonly kind: "open" | "published" | "manage";
  readonly at: number;
  readonly title?: string;
}

interface Publication {
  readonly title: string;
  readonly body: string;
  readonly hasFocus: boolean;
  /** 这次发布之前传上来的图片的 sha256，按上传顺序。 */
  readonly images: readonly string[];
}

const NOTE_IDS = ["65f1a2b3c4d5e6f7a8b9c0d1", "65f1a2b3c4d5e6f7a8b9c0d2", "65f1a2b3c4d5e6f7a8b9c0d3"];
const OLD_NOTE = { id: "5e0000000000000000000abc", title: "去年的旧笔记" };
const signedNoteUrl = (id: string): string =>
  `https://www.xiaohongshu.com/explore/${id}?xsec_token=AB${id.slice(-6)}xyz%3D&xsec_source=pc_creatormng`;

// 按 XIAOHONGSHU_PAGES 里写的结构搭的假创作者中心：切到上传图文才出上传框，第一张图传完才出标题和正文，
// 发布按钮把标题、正文和从加载到点发布是否一直有焦点交给服务端，再跳离发布页；笔记管理页最新的在最前，
// 卡片里有作者主页和笔记两个带 xsec_token 的链接。正文框照 tiptap 的脾气：一次 insertText 里的换行被吞掉，
// 只有回车键才分段（OpenCLI clis/xiaohongshu/publish.js 的 fillCard 注释）。
const PUBLISH_PAGE = (mode: SiteMode): string => `<!doctype html><meta charset="utf-8"><title>发布笔记</title>
<div class="upload-content">
  <div class="creator-tab"><span>上传视频</span></div>
  <div class="creator-tab"><span>上传图文</span></div>
  <div id="area"></div>
</div>
<script>
// 页面一加载就记，赶在任何点击之前：无头 Chrome 里鼠标点一下就会给页面焦点，点完再看分不出有没有焦点模拟。
const focusedAtLoad = document.hasFocus();
const area = document.getElementById("area");
document.querySelectorAll(".creator-tab")[1].addEventListener("click", () => {
  if (area.querySelector("input")) return;
  area.innerHTML = '<input class="upload-input" type="file" accept=".jpg,.jpeg,.png,.webp" multiple><div class="img-preview-area"></div>';
  const input = area.querySelector("input");
  input.addEventListener("change", async () => {
    for (const file of input.files) {
      await fetch("/upload", { method: "POST", body: await file.arrayBuffer() });
      const preview = document.createElement("div");
      preview.className = "pr";
      area.querySelector(".img-preview-area").append(preview);
    }
    if (!document.querySelector(".d-input")) showEditor();
  });
});
// 回车在 contenteditable 里新起一个 div，空段是 <div><br></div>；innerText 会给空段多算一个换行，所以按段读。
function paragraphs(editor) {
  const lines = [""];
  for (const node of editor.childNodes) {
    if (node.nodeName === "DIV") lines.push(node.textContent);
    else lines[lines.length - 1] += node.textContent;
  }
  return lines.join("\\n");
}
function showEditor() {
  const editor = document.createElement("div");
  editor.innerHTML = '<div class="d-input"><input placeholder="填写标题会有更多赞哦"></div>' +
    '<div class="tiptap" contenteditable="true" role="textbox"></div>' +
    ${JSON.stringify(mode === "no-button" ? "" : '<div class="publish-page-publish-btn"><button class="bg-red">发布</button></div>')};
  area.append(editor);
  editor.querySelector(".tiptap").addEventListener("beforeinput", (event) => {
    if (event.inputType !== "insertText" || !event.data?.includes("\\n")) return;
    event.preventDefault();
    document.execCommand("insertText", false, event.data.replaceAll("\\n", ""));
  });
  editor.querySelector("button")?.addEventListener("click", async () => {
    await fetch("/publish", {
      method: "POST",
      body: JSON.stringify({
        title: editor.querySelector("input").value,
        body: paragraphs(editor.querySelector(".tiptap")),
        hasFocus: focusedAtLoad && document.hasFocus(),
      }),
    });
    location.href = "/publish/success";
  });
}
</script>`;

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

async function startCreatorSite(mode: SiteMode, publishDelayMs = 0) {
  const events: SiteEvent[] = [];
  const publications: Publication[] = [];
  const notes = [OLD_NOTE];
  let uploads: string[] = [];
  let requests = 0;
  const hanging: ServerResponse[] = [];

  const server = createServer((request, response) => {
    requests += 1;
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const html = (body: string): void => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(body);
      };
      if (url.pathname === "/publish/publish") {
        if (mode === "hang") {
          hanging.push(response);
          return;
        }
        if (mode === "logged-out") {
          response.writeHead(302, { location: "/login?redirectReason=401" });
          response.end();
          return;
        }
        events.push({ kind: "open", at: Date.now() });
        uploads = [];
        html(PUBLISH_PAGE(mode));
        return;
      }
      if (url.pathname === "/upload" && request.method === "POST") {
        uploads.push(
          createHash("sha256")
            .update(await readBody(request))
            .digest("hex"),
        );
        response.end("{}");
        return;
      }
      if (url.pathname === "/publish" && request.method === "POST") {
        const sent = JSON.parse((await readBody(request)).toString("utf8")) as Omit<Publication, "images">;
        await delay(publishDelayMs);
        publications.push({ ...sent, images: uploads });
        events.push({ kind: "published", at: Date.now(), title: sent.title });
        const id = NOTE_IDS[publications.length - 1] ?? "65f1a2b3c4d5e6f7a8b9c0ff";
        notes.unshift({ id, title: sent.title });
        response.end("{}");
        return;
      }
      if (url.pathname === "/publish/success") {
        html("<!doctype html><meta charset='utf-8'><title>发布成功</title><p>发布成功</p>");
        return;
      }
      if (url.pathname === "/new/note-manager") {
        events.push({ kind: "manage", at: Date.now() });
        const cards = mode === "no-notes" ? [] : notes;
        html(
          `<!doctype html><meta charset="utf-8"><title>笔记管理</title>${cards
            .map(
              (note) =>
                `<div class="note" data-impression='{"noteTarget":{"type":"normal","noteId":"${note.id}"}}'>` +
                `<a href="https://www.xiaohongshu.com/user/profile/5f0000000000000000000001?xsec_token=PROFILE">作者</a>` +
                (mode === "no-token" ? "" : `<a href="${signedNoteUrl(note.id)}">`) +
                `<div class="title">${note.title}</div>${mode === "no-token" ? "" : "</a>"}</div>`,
            )
            .join("")}`,
        );
        return;
      }
      if (url.pathname === "/login") {
        html("<!doctype html><meta charset='utf-8'><title>登录</title><p>扫码登录</p>");
        return;
      }
      if (url.pathname === "/user") {
        html(
          "<!doctype html><meta charset='utf-8'><title>用户在看</title><script>window.hidden = []; document.addEventListener('visibilitychange', () => window.hidden.push(document.visibilityState));</script>",
        );
        return;
      }
      response.writeHead(404);
      response.end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("假创作者页没有端口");
  return {
    url: `http://127.0.0.1:${address.port}`,
    events,
    publications,
    requests: () => requests,
    close: async () => {
      for (const response of hanging) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type CreatorSite = Awaited<ReturnType<typeof startCreatorSite>>;

const textOf = (content: readonly ({ type: "text"; text: string } | { type: "image" })[]): string =>
  content.map((block) => (block.type === "text" ? block.text : "")).join("");

const sha256Of = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** 照起草工具的规矩放一张拷贝：`<dataDir>/<botId>/drafts/<sha256>.<扩展名>`。 */
function draftCopy(dataDir: string, label: string, botId = "bot-1"): { path: string; sha256: string } {
  const bytes = Buffer.from(`假 PNG：${label}`);
  const sha256 = sha256Of(bytes);
  const dir = join(dataDir, botId, "drafts");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sha256}.png`);
  writeFileSync(path, bytes);
  return { path, sha256 };
}

const ATTEMPT = "2026-09-26T08:00:00.000Z";

function draftMessage(
  draftId: string,
  post: { title: string | null; text: string; images: ReadonlyArray<{ path: string; sha256: string }> },
  botId: string | null = "bot-1",
): PublishDraftMessage {
  const parsed = ControlToAgent.parse({
    type: "publish_draft",
    draftId: DraftId.parse(draftId),
    botId,
    accountId: AccountId.parse("acc-xhs"),
    platform: "xiaohongshu",
    content: { kind: "post", title: post.title, text: post.text, images: post.images, github: null },
    attempt: ATTEMPT,
  });
  if (parsed.type !== "publish_draft") throw new Error("不是 publish_draft");
  return parsed;
}

const noBrowserCalls = (): { deps: (dataDir: string) => PublisherDeps; calls: () => number } => {
  let calls = 0;
  return {
    deps: (dataDir) => ({
      dataDir,
      browser: {
        connection: async () => {
          calls += 1;
          throw new Error("不该碰浏览器");
        },
      },
    }),
    calls: () => calls,
  };
};

describe("发布器先验草稿，不碰浏览器", () => {
  let dataDir = "";
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "baize-publisher-check-"));
  });
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it("没有浏览器配置的电脑回 error", async () => {
    const image = draftCopy(dataDir, "远程");
    const result = await publishDraft(draftMessage("draft-remote", { title: "t", text: "正文", images: [image] }), {
      dataDir,
      browser: null,
    });

    expect(result, "认领标识原样带回").toEqual({
      type: "publish_result",
      draftId: "draft-remote",
      attempt: ATTEMPT,
      result: { status: "failed", reason: "error", detail: "这台电脑没有助理浏览器" },
    });
  });

  it("别的 Bot 目录下的配图不上传，回 error", async () => {
    const others = draftCopy(dataDir, "别的 Bot 起的", "bot-2");
    const probe = noBrowserCalls();

    const results = [
      await publishDraft(
        draftMessage("draft-other-bot", { title: "t", text: "正文", images: [others] }, "bot-1"),
        probe.deps(dataDir),
      ),
      await publishDraft(
        draftMessage("draft-bot-gone", { title: "t", text: "正文", images: [others] }, null),
        probe.deps(dataDir),
      ),
    ];

    for (const { result } of results) {
      expect(result).toMatchObject({ status: "failed", reason: "error" });
      expect(result.status === "failed" ? result.detail : "", "说清楚是配图不对").toContain("配图");
    }
    expect(probe.calls(), "别的 Bot 的拷贝一张都不传，浏览器也不连").toBe(0);
  });

  it("图片路径不在拷贝目录里，不上传，回 error", async () => {
    const outside = join(dataDir, "bot-1", "work");
    mkdirSync(outside, { recursive: true });
    const bytes = Buffer.from("工作目录里的原图");
    const sha256 = sha256Of(bytes);
    const workImage = join(outside, `${sha256}.png`);
    writeFileSync(workImage, bytes);
    const tampered = draftCopy(dataDir, "被改过");
    writeFileSync(tampered.path, "起草之后被换了字节");
    const probe = noBrowserCalls();

    const results = [
      await publishDraft(
        draftMessage("draft-outside", { title: "t", text: "正文", images: [{ path: workImage, sha256 }] }),
        probe.deps(dataDir),
      ),
      await publishDraft(
        draftMessage("draft-tampered", { title: "t", text: "正文", images: [tampered] }),
        probe.deps(dataDir),
      ),
    ];

    for (const { result } of results) {
      expect(result).toMatchObject({ status: "failed", reason: "error" });
      expect(result.status === "failed" ? result.detail : "", "说清楚是配图不对").toContain("配图");
    }
    expect(probe.calls(), "配图不对就不碰浏览器，一张都不传").toBe(0);
  });

  it("没图的小红书笔记回 error，不碰浏览器", async () => {
    const probe = noBrowserCalls();
    const { result } = await publishDraft(
      draftMessage("draft-no-image", { title: "t", text: "正文", images: [] }),
      probe.deps(dataDir),
    );

    expect(result).toEqual({ status: "failed", reason: "error", detail: "小红书笔记至少要一张图" });
    expect(probe.calls()).toBe(0);
  });

  it("detail 截到 200 字", async () => {
    const name = `${"起草时没拷下来的配图".repeat(30)}.png`;
    const { result } = await publishDraft(
      draftMessage("draft-long-detail", {
        title: "t",
        text: "正文",
        images: [{ path: join(dataDir, "bot-1", "work", name), sha256: "0".repeat(64) }],
      }),
      noBrowserCalls().deps(dataDir),
    );

    const detail = result.status === "failed" ? result.detail : "";
    expect(detail, "配图名拼进去有三百多字，截到正好 200 字").toHaveLength(200);
    expect(detail.startsWith("配图「起草时没拷下来的配图")).toBe(true);
    expect(detail.endsWith("…"), "截断处留个省略号").toBe(true);
  });
});

describe.skipIf(chromeBinary === null)("小红书发布器（真 Chrome 加假创作者页）", () => {
  let chrome: TestChrome;
  let profileDir = "";
  let dataDir = "";
  const sites: CreatorSite[] = [];

  beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), "baize-publisher-chrome-"));
    dataDir = mkdtempSync(join(tmpdir(), "baize-publisher-data-"));
    chrome = await launchTestChrome(profileDir);
  }, 30_000);

  afterAll(async () => {
    await chrome?.stop();
    await Promise.all(sites.map((site) => site.close()));
    rmSync(profileDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  const site = async (mode: SiteMode, publishDelayMs = 0): Promise<CreatorSite> => {
    const started = await startCreatorSite(mode, publishDelayMs);
    sites.push(started);
    return started;
  };
  const depsFor = (creator: CreatorSite, limits = { totalMs: 30_000, stepMs: 3_000 }): PublisherDeps => ({
    dataDir,
    browser: { connection: async () => chrome.connection },
    xiaohongshu: {
      ...XIAOHONGSHU_PAGES,
      publishUrl: `${creator.url}/publish/publish`,
      manageUrl: `${creator.url}/new/note-manager`,
    },
    limits,
  });
  const tabIds = async (): Promise<string[]> =>
    (await pageTargets(chrome.connection)).map((target) => target.id).toSorted();
  // 上一条用例的发布标签页关了还没从清单里消失时拍的「之前」会多出它，先等假创作者站上除用户页以外的标签页走完。
  const tabIdsBefore = async (): Promise<string[]> =>
    (
      await settledPages(chrome.connection, (pages) =>
        pages.every(
          (page) => page.url.endsWith("/user") || !sites.some((started) => page.url.startsWith(`${started.url}/`)),
        ),
      )
    )
      .map((page) => page.id)
      .toSorted();
  // closeTarget 先回 success，标签页要等 detachedFromTarget 之后才从清单里消失。
  const tabsSettleTo = async (expected: readonly string[]): Promise<string[]> => {
    const deadline = Date.now() + 3_000;
    for (;;) {
      const ids = await tabIds();
      if (ids.join() === expected.join() || Date.now() > deadline) return ids;
      await delay(50);
    }
  };

  it("发出一条笔记，回 ok 带笔记链接", async () => {
    const creator = await site("normal");
    const images = [draftCopy(dataDir, "封面"), draftCopy(dataDir, "第二张")];

    const text = "新的一周从一杯咖啡开始\n第二行也要在\n\n空一行之后是第三段";

    const reply = await publishDraft(draftMessage("draft-ok", { title: "周一早安", text, images }), depsFor(creator));

    expect(reply, "笔记链接用管理页卡片上带 xsec_token 的那条，不是作者主页那条").toEqual({
      type: "publish_result",
      draftId: "draft-ok",
      attempt: ATTEMPT,
      result: { status: "ok", url: signedNoteUrl(NOTE_IDS[0] ?? ""), externalId: NOTE_IDS[0] },
    });
    expect(creator.publications, "假页面收到了标题、分好段的正文，图片就是拷贝目录里那两张，按顺序").toEqual([
      {
        title: "周一早安",
        body: text,
        hasFocus: true,
        images: images.map((image) => image.sha256),
      },
    ]);
  });

  it("管理页卡片上读不到带 xsec_token 的笔记链接，退回拼 explore/<id>", async () => {
    const creator = await site("no-token");

    const { result } = await publishDraft(
      draftMessage("draft-no-token", { title: "没带签名", text: "正文", images: [draftCopy(dataDir, "没签名")] }),
      depsFor(creator),
    );

    expect(result).toEqual({
      status: "ok",
      url: `https://www.xiaohongshu.com/explore/${NOTE_IDS[0]}`,
      externalId: NOTE_IDS[0],
    });
  });

  it("发完标签页关掉，建标签页用的是 background", async () => {
    const creator = await site("normal");
    const user: PageTarget = await openUserTab(chrome.connection, `${creator.url}/user`);
    const before = await tabIdsBefore();

    const { result } = await publishDraft(
      draftMessage("draft-bg", { title: "后台发", text: "你照常打字", images: [draftCopy(dataDir, "后台")] }),
      depsFor(creator),
    );

    expect(result.status).toBe("ok");
    expect(await tabsSettleTo(before), "发布器的标签页发完就关，别的标签页一个不少").toEqual(before);
    expect(await evaluateIn(user, "window.hidden"), "用户那页从头到尾没被挤到后面").toEqual([]);
    expect(await evaluateIn(user, "document.visibilityState")).toBe("visible");
    expect(creator.publications[0]?.hasFocus, "后台页开了焦点模拟，页面照有焦点的样子跑").toBe(true);
  });

  it("撞到登录页回 login_expired", async () => {
    const creator = await site("logged-out");
    const before = await tabIdsBefore();

    const { result } = await publishDraft(
      draftMessage("draft-login", { title: "t", text: "正文", images: [draftCopy(dataDir, "登录")] }),
      depsFor(creator),
    );

    expect(result).toMatchObject({ status: "failed", reason: "login_expired" });
    expect(await tabsSettleTo(before), "失败也关标签页").toEqual(before);
  });

  it("发布按钮不见了回 page_changed，detail 说是哪一步", async () => {
    const creator = await site("no-button");

    const { result } = await publishDraft(
      draftMessage("draft-changed", { title: "t", text: "正文", images: [draftCopy(dataDir, "改版")] }),
      depsFor(creator, { totalMs: 30_000, stepMs: 1_500 }),
    );

    expect(result).toMatchObject({ status: "failed", reason: "page_changed" });
    const detail = result.status === "failed" ? result.detail : "";
    expect(detail, "说是点发布那一步").toContain("点发布");
    expect(detail.length, "detail 截到 200 字").toBeLessThanOrEqual(200);
    expect(creator.publications, "没发出去").toEqual([]);
  });

  it("两条同时到，第二条等第一条发完", async () => {
    const creator = await site("normal", 400);

    const [first, second] = await Promise.all([
      publishDraft(
        draftMessage("draft-a", { title: "第一条", text: "甲", images: [draftCopy(dataDir, "甲")] }),
        depsFor(creator),
      ),
      publishDraft(
        draftMessage("draft-b", { title: "第二条", text: "乙", images: [draftCopy(dataDir, "乙")] }),
        depsFor(creator),
      ),
    ]);

    expect(first?.result.status).toBe("ok");
    expect(second?.result.status).toBe("ok");
    expect(
      creator.events.map((event) => `${event.kind}${event.title === undefined ? "" : `:${event.title}`}`),
      "一条从开发布页到读完笔记链接，另一条才开始",
    ).toEqual(["open", "published:第一条", "manage", "open", "published:第二条", "manage"]);
    const [, , firstDone, secondOpen] = creator.events;
    expect(secondOpen?.at ?? 0, "两次发布的时间不重叠").toBeGreaterThanOrEqual(firstDone?.at ?? Infinity);
    expect(first?.result.status === "ok" ? first.result.externalId : "").toBe(NOTE_IDS[0]);
    expect(second?.result.status === "ok" ? second.result.externalId : "", "各读各的那条笔记").toBe(NOTE_IDS[1]);
  });

  it("超时回 error，标签页关掉", async () => {
    const creator = await site("hang");
    const before = await tabIdsBefore();
    const started = Date.now();

    const { result } = await publishDraft(
      draftMessage("draft-timeout", { title: "t", text: "正文", images: [draftCopy(dataDir, "超时")] }),
      depsFor(creator, { totalMs: 1_500, stepMs: 60_000 }),
    );

    expect(result).toMatchObject({ status: "failed", reason: "error" });
    expect(result.status === "failed" ? result.detail : "").toContain("超时");
    expect(Date.now() - started, "到总时限就停，不等单条 CDP 命令的 30 秒").toBeLessThan(10_000);
    expect(await tabsSettleTo(before), "超时也关标签页").toEqual(before);
    expect(creator.requests(), "发布页确实被请求过，卡在它不回").toBeGreaterThan(0);
  });

  it("超时以后不再往发布标签页发命令，关标签页慢了也一样", async () => {
    const creator = await site("no-button");
    let closing = false;
    const afterClose: string[] = [];
    // 关标签页故意慢一秒：在这一秒里还往标签页发的命令，真页面上就可能接着点了发布。
    const shared = chrome.connection;
    const slowClose: CdpConnection = {
      onEvent: (listener) => shared.onEvent(listener),
      isOpen: () => shared.isOpen(),
      send: async (method, params, sessionId) => {
        if (closing && sessionId !== undefined) afterClose.push(method);
        if (method === "Target.closeTarget") {
          closing = true;
          await delay(1_000);
        }
        return shared.send(method, params, sessionId);
      },
    };

    const { result } = await publishDraft(
      draftMessage("draft-late-write", { title: "t", text: "正文", images: [draftCopy(dataDir, "迟写")] }),
      { ...depsFor(creator, { totalMs: 2_500, stepMs: 60_000 }), browser: { connection: async () => slowClose } },
    );

    expect(result).toMatchObject({ status: "failed", reason: "error" });
    expect(result.status === "failed" ? result.detail : "", "超时时正卡在等发布按钮").toContain("点发布");
    expect(closing, "超时确实去关了标签页").toBe(true);
    expect(afterClose, "超时之后一条命令都不再发给发布标签页").toEqual([]);
  });

  it("Bot 浏览器和发布器同时用一条管道，各走各的 session 互不串", async () => {
    const creator = await site("normal", 400);
    const slow = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end('<!doctype html><meta charset="utf-8"><title>BOT-慢页</title><p>BOT-TEXT</p>');
      }, 2_000);
    });
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    const address = slow.address();
    if (address === null || typeof address === "string") throw new Error("慢页没有端口");
    const bot = createBotBrowser({ profileDir, connection: async () => chrome.connection });
    const open = bot.tools.find((tool) => tool.name === "browser_open");
    const snapshot = bot.tools.find((tool) => tool.name === "browser_snapshot");
    if (open === undefined || snapshot === undefined) throw new Error("没有浏览器工具");
    try {
      const publishing = publishDraft(
        draftMessage("draft-shared", { title: "同时发", text: "正文", images: [draftCopy(dataDir, "同时")] }),
        depsFor(creator),
      );
      await delay(200);
      const opened = await open.execute(
        "call-open",
        { url: `http://127.0.0.1:${address.port}/slow` } as never,
        undefined,
        undefined,
        undefined as never,
      );
      const { result } = await publishing;
      const after = await snapshot.execute("call-snapshot", {} as never, undefined, undefined, undefined as never);

      expect(textOf(opened.content), "Bot 的导航等到了自己那页加载完").toContain("已打开「BOT-慢页」");
      expect(result.status, "Bot 在旁边开页，发布照常完成").toBe("ok");
      expect(creator.publications.map((one) => one.title)).toEqual(["同时发"]);
      expect(textOf(after.content), "发布器关掉自己的页，Bot 的页还在原地，不当成自己断开").toContain("BOT-TEXT");
      expect(textOf(after.content)).not.toContain("重开过");
    } finally {
      await bot.close();
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  });

  it("发出去了但读不到笔记链接，回 ok 带笔记管理页地址，不让用户重发", async () => {
    const creator = await site("no-notes");

    const { result } = await publishDraft(
      draftMessage("draft-no-link", { title: "读不到", text: "正文", images: [draftCopy(dataDir, "读不到")] }),
      depsFor(creator, { totalMs: 30_000, stepMs: 1_500 }),
    );

    expect(creator.publications, "笔记确实发出去了").toHaveLength(1);
    expect(result, "读不到笔记 id 就不编一个").toEqual({
      status: "ok",
      url: `${creator.url}/new/note-manager`,
      externalId: null,
    });
  });
});
