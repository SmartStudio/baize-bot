import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, rename, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  ATTACHMENT_MAX_BYTES,
  type AccountConfig,
  type AgentToControl,
  ContentPlanId,
  type DraftContent,
  DraftId,
  type DraftImage,
  type DraftSpec,
  imageMime,
  type Platform,
} from "@baize/shared";
import { type Static, Type } from "typebox";
import { parseOrThrow, resultText } from "./assistant.js";
import type { RunnerTool } from "./bot-session.js";
import { isInsideRoot, logicalResolve, realpathExisting } from "./paths.js";
import type { ActiveRun } from "./topic.js";
import { attachmentCopyName, uploadAttachment, type AttachmentLive } from "./attachments.js";

// Bot 往外发东西只有起草这一条路：三件工具都只发上行，群里出草稿卡或计划卡，用户在卡上批了才发。
// 闸门把它们归 publish，只看账号档，见 gate.ts 的 decideDraft。

/** 所有 Bot 都挂，所以这三个名字对队员和主助理都先占上，工具连接的同名操作不注册。 */
export const DRAFT_TOOL_NAMES = ["create_draft", "edit_draft", "propose_plan"] as const;

export const DRAFT_RULE =
  "往外发东西只能起草：调 create_draft 或 propose_plan，群里出一张卡等用户批，批了才发。" +
  "不要用 bash、浏览器或工具连接里的操作自己去发帖、回复或提 issue。" +
  "在电脑浏览器里登录过的平台（小红书、X）也走草稿，批了由电脑上的浏览器发，不用让用户去配接口授权。";

const PLATFORM_LABEL: Record<Platform, string> = { github: "GitHub", x: "X", xiaohongshu: "小红书" };

const VIA_LABEL: Record<AccountConfig["via"], string> = { api: "接口授权", computer: "电脑浏览器登录" };

// 和控制面发布器表的数一致：走接口的图要控制面上传，还没做；走电脑的由浏览器发布器传图，X 一条最多 4 张。
const maxImages = (account: AccountConfig): number => (account.via === "api" ? 0 : account.platform === "x" ? 4 : 9);

export const accountLabel = (account: AccountConfig): string =>
  `${PLATFORM_LABEL[account.platform]} ${account.handle === null ? "（没有账号名）" : `@${account.handle}`}`;

const TIER_LABEL: Record<AccountConfig["tier"], string> = {
  read_only: "只读档，不能起草",
  draft: "可起草档",
  confirm_publish: "发布要确认档",
  direct_publish: "可直接发布档",
};

/** prompt 里「能用的账号」一段，模型照这里抄 accountId。没账号时不调，整段不出。 */
export const renderAccounts = (accounts: readonly AccountConfig[]): string =>
  [
    "能用的账号：",
    ...accounts.map(
      (account) =>
        `- ${accountLabel(account)}，${VIA_LABEL[account.via]}，${TIER_LABEL[account.tier]}，accountId：${account.id}`,
    ),
  ].join("\n");

const IMAGE = Type.Object({ path: Type.String() });

// 可省的字段在边界上补成协议要的 null 或空数组；长度范围不写进 schema，交给 AgentToControl 校验再翻成中文。
const CONTENT = Type.Union([
  Type.Object({
    kind: Type.Literal("post"),
    title: Type.Optional(Type.String()),
    text: Type.String(),
    images: Type.Optional(Type.Array(IMAGE)),
    github: Type.Optional(
      Type.Object({ repo: Type.String(), as: Type.Union([Type.Literal("issue"), Type.Literal("discussion")]) }),
    ),
  }),
  Type.Object({
    kind: Type.Literal("reply"),
    text: Type.String(),
    images: Type.Optional(Type.Array(IMAGE)),
    replyTo: Type.Object({ url: Type.String(), author: Type.String(), quote: Type.String() }),
  }),
]);

const DRAFT_INPUT = Type.Object({
  accountId: Type.String(),
  content: CONTENT,
  scheduledAt: Type.Optional(Type.String()),
});

