import { randomBytes } from "node:crypto";
import {
  Approval,
  ApprovalId,
  Bot,
  BotId,
  Group,
  GroupId,
  Handoff,
  HandoffId,
  Message,
  MessageId,
  OvernightResponse,
  Routine,
  RoutineId,
  RunId,
  Settings,
  Skill,
  SkillId,
  TaskId,
  ToolConnection,
  ToolConnectionId,
  TopicTask,
  User,
  UsageResponse,
  type BotHue,
  type ChecklistItem,
  type MessageBody,
  type CreateRoutineRequest,
  type CreateSkillRequest,
  type ServerPush,
  type SkillSource,
  type ToolCallStatus,
  type TriggerInput,
  type ToolOperation,
  type UpdateRoutineRequest,
  type UpdateSkillRequest,
} from "@baize/shared";

export type ApprovalDecision = "approved" | "rejected";

export const MOCK_EMAIL = "chen@baize.dev";
export const MOCK_PASSWORD = "baize-dev";

const T0 = Date.parse("2026-09-18T01:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

// 预置的运行记录按真实日期算：固定的 T0 过一天就不是「今天」了，而原型 2c 最上面那行是「今天 09:00」。
// 顺手别落在将来：早上九点前开的话，试跑落的那条会排在一个还没发生的时刻上面。
const ranAt = (daysAgo: number): string => {
  const day = new Date();
  day.setDate(day.getDate() - daysAgo);
  day.setHours(9, 0, 0, 0);
  return new Date(Math.min(day.getTime(), Date.now() - 60_000)).toISOString();
};

let counter = 0;
const nextSuffix = () => `${(counter += 1)}`;

export const user: User = User.parse({
  id: "usr_chen",
  name: "陈默",
  email: MOCK_EMAIL,
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
      {
        kind: "skill_offer",
        botId: BotId.parse("bot_sales"),
        name: "Initech 报价",
        steps: ["在 ERP 按 Initech 建报价单", "折扣沿用 Globex 那套口径", "生成 PDF 发我过目"],
        status: "offered",
        skillId: null,
      },
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
export const tasks = new Map<string, TopicTask>();
export const groupIdByBotId = new Map<string, string>();
export const messagesByGroupId = new Map<string, Message[]>();
export const approvals = new Map<string, Approval>();
export const handoffs = new Map<string, Handoff>();
export const routines = new Map<string, Routine>();
export const skills = new Map<string, Skill>();
export const tools = new Map<string, ToolConnection>();

// 单 Bot 群建 Bot 时自动建，多 Bot 群从建群页来。成员数就是这两类的分界，`/api/groups` 只列后者。
export const isTeamGroup = (group: Group): boolean => group.botIds.length > 1;

// 编号由系统分配，T 加四位。预置的那个群是 T-2481，原型 08 里建好的下一个是 T-2482，接着往下发。
const FIRST_TASK_NUMBER = 2481;
let lastTaskNumber = FIRST_TASK_NUMBER;
const nextTaskNumber = (): string => {
  lastTaskNumber += 1;
  return `T-${lastTaskNumber}`;
};

// 等结论的那次运行停在这里的 resolve 上。按钮和群里回的一句话唤醒的是同一个。
const waiters = new Map<string, (decision: ApprovalDecision) => void>();
const handoffWaiters = new Map<string, () => void>();
let autoAcceptHandoff = true;

const buildMessage = (groupId: string, body: MessageBody, minutes: number): Message =>
  Message.parse({ id: `msg_${nextSuffix()}`, groupId, body, createdAt: at(minutes) });

// 端到端每条用例开头 reseed。上一条用例还在跑的回复得认出世界已经换了一茬，别往新状态里写。
let generation = 0;

// 预置的多 Bot 群，对着原型 05：小服和小销在一个主题任务下协作，任务卡钉在群顶部。
const TEAM_GROUP_ID = "grp_order";
const TEAM_TASK_ID = "tsk_order";
// 小采在群里，交接才演得起来：原型 05 的这个群就是小服、小销、小采三个。
const TEAM_BOT_IDS = ["bot_service", "bot_sales", "bot_buy"];
const TEAM_CHECKLIST = [
  "查 X3 库存与排产，确认 200 台的交付节奏",
  "出 200 台 X3 的报价单",
  "跟 Lisa 确认交期和付款方式",
  "报价发出去之前找陈默点头",
  "订单录进 ERP，交期同步给客户",
];

export const reseed = (): void => {
  generation += 1;
  // 上一条用例可能还有一次运行停在等结论上。不给它一个结论那个 Promise 永远不落地，进程里就攒下一堆停住的运行。
  for (const wake of waiters.values()) wake("rejected");
  waiters.clear();
  for (const wake of handoffWaiters.values()) wake();
  handoffWaiters.clear();
  autoAcceptHandoff = true;
  approvals.clear();
  handoffs.clear();
  routines.clear();
  skills.clear();
  tools.clear();
  bots.clear();
  groups.clear();
  tasks.clear();
  groupIdByBotId.clear();
  messagesByGroupId.clear();
  counter = 0;
  lastTaskNumber = FIRST_TASK_NUMBER;
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
        chiefBotId: null,
        createdAt: at(seedIndex),
      }),
    );
    groupIdByBotId.set(botId, groupId);
    messagesByGroupId.set(
      groupId,
      seed.bodies.map((body, i) => buildMessage(groupId, body, 10 + seedIndex * 10 + i)),
    );
  });

  groups.set(
    TEAM_GROUP_ID,
    Group.parse({
      id: TEAM_GROUP_ID,
      ownerId: user.id,
      botIds: TEAM_BOT_IDS,
      taskId: TEAM_TASK_ID,
      chiefBotId: null,
      createdAt: at(40),
    }),
  );
  tasks.set(
    TEAM_TASK_ID,
    TopicTask.parse({
      id: TEAM_TASK_ID,
      groupId: TEAM_GROUP_ID,
      number: `T-${FIRST_TASK_NUMBER}`,
      title: "Globex X3 × 200 订单",
      summary: "Lisa 确认要 200 台 X3，交期 10 月 30 日前。报价归小销，供货和沟通归小服。对外发邮件先找我点头。",
      dueAt: at(60 * 24 * 12),
      checklist: TEAM_CHECKLIST.map((text) => ({ text, done: false, ownerBotId: null })),
      currentBotId: null,
      handled: [],
      status: "active",
    }),
  );
  // 群里先只有一条系统消息。谁开口都是被 @ 出来的，用例才数得清「只有被 @ 的那个回了」。
  messagesByGroupId.set(TEAM_GROUP_ID, [
    buildMessage(TEAM_GROUP_ID, { kind: "system", text: "群建好了。直接说话大家轮流答，@ 谁就只派给谁。" }, 40),
  ]);

  routines.set(
    SEEDED_ROUTINE_ID,
    Routine.parse({
      id: SEEDED_ROUTINE_ID,
      botId: "bot_service",
      name: "每日工单早报",
      instruction: "汇总昨天的新工单，按紧急度排序，发我一份摘要。标准问题直接按话术回复；退款、改交期停下来等我。",
      triggers: [{ kind: "cron", expr: "0 9 * * 1-5" }],
      onFailure: "stop_and_tell",
      enabled: true,
      // 对着原型 2c 那三行。
      runs: [
        { startedAt: ranAt(0), status: "stopped", note: "1 条等你点头 · ¥0.8" },
        { startedAt: ranAt(5), status: "ok", note: "¥0.7" },
        { startedAt: ranAt(6), status: "failed", note: "工单系统登录过期 · ¥0.2" },
      ],
    }),
  );

  for (const skill of SEEDED_SKILLS) skills.set(skill.id, skill);

  tools.set(
    "tool_tickets",
    ToolConnection.parse({
      id: ToolConnectionId.parse("tool_tickets"),
      ownerId: user.id,
      name: "工单系统",
      url: "https://tickets.acme.internal/mcp",
      operations: [
        {
          name: "create_ticket",
          description: "创建工单",
          inputSchema: {
            type: "object",
            properties: { title: { type: "string" }, description: { type: "string" } },
            required: ["title"],
          },
          needsApproval: true,
        },
        {
          name: "lookup_ticket",
          description: "查询工单",
          inputSchema: {
            type: "object",
            properties: { ticketId: { type: "string" } },
            required: ["ticketId"],
          },
          needsApproval: false,
        },
      ] satisfies ToolOperation[],
      assignedBotIds: ["bot_service"],
    }),
  );
  tools.set(
    "tool_mail",
    ToolConnection.parse({
      id: ToolConnectionId.parse("tool_mail"),
      ownerId: user.id,
      name: "邮箱",
      url: "https://mail.acme.com/mcp",
      operations: [
        {
          name: "send_email",
          description: "发送邮件",
          inputSchema: {
            type: "object",
            properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
            required: ["to", "subject", "body"],
          },
          needsApproval: true,
        },
        {
          name: "list_inbox",
          description: "列出收件箱",
          inputSchema: { type: "object", properties: {} },
          needsApproval: false,
        },
      ] satisfies ToolOperation[],
      assignedBotIds: ["bot_service", "bot_sales", "bot_buy"],
    }),
  );
};

