import {
  AgentToControl,
  BotId,
  ChecklistItem,
  type ControlToAgent,
  type HandoffId,
  type ProjectGoal,
  type TaskMetric,
  type TopicTask,
} from "@baize/shared";
import { type Static, Type } from "typebox";
import { z } from "zod";
import type { Project } from "./assistant.js";
import type { RunnerTool } from "./bot-session.js";
import type { RunIdentity } from "./reporter.js";

// 主题任务工具。Bot 靠它读任务卡、改清单、@ 群里别的 Bot、把活交接出去和接下别人的交接。
// 错误一律 throw：pi-agent-core 的 agent-loop 在 catch 里把 error.message 做成 isError 的工具结果，
// 运行器的 reporter 据此把 bot_tool_call 记成 failed。返回一条带错误字样的正常结果只会被记成 ok。

type PromptMessage = Extract<ControlToAgent, { type: "prompt" }>;

export type GroupMember = PromptMessage["members"][number];

/** 工具执行时手头要有的东西：这次运行的身份，加这次 prompt 的任务卡、成员名单和待接手的交接。 */
export interface ActiveRun {
  readonly run: RunIdentity;
  readonly groupKind: PromptMessage["group"]["kind"];
  readonly task: PromptMessage["task"];
  readonly members: readonly GroupMember[];
  /** 这次 prompt 是为了处理某份交接派来的才有值。 */
  readonly handoffId: HandoffId | undefined;
  /** 主助理手上的项目，set_cadence 只认这里面的。队员的 prompt 不带，是空的。 */
  readonly projects: readonly Project[];
  /** 这次 run 是不是例行触发的，是的话带这条例行的边界，复盘这类只该在例行里做的事也按它收放；用户当面派的是 null。 */
  readonly routine: PromptMessage["routine"];
}

const NO_SUMMARY = "无";
const NO_DUE = "不限";
const NO_OWNER = "未指派";
const EMPTY = "（空）";

// 名单里没有的 id 原样渲染：丢了它就查不出是谁，而成员名单是可能滞后于任务卡的。
const nameOf = (members: readonly GroupMember[], id: BotId): string =>
  members.find((member) => member.id === id)?.name ?? id;

// 两位小数以内原样写，浮点加减的尾巴（0.1 + 0.2）不进卡片。不乘 100 再 round：1.005 会丢掉进位，1e308 会溢出成 Infinity。
const TWO_DECIMALS = new Intl.NumberFormat("en-US", { useGrouping: false, maximumFractionDigits: 2 });

// 舍入成零的负数 Intl 写成 "-0"，卡片上只认 "0"。
const plain = (value: number): string => {
  const text = TWO_DECIMALS.format(value);
  return text === "-0" ? "0" : text;
};

const signed = (value: number): string => {
  const text = plain(value);
  return value > 0 && text !== "0" ? `+${text}` : text;
};

/**
 * 目标的两行：目标和期限，当前值 / 目标、还差多少、本周变化。没有目标一行都不出，这样没设目标的项目
 * 卡片和加这两行之前逐字相同；设了目标还没有样本，进度写「还没有数据」而不是 0，0 是一个真实的读数。
 */
function renderGoal(goal: ProjectGoal | null, metric: TaskMetric | null): string[] {
  if (goal === null) return [];
  const { target, unit } = goal;
  const head = `目标：${target} ${unit}，期限：${goal.dueAt ?? NO_DUE}`;
  if (metric === null) return [head, "进度：还没有数据"];
  const gap = target - metric.current;
  // 达成按真实差额判，显示再舍入。正差额舍入后是 0 就说不足一分，不能写「还差 0」让模型以为到了。
  const shown = plain(gap);
  const remaining = gap <= 0 ? "已达成" : shown === "0" ? "还差不足 0.01" : `还差 ${shown}`;
  return [head, `进度：${plain(metric.current)} / ${target} ${unit}，${remaining}，本周 ${signed(metric.weekDelta)}`];
}

/**
 * 任务卡的文本形式。全函数：每个字段都出现一行，空值走固定占位词，不按字段有无分支。
 * 模型看到的行数因此是固定的，「这行没出现」和「这个字段是空的」不会混起来。
 * prompt 的任务卡段和 read_task 的返回共用这一份，两边看到的卡片不会飘。
 */
