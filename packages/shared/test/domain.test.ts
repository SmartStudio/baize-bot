import { describe, expect, it } from "vitest";
import {
  AgentToControl,
  Bot,
  BotId,
  GRANTABLE_SCOPES,
  ControlToAgent,
  CreateGroupRequest,
  CreateRoutineRequest,
  DecideSkillOfferRequest,
  Draft,
  Group,
  GroupId,
  Handoff,
  Message,
  MessageBody,
  ProjectOfferPlatform,
  RoutineRun,
  ServerPush,
  Skill,
  SkillId,
  TopicTask,
  toolViewText,
  gatewayAlias,
  TodayResponse,
  UsageResponse,
  UsageRunItem,
  type UserId,
} from "../src/index.js";

const now = "2026-09-18T00:00:00.000Z";

describe("id 品牌", () => {
  it("BotId 不能赋给 UserId", () => {
    const botId = BotId.parse("b1");
    // @ts-expect-error BotId 和 UserId 必须是两个不同的品牌。
    const userId: UserId = botId;
    expect(userId).toBe("b1");
  });
});

describe("domain schemas reject illegal states", () => {
  it("a group needs 1 to 6 bots", () => {
    const base = { id: "g1", ownerId: "u1", taskId: "t1", kind: "team", chiefBotId: null, createdAt: now };
    expect(Group.safeParse({ ...base, botIds: ["b1"], chiefBotId: undefined }).success, "首席字段不可省").toBe(false);
    expect(Group.safeParse({ ...base, botIds: [] }).success).toBe(false);
    expect(Group.safeParse({ ...base, botIds: ["b1", "b2", "b3", "b4", "b5", "b6", "b7"] }).success).toBe(false);
    expect(Group.safeParse({ ...base, botIds: ["b1"] }).success).toBe(true);
    expect(Group.safeParse({ ...base, kind: undefined, botIds: ["b1"] }).success, "kind 不可省").toBe(false);
  });

  it("a solo group is exactly one bot and never has a chief", () => {
    const base = { id: "g1", ownerId: "u1", taskId: "t1", kind: "solo", chiefBotId: null, createdAt: now };
    expect(Group.safeParse({ ...base, botIds: ["b1"] }).success).toBe(true);
    expect(Group.safeParse({ ...base, botIds: ["b1", "b2"] }).success, "单聊不能两个成员").toBe(false);
    expect(Group.safeParse({ ...base, botIds: ["b1"], chiefBotId: "b1" }).success, "单聊没有首席").toBe(false);
  });

  it("task numbers are T plus four digits", () => {
    const task = {
      id: "t1",
      groupId: "g1",
      title: "x",
      checklist: [],
      handled: [],
      currentBotId: null,
      dueAt: null,
      cadence: "",
      status: "active",
    };
    expect(TopicTask.safeParse({ ...task, number: "T-2481" }).success).toBe(true);
    expect(TopicTask.safeParse({ ...task, number: "2481" }).success).toBe(false);
  });

  it("a bot hue must be one of the seven design-system hues", () => {
    const bot = { id: "b1", ownerId: "u1", name: "小服", role: "member", runState: "running", createdAt: now };
    expect(Bot.safeParse({ ...bot, hue: "mint" }).success).toBe(true);
    expect(Bot.safeParse({ ...bot, hue: "red" }).success).toBe(false);
  });

  it("message body is discriminated by kind", () => {
    const msg = { id: "m1", groupId: "g1", createdAt: now };
    expect(Message.safeParse({ ...msg, body: { kind: "user", text: "hi" } }).success).toBe(true);
    expect(Message.safeParse({ ...msg, body: { kind: "bot", text: "hi" } }).success).toBe(false);
  });

  it("硬清单只允许这一次，write_outside 允许项目授权", () => {
    expect(GRANTABLE_SCOPES.spend).toEqual(["once"]);
    expect(GRANTABLE_SCOPES.account_security).toEqual(["once"]);
    expect(GRANTABLE_SCOPES.delete).toEqual(["once"]);
    expect(GRANTABLE_SCOPES.write_outside).toEqual(["once", "project"]);
    expect(GRANTABLE_SCOPES.spend).not.toContain("project");
    expect(GRANTABLE_SCOPES.spend).not.toContain("forever");
  });

  it("Bot 带运行状态，方案卡能表达暂不支持的平台", () => {
    const bot = {
      id: "b1",
      ownerId: "u1",
      role: "member",
      name: "小服",
      hue: "mint",
      runState: "paused",
      createdAt: now,
    };
    expect(Bot.parse(bot).runState).toBe("paused");
    expect(ProjectOfferPlatform.safeParse({ kind: "unsupported", name: "抖音" }).success).toBe(true);
    expect(ProjectOfferPlatform.safeParse({ kind: "supported", platform: "抖音" }).success).toBe(false);
  });

  it("MessageBody 能解析方案卡、草稿卡和计划卡", () => {
    const offer = {
      kind: "project_offer",
      botId: "b1",
      name: "内容项目",
      goal: "每周发帖",
      team: [{ name: "小编", tag: "edit", description: "负责写作" }],
      platforms: [{ kind: "unsupported", name: "抖音" }],
      cadence: "每周 3 篇",
      firstStep: "先写第一篇",
      status: "offered",
      groupId: null,
    };
    expect(MessageBody.safeParse(offer).success).toBe(true);
    expect(MessageBody.safeParse({ kind: "draft", draftId: "d1" }).success).toBe(true);
    expect(MessageBody.safeParse({ kind: "plan", planId: "p1" }).success).toBe(true);
  });
});

