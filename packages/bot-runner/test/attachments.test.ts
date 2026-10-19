import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountId,
  BotId,
  ControlToAgent,
  GroupId,
  MessageId,
  RunId,
  type AgentToControl,
  type DraftImage,
} from "@baize/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachmentCopyName, type AttachmentLive } from "../src/attachments.js";
import { createDraftTools } from "../src/drafts.js";
import { publishDraft, type PublishDraftMessage } from "../src/publisher.js";
import { startAttachmentHub } from "./helpers/attachments.js";

const failNextWrite = vi.hoisted(() => ({ armed: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (failNextWrite.armed) {
        failNextWrite.armed = false;
        const [path] = args;
        await actual.writeFile(path, Buffer.from("partial"), { mode: 0o444 });
        throw new Error("模拟写入失败");
      }
      return actual.writeFile(...args);
    },
  };
});

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const hashOf = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function setup(bytes = PNG, filename = "cover.dat") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "baize-attachments-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const workDir = join(root, "bot-1", "work");
  const draftsDir = join(root, "bot-1", "drafts");
  mkdirSync(workDir, { recursive: true });
  mkdirSync(draftsDir, { recursive: true });
  writeFileSync(join(workDir, filename), bytes);
  const hub = await startAttachmentHub();
  cleanups.push(() => hub.close());
  let key = "private-gateway-key-1";
  let baseUrl = hub.baseUrl;
  const live = (): AttachmentLive => ({
    hub: { baseUrl },
    gateway: { baseUrl: "http://unused/gateway/v1", apiKey: key },
  });
  const sent: AgentToControl[] = [];
  const tools = createDraftTools({
    activeRun: () => ({
      run: {
        runId: RunId.parse("run-1"),
        botId: BotId.parse("bot-1"),
        groupId: GroupId.parse("group-1"),
        messageId: MessageId.parse("m-1"),
      },
      groupKind: "solo",
      task: null,
      members: [],
      handoffId: undefined,
      projects: [],
      routine: null,
    }),
    accounts: () => [
      {
        id: AccountId.parse("acc-xhs"),
        platform: "xiaohongshu",
        via: "computer",
        handle: "小满",
        login: "valid",
        tier: "confirm_publish",
      },
    ],
    images: { workDir, draftsDir, hidden: [] },
    liveHub: live,
    send: (message) => sent.push(message),
  });
  const create = tools.find((tool) => tool.name === "create_draft")!;
  const draft = () =>
    create.execute(
      "call-1",
      {
        accountId: "acc-xhs",
        content: { kind: "post", title: "标题", text: "正文", images: [{ path: filename }] },
      },
      undefined,
      undefined,
      undefined as never,
    );
  const image = (): DraftImage => {
    const created = sent.find((message) => message.type === "draft_create");
    if (created?.type !== "draft_create" || created.draft.content.images[0] === undefined)
      throw new Error("草稿配图没有上行");
    return created.draft.content.images[0];
  };
  return {
    root,
    draftsDir,
    hub,
    sent,
    draft,
    image,
    live,
    setKey: (next: string) => {
      key = next;
    },
    setUrl: (next: string) => {
      baseUrl = next;
    },
  };
}

function publishMessage(image: unknown): PublishDraftMessage {
  const parsed = ControlToAgent.parse({
    type: "publish_draft",
    draftId: "draft-1",
    botId: "bot-1",
    accountId: "acc-xhs",
    platform: "xiaohongshu",
    content: { kind: "post", title: "标题", text: "正文", github: null, images: [image] },
    attempt: "2026-10-14T00:00:00.000Z",
  });
  if (parsed.type !== "publish_draft") throw new Error("不是发布草稿");
  return parsed;
}

