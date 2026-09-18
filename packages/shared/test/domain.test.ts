import { describe, expect, it } from "vitest";
import { Bot, Group, Message, TopicTask } from "../src/index.js";

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
