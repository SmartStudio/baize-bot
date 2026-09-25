import type { BotId, ToolConnectionConfig } from "@baize/shared";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Type } from "typebox";
import type { RunnerTool } from "./bot-session.js";

// 每条工具连接一个 MCP Client，第一次调用它的工具时才连。连不上不抛：工具结果里放一句中文，
// Bot 转述给用户，比整次 run 崩掉强。

export interface McpToolSet {
  readonly tools: readonly RunnerTool[];
  serverFor(toolName: string): string;
  close(): Promise<void>;
}

interface Link {
  readonly connection: ToolConnectionConfig;
  /** 正在连或已经连上的 client。连失败就清回 null，下一次调用再试。 */
  client: Promise<Client> | null;
}

/** config.tools 里分配给这个 Bot 的连接，保持 config 里的先后。 */
export function connectionsFor(botId: BotId, tools: readonly ToolConnectionConfig[]): readonly ToolConnectionConfig[] {
  return tools.filter((tool) => tool.assignedBotIds.includes(botId));
}

/** MCP 结果里 text 块的正文拼起来。图片、资源这类块不进模型，SDK 已按协议校验过形状，这里只挑类型。 */
const textOf = (content: unknown): string =>
  (Array.isArray(content) ? content : [])
    .filter(
      (block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");

const reasonOf = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? `（${error.cause.message}）` : "";
  return `${error.message}${cause}`;
};

async function connect(connection: ToolConnectionConfig): Promise<Client> {
  const client = new Client({ name: "baize-bot-runner", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(connection.url),
    connection.authorization === null ? {} : { requestInit: { headers: { Authorization: connection.authorization } } },
  );
  // SDK 1.30 的 StreamableHTTPClientTransport 把 sessionId 声明成 `string | undefined`，Transport 要的是可省属性，
  // exactOptionalPropertyTypes 下两者不相容，只能在这里转一次。
  await client.connect(transport as unknown as Transport);
  return client;
}

const clientOf = (link: Link): Promise<Client> => {
  if (link.client === null) {
    link.client = connect(link.connection).catch((error: unknown) => {
      link.client = null;
      throw error;
    });
  }
  return link.client;
};

/**
 * 把分配给 Bot 的连接里的每个 operation 变成一个 Pi 工具。
 * 撞名先到先得：`reserved` 里已有的名字和前面连接已注册的名字都跳过，每个跳过 console.warn 一次。
 */
export function createMcpTools(options: {
  readonly botId: BotId;
  readonly connections: readonly ToolConnectionConfig[];
  readonly reserved: ReadonlySet<string>;
}): McpToolSet {
  const taken = new Set(options.reserved);
  const links: Link[] = [];
  const tools: RunnerTool[] = [];
  const servers = new Map<string, string>();

  for (const connection of options.connections) {
    const link: Link = { connection, client: null };
    links.push(link);
    for (const op of connection.operations) {
      if (taken.has(op.name)) {
        console.warn(`Bot ${options.botId}：连接「${connection.name}」的操作「${op.name}」和已注册的工具重名，跳过`);
        continue;
      }
      taken.add(op.name);
      servers.set(op.name, connection.name);
      tools.push({
        name: op.name,
        label: op.name,
        description: op.description,
        // 控制面已经按 ToolOperation 收过这份 JSON Schema，这里原样交给 Pi 校验参数，不再翻译一遍。
        parameters: Type.Unsafe<Record<string, unknown>>(op.inputSchema),
        execute: async (_callId, params) => {
          let client: Client;
          try {
            client = await clientOf(link);
          } catch (error) {
            return {
              content: [{ type: "text", text: `工具连接「${connection.name}」连不上：${reasonOf(error)}` }],
              details: {},
            };
          }
          const result = await client.callTool({ name: op.name, arguments: params as Record<string, unknown> });
          const text = textOf(result.content);
          if (result.isError === true) throw new Error(text === "" ? `工具「${op.name}」报错，没有说明` : text);
          return { content: [{ type: "text", text: text === "" ? "（工具没有返回文字）" : text }], details: {} };
        },
      });
    }
  }

  return {
    tools,
    serverFor: (toolName) => servers.get(toolName) ?? "",
    close: async () => {
      await Promise.all(
        links.map(async (link) => {
          const pending = link.client;
          link.client = null;
          const client = await pending?.catch(() => null);
          await client?.close();
        }),
      );
    },
  };
}