describe("起草把本地安全拷贝传成附件", () => {
  it("按魔数认 MIME、不信扩展名，上传字节和哈希一致，引用附件支", async () => {
    const h = await setup();
    await h.draft();
    expect(h.image()).toMatchObject({ kind: "attachment", sha256: hashOf(PNG), mime: "image/png" });
    expect(h.hub.uploads).toEqual([
      {
        authorization: "Bearer private-gateway-key-1",
        botId: "bot-1",
        groupId: "group-1",
        sha256: hashOf(PNG),
        mime: "image/png",
        bytes: PNG,
      },
    ]);
    const copy = join(h.draftsDir, `${hashOf(PNG)}.png`);
    expect(readFileSync(copy)).toEqual(PNG);
    expect(statSync(copy).mode & 0o777).toBe(0o444);
  });

  it.each([
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg", ".jpg"],
    [Buffer.from("RIFF0000WEBP0000"), "image/webp", ".webp"],
    [Buffer.from("GIF89a0000"), "image/gif", ".gif"],
  ])("接受另三种魔数并使用对应的缓存扩展名", async (bytes, mime, extension) => {
    const h = await setup(bytes);
    await h.draft();
    expect(h.image()).toMatchObject({ kind: "attachment", sha256: hashOf(bytes), mime });
    expect(readFileSync(join(h.draftsDir, `${hashOf(bytes)}${extension}`))).toEqual(bytes);
  });

  it.each([Buffer.from("普通文本"), Buffer.from([0xc7, 0xc9, 0xc6, 0xb8, 0xb9, 0xe1])])(
    "伪装成 PNG 扩展名或高位字节伪造 GIF 文件头被拒，既不上传也不建草稿",
    async (bytes) => {
      const h = await setup(bytes, "cover.png");
      await expect(h.draft()).rejects.toThrow("不是 PNG、JPEG、WebP 或 GIF");
      expect(h.sent).toEqual([]);
      expect(h.hub.uploads).toEqual([]);
      expect(readdirSync(h.draftsDir)).toEqual([]);
    },
  );

  it("上传失败不建草稿，不泄露服务端正文里的 Bearer 或查询串", async () => {
    const h = await setup();
    h.hub.failUploads();
    await expect(h.draft()).rejects.toThrow("配图传到白泽失败，过一会儿再起草");
    const error = await h.draft().catch((reason: unknown) => String(reason));
    expect(error).not.toContain("Bearer");
    expect(error).not.toContain("private-gateway-key");
    expect(error).not.toContain("botId=");
    expect(h.sent).toEqual([]);
  });

  it("工具建好后轮换 key，下一次上传现取新 key", async () => {
    const h = await setup();
    await h.draft();
    h.setKey("private-gateway-key-2");
    await h.draft();
    expect(h.hub.uploads.map((upload) => upload.authorization)).toEqual([
      "Bearer private-gateway-key-1",
      "Bearer private-gateway-key-2",
    ]);
  });
});