const SEEDED_ROUTINE_ID = "rtn_daily_report";

// 对着原型 10 屏：小销会做的三件活，三种来源各一条。
const SEEDED_SKILLS: Skill[] = [
  Skill.parse({
    id: "skl_quote",
    botId: "bot_sales",
    name: "Globex 报价",
    source: "chat",
    steps: [
      "在 ERP 按客户建报价单",
      "折扣沿用上季度口径，不确定时问你",
      "生成 PDF，附上保修条款",
      "发邮件前停下等你点头",
    ],
    useCount: 3,
    createdAt: at(-60 * 24 * 5),
  }),
  Skill.parse({
    id: "skl_lead_digest",
    botId: "bot_sales",
    name: "线索跟进早报",
    source: "routine",
    steps: ["拉昨天进来的线索，按金额排序", "给三天没动的线索写一句跟进话术", "汇总成一份早报发我"],
    useCount: 21,
    createdAt: at(-60 * 24 * 3),
  }),
  Skill.parse({
    id: "skl_contract_diff",
    botId: "bot_sales",
    name: "合同条款比对",
    source: "taught",
    steps: ["把对方回传的合同和我们的模板逐条比对", "标出改过的条款和风险点", "拿不准的停下来问我"],
    useCount: 1,
    createdAt: at(-60 * 24),
  }),
];

