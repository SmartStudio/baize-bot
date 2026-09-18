import { describe, expect, it } from "vitest";
import {
  AgentToControl,
  Bot,
  ControlToAgent,
  CreateGroupRequest,
  Group,
  Handoff,
  Message,
  TopicTask,
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
    const prompt = { type: "prompt", runId: "r1", botId: "b1", groupId: "g1", text: "hi", context: [], members: [] };
    expect(ControlToAgent.safeParse(prompt).success).toBe(false);
    expect(ControlToAgent.safeParse({ ...prompt, task: null }).success).toBe(true);
  });

  it("交接报文的 handoff_accept 必须带 handoffId，prompt 的 handoffId 可省", () => {
    const run = { runId: "r1", botId: "b1", groupId: "g1" };
    expect(AgentToControl.safeParse({ type: "handoff_accept", ...run, handoffId: "h1" }).success).toBe(true);
    expect(AgentToControl.safeParse({ type: "handoff_accept", ...run }).success).toBe(false);
    const prompt = { type: "prompt", ...run, text: "x", context: [], task: null, members: [] };
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
