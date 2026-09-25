import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ToolView } from "@baize/shared";
import { join } from "node:path";
import { Type } from "typebox";
import type { ApprovalGate } from "./approval.js";

// 一个 Bot 一个 AgentSession。每个会话自带 ModelRuntime、cwd、会话目录，
// 进程里同时跑多个时互不共享可变状态。

export const GATEWAY_PROVIDER_ID = "baize-gateway";
export const GATEWAY_MODEL_ID = "baize-gateway-model";

export interface BotSessionOptions {
  readonly botId: string;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly agentDir: string;
  readonly gatewayBaseUrl: string;
  /** 网关按这个 key 分账，一个 Bot 一个。 */
  readonly gatewayApiKey: string;
  readonly approvals: ApprovalGate;
  /** 哪些工具要先找人点头。 */
  readonly needsApproval: (toolName: string) => boolean;
  /** 工具函数体真正执行时往这里追加，用来证明被 block 的调用没有执行。 */
  readonly sideEffects: string[];
  /** 覆盖会话设置。测试用它关掉供应商 SDK 那层重试，好让上游错误冒到 Pi 的重试逻辑。 */
  readonly settings?: Parameters<typeof SettingsManager.inMemory>[0];
}

export interface BotSession {
  readonly botId: string;
  readonly session: AgentSession;
  readonly sessionFile: string | undefined;
  dispose(): void;
}

function botExtension(options: BotSessionOptions): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.registerTool({
      name: "send_email",
      label: "发邮件",
      description: "给客户发一封邮件。",
      parameters: Type.Object({ to: Type.String(), subject: Type.String(), body: Type.String() }),
      execute: async (_toolCallId, params) => {
        options.sideEffects.push(`send_email:${params.to}`);
        return { content: [{ type: "text", text: `已发送给 ${params.to}` }], details: {} };
      },
    });

    pi.registerTool({
      name: "list_files",
      label: "列文件",
      description: "列出一个目录下的文件。",
      parameters: Type.Object({ dir: Type.String() }),
      execute: async (_toolCallId, params) => {
        options.sideEffects.push(`list_files:${params.dir}`);
        return { content: [{ type: "text", text: `${params.dir} 下有 report.md` }], details: {} };
      },
    });

    pi.on("tool_call", async (event) => {
      if (!options.needsApproval(event.toolName)) return undefined;
      const decision = await options.approvals.request({
        callId: event.toolCallId,
        botId: options.botId,
        tool: event.toolName,
        view: {
          kind: "mcp",
          server: "",
          tool: event.toolName,
          params: [],
          raw: event.input as ToolView["raw"],
        },
      });
      return decision.approved ? undefined : { block: true, reason: decision.reason || "归属人拒绝了这个动作" };
    });
  };
}

export async function createBotSession(options: BotSessionOptions): Promise<BotSession> {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(options.agentDir, "auth.json"),
    // 不给的话 ModelsStore 落到 ~/.pi/agent/models-store.json，云电脑上会串到别的 Bot。
    modelsStorePath: join(options.agentDir, "models-store.json"),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });

  modelRuntime.registerProvider(GATEWAY_PROVIDER_ID, {
    name: "白泽模型网关",
    baseUrl: options.gatewayBaseUrl,
    apiKey: options.gatewayApiKey,
    api: "openai-completions",
    models: [
      {
        id: GATEWAY_MODEL_ID,
        name: "白泽网关模型",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
  });

  const model = modelRuntime.getModel(GATEWAY_PROVIDER_ID, GATEWAY_MODEL_ID);
  if (!model) throw new Error(`网关供应商没注册上：${GATEWAY_PROVIDER_ID}/${GATEWAY_MODEL_ID}`);

  const settingsManager = SettingsManager.inMemory(options.settings);
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [botExtension(options)],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    model,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.create(options.cwd, options.sessionDir),
    noTools: "builtin",
  });

  return {
    botId: options.botId,
    session,
    sessionFile: session.sessionManager.getSessionFile(),
    dispose: () => session.dispose(),
  };
}