const WEEKLY_SPEND = [
  { botId: BotId.parse("bot_sales"), amount: 21.4, runs: 9 },
  { botId: BotId.parse("bot_service"), amount: 8.1, runs: 5 },
  { botId: BotId.parse("bot_buy"), amount: 8.7, runs: 4 },
];

const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 60 * 60_000).toISOString();

const weekStart = (): string => {
  const shanghai = new Date(Date.now() + 8 * 60 * 60_000);
  shanghai.setUTCDate(shanghai.getUTCDate() - ((shanghai.getUTCDay() + 6) % 7));
  shanghai.setUTCHours(0, 0, 0, 0);
  return new Date(shanghai.getTime() - 8 * 60 * 60_000).toISOString();
};

export const usageOf = (): UsageResponse => {
  const recent = [
    { id: "quote", botId: "bot_sales", groupId: "grp_sales", title: "Globex X3 × 200 报价", hours: 1, amount: 4.6 },
    { id: "tickets", botId: "bot_service", groupId: "grp_service", title: "处理 14 张夜间工单", hours: 3, amount: 3.9 },
    { id: "supply", botId: "bot_buy", groupId: "grp_buy", title: "3 家供应商询价 · X3 现货", hours: 9, amount: 2.8 },
    {
      id: "leads",
      botId: "bot_sales",
      groupId: "grp_sales",
      title: "例行 · 每天 08:00 线索跟进",
      hours: 25,
      amount: 1.1,
    },
    {
      id: "reply",
      botId: "bot_service",
      groupId: "grp_service",
      title: "回复 Globex 交期问题",
      hours: 30,
      amount: 0.7,
    },
  ];
  return UsageResponse.parse({
    weekStartsAt: weekStart(),
    total: WEEKLY_SPEND.reduce((sum, line) => sum + line.amount, 0),
    bots: [...bots.values()]
      .map((bot) => {
        const spend = WEEKLY_SPEND.find((line) => line.botId === bot.id);
        return { botId: bot.id, amount: spend?.amount ?? 0, runs: spend?.runs ?? 0 };
      })
      .sort((a, b) => b.amount - a.amount),
    recent: recent.map((run) => ({
      runId: RunId.parse(`run_usage_${run.id}`),
      botId: bots.has(run.botId) ? BotId.parse(run.botId) : null,
      groupId: groups.has(run.groupId) ? GroupId.parse(run.groupId) : null,
      title: run.title,
      startedAt: hoursAgo(run.hours),
      endedAt: hoursAgo(run.hours - 0.1),
      steps: 6,
      amount: run.amount,
    })),
  });
};