const EDIT_PARAMS = Type.Object({ draftId: Type.String(), content: CONTENT });

const PLAN_PARAMS = Type.Object({ title: Type.String(), drafts: Type.Array(DRAFT_INPUT) });

const CONTENT_GUIDE =
  "各平台的要求：X 正文不超过 280 字符，接口授权的号不带图，电脑浏览器登录的号最多 4 张图；" +
  "同一个平台既有接口授权又有电脑浏览器登录的号，没说用哪个就用接口授权那个；GitHub 要写 title，github 里写 repo（owner/name）和 as（issue 或 discussion），不带图；" +
  "小红书要写 title，可以带图（images 每张给一个 path，图要先放进你的工作目录，相对路径按工作目录算）。回复别人的帖子 kind 写 reply，replyTo 带原帖链接、作者和原话。" +
  "scheduledAt 是想发出的时间，写成 2026-09-28T09:00:00+08:00 这样，不写就等用户定。";

const MAX_IMAGE_BYTES = ATTACHMENT_MAX_BYTES;

/** 配图从哪儿收、拷到哪儿、哪些目录碰都不能碰。 */
export interface ImageDirs {
  readonly workDir: string;
  readonly draftsDir: string;
  readonly hidden: readonly string[];
}

/** drafts 目录里拷贝的文件名。发布器按它核对配图还是起草时那份。 */
export const draftCopyName = (sha256: string, source: string): string => `${sha256}${extname(source).toLowerCase()}`;

const errorCode = (error: unknown): unknown =>
  error && typeof error === "object" && "code" in error ? error.code : undefined;

// 用户批的必须就是发出去的那份字节：从 fd 读、算哈希、拷进 Bot 写不到的 drafts 目录，再上传同一份字节。
// 之后工作目录里的原图怎么改都不影响草稿。禁区先于工作目录判：禁区里的文件不能叫模型挪进工作目录再来。
interface ImageUpload {
  readonly run: ActiveRun["run"];
  readonly live: (() => AttachmentLive) | undefined;
}

