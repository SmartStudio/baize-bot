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
  tag: "",
  description: "",
  hue: "sky",
  notify: true,
  toolConnectionIds: [],
  runState: "running",
  createdAt: at,
});
const member = Bot.parse({ ...assistant, id: "bot_member", role: "member", name: "小销" });
const memberChat = Group.parse({
  id: "group_member",
  ownerId: "user_me",
  kind: "solo",
  botIds: [member.id],
  taskId: "task_member",
  chiefBotId: null,
  createdAt: at,
});
const project = Group.parse({
  id: "group_project",
  ownerId: "user_me",
  kind: "team",
  botIds: [assistant.id, member.id],
  taskId: "task_project",
  chiefBotId: assistant.id,
  createdAt: at,
});
const taskOf = (group: Group) =>
  TopicTask.parse({
    id: group.taskId,
    groupId: group.id,
    number: "T-0001",
    title: group.id,
    summary: "",
    cadence: "",
    dueAt: null,
    checklist: [],
    currentBotId: null,
    handled: [],
    status: "active",
  });

const created = { type: "bot_created", bot: member, groupId: memberChat.id } as const;
const projectCreated = { type: "group_created", group: project, task: taskOf(project) } as const;

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

const snapshot = (state: ReadyState) => ({
  bots: state.bots,
  conversations: [...state.conversations].sort((a, b) => a.groupId.localeCompare(b.groupId)),
});

describe("项目开始后新队员的 bot_created 推送", () => {
  it("收到 bot_created 后队员的单聊入列，群 id 取推送里带的，不用再拉 Bot 列表", () => {
    const page = opened();
    page.push(created);

    expect(page.state().bots[member.id]).toEqual(member);
    expect(page.state().conversations).toEqual([
      expect.objectContaining({ kind: "solo", botId: member.id, groupId: memberChat.id }),
    ]);
  });

  it("同一条推送重复到达是幂等的：不重复入列，已有的历史和角标也不被冲掉", () => {
    const page = opened();
    page.push({ type: "group_created", group: memberChat, task: taskOf(memberChat) });
    page.push({
      type: "message",
      message: Message.parse({
        id: "message_history",
        groupId: memberChat.id,
        body: { kind: "bot", botId: member.id, text: "原有历史", streaming: false },
        createdAt: at,
      }),
    });
    const before = page.state().conversations;

    page.push(created);
    const once = snapshot(page.state());
    page.push(created);

    expect(page.state().conversations, "群已在列，bot_created 不动会话").toEqual(before);
    expect(snapshot(page.state())).toEqual(once);
  });

  it("Bot 已经在、单聊没入列时补一个；重放不重复", () => {
    const page = opened();
    page.push({ type: "bot_updated", bot: member });
    page.push(created);
    page.push(created);

    expect(page.state().conversations).toHaveLength(1);
  });

  it("推送和开始回包里的团队群，不论先后顺序，业务状态相同", () => {
    const events = [created, projectCreated, projectCreated];
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    const outputs = orders.map((order) => {
      const page = opened();
      for (const index of order) page.push(events[index]!);
      return snapshot(page.state());
    });

    for (const output of outputs) expect(output).toEqual(outputs[0]);
    expect(outputs[0]?.conversations).toHaveLength(2);
  });
});