export const overnightOf = (): OvernightResponse =>
  OvernightResponse.parse({
    since: hoursAgo(12),
    items: [
      {
        botId: "bot_buy",
        groupId: "grp_buy",
        text: "3 家供应商报价齐了，X3 现货 160 台，其余 10-20 到。",
        status: "done",
        at: hoursAgo(1),
      },
      {
        botId: "bot_service",
        groupId: "grp_service",
        text: "清了 14 张工单。Globex 要改交期，等你点头。",
        status: "waiting",
        at: hoursAgo(2),
      },
      {
        botId: "bot_sales",
        groupId: "grp_sales",
        text: "08:00 例行：跟进了 6 条线索，2 条有回复。",
        status: "working",
        at: hoursAgo(3),
      },
    ].filter((item) => bots.has(item.botId)),
  });

export const routinesOf = (botId: string): Routine[] => [...routines.values()].filter((r) => r.botId === botId);

export const routineByToken = (token: string): Routine | null =>
  [...routines.values()].find((r) => r.triggers.some((t) => t.kind === "webhook" && t.token === token)) ?? null;

const RUN_CAP = 20;

// webhook 的 token 由服务端发。带着这条例行任务已有的 token 就保留那个地址，不带或对不上就换一个新的：
// 客户端选不了 token，不然谁都能挑一个别人的地址。
const tokensFrom = (previous: Routine["triggers"], inputs: TriggerInput[]): Routine["triggers"] => {
  const mine = new Set(previous.filter((t) => t.kind === "webhook").map((t) => t.token));
  return inputs.map((input) =>
    input.kind === "cron"
      ? { kind: "cron", expr: input.expr }
      : {
          kind: "webhook",
          token: input.token !== undefined && mine.has(input.token) ? input.token : randomBytes(16).toString("hex"),
        },
  );
};

export const createRoutine = (botId: string, input: CreateRoutineRequest): Routine => {
  const routine = Routine.parse({
    id: RoutineId.parse(`rtn_new_${nextSuffix()}`),
    botId,
    name: input.name,
    instruction: input.instruction,
    triggers: tokensFrom([], input.triggers),
    onFailure: input.onFailure,
    enabled: input.enabled,
    runs: [],
  });
  routines.set(routine.id, routine);
  return routine;
};

// patch 从 PATCH 的请求体来，键在不在、值对不对都由 Routine.parse 说了算。triggers 给了就是整份替换，
// 替换前先把已有的 webhook token 认回来。
export const writeRoutine = (id: string, patch: UpdateRoutineRequest): Routine | null => {
  const routine = routines.get(id);
  if (routine === undefined) return null;
  const triggers = patch.triggers === undefined ? routine.triggers : tokensFrom(routine.triggers, patch.triggers);
  const next = Routine.parse({ ...routine, ...patch, triggers });
  routines.set(next.id, next);
  return next;
};

// 试跑一次就是用户在这个 Bot 的单 Bot 群里发了一条消息：先一条 system 说是例行任务在跑，再一条 user 是正文。
// 运行记录在触发那一刻就落一条 running，mock 不演收尾，跟控制面中途重启停在 running 是同一个样子。
export const runRoutine = (id: string): { routine: Routine; messages: Message[] } | null => {
  const routine = routines.get(id);
  if (routine === undefined) return null;
  const groupId = groupIdByBotId.get(routine.botId);
  if (groupId === undefined) return null;
  const messages = [
    appendMessage(groupId, { kind: "system", text: `例行任务「${routine.name}」自动运行` }),
    appendMessage(groupId, { kind: "user", text: routine.instruction }),
  ];
  const runs = [{ startedAt: new Date().toISOString(), status: "running", note: "" }, ...routine.runs].slice(
    0,
    RUN_CAP,
  );
  const next = Routine.parse({ ...routine, runs });
  routines.set(next.id, next);
  return { routine: next, messages };
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
    chiefBotId: null,
    createdAt: bot.createdAt,
  });
  bots.set(bot.id, bot);
  groups.set(group.id, group);
  groupIdByBotId.set(bot.id, group.id);
  messagesByGroupId.set(group.id, []);
  return { bot, group };
};

