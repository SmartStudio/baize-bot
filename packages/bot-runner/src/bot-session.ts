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
import type { RunIdentity } from "./reporter.js";

// 一个 Bot 一个 AgentSession，自带 ModelRuntime、cwd、会话目录，进程里同时跑多个时不共享可变状态。

export const GATEWAY_PROVIDER_ID = "baize-gateway";

/** 扩展工具的注册点。桌面操作、MCP 桥接、主题任务、存 skill 以后都从这里进来。 */
export type RunnerTool = ToolDefinition<TSchema>;

export type PiSettings = Parameters<typeof SettingsManager.inMemory>[0];

export interface BotSessionOptions {
  readonly botId: BotId;
  readonly dirs: BotDirs;
  readonly gateway: Extract<ControlToAgent, { type: "config" }>["modelGateway"];
  readonly tools: readonly RunnerTool[];
  readonly needsApproval: (toolName: string) => boolean;
  readonly approvals: ApprovalGate;
  /** 工具调用发生时读，用来把审批挂到当前这一次运行上。 */
  readonly activeRun: () => RunIdentity | null;
  readonly settings?: PiSettings;
}

export interface BotSession {
  readonly session: AgentSession;
  readonly sessionFile: string | undefined;
  dispose(): void;
}

function botExtension(options: BotSessionOptions): (pi: ExtensionAPI) => void {
  return (pi) => {
    for (const tool of options.tools) pi.registerTool(tool);

    pi.on("tool_call", async (event) => {
      if (!options.needsApproval(event.toolName)) return undefined;
      const run = options.activeRun();
      // 没有运行在身就没人能批。放行等于绕开审批，一律拦下。
      if (run === null) return { block: true, reason: "这次工具调用不属于任何一次运行，没法送审批。" };
      const approved = await options.approvals.ask({
        runId: run.runId,
        botId: run.botId,
        groupId: run.groupId,
        callId: event.toolCallId,
        tool: event.toolName,
        summary: JSON.stringify(event.input),
      });
      return approved ? undefined : { block: true, reason: "归属人拒绝了这个动作。" };
    });
  };
}

export async function createBotSession(options: BotSessionOptions): Promise<BotSession> {
  const { agentDir, sessionDir, workDir } = options.dirs;

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
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [botExtension(options)],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: workDir,
    agentDir,
    model,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.create(workDir, sessionDir),
    noTools: "builtin",
  });

  return {
    session,
    sessionFile: session.sessionManager.getSessionFile(),
    dispose: () => session.dispose(),
  };
}
