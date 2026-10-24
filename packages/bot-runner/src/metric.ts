import { landReported, type AgentToControl, type ReportRefusal } from "@baize/shared";
import { type Static, Type } from "typebox";
import { parseOrThrow, resultText } from "./assistant.js";
import type { RunnerTool } from "./bot-session.js";
import type { ActiveRun } from "./topic.js";

// label 的长度范围不写进 schema，理由同 propose_skill：交给 AgentToControl 校验，再把 issue 翻成中文。
const REPORT_METRIC_PARAMS = Type.Object({ value: Type.Number(), label: Type.String() });

/**
 * 只能走浏览器读数的平台（小红书粉丝数这类）没有 API 可直读，Bot 在例行里读完用 report_metric 报上来，
 * 控制面落一条样本，任务卡上的当前值和本周变化随之更新。
 *
 * 只给项目群：单聊没有任务卡，报了也没有地方落。会话按群建、群的出身不变，建会话时那次 prompt 的
 * groupKind 就是整个会话的，所以在这里一次定下来，单聊的会话里工具名单里压根没有它。
 */
export function createMetricTools(options: {
  readonly activeRun: () => ActiveRun | null;
  readonly send: (message: AgentToControl) => void;
}): readonly RunnerTool[] {
  if (options.activeRun()?.groupKind !== "team") return [];

  return [
    {
      name: "report_metric",
      label: "报指标",
      description:
        "项目群里，你自己读到了项目要的那个数（比如在浏览器里看到的小红书粉丝数），用它把这个数报给项目。" +
        "value 是读到的当前值，label 是这个数的名字：任务卡上有「要报的数」就照那里的名字写，没有就写一个好认的名字，比如「小红书粉丝」。" +
        "报完任务卡上的进度和本周变化会跟着更新。只报你亲眼读到的数，读不到就别报。",
      parameters: REPORT_METRIC_PARAMS,
      execute: async (_callId, params) => {
        const active = options.activeRun();
        if (active === null) throw new Error("这次工具调用不属于任何一次运行，没法报指标。");
        const { value, label } = params as Static<typeof REPORT_METRIC_PARAMS>;
        const named = label.trim();
        if (named === "") {
          throw new Error("指标没发出去，改好再调：label 是这个数的名字，比如「小红书粉丝」，不能空。");
        }
        if (active.task !== null) {
          const landing = landReported(
            { sources: active.task.metricSources, goalMetric: active.task.goal?.metric ?? null },
            named,
          );
          if (landing.kind === "refused") throw new Error(refusalText(landing.reason));
        }
        options.send(
          parseOrThrow(
            {
              type: "metric_report",
              runId: active.run.runId,
              botId: active.run.botId,
              groupId: active.run.groupId,
              value,
              label: named,
            },
            "指标",
          ),
        );
        return resultText(`已上报：${named} ${value}。`);
      },
    },
  ];
}

function refusalText(reason: ReportRefusal): string {
  switch (reason.kind) {
    case "unknown_label":
      return `指标没发出去：这个项目要报的数是${reason.labels.map((label) => `「${label}」`).join("")}，label 照这个名字写，改好再调。`;
    case "polled_goal":
      return "指标没发出去：这个项目的目标对的是读数器读的数（GitHub 星数、X 粉丝数这类），这个数由读数器读，不用报。";
  }
}