export const createGroup = (input: {
  title: string;
  botIds: BotId[];
  summary?: string | undefined;
  dueAt?: string | null | undefined;
}) => {
  const suffix = nextSuffix();
  const groupId = GroupId.parse(`grp_new_${suffix}`);
  const taskId = TaskId.parse(`tsk_new_${suffix}`);
  const group = Group.parse({
    id: groupId,
    ownerId: user.id,
    botIds: input.botIds,
    taskId,
    chiefBotId: null,
    createdAt: new Date().toISOString(),
  });
  const task = TopicTask.parse({
    id: taskId,
    groupId,
    number: nextTaskNumber(),
    title: input.title,
    summary: input.summary ?? "",
    dueAt: input.dueAt ?? null,
    // 清单由 Bot 接手后自己列，建群这一刻是空的。原型 08 的预览卡写的就是「0 / 0 · Bot 接手后自己列」。
    checklist: [],
    currentBotId: null,
    handled: [],
    status: "active",
  });
  groups.set(group.id, group);
  tasks.set(task.id, task);
  messagesByGroupId.set(group.id, []);
  return { group, task };
};

// patch 从 PATCH 的请求体来，键在不在、值对不对都由 TopicTask.parse 说了算，这里不替它先信一遍。
export const writeTask = (id: string, patch: Partial<Record<keyof TopicTask, unknown>>): TopicTask | null => {
  const task = tasks.get(id);
  if (task === undefined) return null;
  const next = TopicTask.parse({ ...task, ...patch });
  tasks.set(next.id, next);
  return next;
};

// 群消息只送给被 @ 的 Bot 和当前经手 Bot。名单从群成员来，@ 的是别人的 Bot 或群外的 Bot 都不算。
export const mentionsIn = (groupId: string, text: string): BotId[] => {
  const group = groups.get(groupId);
  if (group === undefined) return [];
  return group.botIds.filter((botId) => {
    const name = bots.get(botId)?.name;
    return name !== undefined && text.includes(`@${name}`);
  });
};

// 单 Bot 群里那一个永远是收件人。多 Bot 群里开口的是被 @ 的那个，没 @ 谁就落到当前经手身上，谁都没有就没人接活。
export const responderOf = (groupId: string, mentions: BotId[]): BotId | null => {
  const group = groups.get(groupId);
  if (group === undefined) return null;
  if (group.botIds.length === 1) return group.botIds[0] ?? null;
  return mentions[0] ?? tasks.get(group.taskId)?.currentBotId ?? null;
};

// 被 @ 就是接手。上一任的经手记录在这一刻收尾，新的一条从现在开始。
export const assignTask = (groupId: string, botId: BotId): TopicTask | null => {
  const taskId = groups.get(groupId)?.taskId;
  const task = taskId === undefined ? undefined : tasks.get(taskId);
  if (task === undefined || task.currentBotId === botId) return null;
  const now = new Date().toISOString();
  const handed = task.handled.map((record) => (record.to === null ? { ...record, to: now } : record));
  return writeTask(task.id, { currentBotId: botId, handled: [...handed, { botId, from: now, to: null }] });
};

