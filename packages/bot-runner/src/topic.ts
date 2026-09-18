import { AgentToControl, BotId, ChecklistItem, type ControlToAgent, type TopicTask } from "@baize/shared";
import { type Static, Type } from "typebox";
import { z } from "zod";
import type { RunnerTool } from "./bot-session.js";
import type { RunIdentity } from "./reporter.js";

// 主题任务工具。Bot 靠它读任务卡、改清单、@ 群里别的 Bot。
// 错误一律 throw：pi-agent-core 的 agent-loop 在 catch 里把 error.message 做成 isError 的工具结果，
// 运行器的 reporter 据此把 bot_tool_call 记成 failed。返回一条带错误字样的正常结果只会被记成 ok。

type PromptMessage = Extract<ControlToAgent, { type: "prompt" }>;

export type GroupMember = PromptMessage["members"][number];

/** 工具执行时手头要有的东西：这次运行的身份，加这次 prompt 的任务卡与成员名单。 */
export interface ActiveRun {
  readonly run: RunIdentity;
  readonly task: PromptMessage["task"];
  readonly members: readonly GroupMember[];
}

const NO_SUMMARY = "无";
const NO_DUE = "不限";
const NO_OWNER = "未指派";
const EMPTY = "（空）";

/**
 * 任务卡的文本形式。全函数：每个字段都出现一行，空值走固定占位词，不按字段有无分支。
 * 模型看到的行数因此是固定的，「这行没出现」和「这个字段是空的」不会混起来。
 * prompt 的第一段和 read_task 的返回共用这一份，两边看到的卡片不会飘。
 */
export function renderTaskCard(task: TopicTask, members: readonly GroupMember[]): string {
  // 名单里没有的 id 原样渲染：丢了它就查不出是谁，而成员名单是可能滞后于任务卡的。
  const nameOf = (id: BotId): string => members.find((member) => member.id === id)?.name ?? id;
  const checklist =
    task.checklist.length === 0
      ? [EMPTY]
      : task.checklist.map(
          (item, index) =>
            `${index + 1}. [${item.done ? "x" : " "}] ${item.text}（经手：${
              item.ownerBotId === null ? NO_OWNER : nameOf(item.ownerBotId)
            }）`,
        );

  return [
    `${task.number} ${task.title}`,
    `说明：${task.summary === "" ? NO_SUMMARY : task.summary}`,
    `截止：${task.dueAt ?? NO_DUE}`,
    `当前经手：${task.currentBotId === null ? NO_OWNER : nameOf(task.currentBotId)}`,
    `群成员：${members.length === 0 ? EMPTY : members.map((member) => member.name).join("、")}`,
    "清单：",
    ...checklist,
  ].join("\n");
}

const UPDATE_CHECKLIST_PARAMS = Type.Object({
  items: Type.Array(
    Type.Object({ text: Type.String(), done: Type.Boolean(), ownerBotId: Type.Optional(Type.String()) }),
    { maxItems: 50 },
  ),
});

const MENTION_PARAMS = Type.Object({ name: Type.String(), text: Type.String() });

const Checklist = z.array(ChecklistItem).max(50);

/**
 * 把模型写的经手解析成 BotId。卡片上经手渲染的是名字，所以名字是主路；名单外的 id 卡片上原样
 * 渲染，模型读一遍改一条再整份写回来时会原样抄回来，这种也得认。两样都不是就抛：BotId 只是个
 * 带牌子的字符串，模型猜的名字照样过得了 schema，放过去就是一条形状合法的脏数据发到控制面。
 */
function ownerResolver(active: ActiveRun): (written: string | undefined) => BotId | null {
  const idByName = new Map(active.members.map((member) => [member.name, member.id]));
  const idsOnCard = new Set<string>([
    ...active.members.map((member) => member.id),
    ...(active.task?.checklist ?? []).flatMap((item) => (item.ownerBotId === null ? [] : [item.ownerBotId])),
  ]);

  return (written) => {
    if (written === undefined) return null;
    const named = idByName.get(written);
    if (named !== undefined) return named;
    if (idsOnCard.has(written)) return BotId.parse(written);
    throw new Error(`清单里的经手「${written}」不在这个群里。经手写群成员的名字：${[...idByName.keys()].join("、")}`);
  };
}

const resultText = (body: string): Awaited<ReturnType<RunnerTool["execute"]>> => ({
  content: [{ type: "text", text: body }],
  details: {},
});

export function createTopicTools(options: {
  readonly activeRun: () => ActiveRun | null;
  readonly send: (message: AgentToControl) => void;
}): readonly RunnerTool[] {
  const activeOrThrow = (action: string): ActiveRun => {
    const active = options.activeRun();
    if (active === null) throw new Error(`这次工具调用不属于任何一次运行，没法${action}。`);
    return active;
  };

  const push = (message: AgentToControl): void => {
    options.send(AgentToControl.parse(message));
  };

  return [
    {
      name: "read_task",
      label: "看任务卡",
      description: "读这个群的主题任务卡：编号、标题、说明、截止、当前经手、群成员和清单。",
      parameters: Type.Object({}),
      execute: async () => {
        const active = activeOrThrow("读任务卡");
        if (active.task === null) return resultText("这个群没有任务卡");
        return resultText(renderTaskCard(active.task, active.members));
      },
    },
    {
      name: "update_checklist",
      label: "改清单",
      description: "整份替换任务卡的清单。每条给文字、做没做完、经手的 Bot（写群成员名单里的名字，不给就是未指派）。",
      parameters: UPDATE_CHECKLIST_PARAMS,
      execute: async (_callId, params) => {
        const active = activeOrThrow("改清单");
        const { items } = params as Static<typeof UPDATE_CHECKLIST_PARAMS>;
        const ownerOf = ownerResolver(active);
        // 协议里 ownerBotId 是可空不是可省，缺省在这个边界上补成 null，往里一律是定好的形状。
        const checklist = Checklist.parse(
          items.map((item) => ({ text: item.text, done: item.done, ownerBotId: ownerOf(item.ownerBotId) })),
        );
        push({
          type: "task_checklist",
          runId: active.run.runId,
          botId: active.run.botId,
          groupId: active.run.groupId,
          checklist,
        });
        return resultText(`清单已更新，${checklist.filter((item) => item.done).length}/${checklist.length} 完成`);
      },
    },
    {
      name: "mention_bot",
      label: "@ 队友",
      description: "在群里 @ 另一个 Bot，把活交给它看。名字要和群成员名单里的完全一样。",
      parameters: MENTION_PARAMS,
      execute: async (_callId, params) => {
        const active = activeOrThrow("@ 队友");
        const { name, text: body } = params as Static<typeof MENTION_PARAMS>;
        const target = active.members.find((member) => member.name === name);
        if (target === undefined) {
          const others = active.members.filter((member) => member.id !== active.run.botId).map((m) => m.name);
          const hint = others.length === 0 ? "群里只有你自己。" : `可以 @ 的是：${others.join("、")}`;
          throw new Error(`群里没有叫「${name}」的 Bot。${hint}`);
        }
        if (target.id === active.run.botId) throw new Error("不能 @ 自己。");
        push({
          type: "mention",
          runId: active.run.runId,
          botId: active.run.botId,
          groupId: active.run.groupId,
          targetBotId: target.id,
          text: body,
        });
        return resultText(`已经在群里 @ 了 ${target.name}。`);
      },
    },
  ];
}
