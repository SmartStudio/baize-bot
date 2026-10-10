import type { AgentToControl } from "@baize/shared";
import { type Static, Type } from "typebox";
import { parseOrThrow, resultText } from "./assistant.js";
import type { RunnerTool } from "./bot-session.js";
import type { ActiveRun } from "./topic.js";

// body 的长度范围不写进 schema，理由同 report_metric：交给 AgentToControl 校验，再把 issue 翻成中文。
const SUBMIT_REVIEW_PARAMS = Type.Object({ body: Type.String() });

const SUBMIT_REVIEW = "submit_review";

/**
 * 主助理在项目群的例行（周五复盘）里把整份复盘交上去，控制面落进项目页的「成果」，同一周再交覆盖。
 *
 * 只给项目群：单聊没有项目页。群的出身随会话定，这一层在建会话时定下。是不是例行却是按次的，
 * 同一个项目群的会话里既有例行也有当面聊天，所以每次请求前按这次 run 收放声明：当面聊天时模型看不到它，
 * 不会把一句闲聊交成本周复盘、顶掉周五那份。
 */
export function createReviewTools(options: {
  readonly groupKind: ActiveRun["groupKind"];
  readonly activeRun: () => ActiveRun | null;
  readonly send: (message: AgentToControl) => void;
}): readonly RunnerTool[] {
  if (options.groupKind !== "team") return [];

  return [
    {
      name: SUBMIT_REVIEW,
      label: "交复盘",
      description:
        "项目群的例行复盘里，复盘写完了用它把整份复盘交上去，进项目页的「成果」。" +
        "body 是复盘全文：做成了哪些、没做成哪些和原因、数字的变化、下周最该改的一条。同一周再交会顶掉上一份。",
      parameters: SUBMIT_REVIEW_PARAMS,
      prepareLoadout: () =>
        (options.activeRun()?.routine ?? null) === null ? { hiddenDeclarations: [SUBMIT_REVIEW] } : undefined,
      execute: async (_callId, params) => {
        const active = options.activeRun();
        if (active === null) throw new Error("这次工具调用不属于任何一次运行，没法交复盘。");
        if (active.routine === null) throw new Error("复盘只在例行里交。当面聊的复盘直接回在群里就行。");
        const { body } = params as Static<typeof SUBMIT_REVIEW_PARAMS>;
        if (body.trim() === "") throw new Error("复盘没交上去，改好再调：body 是复盘全文，不能空。");
        options.send(
          parseOrThrow(
            {
              type: "review_submit",
              runId: active.run.runId,
              botId: active.run.botId,
              groupId: active.run.groupId,
              body,
            },
            "复盘",
          ),
        );
        return resultText("复盘已交，会出现在项目页的「成果」里。");
      },
    },
  ];
}
