import { randomUUID } from "node:crypto";
import {
  type AccountConfig,
  type AgentToControl,
  ContentPlanId,
  type DraftContent,
  DraftId,
  type DraftSpec,
  type Platform,
} from "@baize/shared";
import { type Static, Type } from "typebox";
import { parseOrThrow, resultText } from "./assistant.js";
import type { RunnerTool } from "./bot-session.js";
import type { ActiveRun } from "./topic.js";

// Bot 往外发东西只有起草这一条路：三件工具都只发上行，群里出草稿卡或计划卡，用户在卡上批了才发。
// 闸门把它们归 publish，只看账号档，见 gate.ts 的 decideDraft。

/** 所有 Bot 都挂，所以这三个名字对队员和主助理都先占上，工具连接的同名操作不注册。 */
export const DRAFT_TOOL_NAMES = ["create_draft", "edit_draft", "propose_plan"] as const;

export const DRAFT_RULE =
  "往外发东西只能起草：调 create_draft 或 propose_plan，群里出一张卡等用户批，批了才发。" +
  "不要用 bash、浏览器或工具连接里的操作自己去发帖、回复或提 issue。";

const PLATFORM_LABEL: Record<Platform, string> = { github: "GitHub", x: "X", xiaohongshu: "小红书" };

// 小红书的图随 P1-5 的本机发布器一起接，这两个平台的图要控制面上传，还没做。
const TEXT_ONLY_PLATFORMS: ReadonlySet<Platform> = new Set(["github", "x"]);

export const accountLabel = (account: AccountConfig): string =>
  `${PLATFORM_LABEL[account.platform]} ${account.handle === null ? "（没有账号名）" : `@${account.handle}`}`;

const IMAGE = Type.Object({ path: Type.String(), sha256: Type.String() });

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
  "各平台的要求：X 正文不超过 280 字符，不带图；GitHub 要写 title，github 里写 repo（owner/name）和 as（issue 或 discussion），不带图；" +
  "小红书要写 title，可以带图（images 每张给本机路径和 sha256）。回复别人的帖子 kind 写 reply，replyTo 带原帖链接、作者和原话。" +
  "scheduledAt 是想发出的时间，写成 2026-09-28T09:00:00+08:00 这样，不写就等用户定。";

// 协议里的对象都是 strict，模型多写一个键就整条被拒，所以只挑协议要的字段。
const contentOf = (content: Static<typeof CONTENT>): DraftContent => {
  const images = (content.images ?? []).map((image) => ({ path: image.path, sha256: image.sha256 }));
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

function specOf(input: Static<typeof DRAFT_INPUT>, accounts: readonly AccountConfig[], where: string): DraftSpec {
  const account = accounts.find((candidate) => candidate.id === input.accountId);
  if (account === undefined) {
    throw new Error(`${where}没有 accountId 是「${input.accountId}」的账号。${accountsHint(accounts)}`);
  }
  const content = contentOf(input.content);
  if (content.images.length > 0 && TEXT_ONLY_PLATFORMS.has(account.platform)) {
    throw new Error(`${where}${PLATFORM_LABEL[account.platform]} 的草稿先不带图，去掉 images 再调。`);
  }
  return {
    draftId: DraftId.parse(randomUUID()),
    accountId: account.id,
    content,
    scheduledAt: scheduledAtOf(input.scheduledAt, where),
  };
}

export function createDraftTools(options: {
  readonly activeRun: () => ActiveRun | null;
  /** 工具调用时读最新的 config.accounts：换账号不重建会话，建工具时抓一份会过期。 */
  readonly accounts: () => readonly AccountConfig[];
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
        "起草一条要往外发的内容，群里出一张草稿卡等用户批，批了才发。accountId 用用户连过的账号，不知道就先随便写，报错里会列出能用的账号。" +
        CONTENT_GUIDE,
      parameters: DRAFT_INPUT,
      execute: async (_callId, params) => {
        const active = activeOrThrow("起草");
        const draft = specOf(params as Static<typeof DRAFT_INPUT>, options.accounts(), "草稿没建，改好再调：");
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
          `草稿已建（draftId：${draft.draftId}），等用户在卡上批。批之前什么都没发出去，回复用户时说草稿在等他批，别说已经发了。`,
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
              content: contentOf(content),
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
        const specs = drafts.map((draft, index) =>
          specOf(draft, accounts, `计划没发出去，改好再调：第 ${index + 1} 条草稿`),
        );
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
