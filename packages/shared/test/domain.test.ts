import { describe, expect, it } from "vitest";
import {
  AgentToControl,
  Bot,
  ControlToAgent,
  CreateGroupRequest,
  CreateRoutineRequest,
  DecideSkillOfferRequest,
  Group,
  Handoff,
  Message,
  RoutineRun,
  ServerPush,
  Skill,
  SkillId,
  TopicTask,
  OvernightResponse,
  UsageResponse,
  UsageRunItem,
} from "../src/index.js";

const now = "2026-09-18T00:00:00.000Z";

describe("domain schemas reject illegal states", () => {
  it("a group needs 1 to 6 bots", () => {
    const base = { id: "g1", ownerId: "u1", taskId: "t1", createdAt: now };
    expect(Group.safeParse({ ...base, botIds: [] }).success).toBe(false);
    expect(Group.safeParse({ ...base, botIds: ["b1", "b2", "b3", "b4", "b5", "b6", "b7"] }).success).toBe(false);
    expect(Group.safeParse({ ...base, botIds: ["b1"] }).success).toBe(true);
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
      status: "active",
    };
    expect(TopicTask.safeParse({ ...task, number: "T-2481" }).success).toBe(true);
    expect(TopicTask.safeParse({ ...task, number: "2481" }).success).toBe(false);
  });

  it("a bot hue must be one of the seven design-system hues", () => {
    const bot = { id: "b1", ownerId: "u1", name: "小服", createdAt: now };
    expect(Bot.safeParse({ ...bot, hue: "mint" }).success).toBe(true);
    expect(Bot.safeParse({ ...bot, hue: "red" }).success).toBe(false);
  });

  it("message body is discriminated by kind", () => {
    const msg = { id: "m1", groupId: "g1", createdAt: now };
    expect(Message.safeParse({ ...msg, body: { kind: "user", text: "hi" } }).success).toBe(true);
    expect(Message.safeParse({ ...msg, body: { kind: "bot", text: "hi" } }).success).toBe(false);
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
      text: "hi",
      origin: { kind: "user" },
      group: { id: "g1", number: "", title: "", kind: "solo" },
      context: [],
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
      text: "x",
      origin: { kind: "user" },
      group: { id: "g1", number: "", title: "", kind: "solo" },
      context: [],
      task: null,
      members: [],
    };
    expect(ControlToAgent.safeParse(prompt).success).toBe(true);
    expect(ControlToAgent.safeParse({ ...prompt, handoffId: "h1" }).success).toBe(true);
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

describe("M11 用量与昨夜进展的共享形状", () => {
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

  it("昨夜进展只有三种状态，since 从没连过是 null", () => {
    const item = { botId: "b1", groupId: "g1", text: "3 家供应商报价齐了", status: "done", at: now };
    expect(OvernightResponse.safeParse({ since: null, items: [] }).success).toBe(true);
    expect(OvernightResponse.safeParse({ since: now, items: [item] }).success).toBe(true);
    expect(OvernightResponse.safeParse({ since: now, items: [{ ...item, status: "pending" }] }).success).toBe(false);
    expect(OvernightResponse.safeParse({ since: now, items: Array.from({ length: 11 }, () => item) }).success).toBe(
      false,
    );
  });
});