describe("发布器在另一台电脑补齐附件", () => {
  const local = (): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "baize-local-publisher-")));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    return root;
  };

  it("没有拷贝时下载并原子写只读文件，缓存再次使用时不下载", async () => {
    const h = await setup();
    await h.draft();
    const image = h.image();
    if (image.kind !== "attachment") throw new Error("不是附件支");
    const dataDir = local();
    const copy = join(dataDir, "bot-1", "drafts", attachmentCopyName(image.sha256, image.mime));
    let calls = 0;
    const browser = {
      connection: async () => {
        calls += 1;
        expect(readFileSync(copy)).toEqual(PNG);
        throw new Error("假浏览器在配图就绪后停下");
      },
    };
    h.setKey("rotated-key");
    const first = await publishDraft(publishMessage(image), { dataDir, browser, liveHub: h.live });
    expect(first.result).toMatchObject({ status: "failed", detail: "发布出错：假浏览器在配图就绪后停下" });
    expect(h.hub.downloads).toEqual(["Bearer rotated-key"]);
    expect(statSync(copy).mode & 0o777).toBe(0o444);
    expect(readdirSync(join(dataDir, "bot-1", "drafts"))).toEqual([`${image.sha256}.png`]);
    await publishDraft(publishMessage(image), { dataDir, browser });
    expect(h.hub.downloads).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("同名只读错误缓存会重新下载并原子替换为正确的只读字节", async () => {
    const h = await setup();
    await h.draft();
    const image = h.image();
    if (image.kind !== "attachment") throw new Error("不是附件支");
    const dataDir = local();
    const copy = join(dataDir, "bot-1", "drafts", attachmentCopyName(image.sha256, image.mime));
    const wrong = Buffer.from("same filename, wrong bytes");
    mkdirSync(join(dataDir, "bot-1", "drafts"), { recursive: true });
    writeFileSync(copy, wrong, { mode: 0o444 });
    expect(readFileSync(copy)).toEqual(wrong);
    expect(statSync(copy).mode & 0o777).toBe(0o444);
    let calls = 0;
    const reply = await publishDraft(publishMessage(image), {
      dataDir,
      liveHub: h.live,
      browser: {
        connection: async () => {
          calls += 1;
          expect(readFileSync(copy)).toEqual(PNG);
          throw new Error("假浏览器在配图就绪后停下");
        },
      },
    });
    expect(reply.result).toMatchObject({ status: "failed", detail: "发布出错：假浏览器在配图就绪后停下" });
    expect(h.hub.downloads).toEqual(["Bearer private-gateway-key-1"]);
    expect(readFileSync(copy)).toEqual(PNG);
    expect(statSync(copy).mode & 0o777).toBe(0o444);
    expect(readdirSync(join(dataDir, "bot-1", "drafts"))).toEqual([`${image.sha256}.png`]);
    expect(calls).toBe(1);
  });

  it("部分写入失败会清理临时文件并阻止浏览器，重试重新下载正确的只读字节", async () => {
    const h = await setup();
    await h.draft();
    const image = h.image();
    if (image.kind !== "attachment") throw new Error("不是附件支");
    const dataDir = local();
    const draftsDir = join(dataDir, "bot-1", "drafts");
    const copy = join(draftsDir, attachmentCopyName(image.sha256, image.mime));
    let calls = 0;
    failNextWrite.armed = true;
    const failed = await publishDraft(publishMessage(image), {
      dataDir,
      liveHub: h.live,
      browser: {
        connection: async () => {
          calls += 1;
          throw new Error("失败写入后不应连接浏览器");
        },
      },
    });
    expect(failed.result).toEqual({ status: "failed", reason: "error", detail: "发布出错：模拟写入失败" });
    expect(failNextWrite.armed).toBe(false);
    expect(readdirSync(draftsDir)).toEqual([]);
    expect(h.hub.downloads).toEqual(["Bearer private-gateway-key-1"]);
    expect(calls).toBe(0);

    const retried = await publishDraft(publishMessage(image), {
      dataDir,
      liveHub: h.live,
      browser: {
        connection: async () => {
          calls += 1;
          expect(readFileSync(copy)).toEqual(PNG);
          throw new Error("重试时配图已就绪");
        },
      },
    });
    expect(retried.result).toMatchObject({ status: "failed", detail: "发布出错：重试时配图已就绪" });
    expect(h.hub.downloads).toEqual(["Bearer private-gateway-key-1", "Bearer private-gateway-key-1"]);
    expect(readFileSync(copy)).toEqual(PNG);
    expect(statSync(copy).mode & 0o777).toBe(0o444);
    expect(readdirSync(draftsDir)).toEqual([`${image.sha256}.png`]);
    expect(calls).toBe(1);
  });

  it("下载字节被篡改时失败，不落盘也不接浏览器", async () => {
    const h = await setup();
    await h.draft();
    h.hub.corruptDownloads(Buffer.from("被篡改的字节"));
    const dataDir = local();
    let calls = 0;
    const reply = await publishDraft(publishMessage(h.image()), {
      dataDir,
      liveHub: h.live,
      browser: {
        connection: async () => {
          calls += 1;
          throw new Error("不应调用");
        },
      },
    });
    expect(reply.result).toMatchObject({
      status: "failed",
      reason: "error",
      detail: expect.stringContaining("SHA-256 和起草时不一致"),
    });
    expect(calls).toBe(0);
    expect(readdirSync(join(dataDir, "bot-1", "drafts"))).toEqual([]);
  });

  it("下载错误不泄露 Bearer、网关 key 或 URL 查询串", async () => {
    const h = await setup();
    await h.draft();
    const image = h.image();
    if (image.kind !== "attachment") throw new Error("不是附件");
    const reply = await publishDraft(publishMessage({ ...image, attachmentId: "missing" }), {
      dataDir: local(),
      liveHub: h.live,
      browser: {
        connection: async () => {
          throw new Error("不应调用");
        },
      },
    });
    expect(reply.result).toMatchObject({ status: "failed", detail: "发布出错：配图从白泽下载失败，请稍后重试" });
    expect(JSON.stringify(reply)).not.toContain("Bearer");
    expect(JSON.stringify(reply)).not.toContain("private-gateway-key");
    expect(JSON.stringify(reply)).not.toContain("http://");
  });

  it("旧库中没有 kind 的 path 草稿照旧使用本地拷贝", async () => {
    const h = await setup();
    await h.draft();
    const path = join(h.draftsDir, `${hashOf(PNG)}.png`);
    let calls = 0;
    const reply = await publishDraft(publishMessage({ path, sha256: hashOf(PNG) }), {
      dataDir: h.root,
      browser: {
        connection: async () => {
          calls += 1;
          throw new Error("旧稿通过验图");
        },
      },
    });
    expect(reply.result).toMatchObject({ status: "failed", detail: "发布出错：旧稿通过验图" });
    expect(calls).toBe(1);
    expect(h.hub.downloads).toEqual([]);
  });
});