export function renderTaskCard(task: TopicTask, members: readonly GroupMember[]): string {
  const checklist =
    task.checklist.length === 0
      ? [EMPTY]
      : task.checklist.map(
          (item, index) =>
            `${index + 1}. [${item.done ? "x" : " "}] ${item.text}（经手：${
              item.ownerBotId === null ? NO_OWNER : nameOf(members, item.ownerBotId)
            }）`,
        );

  // 描述常以句号收尾，再用顿号串起来就读成「先找我。、小采」，所以每人一行。
  const roster =
    members.length === 0
      ? [EMPTY]
      : members.map((member) => {
          const tags = [...member.tags, ...(member.seat === "chief" ? ["首席"] : [])];
          return `- ${member.name}${tags.length === 0 ? "" : `（${tags.join("，")}）`}${member.description === "" ? "" : `：${member.description}`}`;
        });

  return [
    `${task.number} ${task.title}`,
    `说明：${task.summary === "" ? NO_SUMMARY : task.summary}`,
    `截止：${task.dueAt ?? NO_DUE}`,
    // 节奏只有例行派来的主题才有，空着不出这一行，队员的 prompt 字节不变。
    ...(task.cadence === "" ? [] : [`节奏：${task.cadence}`]),
    ...renderGoal(task.goal, task.metric),
    `当前经手：${task.currentBotId === null ? NO_OWNER : nameOf(members, task.currentBotId)}`,
    "群成员：",
    ...roster,
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

const SET_CHIEF_PARAMS = Type.Object({ name: Type.Optional(Type.String()) });

const HANDOFF_PARAMS = Type.Object({
  to: Type.String(),
  done: Type.String(),
  notDone: Type.String(),
  next: Type.String(),
  // 范围不写进 schema：Pi 拿 schema 挡下的参数，模型收到的是一条 Validation 报错，看不出该写几。
  // 交给下面的范围检查统一报，0 和越界给的是同一句能照着改的话。
  checklistIndex: Type.Optional(Type.Integer()),
});

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

/**
 * 把模型写的名字解析成群里的另一个 Bot。错误文本把还能选的名字列出来，不然模型只能接着猜。
 * @ 和交接两处用同一条路，两边认的名字因此不会不一样。
 */
function otherMemberByName(active: ActiveRun, name: string, verb: string): GroupMember {
  const target = active.members.find((member) => member.name === name);
  if (target === undefined) {
    const others = active.members.filter((member) => member.id !== active.run.botId).map((member) => member.name);
    const hint = others.length === 0 ? "群里只有你自己。" : `可以${verb}的是：${others.join("、")}`;
    throw new Error(`群里没有叫「${name}」的 Bot。${hint}`);
  }
  if (target.id === active.run.botId) throw new Error(`不能${verb}自己。`);
  return target;
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
      description: "读这个群的主题任务卡：编号、标题、说明、截止、目标和进度（设了目标才有）、当前经手、群成员和清单。",
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
        const target = otherMemberByName(active, name, " @ ");
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
    {
      name: "set_chief",
      label: "设首席",
      description:
        "用户让你或让某个队友当首席时调，名字写群成员名单里的名字；用户让首席卸任时不传名字。只在多 Bot 群可用。",
      parameters: SET_CHIEF_PARAMS,
      execute: async (_callId, params) => {
        const active = activeOrThrow("设首席");
        if (active.members.length < 2) throw new Error("这是单聊，没有首席可设");
        const { name } = params as Static<typeof SET_CHIEF_PARAMS>;
        const target = name === undefined ? null : active.members.find((member) => member.name === name);
        if (target === undefined) {
          throw new Error(
            `群里没有叫「${name}」的 Bot。可以设为首席的是：${active.members.map((member) => member.name).join("、")}`,
          );
        }
        push({
          type: "set_chief",
          runId: active.run.runId,
          botId: active.run.botId,
          groupId: active.run.groupId,
          targetBotId: target?.id ?? null,
        });
        return resultText(target === null ? "已请求卸任首席。" : `已请求将${target.name}设为首席。`);
      },
    },
    {
      name: "handoff_task",
      label: "交接",
      description:
        "把这个任务交给群里另一个 Bot。要写清做了什么、没做什么、下一步从哪接，还可以指到清单的某一条，写任务卡上那条前面的序号。只有当前经手能交接，对方确认之后它才是当前经手。",
      parameters: HANDOFF_PARAMS,
      execute: async (_callId, params) => {
        const active = activeOrThrow("交接");
        const { to, done, notDone, next, checklistIndex } = params as Static<typeof HANDOFF_PARAMS>;
        const task = active.task;
        if (task === null) throw new Error("这个群没有任务卡，没有任务卡就没有可交接的活。");
        if (task.currentBotId !== active.run.botId) {
          const holder = task.currentBotId === null ? NO_OWNER : nameOf(active.members, task.currentBotId);
          throw new Error(`当前经手是${holder}，不是你。只有当前经手能把活交出去。`);
        }
        const target = otherMemberByName(active, to, "交接给");
        // 卡片上清单从 1 编号，模型照卡片写；协议里的 checklistIndex 是下标，从 0 起。在这个边界
        // 上换算并卡住范围：越界的指针进了报文，接手的 Bot 拿到的就是一条指向不存在清单项的交接。
        if (checklistIndex !== undefined && (checklistIndex < 1 || checklistIndex > task.checklist.length)) {
          throw new Error(`清单一共 ${task.checklist.length} 条，没有第 ${checklistIndex} 条。`);
        }
        push({
          type: "handoff",
          runId: active.run.runId,
          botId: active.run.botId,
          groupId: active.run.groupId,
          toBotId: target.id,
          done,
          notDone,
          next,
          checklistIndex: checklistIndex === undefined ? null : checklistIndex - 1,
        });
        return resultText(`已发交接报文给${target.name}，等它确认。`);
      },
    },
    {
      name: "accept_handoff",
      label: "接手",
      description:
        "确认接下别人交给你的这份活。只有这次是为了让你处理一份交接派来的时候才用得上，接手之后你就是当前经手。",
      parameters: Type.Object({}),
      execute: async () => {
        const active = activeOrThrow("接手");
        const handoffId = active.handoffId;
        if (handoffId === undefined) throw new Error("这次没有要你接手的交接，用不上 accept_handoff。");
        push({
          type: "handoff_accept",
          runId: active.run.runId,
          botId: active.run.botId,
          groupId: active.run.groupId,
          handoffId,
        });
        return resultText("已确认接手，你现在是当前经手。");
      },
    },
  ];
}