describe("M7 群与主题任务的共享形状", () => {
  it("消息正文的 mentions 可省，带了必须是 Bot id 数组", () => {
    const msg = { id: "m1", groupId: "g1", createdAt: now };
    expect(Message.safeParse({ ...msg, body: { kind: "user", text: "@小服 查一下" } }).success).toBe(true);
    expect(Message.safeParse({ ...msg, body: { kind: "user", text: "x", mentions: ["b1"] } }).success).toBe(true);
    expect(Message.safeParse({ ...msg, body: { kind: "user", text: "x", mentions: "b1" } }).success).toBe(false);
  });

  it("建群要 2 到 6 个 Bot，单 Bot 群不走建群接口", () => {
    expect(CreateGroupRequest.safeParse({ title: "续约", botIds: ["b1"] }).success).toBe(false);
    expect(CreateGroupRequest.safeParse({ title: "续约", botIds: ["b1", "b2"] }).success).toBe(true);
  });

  it("运行器上报的清单最多 50 条", () => {
    const base = { type: "task_checklist", runId: "r1", botId: "b1", groupId: "g1" };
    const item = { text: "x", done: false, ownerBotId: null };
    expect(AgentToControl.safeParse({ ...base, checklist: Array.from({ length: 50 }, () => item) }).success).toBe(true);
    expect(AgentToControl.safeParse({ ...base, checklist: Array.from({ length: 51 }, () => item) }).success).toBe(
      false,
    );
  });

  it("prompt 必须带任务卡字段，单 Bot 群传 null", () => {
    const prompt = {
      type: "prompt",
      runId: "r1",
      botId: "b1",
      groupId: "g1",
      messageId: "m1",
      text: "hi",
      origin: { kind: "user" },
      reason: "solo",
      group: { id: "g1", number: "", title: "", kind: "solo" },
      context: [{ messageId: "m1", from: "用户", text: "hi", settled: true }],
      purpose: "plan",
      members: [],
    };
    expect(ControlToAgent.safeParse(prompt).success).toBe(false);
    expect(ControlToAgent.safeParse({ ...prompt, task: null }).success).toBe(true);
  });

  it("交接报文的 handoff_accept 必须带 handoffId，prompt 的 handoffId 可省", () => {
    const run = { runId: "r1", botId: "b1", groupId: "g1" };
    expect(AgentToControl.safeParse({ type: "handoff_accept", ...run, handoffId: "h1" }).success).toBe(true);
    expect(AgentToControl.safeParse({ type: "handoff_accept", ...run }).success).toBe(false);
    const prompt = {
      type: "prompt",
      ...run,
      messageId: "m1",
      text: "x",
      origin: { kind: "user" },
      reason: "solo",
      group: { id: "g1", number: "", title: "", kind: "solo" },
      context: [{ messageId: "m1", from: "用户", text: "x", settled: true }],
      purpose: "plan",
      task: null,
      members: [],
    };
    expect(ControlToAgent.safeParse(prompt).success).toBe(true);
    expect(ControlToAgent.safeParse({ ...prompt, handoffId: "h1" }).success).toBe(true);
  });

  it("prompt 必须说明派到你的原因，成员必须带座次；set_chief 的目标可为 null 表示卸任", () => {
    const run = { runId: "r1", botId: "b1", groupId: "g1" };
    const member = { id: "b1", name: "小服", tag: "", description: "" };
    const prompt = {
      type: "prompt",
      ...run,
      messageId: "m1",
      text: "x",
      origin: { kind: "user" },
      reason: "everyone",
      group: { id: "g1", number: "T-0001", title: "群", kind: "team" },
      context: [{ messageId: "m1", from: "用户", text: "x", settled: true }],
      purpose: "plan",
      task: null,
      members: [{ ...member, seat: "chief" }],
    };
    expect(ControlToAgent.safeParse(prompt).success).toBe(true);
    const { reason: _reason, ...withoutReason } = prompt;
    expect(ControlToAgent.safeParse(withoutReason).success, "reason 不可省").toBe(false);
    const { messageId: _messageId, ...withoutMessageId } = prompt;
    expect(ControlToAgent.safeParse(withoutMessageId).success, "messageId 不可省").toBe(false);
    expect(ControlToAgent.safeParse({ ...prompt, members: [member] }).success, "成员座次不可省").toBe(false);
    const legacy = ControlToAgent.parse({ ...prompt, context: [{ messageId: "m1", from: "用户", text: "x" }] });
    expect(legacy.type === "prompt" ? legacy.context : null, "旧控制面不带 settled 的上下文行照样收下，当定稿").toEqual(
      [{ messageId: "m1", from: "用户", text: "x", settled: true }],
    );
    expect(AgentToControl.safeParse({ type: "set_chief", ...run, targetBotId: "b2" }).success).toBe(true);
    expect(AgentToControl.safeParse({ type: "set_chief", ...run, targetBotId: null }).success).toBe(true);
    expect(AgentToControl.safeParse({ type: "set_chief", ...run }).success, "目标字段不可省").toBe(false);
  });

  it("交接记录带创建时刻，接手时刻在确认前是 null", () => {
    const handoff = {
      id: "h1",
      groupId: "g1",
      fromBotId: "b1",
      toBotId: "b2",
      done: "查了库存",
      notDone: "没出报价",
      next: "出报价单",
      checklistIndex: 1,
      status: "pending",
      createdAt: now,
    };
    expect(Handoff.safeParse({ ...handoff, acceptedAt: null }).success).toBe(true);
    expect(Handoff.safeParse(handoff).success).toBe(false);
  });
});

