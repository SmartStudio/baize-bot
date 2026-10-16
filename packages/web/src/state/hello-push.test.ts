import { Bot, Group, Message, TopicTask } from "@baize/shared";
import { describe, expect, it } from "vitest";
import { createPushHandlers, dispatchServerPush } from "./push.js";
import { reduce } from "./reducer.js";
import type { Seq } from "./stamped.js";
import type { Action, AppState, ReadyState, SessionId } from "./types.js";

const session = 1 as SessionId;
const at = "2026-09-27T00:00:00.000Z";

const assistant = Bot.parse({
  id: "bot_assistant",
  ownerId: "user_me",
  role: "assistant",
  name: "主助理",
  tags: [],
  description: "",
  hue: "sky",
  notify: true,
  toolConnectionIds: [],
  runState: "running",
  createdAt: at,
});
const solo = Group.parse({
  id: "group_assistant",
  ownerId: "user_me",
  kind: "solo",
  botIds: [assistant.id],
  taskId: "task_assistant",
  chiefBotId: null,
  createdAt: at,
});
const taskOf = (group: Group) =>
  TopicTask.parse({
    id: group.taskId,
    groupId: group.id,
    number: "T-0001",
    title: "主助理",
    summary: "",
    cadence: "",
    dueAt: null,
    checklist: [],
    currentBotId: null,
    handled: [],
    status: "active",
    goal: null,
    metricSource: null,
    metric: null,
  });
const greeting = Message.parse({
  id: "message_greeting",
  groupId: solo.id,
  body: { kind: "bot", botId: assistant.id, text: "想让我帮你做成什么事？说一句就行", streaming: false },
  createdAt: at,
  revision: 0,
  visibleTo: null,
});

// 老用户会话一直有效、登录时没补上主助理：首页打开时 bots 和 groups 都是空的。
const opened = () => {
  let state = reduce({ status: "loading" }, {
    type: "ready",
    session,
    user: { id: "user_me", email: "me@baize.dev", name: "我" },
    bots: [],
    groups: [],
    tools: [],
    settings: {},
    usage: {},
  } as unknown as Action);
  const ref = { current: state };
  const handlers = createPushHandlers({
    session,
    live: () => true,
    dispatch: (action) => {
      state = reduce(state, action);
      ref.current = state;
    },
    stateRef: ref,
    refreshPendingCounts: () => undefined,
    recoverLogins: () => undefined,
    reloadChoices: () => undefined,
  });
  let seq = 0;
  return {
    push: (push: Parameters<typeof dispatchServerPush>[1]) => dispatchServerPush(handlers, push, ++seq as Seq),
    state: (): ReadyState => {
      const current: AppState = state;
      if (current.status !== "ready") throw new Error("应当已进入 ready");
      return current;
    },
  };
};

describe("电脑 hello 补建主助理的三条推送", () => {
  it("单聊群按单聊入列，首页的今天快照要重拉", () => {
    const page = opened();
    page.push({ type: "bot_updated", bot: assistant });
    page.push({ type: "group_created", group: solo, task: taskOf(solo) });
    page.push({ type: "message", message: greeting });

    expect(page.state().conversations, "补建的是主助理的单聊，不是项目").toEqual([
      expect.objectContaining({ kind: "solo", groupId: solo.id, botId: assistant.id }),
    ]);
    expect(
      page.state().todayVersion,
      "today 快照里 assistantGroupId 还是 null，得重拉才能解除输入框禁用",
    ).toBeGreaterThan(0);
  });

  it("多 Bot 群和有首席的项目群仍按项目入列", () => {
    const page = opened();
    const team = Group.parse({
      ...solo,
      kind: "team",
      id: "group_team",
      botIds: ["bot_a", "bot_b"],
      taskId: "task_team",
    });
    const project = Group.parse({
      ...solo,
      kind: "team",
      id: "group_project",
      botIds: [assistant.id],
      taskId: "task_project",
      chiefBotId: assistant.id,
    });
    page.push({ type: "group_created", group: team, task: taskOf(team) });
    page.push({ type: "group_created", group: project, task: taskOf(project) });

    expect(page.state().conversations.map((c) => [c.groupId, c.kind])).toEqual([
      [team.id, "team"],
      [project.id, "team"],
    ]);
  });

  it("只到了 group_created、第一句还在路上，也已经要重拉", () => {
    const page = opened();
    page.push({ type: "bot_updated", bot: assistant });
    page.push({ type: "group_created", group: solo, task: taskOf(solo) });

    expect(page.state().todayVersion).toBeGreaterThan(0);
  });
});

describe("首页的主助理最近一句跟着单聊走", () => {
  const joined = () => {
    const page = opened();
    page.push({ type: "bot_updated", bot: assistant });
    page.push({ type: "group_created", group: solo, task: taskOf(solo) });
    return { ...page, before: page.state().todayVersion };
  };
  const said = (text: string, streaming: boolean, id = "message_next") =>
    Message.parse({ ...greeting, id, body: { ...greeting.body, text, streaming } });

  it("主助理说完一句，重拉 today", () => {
    const page = joined();
    page.push({ type: "message", message: said("好，我排进本周计划", false) });
    expect(page.state().todayVersion).toBeGreaterThan(page.before);
  });

  it("流式的半句不重拉，流收尾时重拉", () => {
    const page = joined();
    const next = said("好，我", true);
    page.push({ type: "message", message: next });
    page.push({
      type: "message_delta",
      groupId: solo.id,
      messageId: next.id,
      delta: "排进",
      done: false,
      revision: 1,
      visibleTo: null,
    });
    expect(page.state().todayVersion, "半句不是最近一句").toBe(page.before);
    page.push({
      type: "message_delta",
      groupId: solo.id,
      messageId: next.id,
      delta: "计划",
      done: true,
      revision: 2,
      visibleTo: null,
    });
    expect(page.state().todayVersion).toBeGreaterThan(page.before);
  });

  it("队员单聊里的话不碰首页", () => {
    const page = joined();
    const member = Bot.parse({ ...assistant, id: "bot_member", role: "member", name: "小销" });
    const memberChat = Group.parse({ ...solo, id: "group_member", botIds: [member.id], taskId: "task_member" });
    page.push({ type: "bot_updated", bot: member });
    page.push({ type: "group_created", group: memberChat, task: taskOf(memberChat) });
    const before = page.state().todayVersion;
    page.push({
      type: "message",
      message: Message.parse({
        ...said("收到", false),
        groupId: memberChat.id,
        body: { ...greeting.body, botId: member.id },
      }),
    });
    expect(page.state().todayVersion).toBe(before);
  });
});
