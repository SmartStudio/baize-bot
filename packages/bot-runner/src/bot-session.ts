import type { BotId, ControlToAgent } from "@baize/shared";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { TSchema } from "typebox";
import type { ApprovalGate } from "./approvals.js";
import type { BotDirs } from "./paths.js";
import { PROPOSE_SKILL_RULE } from "./skills.js";
import type { ActiveRun } from "./topic.js";

// 一个 Bot 一个 AgentSession，自带 ModelRuntime、cwd、会话目录，进程里同时跑多个时不共享可变状态。

export const GATEWAY_PROVIDER_ID = "baize-gateway";

/** 工具的注册点。`src/topic.ts`、`src/skills.ts` 那两组和 `src/mcp-tools.ts` 的工具连接由 createRunner 拼进来，桌面操作还没做。 */
export type RunnerTool = ToolDefinition<TSchema>;

export type PiSettings = Parameters<typeof SettingsManager.inMemory>[0];

export interface BotSessionOptions {
  readonly botId: BotId;
  /** Bot 的描述，也是它的边界。进系统提示，排在存 skill 的规则前面。空串就不占一段。 */
  readonly description: string;
  readonly dirs: BotDirs;
  readonly gateway: Extract<ControlToAgent, { type: "config" }>["modelGateway"];
  readonly tools: readonly RunnerTool[];
  readonly needsApproval: (toolName: string) => boolean;
  readonly approvals: ApprovalGate;
  /** 工具调用发生时读。这里只用 active.run 送审批，放宽到整个上下文是为了和主题任务工具共用同一个访问器。 */
  readonly activeRun: () => ActiveRun | null;
  readonly settings?: PiSettings;
}

export interface BotSession {
  readonly session: AgentSession;
  readonly sessionFile: string | undefined;
  dispose(): Promise<void>;
}

function botExtension(options: BotSessionOptions): (pi: ExtensionAPI) => void {
  return (pi) => {
    for (const tool of options.tools) pi.registerTool(tool);

    pi.on("tool_call", async (event) => {
      if (!options.needsApproval(event.toolName)) return undefined;
      const active = options.activeRun();
      // 没有运行在身就没人能批。放行等于绕开审批，一律拦下。
      if (active === null) return { block: true, reason: "这次工具调用不属于任何一次运行，没法送审批。" };
      const approved = await options.approvals.ask({
        runId: active.run.runId,
        botId: active.run.botId,
        groupId: active.run.groupId,
        callId: event.toolCallId,
        tool: event.toolName,
        summary: JSON.stringify(event.input),
      });
      return approved ? undefined : { block: true, reason: "归属人拒绝了这个动作。" };
    });
  };
}

export async function createBotSession(options: BotSessionOptions): Promise<BotSession> {
  const { agentDir, sessionDir, workDir, skillsDir } = options.dirs;

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });

  modelRuntime.registerProvider(GATEWAY_PROVIDER_ID, {
    name: "白泽模型网关",
    baseUrl: options.gateway.baseUrl,
    apiKey: options.gateway.apiKey,
    api: "openai-completions",
    models: [
      {
        id: options.gateway.model,
        name: options.gateway.model,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      },
    ],
  });

  const model = modelRuntime.getModel(GATEWAY_PROVIDER_ID, options.gateway.model);
  if (!model) throw new Error(`网关供应商没注册上：${GATEWAY_PROVIDER_ID}/${options.gateway.model}`);

  const settingsManager = SettingsManager.inMemory(options.settings);
  const resourceLoader = new DefaultResourceLoader({
    cwd: workDir,
    agentDir,
    settingsManager,
    // noSkills 只关掉 Pi 默认的那两处（agentDir/skills、cwd/.pi/skills），additionalSkillPaths 照收不误
    // （`core/resource-loader.js` 的 mergePaths）。不选 skillsOverride 的理由见 README 的 skill 一节。
    noSkills: true,
    additionalSkillPaths: [skillsDir],
    appendSystemPrompt: [
      ...(options.description === "" ? [] : [`你的描述，也是你的边界：${options.description}`]),
      PROPOSE_SKILL_RULE,
    ],
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [botExtension(options)],
  });
  await resourceLoader.reload();

  // 不传 noTools，Pi 的四个内置工具（read、bash、edit、write）就是开的。Bot 在云电脑上干活靠它们，
  // 关掉的话「看看电脑里有哪些文件」这类活一件也做不了。作用范围是这个 Bot 自己的 work 目录。
  const { session } = await createAgentSession({
    cwd: workDir,
    agentDir,
    model,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.create(workDir, sessionDir),
  });

  return {
    session,
    sessionFile: session.sessionManager.getSessionFile(),
    dispose: async () => session.dispose(),
  };
}