async function imageOf(path: string, dirs: ImageDirs, where: string, upload: ImageUpload): Promise<DraftImage> {
  const label = `${where}配图「${path}」`;
  const loop = `${label}是符号链接绕成了环，换成真正的图片文件。`;
  const logical = logicalResolve(path, dirs.workDir);
  // realpathExisting 遇到成环抛的是通用的 PathError，报错就偏了，所以先单独认出成环，点名是配图。
  const real = await realpath(logical).catch((error: unknown) => {
    if (errorCode(error) === "ELOOP") throw new Error(loop);
    return realpathExisting(logical);
  });
  if (dirs.hidden.some((prefix) => isInsideRoot(real, prefix))) {
    throw new Error(`${label}在固定禁区里，不能当配图，换一张图。`);
  }
  if (!isInsideRoot(real, dirs.workDir)) {
    throw new Error(`${label}不在工作目录里，先把图放进工作目录再起草。`);
  }
  let file;
  try {
    // O_NONBLOCK：路径若是命名管道，open 不会一直等写端。
    file = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") throw new Error(`${label}不存在，路径按工作目录算，核对一下再调。`, { cause: error });
    if (code === "EACCES" || code === "EPERM")
      throw new Error(`${label}没有权限读，换一张图或者先改好权限。`, { cause: error });
    if (code === "ELOOP") throw new Error(loop, { cause: error });
    throw new Error(`${label}打不开：${String(error)}`, { cause: error });
  }
  try {
    const opened = await file.stat();
    if (!opened.isFile()) throw new Error(`${label}不是普通文件，给一张图片文件的路径。`);
    if (opened.size > MAX_IMAGE_BYTES) throw new Error(`${label}超过 20 MiB，压小一点再起草。`);
    // realpath 和 open 之间上级目录可能被换成链接，打开后再核一次路径和 inode 还是同一个文件。
    const now = await stat(real).catch(() => null);
    if ((await realpath(real).catch(() => null)) !== real || now?.ino !== opened.ino || now.dev !== opened.dev) {
      throw new Error(`${label}在读的时候被换掉了，重新调一次。`);
    }
    const bytes = await file.readFile();
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`${label}超过 20 MiB，压小一点再起草。`);
    const mime = imageMime(bytes);
    if (mime === null) throw new Error(`${label}不是 PNG、JPEG、WebP 或 GIF 图片，换一张图。`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const copy = join(dirs.draftsDir, attachmentCopyName(sha256, mime));
    const temporary = `${copy}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o444 });
    await rename(temporary, copy);
    const uploaded = await uploadAttachment(
      upload.live,
      { botId: upload.run.botId, groupId: upload.run.groupId, sha256, mime },
      bytes,
    );
    return { kind: "attachment", attachmentId: uploaded.attachmentId, sha256, mime };
  } finally {
    await file.close();
  }
}

// 协议里的对象都是 strict，模型多写一个键就整条被拒，所以只挑协议要的字段。
const contentOf = async (
  content: Static<typeof CONTENT>,
  dirs: ImageDirs,
  where: string,
  upload: ImageUpload,
): Promise<DraftContent> => {
  const images: DraftImage[] = [];
  for (const image of content.images ?? []) images.push(await imageOf(image.path, dirs, where, upload));
  return content.kind === "post"
    ? {
        kind: "post",
        title: content.title ?? null,
        text: content.text,
        images,
        github: content.github === undefined ? null : { repo: content.github.repo, as: content.github.as },
      }
    : {
        kind: "reply",
        text: content.text,
        images,
        replyTo: { url: content.replyTo.url, author: content.replyTo.author, quote: content.replyTo.quote },
      };
};

// 模型常写带时区偏移的时间，协议只收 UTC 的 ISO 串，在这里换算。
const scheduledAtOf = (value: string | undefined, where: string): string | null => {
  if (value === undefined) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`${where}scheduledAt「${value}」认不出是什么时间，写成 2026-09-28T09:00:00+08:00 这样。`);
  }
  return at.toISOString();
};

const accountsHint = (accounts: readonly AccountConfig[]): string =>
  accounts.length === 0
    ? "用户还没连任何账号，告诉用户先去账号页连一个。"
    : `能用的账号：${accounts.map((account) => `${accountLabel(account)}（accountId：${account.id}）`).join("、")}`;

async function specOf(
  input: Static<typeof DRAFT_INPUT>,
  accounts: readonly AccountConfig[],
  dirs: ImageDirs,
  where: string,
  upload: ImageUpload,
): Promise<DraftSpec> {
  const account = accounts.find((candidate) => candidate.id === input.accountId);
  if (account === undefined) {
    throw new Error(`${where}没有 accountId 是「${input.accountId}」的账号。${accountsHint(accounts)}`);
  }
  const limit = maxImages(account);
  if ((input.content.images ?? []).length > limit) {
    throw new Error(
      limit === 0
        ? `${where}${PLATFORM_LABEL[account.platform]} 接口授权的号起草先不带图，去掉 images 再调。`
        : `${where}${PLATFORM_LABEL[account.platform]} 一条最多带 ${limit} 张图，去掉几张再调。`,
    );
  }
  return {
    draftId: DraftId.parse(randomUUID()),
    accountId: account.id,
    content: await contentOf(input.content, dirs, where, upload),
    scheduledAt: scheduledAtOf(input.scheduledAt, where),
  };
}

export function createDraftTools(options: {
  readonly activeRun: () => ActiveRun | null;
  /** 工具调用时读最新的 config.accounts：换账号不重建会话，建工具时抓一份会过期。 */
  readonly accounts: () => readonly AccountConfig[];
  /** 配图只收工作目录里的文件，拷进 drafts 目录。 */
  readonly images: ImageDirs;
  readonly liveHub?: () => AttachmentLive;
  readonly send: (message: AgentToControl) => void;
}): readonly RunnerTool[] {
  const activeOrThrow = (action: string): ActiveRun => {
    const active = options.activeRun();
    if (active === null) throw new Error(`这次工具调用不属于任何一次运行，没法${action}。`);
    return active;
  };

  return [
    {
      name: "create_draft",
      label: "起草",
      description:
        "起草一条要往外发的内容，群里出一张草稿卡等用户批，批了才发。accountId 从 prompt 里的能用的账号取。" +
        CONTENT_GUIDE,
      parameters: DRAFT_INPUT,
      execute: async (_callId, params) => {
        const active = activeOrThrow("起草");
        const draft = await specOf(
          params as Static<typeof DRAFT_INPUT>,
          options.accounts(),
          options.images,
          "草稿没建，改好再调：",
          { run: active.run, live: options.liveHub },
        );
        options.send(
          parseOrThrow(
            {
              type: "draft_create",
              runId: active.run.runId,
              botId: active.run.botId,
              groupId: active.run.groupId,
              draft,
            },
            "草稿",
          ),
        );
        return resultText(
          `草稿已建（draftId：${draft.draftId}），等用户在卡上批。批之前什么都没发出去，回复用户时说草稿在等用户批，别说已经发了。`,
        );
      },
    },
    {
      name: "edit_draft",
      label: "改草稿",
      description: `改一条还没发出去的草稿，content 写改完的整份内容。改过的稿子要用户重新批。${CONTENT_GUIDE}`,
      parameters: EDIT_PARAMS,
      execute: async (_callId, params) => {
        const active = activeOrThrow("改草稿");
        const { draftId, content } = params as Static<typeof EDIT_PARAMS>;
        const parsedId = DraftId.safeParse(draftId);
        if (!parsedId.success) throw new Error("草稿没改，改好再调：draftId 是空的，照建草稿时拿到的 draftId 抄。");
        options.send(
          parseOrThrow(
            {
              type: "draft_edit",
              runId: active.run.runId,
              botId: active.run.botId,
              groupId: active.run.groupId,
              draftId: parsedId.data,
              content: await contentOf(content, options.images, "草稿没改，改好再调：", {
                run: active.run,
                live: options.liveHub,
              }),
            },
            "改动",
          ),
        );
        return resultText(`草稿 ${parsedId.data} 已改，改过的稿子会重新等用户批，批之前不会发出去。`);
      },
    },
    {
      name: "propose_plan",
      label: "出内容计划",
      description:
        "一次排好一批要发的内容（1 到 20 条），群里出一张计划卡，用户一次批完。每条草稿的写法和 create_draft 一样，排本周计划时每条都写上 scheduledAt。" +
        CONTENT_GUIDE,
      parameters: PLAN_PARAMS,
      execute: async (_callId, params) => {
        const active = activeOrThrow("出内容计划");
        const { title, drafts } = params as Static<typeof PLAN_PARAMS>;
        const accounts = options.accounts();
        const specs: DraftSpec[] = [];
        for (const [index, draft] of drafts.entries()) {
          specs.push(
            await specOf(draft, accounts, options.images, `计划没发出去，改好再调：第 ${index + 1} 条草稿`, {
              run: active.run,
              live: options.liveHub,
            }),
          );
        }
        options.send(
          parseOrThrow(
            {
              type: "plan_propose",
              runId: active.run.runId,
              botId: active.run.botId,
              groupId: active.run.groupId,
              planId: ContentPlanId.parse(randomUUID()),
              title,
              drafts: specs,
            },
            "计划",
          ),
        );
        return resultText(
          `计划「${title}」已发出，${specs.length} 条草稿等用户在计划卡上批（draftId 依次是 ${specs.map((spec) => spec.draftId).join("、")}）。批之前什么都没发出去。`,
        );
      },
    },
  ];
}