describe("M9 例行任务的共享形状", () => {
  const routine = {
    name: "每日工单早报",
    instruction: "汇总昨天的新工单",
    triggers: [{ kind: "cron", expr: "0 9 * * 1-5" }],
    onFailure: "stop_and_tell",
  };

  it("webhook 触发器建的时候不带 token，token 由控制面发", () => {
    const withHook = { ...routine, triggers: [{ kind: "webhook" }] };
    expect(CreateRoutineRequest.safeParse(withHook).success).toBe(true);
    expect(CreateRoutineRequest.parse(routine).enabled).toBe(true);
  });

  it("cron 表达式不能是空串，触发器最多 10 个", () => {
    expect(CreateRoutineRequest.safeParse({ ...routine, triggers: [{ kind: "cron", expr: "" }] }).success).toBe(false);
    const eleven = Array.from({ length: 11 }, () => ({ kind: "cron", expr: "* * * * *" }));
    expect(CreateRoutineRequest.safeParse({ ...routine, triggers: eleven }).success).toBe(false);
  });

  it("运行记录触发时是 running，收尾后才是另外三种", () => {
    for (const status of ["running", "ok", "failed", "stopped"]) {
      expect(RoutineRun.safeParse({ startedAt: now, status, note: "" }).success).toBe(true);
    }
    expect(RoutineRun.safeParse({ startedAt: now, status: "pending", note: "" }).success).toBe(false);
  });

  it("删例行任务的推送带 botId，客户端按 Bot 分列表", () => {
    expect(ServerPush.safeParse({ type: "routine_deleted", routineId: "r1", botId: "b1" }).success).toBe(true);
    expect(ServerPush.safeParse({ type: "routine_deleted", routineId: "r1" }).success).toBe(false);
  });
});

