import type { ControlToAgent, ToolView } from "@baize/shared";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { ACCOUNT_READ_TOOL } from "./account-read.js";
import { resultText } from "./assistant.js";
import { createEphemeralSession, type PiSettings, type RunnerTool, type SessionGate } from "./bot-session.js";

// 临时帮手（D6）：主助理随拉随散，不建 Bot 行、不进团队页、不留记忆。
// 一次 call_helper 起一个只在内存里的 Pi 会话，跑完把最后一段话当工具结果交回主助理，会话随即丢弃。

export const HELPER_TOOL = "call_helper";

/** 浏览器只给读的两件：打开和读页面。截图归读但对资料员没用，点和填会替用户留下动作。 */
const HELPER_BROWSER_TOOLS: ReadonlySet<string> = new Set(["browser_open", "browser_snapshot"]);

const HELPERS = {
  researcher: {
    name: "资料员",
    rule: "你只查资料，不动手：用 read 读工作目录里的文件，用 account_read 读 GitHub、X，有浏览器时用 browser_open、browser_snapshot 看网页。查完写一段结论，先给结论再给出处，查不到就直说查不到。",
  },
  translator: {
    name: "翻译",
    rule: "你只做翻译：按交代把文字译成要的语言，原文在文件里就用 read 读。只回译文，不加评论。",
  },
} as const;

type HelperKind = keyof typeof HELPERS;

const CALL_HELPER_PARAMS = Type.Object({
  kind: Type.Union([Type.Literal("researcher"), Type.Literal("translator")]),
  task: Type.String(),
});

const TASK_VIEW_LIMIT = 200;

/** 工具行上的「拉临时帮手：资料员」。参数不认得时按资料员摆，不让一条工具行把上行报文弄坏。 */
export function helperToolView(args: unknown, status: Extract<ToolView, { kind: "helper" }>["status"]): ToolView {
  const object =
    typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const kind: HelperKind = object.kind === "translator" ? "translator" : "researcher";
  const task = typeof object.task === "string" ? object.task.slice(0, TASK_VIEW_LIMIT) : "";
  return {
    kind: "helper",
    name: HELPERS[kind].name,
    task,
    status,
    ...(args === undefined ? {} : { raw: args as ToolView["raw"] }),
  };
}

/** 建帮手会话那一刻要的东西。网关和工具按调用时读，主助理换了 key 帮手跟着用新的。 */
export interface HelperContext {
  readonly agentDir: string;
  readonly workDir: string;
  readonly gateway: () => Extract<ControlToAgent, { type: "config" }>["modelGateway"];
  readonly settings: PiSettings | undefined;
  /** 主助理手上的工具。帮手只挑 account_read 和浏览器的读页两件。 */
  readonly tools: () => readonly RunnerTool[];
  readonly gate: SessionGate;
}

const lastAssistant = (session: AgentSession) => session.messages.findLast((message) => message.role === "assistant");

/** 主助理专属，index.ts 只在 role = assistant 时挂它。 */
export function createHelperTools(context: HelperContext): readonly RunnerTool[] {
  return [
    {
      name: HELPER_TOOL,
      label: "拉临时帮手",
      description:
        "拉一个临时帮手替你干一件读类的小活，干完就散，不进团队，不记事。kind 写 researcher 是资料员（查文件、GitHub、X、网页），" +
        "写 translator 是翻译。task 写清要它干什么、交回什么，它看不到群里的对话，要用的上下文都写进 task。" +
        "帮手只能读，不能写文件、发东西、点网页；它交回的话就是这次的工具结果。",
      parameters: CALL_HELPER_PARAMS,
      execute: async (callId, params, signal) => {
        const parent = context.gate.activeRun();
        if (parent === null) throw new Error("这次工具调用不属于任何一次运行，没法拉帮手。");
        const { kind, task } = params as Static<typeof CALL_HELPER_PARAMS>;
        const helper = HELPERS[kind];
        if (task.trim() === "") throw new Error("帮手没拉成，改好再调：task 是空的，写清要它干什么。");

        // 帮手的工具调用 id 是它自己的模型起的，会和主助理的撞。审批按 callId 认，所以挂在这次 call_helper 的 id 下面；
        // 被拦的记号只给主会话的工具行定终态用，帮手的过程不进群，不记。
        const gate: SessionGate = {
          ...context.gate,
          activeRun: () => parent,
          laneFence: {
            headers: () => context.gate.laneFence.headers(parent.run.runId),
            beforeEffect: (_runId, helperCallId, action) =>
              context.gate.laneFence.beforeEffect(parent.run.runId, `${callId}/${helperCallId}`, action),
            toolSettled: (_runId, helperCallId) =>
              context.gate.laneFence.toolSettled(parent.run.runId, `${callId}/${helperCallId}`),
          },
          approvals: {
            ask: (request, askSignal) =>
              context.gate.approvals.ask({ ...request, callId: `${callId}/${request.callId}` }, askSignal),
            block: () => undefined,
          },
        };
        const session = await createEphemeralSession({
          agentDir: context.agentDir,
          workDir: context.workDir,
          gateway: context.gateway(),
          ...(context.settings === undefined ? {} : { settings: context.settings }),
          systemPrompt: `你是主助理临时拉来的帮手（${helper.name}），活干完就散。说中文。${helper.rule}`,
          builtIns: ["read"],
          tools: context
            .tools()
            .filter((tool) => tool.name === ACCOUNT_READ_TOOL || HELPER_BROWSER_TOOLS.has(tool.name)),
          gate,
        });
        const stop = (): void => {
          void session.abort();
        };
        signal?.addEventListener("abort", stop, { once: true });
        // 读成函数：prompt 等待期间 signal 会变，内联的判断会被类型收窄成「一定没中止」。
        const aborted = (): boolean => signal?.aborted === true;
        try {
          if (aborted()) throw new Error(`主助理已经停下，${helper.name}没开工。`);
          await session.prompt(task);
          if (aborted()) throw new Error(`主助理已经停下，${helper.name}的活没干完。`);
          const reply = lastAssistant(session);
          if (reply?.role === "assistant" && reply.stopReason === "error") {
            throw new Error(`${helper.name}没干完：${reply.errorMessage ?? "模型上游没回话"}`);
          }
          const text = session.getLastAssistantText()?.trim() ?? "";
          return resultText(text === "" ? `${helper.name}什么也没交回来。` : `${helper.name}交回来的：\n${text}`);
        } finally {
          signal?.removeEventListener("abort", stop);
          session.dispose();
        }
      },
    },
  ];
}
