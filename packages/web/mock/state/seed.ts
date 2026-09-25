import {
  Bot,
  BotId,
  Group,
  Message,
  Routine,
  RunId,
  Settings,
  Skill,
  ToolConnection,
  ToolConnectionId,
  TopicTask,
  type BotHue,
  type MessageBody,
  type ToolOperation,
} from "@baize/shared";
import {
  TEAM_BOT_IDS,
  TEAM_CHECKLIST,
  TEAM_GROUP_ID,
  TEAM_TASK_ID,
  advanceGeneration,
  approvals,
  at,
  bots,
  groupIdByBotId,
  groups,
  handoffAcceptance,
  handoffWaiters,
  handoffs,
  messagesByGroupId,
  nextSuffix,
  ranAt,
  resetSuffix,
  resetTaskNumber,
  routines,
  settings,
  skills,
  taskNumber,
  tasks,
  tools,
  user,
  waiters,
} from "./store.js";

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
        runId: RunId.parse("run_service_1"),
        botId: BotId.parse("bot_service"),
        tool: "bash",
        view: { kind: "bash", command: "pnpm check", raw: { command: "pnpm check" } },
        status: "ok",
        durationMs: 12_000,
      },
      {
        kind: "tool_call",
        runId: RunId.parse("run_service_1"),
        botId: BotId.parse("bot_service"),
        tool: "write",
        view: {
          kind: "write",
          path: "周报.md",
          preview: ["# 本周完成", "- 核对 X3 库存", "- 更新交付计划"],
          raw: { path: "周报.md", content: "# 本周完成\n- 核对 X3 库存\n- 更新交付计划" },
        },
        status: "ok",
        durationMs: 800,
      },
      {
        kind: "tool_call",
        runId: RunId.parse("run_service_1"),
        botId: BotId.parse("bot_service"),
        tool: "edit",
        view: {
          kind: "edit",
          path: "周报.md",
          changedLines: 3,
          raw: { path: "周报.md", edits: [{ oldText: "交付待定", newText: "10 月 20 日先交 120 台" }] },
        },
        status: "ok",
        durationMs: 1_200,
      },
      {
        kind: "tool_call",
        runId: RunId.parse("run_service_1"),
        botId: BotId.parse("bot_service"),
        tool: "erp.query",
        view: {
          kind: "mcp",
          server: "ERP",
          tool: "query",
          params: [{ key: "查询", value: "库存与排产计划" }],
          raw: { query: "库存与排产计划", limit: 20 },
        },
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

const buildMessage = (groupId: string, body: MessageBody, minutes: number): Message =>
  Message.parse({ id: `msg_${nextSuffix()}`, groupId, body, createdAt: at(minutes) });

export const reseed = (): void => {
  advanceGeneration();
  // 上一条用例可能还有一次运行停在等结论上。不给它一个结论那个 Promise 永远不落地，进程里就攒下一堆停住的运行。
  for (const wake of waiters.values()) wake("rejected");
  waiters.clear();
  for (const wake of handoffWaiters.values()) wake();
  handoffWaiters.clear();
  handoffAcceptance.automatic = true;
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
  resetSuffix();
  resetTaskNumber();
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
      number: taskNumber(),
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