describe("M10 skill 的共享形状", () => {
  it("skill_offer 至少两步，name 非空", () => {
    const offer = { type: "skill_offer", runId: "r1", botId: "b1", groupId: "g1", name: "Globex 报价" };
    expect(AgentToControl.safeParse({ ...offer, steps: ["建报价单", "生成 PDF"] }).success).toBe(true);
    expect(AgentToControl.safeParse({ ...offer, steps: ["建报价单"] }).success).toBe(false);
    expect(AgentToControl.safeParse({ ...offer, name: "", steps: ["a", "b"] }).success).toBe(false);
  });

  it("SkillId 只收能当目录名的一段，带分隔符或点点的不收", () => {
    expect(SkillId.safeParse("skill-globex_1").success).toBe(true);
    expect(SkillId.safeParse("3f2c9a1e-7b4d-4c5e-9a1b-2c3d4e5f6a7b").success).toBe(true);
    for (const bad of ["../pwned", "a/b", "a\\b", "..", "", "x".repeat(65), "报价"]) {
      expect(SkillId.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("GroupId 也只收能当目录名的一段，运行器拿它拼会话目录", () => {
    expect(GroupId.safeParse("grp_sales").success).toBe(true);
    expect(GroupId.safeParse("3f2c9a1e-7b4d-4c5e-9a1b-2c3d4e5f6a7b").success).toBe(true);
    for (const bad of ["../pwned", "a/b", "a\\b", "..", "", "x".repeat(65), "报价"]) {
      expect(GroupId.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("skill_offer 消息正文自带步骤和结论，存了之后 skillId 才有值", () => {
    const msg = { id: "m1", groupId: "g1", createdAt: now };
    const offer = { kind: "skill_offer", botId: "b1", name: "Globex 报价", steps: ["建报价单", "生成 PDF"] };
    expect(Message.safeParse({ ...msg, body: { ...offer, status: "offered", skillId: null } }).success).toBe(true);
    expect(Message.safeParse({ ...msg, body: { ...offer, status: "saved", skillId: "s1" } }).success).toBe(true);
    expect(Message.safeParse({ ...msg, body: { ...offer, status: "offered" } }).success).toBe(false);
    expect(
      Message.safeParse({ ...msg, body: { ...offer, steps: ["只有一步"], status: "offered", skillId: null } }).success,
    ).toBe(false);
    expect(DecideSkillOfferRequest.safeParse({ decision: "save" }).success).toBe(true);
    expect(DecideSkillOfferRequest.safeParse({ decision: "approved" }).success).toBe(false);
  });

  it("skill 名最多 40 字，步骤 1 到 20 条且每条非空", () => {
    const skill = { id: "s1", botId: "b1", source: "taught", useCount: 0, createdAt: now };
    expect(Skill.safeParse({ ...skill, name: "周报", steps: ["翻一遍群消息"] }).success).toBe(true);
    expect(Skill.safeParse({ ...skill, name: "x".repeat(41), steps: ["a"] }).success).toBe(false);
    expect(Skill.safeParse({ ...skill, name: "周报", steps: [] }).success).toBe(false);
    expect(Skill.safeParse({ ...skill, name: "周报", steps: ["a", ""] }).success).toBe(false);
    expect(ServerPush.safeParse({ type: "skill_deleted", skillId: "s1", botId: "b1" }).success).toBe(true);
  });
});

describe("M11 用量的共享形状", () => {
  it("用量页每个 Bot 一行，最近任务最多 20 条", () => {
    const run = {
      runId: "r1",
      botId: "b1",
      groupId: "g1",
      title: "查库存",
      startedAt: now,
      endedAt: now,
      steps: 3,
      amount: 0.4,
    };
    const usage = { weekStartsAt: now, total: 0.4, bots: [{ botId: "b1", amount: 0.4, runs: 1 }], recent: [run] };
    expect(UsageResponse.safeParse(usage).success).toBe(true);
    expect(UsageResponse.safeParse({ ...usage, recent: Array.from({ length: 21 }, () => run) }).success).toBe(false);
    expect(UsageResponse.safeParse({ ...usage, bots: [{ botId: "b1", amount: -1, runs: 0 }] }).success).toBe(false);
    expect(UsageRunItem.safeParse({ ...run, botId: null, groupId: null }).success).toBe(true);
  });
});

describe("今日页的共享形状", () => {
  it("四栏只复用 C1 对象，顶层和各栏都拒绝缺字段与多余字段", () => {
    const approval = {
      id: "a1",
      groupId: "g1",
      botId: "b1",
      runId: "r1",
      action: "publish",
      target: null,
      view: { kind: "bash", command: "echo hi" },
      status: "pending",
      decidedAt: null,
      grantId: null,
    };
    const draft = {
      id: "d1",
      groupId: "g1",
      botId: "b1",
      planId: "p1",
      accountId: "a1",
      platform: "x",
      content: { kind: "post", title: "今日动态", text: "正文", images: [], github: null },
      scheduledAt: null,
      status: "pending",
      edits: [],
      failure: null,
      createdAt: now,
      decidedAt: null,
    };
    const plan = {
      id: "p1",
      groupId: "g1",
      botId: "b1",
      title: "本周计划",
      status: "pending",
      draftIds: ["d1"],
      createdAt: now,
      decidedAt: null,
    };
    const account = {
      id: "a1",
      ownerId: "u1",
      computerId: "c1",
      platform: "x",
      handle: "@baize",
      tier: "confirm_publish",
      login: "valid",
      loginChangedAt: now,
      lastLoginFailure: null,
      createdAt: now,
    };
    const response = {
      assistantGroupId: "g1",
      assistantLatest: { text: "想让我帮你做成什么事？说一句就行", at: "2026-09-27T01:00:00.000Z" },
      pending: [
        { kind: "approval", since: now, approval },
        { kind: "plan", since: now, plan, drafts: [draft] },
        { kind: "draft", since: now, draft },
        { kind: "account", since: now, account },
      ],
      done: [
        {
          kind: "publication",
          at: now,
          groupId: "g1",
          title: "今日动态",
          platform: "x",
          url: "https://example.com/posts/1",
        },
        { kind: "plan_approved", at: now, groupId: "g1", title: "本周计划", draftCount: 1 },
        { kind: "routine", at: now, groupId: null, title: "每日早报", note: "新增 3 条线索" },
      ],
      running: [{ groupId: "g1", title: "本周计划", published: 1, planned: 3 }],
      next: [
        { kind: "draft", at: now, draft },
        { kind: "routine", at: now, routineId: "routine-1", groupId: null, botId: "b1", title: "每日早报" },
      ],
    };

    expect(TodayResponse.safeParse(response).success).toBe(true);
    expect(TodayResponse.safeParse({ ...response, assistantGroupId: null }).success).toBe(true);
    expect(TodayResponse.safeParse({ ...response, assistantLatest: null }).success).toBe(true);
    expect(TodayResponse.safeParse({ ...response, assistantLatest: undefined }).success).toBe(false);
    expect(
      TodayResponse.safeParse({ ...response, assistantLatest: { text: "", at: "2026-09-27T01:00:00.000Z" } }).success,
      "空正文不算主助理说过的话",
    ).toBe(false);
    expect(TodayResponse.safeParse({ ...response, pending: undefined }).success).toBe(false);
    expect(TodayResponse.safeParse({ ...response, extra: [] }).success).toBe(false);
    expect(
      TodayResponse.safeParse({
        ...response,
        pending: [{ ...response.pending[0], extra: [] }, ...response.pending.slice(1)],
      }).success,
    ).toBe(false);
  });
});

describe("C0 工具视图与审批报文", () => {
  it("工具调用只带结构化视图，消息正文带 runId", () => {
    const view = {
      kind: "mcp",
      server: "库存服务",
      tool: "lookup_stock",
      params: [{ key: "sku", value: "A-001" }],
      raw: { sku: "A-001" },
    };
    expect(
      AgentToControl.safeParse({
        type: "bot_tool_call",
        runId: "r1",
        botId: "b1",
        groupId: "g1",
        callId: "c1",
        tool: "lookup_stock",
        view,
        status: "running",
        durationMs: null,
      }).success,
      "带视图的工具调用报文应能解析",
    ).toBe(true);
    expect(
      Message.safeParse({
        id: "m1",
        groupId: "g1",
        createdAt: now,
        body: {
          kind: "tool_call",
          runId: "r1",
          botId: "b1",
          tool: "lookup_stock",
          view,
          status: "running",
          durationMs: null,
        },
      }).success,
      "工具消息应保存 runId 和结构化视图",
    ).toBe(true);
    expect(
      AgentToControl.safeParse({ type: "approval_abandoned", runId: "r1", callId: "c1", reason: "paused" }).success,
      "审批放弃报文应能解析",
    ).toBe(true);
  });

  it("工具视图限制预览行数并拒绝非 JSON 值", () => {
    const base = { kind: "write", path: "报价.md", preview: ["1", "2", "3", "4", "5"] };
    expect(
      AgentToControl.safeParse({
        type: "approval_request",
        runId: "r1",
        botId: "b1",
        groupId: "g1",
        callId: "c1",
        tool: "write_file",
        action: "message_person",
        target: null,
        view: base,
      }).success,
      "五行预览应能解析",
    ).toBe(true);
    expect(
      AgentToControl.safeParse({
        type: "approval_request",
        runId: "r1",
        botId: "b1",
        groupId: "g1",
        callId: "c1",
        tool: "write_file",
        action: "message_person",
        target: null,
        view: { ...base, preview: [...base.preview, "6"] },
      }).success,
      "预览最多五行",
    ).toBe(false);
    expect(
      AgentToControl.safeParse({
        type: "approval_request",
        runId: "r1",
        botId: "b1",
        groupId: "g1",
        callId: "c1",
        tool: "write_file",
        action: "message_person",
        target: null,
        view: { ...base, raw: { invalid: BigInt(1) } },
      }).success,
      "原始参数只能是 JSON 值",
    ).toBe(false);
  });

  it("toolViewText 四种视图都说人话且没有花括号", () => {
    const samples = [
      toolViewText({ kind: "bash", command: "ls ~/Downloads", raw: { command: "ls ~/Downloads" } }),
      toolViewText({ kind: "write", path: "报价.md", preview: ["第一行"], raw: { path: "报价.md" } }),
      toolViewText({ kind: "edit", path: "报价.md", changedLines: 3, raw: { oldText: "旧", newText: "新" } }),
      toolViewText({
        kind: "mcp",
        server: "库存服务",
        tool: "lookup_stock",
        params: [{ key: "sku", value: "A-001" }],
        raw: { sku: "A-001" },
      }),
    ];
    expect(samples).toEqual([
      "要执行 `ls ~/Downloads`",
      "要写 `报价.md`",
      "要改 `报价.md` 的 3 行",
      "要用库存服务的 lookup_stock，参数：sku=A-001",
    ]);
    expect(samples.every((sample) => !/[{}]/.test(sample))).toBe(true);
  });
});

describe("登录失败、发布失败和网关别名", () => {
  it("login_state 的 failed 只收两种原因，并且要带回这一次的尝试号", () => {
    const base = { type: "login_state", accountId: "a1" };
    for (const reason of ["window_failed", "remote_refused"]) {
      expect(AgentToControl.safeParse({ ...base, state: { login: "failed", reason, attempt: "try_1" } }).success).toBe(
        true,
      );
    }
    expect(
      AgentToControl.safeParse({ ...base, state: { login: "failed", reason: "timeout", attempt: "try_1" } }).success,
    ).toBe(false);
    expect(
      AgentToControl.safeParse({ ...base, state: { login: "failed", attempt: "try_1" } }).success,
      "原因不可省",
    ).toBe(false);
    expect(
      AgentToControl.safeParse({ ...base, state: { login: "failed", reason: "window_failed" } }).success,
      "尝试号不可省，页面靠它认出失败的是哪一次点击",
    ).toBe(false);
  });

  it("publish_result 的失败原因和草稿上的 failure 是同一组值", () => {
    const failed = {
      type: "publish_result",
      draftId: "d1",
      attempt: now,
      result: { status: "failed", detail: "" },
    };
    const draft = {
      id: "d1",
      groupId: "g1",
      botId: "b1",
      planId: null,
      accountId: "a1",
      platform: "x",
      content: { kind: "post", title: "今日动态", text: "正文", images: [], github: null },
      scheduledAt: null,
      status: "approved",
      edits: [],
      createdAt: now,
      decidedAt: now,
    };
    for (const reason of ["login_expired", "page_changed", "error"]) {
      expect(AgentToControl.safeParse({ ...failed, result: { ...failed.result, reason } }).success).toBe(true);
      expect(Draft.safeParse({ ...draft, failure: reason }).success, reason).toBe(true);
    }
    expect(AgentToControl.safeParse({ ...failed, result: { ...failed.result, reason: "timeout" } }).success).toBe(
      false,
    );
    expect(Draft.safeParse({ ...draft, failure: "timeout" }).success, "草稿不收发布报文之外的原因").toBe(false);
    expect(Draft.safeParse({ ...draft, failure: null }).success).toBe(true);
  });

  it("发布报文带认领标识，结果原样带回；读不到笔记 id 可以是 null", () => {
    const draft = {
      type: "publish_draft",
      draftId: "d1",
      botId: "b1",
      accountId: "a1",
      platform: "xiaohongshu",
      content: { kind: "post", title: null, text: "正文", images: [], github: null },
      attempt: now,
    };
    expect(ControlToAgent.safeParse(draft).success).toBe(true);
    expect(ControlToAgent.safeParse({ ...draft, botId: null }).success, "起草的 Bot 删了").toBe(true);
    expect(ControlToAgent.safeParse({ ...draft, attempt: undefined }).success, "认领标识不可省").toBe(false);
    const ok = { type: "publish_result", draftId: "d1", attempt: now, result: { status: "ok", url: "https://a.b/c" } };
    expect(AgentToControl.safeParse({ ...ok, result: { ...ok.result, externalId: null } }).success).toBe(true);
    expect(AgentToControl.safeParse({ ...ok, result: { ...ok.result, externalId: "" } }).success).toBe(false);
    expect(
      AgentToControl.safeParse({ ...ok, attempt: undefined, result: { ...ok.result, externalId: "n1" } }).success,
      "结果不带认领标识不认",
    ).toBe(false);
  });

  it("网关别名是 baize: 加用途", () => {
    expect(gatewayAlias("plan")).toBe("baize:plan");
    expect(gatewayAlias("fast")).toBe("baize:fast");
  });
});
