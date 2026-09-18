import {
  Approval,
  ApprovalId,
  Bot,
  BotId,
  Group,
  GroupId,
  Message,
  MessageId,
  RunId,
  Settings,
  TaskId,
  User,
  type BotHue,
  type MessageBody,
  type ServerPush,
  type ToolCallStatus,
} from "@baize/shared";

export type ApprovalDecision = "approved" | "rejected";

export const MOCK_EMAIL = "chen@baize.dev";
export const MOCK_PASSWORD = "baize-dev";

const T0 = Date.parse("2026-09-18T01:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

let counter = 0;
const nextSuffix = () => `${(counter += 1)}`;

export const user: User = User.parse({
  id: "usr_chen",
  name: "陈默",
  email: MOCK_EMAIL,
  teamName: "Acme",
  createdAt: at(0),
});

type Seed = {
  key: string;
  name: string;
  tag: string;
  description: string;
  hue: BotHue;
  bodies: MessageBody[];
};

const seeds: Seed[] = [
  {
    key: "service",
    name: "小服",
    tag: "客服",
    description: "接工单、查订单、回答标准问题。改交期、退款、对外发邮件先找我点头。",
    hue: "sky",
    bodies: [
      { kind: "user", text: "Globex 的 Lisa 想把交期从 10 月 30 日提前到 10 月 20 日，能不能做到？先别回她。" },
      {
        kind: "bot",
        botId: BotId.parse("bot_service"),
        text: "收到。我去查库存和排产，查完给你结论，不回客户。",
        streaming: false,
      },
      {
        kind: "tool_call",
        botId: BotId.parse("bot_service"),
        tool: "erp.query",
        argsSummary: "ERP · X3 库存与排产计划",
        status: "ok",
        durationMs: 41_000,
      },
      {
        kind: "bot",
        botId: BotId.parse("bot_service"),
        text: "查完了。10 月 20 日可以先交 120 台，剩下 80 台最早 10 月 27 日。两个方案你选一个，我去回 Lisa。",
        streaming: false,
      },
      { kind: "system", text: "小服完成了这次运行" },
      { kind: "cost", runId: RunId.parse("run_service_1"), steps: 27, amount: 4.6 },
    ],
  },
  {
    key: "sales",
    name: "小销",
    tag: "销售",
    description: "跟线索、出报价、写跟进邮件。对外发送前先找我点头。",
    hue: "tangerine",
    bodies: [
      { kind: "user", text: "给 Globex 出一份 200 台 X3 的报价，发之前先给我看。" },
      { kind: "bot", botId: BotId.parse("bot_sales"), text: "发出去了。有回复我第一时间告诉你。", streaming: false },
    ],
  },
  {
    key: "buy",
    name: "小采",
    tag: "采购",
    description: "比价、询价、盯到货。下单和付钱先找我点头。",
    hue: "mint",
    bodies: [
      { kind: "user", text: "X3 终端再找三家供应商询个价，中午前给我。" },
      { kind: "bot", botId: BotId.parse("bot_buy"), text: "在跟 3 家供应商询价，中午前给你对比表。", streaming: false },
    ],
  },
];

export const bots = new Map<string, Bot>();
export const groups = new Map<string, Group>();
export const groupIdByBotId = new Map<string, string>();
export const messagesByGroupId = new Map<string, Message[]>();
export const approvals = new Map<string, Approval>();

// 等结论的那次运行停在这里的 resolve 上。按钮和群里回的一句话唤醒的是同一个。
const waiters = new Map<string, (decision: ApprovalDecision) => void>();

const buildMessage = (groupId: string, body: MessageBody, minutes: number): Message =>
  Message.parse({ id: `msg_${nextSuffix()}`, groupId, body, createdAt: at(minutes) });

// 端到端每条用例开头 reseed。上一条用例还在跑的回复得认出世界已经换了一茬，别往新状态里写。
let generation = 0;

export const reseed = (): void => {
  generation += 1;
  // 上一条用例可能还有一次运行停在等结论上。不给它一个结论那个 Promise 永远不落地，进程里就攒下一堆停住的运行。
  for (const wake of waiters.values()) wake("rejected");
  waiters.clear();
  approvals.clear();
  bots.clear();
  groups.clear();
  groupIdByBotId.clear();
  messagesByGroupId.clear();
  counter = 0;
  settings.current = Settings.parse({ theme: "system", notify: true, dndFrom: "22:00", dndTo: "08:00" });
  seeds.forEach((seed, seedIndex) => {
    const botId = `bot_${seed.key}`;
    const groupId = `grp_${seed.key}`;
    bots.set(
      botId,
      Bot.parse({
        id: botId,
        ownerId: user.id,
        name: seed.name,
        tag: seed.tag,
        description: seed.description,
        hue: seed.hue,
        notify: true,
        toolConnectionIds: [],
        createdAt: at(seedIndex),
      }),
    );
    groups.set(
      groupId,
      Group.parse({
        id: groupId,
        ownerId: user.id,
        botIds: [botId],
        taskId: `tsk_${seed.key}`,
        createdAt: at(seedIndex),
      }),
    );
    groupIdByBotId.set(botId, groupId);
    messagesByGroupId.set(
      groupId,
      seed.bodies.map((body, i) => buildMessage(groupId, body, 10 + seedIndex * 10 + i)),
    );
  });
};

export const settings: { current: Settings } = {
  current: Settings.parse({ theme: "system", notify: true, dndFrom: "22:00", dndTo: "08:00" }),
};

reseed();

const HUES: BotHue[] = ["coral", "tangerine", "lime", "mint", "sky", "violet", "pink"];

export const createBot = (input: {
  name?: string | undefined;
  tag?: string | undefined;
  description?: string | undefined;
  hue?: BotHue | undefined;
}) => {
  const suffix = nextSuffix();
  const botId = BotId.parse(`bot_new_${suffix}`);
  const groupId = GroupId.parse(`grp_new_${suffix}`);
  const bot = Bot.parse({
    id: botId,
    ownerId: user.id,
    name: input.name ?? `新 Bot ${bots.size + 1}`,
    tag: input.tag ?? "",
    description: input.description ?? "",
    hue: input.hue ?? HUES[bots.size % HUES.length] ?? "sky",
    notify: true,
    toolConnectionIds: [],
    createdAt: new Date().toISOString(),
  });
  const group = Group.parse({
    id: groupId,
    ownerId: user.id,
    botIds: [botId],
    taskId: TaskId.parse(`tsk_new_${suffix}`),
    createdAt: bot.createdAt,
  });
  bots.set(bot.id, bot);
  groups.set(group.id, group);
  groupIdByBotId.set(bot.id, group.id);
  messagesByGroupId.set(group.id, []);
  return { bot, group };
};

export const appendMessage = (groupId: string, body: MessageBody): Message => {
  const message = Message.parse({
    id: MessageId.parse(`msg_${nextSuffix()}`),
    groupId: GroupId.parse(groupId),
    body,
    createdAt: new Date().toISOString(),
  });
  const list = messagesByGroupId.get(groupId);
  if (list) list.push(message);
  else messagesByGroupId.set(groupId, [message]);
  return message;
};

const rewriteMessage = (groupId: string, id: MessageId, body: MessageBody): Message => {
  const list = messagesByGroupId.get(groupId) ?? [];
  const at = list.findIndex((m) => m.id === id);
  const previous = list[at];
  if (previous === undefined) throw new Error(`消息 ${id} 不在 ${groupId} 里，mock 状态坏了`);
  const next = Message.parse({ ...previous, body });
  list[at] = next;
  return next;
};

export const createApproval = (input: {
  groupId: string;
  botId: BotId;
  kind: Approval["kind"];
  summary: string;
}): Approval => {
  const approval = Approval.parse({
    id: ApprovalId.parse(`apr_${nextSuffix()}`),
    groupId: GroupId.parse(input.groupId),
    botId: input.botId,
    runId: RunId.parse(`run_${nextSuffix()}`),
    kind: input.kind,
    summary: input.summary,
    status: "pending",
    decidedAt: null,
  });
  approvals.set(approval.id, approval);
  return approval;
};

// 查状态和写结论是同一步，中间没有让别人插进来的缝。按钮和群里回的那句话会同时到，两边都先看到 pending
// 再各写一次的话，后写的那个会把结论翻过来，而等结论的运行早就按先到的那个跑完了。
// null 表示这条没得决定：查不到，或者已经有结论了。
export const settleApproval = (id: string, decision: ApprovalDecision): Approval | null => {
  const approval = approvals.get(id);
  if (approval === undefined || approval.status !== "pending") return null;
  const next = Approval.parse({ ...approval, status: decision, decidedAt: new Date().toISOString() });
  approvals.set(next.id, next);
  waiters.get(next.id)?.(decision);
  waiters.delete(next.id);
  return next;
};

const pendingIn = (groupId: string): Approval[] =>
  [...approvals.values()].filter((a) => a.groupId === groupId && a.status === "pending");

export const pendingApprovalsOf = (groupId: string): number => pendingIn(groupId).length;

export const settleLatestPending = (groupId: string, decision: ApprovalDecision): Approval | null => {
  const waiting = pendingIn(groupId).at(-1);
  return waiting === undefined ? null : settleApproval(waiting.id, decision);
};

// approval 消息的正文只有 approvalId，状态在 Approval 上。这一页引用到的跟着这一页回，客户端不用再问一次。
export const approvalsIn = (messages: Message[]): Approval[] => {
  const found: Approval[] = [];
  for (const message of messages) {
    if (message.body.kind !== "approval") continue;
    const approval = approvals.get(message.body.approvalId);
    if (approval) found.push(approval);
  }
  return found;
};

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const chunked = (text: string, count: number): string[] => {
  const letters = [...text];
  const size = Math.ceil(letters.length / count);
  const parts: string[] = [];
  for (let i = 0; i < letters.length; i += size) parts.push(letters.slice(i, i + size).join(""));
  return parts;
};

// 真控制面要等运行时回话。这些延迟把一次运行的真实节奏摆出来：工具先跑起来，正文一段段吐，最后结账。
const REPLY_DELAY_MS = 120;
const TOOL_CALL_MS = 1000;
const DELTA_MS = 80;
const DELTA_COUNT = 4;

// 这次运行用的工具要不要点头，写死在 prompt 上：出现「发」「付」或「退款」就要。镜像 bot-runner/README.md 的
// 工具名前缀规则（send_ 映射 send_external、pay_ 映射 pay），含「发」当对外发送，其余当付钱。
const approvalFor = (prompt: string): { tool: string; kind: Approval["kind"] } | null => {
  if (!/[发付]|退款/.test(prompt)) return null;
  return prompt.includes("发") ? { tool: "send_email", kind: "send_external" } : { tool: "pay_refund", kind: "pay" };
};

const waitForDecision = (id: string): Promise<ApprovalDecision> => new Promise((resolve) => waiters.set(id, resolve));

export const streamBotReply = async (
  groupId: string,
  prompt: string,
  push: (event: ServerPush) => void,
): Promise<void> => {
  const botId = groups.get(groupId)?.botIds[0];
  if (botId === undefined) return;
  const run = generation;
  const abandoned = () => generation !== run;
  const needed = approvalFor(prompt);
  const tool = needed?.tool ?? "erp.query";
  const argsSummary = `ERP · ${prompt.slice(0, 12)}`;

  await sleep(REPLY_DELAY_MS);
  if (abandoned()) return;
  const call = appendMessage(groupId, {
    kind: "tool_call",
    botId,
    tool,
    argsSummary,
    status: "running",
    durationMs: null,
  });
  push({ type: "message", message: call });

  let status: ToolCallStatus = "ok";
  let reply = `收到。${prompt.slice(0, 12)}… 我这就去办。`;
  if (needed === null) {
    await sleep(TOOL_CALL_MS);
    if (abandoned()) return;
  } else {
    const approval = createApproval({ groupId, botId, kind: needed.kind, summary: `${tool} · ${prompt}` });
    const card = appendMessage(groupId, { kind: "approval", approvalId: approval.id });
    // 先推 approval_updated 再推那条消息：卡的状态只在 Approval 上，消息先到的话前端只能先画一张查不到状态的占位。
    push({ type: "approval_updated", approval });
    push({ type: "message", message: card });
    const decision = await waitForDecision(approval.id);
    if (abandoned()) return;
    status = decision === "approved" ? "ok" : "blocked";
    reply =
      decision === "approved" ? `好，${prompt.slice(0, 12)}… 已经办了。` : `明白，这一步我放弃了，别的照原样办完。`;
  }

  const settled = rewriteMessage(groupId, call.id, {
    kind: "tool_call",
    botId,
    tool,
    argsSummary,
    status,
    durationMs: TOOL_CALL_MS,
  });
  push({ type: "message", message: settled });

  // 这条回复只靠 delta 长出来，整条的 message 一次都不推，逼着前端走「没见过就先占个位」那条路。
  const draft = appendMessage(groupId, { kind: "bot", botId, text: "", streaming: true });
  const parts = chunked(reply, DELTA_COUNT);
  let text = "";
  for (const [index, delta] of parts.entries()) {
    await sleep(DELTA_MS);
    if (abandoned()) return;
    text += delta;
    const done = index === parts.length - 1;
    rewriteMessage(groupId, draft.id, { kind: "bot", botId, text, streaming: !done });
    push({ type: "message_delta", messageId: draft.id, groupId: draft.groupId, delta, done });
  }

  await sleep(DELTA_MS);
  if (abandoned()) return;
  const cost = appendMessage(groupId, {
    kind: "cost",
    runId: RunId.parse(`run_${nextSuffix()}`),
    steps: 4,
    amount: 0.8,
  });
  push({ type: "message", message: cost });
};

export const lastMessageOf = (groupId: string): Message | null => (messagesByGroupId.get(groupId) ?? []).at(-1) ?? null;