// 接手的 Bot 干的第一件事就是把清单勾掉一项。全勾完了就没得勾，返回 null，别推一条什么都没变的 task_updated。
export const tickFirstUndone = (groupId: string, botId: BotId): TopicTask | null => {
  const taskId = groups.get(groupId)?.taskId;
  const task = taskId === undefined ? undefined : tasks.get(taskId);
  if (task === undefined) return null;
  const at = task.checklist.findIndex((item) => !item.done);
  if (at < 0) return null;
  const checklist: ChecklistItem[] = task.checklist.map((item, i) =>
    i === at ? { ...item, done: true, ownerBotId: botId } : item,
  );
  return writeTask(task.id, { checklist });
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

export const skillsOf = (botId: string): Skill[] => [...skills.values()].filter((s) => s.botId === botId);

// 同一个 Bot 下名字不重复。改名时把自己排除掉，不然原样存一次就会撞上自己。
export const skillNameTaken = (botId: string, name: string, exceptId?: string): boolean =>
  [...skills.values()].some((s) => s.botId === botId && s.name === name && s.id !== exceptId);

export const createSkill = (botId: string, input: CreateSkillRequest, source: SkillSource): Skill => {
  const skill = Skill.parse({
    id: SkillId.parse(`skl_new_${nextSuffix()}`),
    botId,
    name: input.name,
    source,
    steps: input.steps,
    useCount: 0,
    createdAt: new Date().toISOString(),
  });
  skills.set(skill.id, skill);
  return skill;
};

// patch 从 PATCH 的请求体来，键在不在、值对不对都由 Skill.parse 说了算。steps 给了就是整份替换。
export const writeSkill = (id: string, patch: UpdateSkillRequest): Skill | null => {
  const skill = skills.get(id);
  if (skill === undefined) return null;
  const next = Skill.parse({ ...skill, ...patch });
  skills.set(next.id, next);
  return next;
};

// 来源跟着原样走：一条从对话里存下来的活复制给谁，它还是从对话里来的。用过几次是新 Bot 自己的账，从零算。
export const copySkillTo = (id: string, botId: string): Skill | null => {
  const skill = skills.get(id);
  if (skill === undefined) return null;
  const copy = Skill.parse({
    ...skill,
    id: SkillId.parse(`skl_new_${nextSuffix()}`),
    botId,
    useCount: 0,
    createdAt: new Date().toISOString(),
  });
  skills.set(copy.id, copy);
  return copy;
};

// 存 skill 的那张卡按消息 id 点，而消息按群分桶存着，只有一条 id 的话得挨个群找。
export const findMessage = (id: string): Message | null => {
  for (const list of messagesByGroupId.values()) {
    const found = list.find((m) => m.id === id);
    if (found !== undefined) return found;
  }
  return null;
};

export const writeMessageBody = (id: string, body: MessageBody): Message | null => {
  const message = findMessage(id);
  return message === null ? null : rewriteMessage(message.groupId, message.id, body);
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

// 交接卡的正文只有 handoffId，状态在 Handoff 上。跟审批一样，这一页引用到的跟着这一页回。
export const handoffsIn = (messages: Message[]): Handoff[] => {
  const found: Handoff[] = [];
  for (const message of messages) {
    if (message.body.kind !== "handoff") continue;
    const handoff = handoffs.get(message.body.handoffId);
    if (handoff) found.push(handoff);
  }
  return found;
};

export const pendingHandoffsOf = (groupId: string): number =>
  [...handoffs.values()].filter((h) => h.groupId === groupId && h.status === "pending").length;

// 交接报文指向的是「下一个人该从哪一项接着做」，所以指针取交接这一刻第一项还没勾掉的。全勾完了就没什么可指的。
const nextUndoneIndexOf = (groupId: string): number | null => {
  const taskId = groups.get(groupId)?.taskId;
  const at = (taskId === undefined ? undefined : tasks.get(taskId))?.checklist.findIndex((item) => !item.done) ?? -1;
  return at < 0 ? null : at;
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

// mock 只演一次交接，对着原型 05：小服在群里把手上这一段干完，把剩下的供货确认交给小采，两秒后小采接手。
// 真控制面里交给谁由 Bot 自己的 handoff_task 决定，这里写死一条，用例才数得清角标和当前经手。
const HANDOFF_SCRIPT = {
  fromBotId: "bot_service",
  toBotId: "bot_buy",
  done: "查完 Globex 的 X3 库存与排产：10 月 20 日能先交 120 台，联系人和交期口径都记在任务卡上了。",
  notDone: "剩下 80 台的货期还没定，三家供应商的现货和到货期一家都没问。",
  next: "找 3 家供应商问 X3 现货和最早到货日，回来补进任务卡。",
};

const HANDOFF_ACCEPT_MS = 2000;

export const holdHandoffAccept = (): void => {
  autoAcceptHandoff = false;
};

export const confirmNextHandoff = (): boolean => {
  const wake = handoffWaiters.values().next().value;
  if (wake === undefined) return false;
  wake();
  return true;
};

const waitForHandoffAccept = (id: string): Promise<void> =>
  new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const wake = () => {
      if (timer !== null) clearTimeout(timer);
      handoffWaiters.delete(id);
      resolve();
    };
    handoffWaiters.set(id, wake);
    if (autoAcceptHandoff) timer = setTimeout(wake, HANDOFF_ACCEPT_MS);
  });

const pendingHandoff = (groupId: string, fromBotId: BotId, toBotId: BotId): Handoff =>
  Handoff.parse({
    id: HandoffId.parse(`hof_${nextSuffix()}`),
    groupId: GroupId.parse(groupId),
    fromBotId,
    toBotId,
    done: HANDOFF_SCRIPT.done,
    notDone: HANDOFF_SCRIPT.notDone,
    next: HANDOFF_SCRIPT.next,
    checklistIndex: nextUndoneIndexOf(groupId),
    status: "pending",
    createdAt: new Date().toISOString(),
    acceptedAt: null,
  });

export const seedUnseenHandoff = (): Handoff => {
  const handoff = pendingHandoff(
    TEAM_GROUP_ID,
    BotId.parse(HANDOFF_SCRIPT.fromBotId),
    BotId.parse(HANDOFF_SCRIPT.toBotId),
  );
  handoffs.set(handoff.id, handoff);
  return handoff;
};

export const settleUnseenHandoff = (): Handoff | null => {
  const handoff = [...handoffs.values()].find((item) => item.status === "pending");
  if (handoff === undefined) return null;
  const accepted = Handoff.parse({ ...handoff, status: "accepted", acceptedAt: new Date().toISOString() });
  handoffs.set(accepted.id, accepted);
  return accepted;
};

const playHandoff = async (groupId: string, botId: BotId, push: (event: ServerPush) => void): Promise<void> => {
  const run = generation;
  const group = groups.get(groupId);
  if (group === undefined || group.botIds.length === 1 || botId !== HANDOFF_SCRIPT.fromBotId) return;
  const toBotId = group.botIds.find((id) => id === HANDOFF_SCRIPT.toBotId);
  if (toBotId === undefined) return;
  // 演一次就够。再 @ 一次小服不该又长出一张卡，不然角标是几全看用例发过几条消息。
  if ([...handoffs.values()].some((h) => h.groupId === groupId)) return;

  const handoff = pendingHandoff(groupId, botId, toBotId);
  handoffs.set(handoff.id, handoff);
  // 先推 handoff_updated 再推那条消息：卡的状态只在 Handoff 上，消息先到的话前端只能先画一张查不到状态的占位。
  push({ type: "handoff_updated", handoff });
  push({ type: "message", message: appendMessage(groupId, { kind: "handoff", handoffId: handoff.id }) });

  await waitForHandoffAccept(handoff.id);
  if (generation !== run) return;
  const accepted = Handoff.parse({ ...handoff, status: "accepted", acceptedAt: new Date().toISOString() });
  handoffs.set(accepted.id, accepted);
  push({ type: "handoff_updated", handoff: accepted });
  // 接手就是换经手人，控制面那边复用 setCurrentBot，mock 这边是同一件事。
  const assigned = assignTask(groupId, toBotId);
  if (assigned !== null) push({ type: "task_updated", task: assigned });
};

export const streamBotReply = async (
  groupId: string,
  botId: BotId,
  prompt: string,
  push: (event: ServerPush) => void,
): Promise<void> => {
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

  // 接手的 Bot 干完这一步就把清单勾掉一项，这是它维护任务卡的方式，用户在卡上看到的就是这次运行的结果。
  const ticked = status === "ok" ? tickFirstUndone(groupId, botId) : null;
  if (ticked !== null) push({ type: "task_updated", task: ticked });

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

  // 被拦下的那次运行没干成事，没什么可交接的。
  if (status === "ok") await playHandoff(groupId, botId, push);
};

export const lastMessageOf = (groupId: string): Message | null => (messagesByGroupId.get(groupId) ?? []).at(-1) ?? null;
