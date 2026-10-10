import type { BotId, ToolConnectionConfig } from "@baize/shared";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
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

/** 一次共享的连接：几条工具调用一起等同一个 initialize，谁的 signal 先响就把它整个撤掉。 */
interface Pending {
  readonly client: Promise<Client>;
  readonly control: AbortController;
  settled: boolean;
}

interface Link {
  readonly connection: ToolConnectionConfig;
  /** 正在连或已经连上的 client。连失败或被撤就清回 null，下一次调用再连。 */
  pending: Pending | null;
}

/**
 * Pi 自带工具的名字整组保留，不管这个 Bot 的会话实际装了哪几个：闸门按这些名字认运行器自己的工具，
 * 一个 MCP 操作叫 `write` 一旦注册成功，模型调 `write` 就走到了插件而闸门还按工作目录放行。
 * 名字从 Pi 导出的工厂拿，Pi 加工具这里跟着变；runner.test.ts 有一条用例拿它和 Pi 的 allToolNames 对账。
 */
export const PI_BUILT_IN_TOOLS: ReadonlySet<string> = new Set(
  [
    createReadToolDefinition,
    createBashToolDefinition,
    createPowerShellToolDefinition,
    createEditToolDefinition,
    createWriteToolDefinition,
    createGrepToolDefinition,
    createFindToolDefinition,
    createLsToolDefinition,
  ].map((factory) => factory(process.cwd()).name),
);

/** config.tools 里分配给这个 Bot 的连接，保持 config 里的先后。 */
export function connectionsFor(botId: BotId, tools: readonly ToolConnectionConfig[]): readonly ToolConnectionConfig[] {
  return tools.filter((tool) => tool.assignedBotIds.includes(botId));
}

type ResultBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** 上游模型认的图片格式，别的格式送过去整次请求会被拒。 */
const MODEL_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** 单张图的上限，按解码后的字节算。 */
const MODEL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const imageBlock = (data: string, mimeType: string): ResultBlock => {
  if (!MODEL_IMAGE_TYPES.has(mimeType)) {
    return {
      type: "text",
      text: `工具连接回了一张 ${mimeType} 的图模型看不了（只收 png、jpeg、gif、webp），没放进来。`,
    };
  }
  if (Buffer.byteLength(data, "base64") > MODEL_IMAGE_MAX_BYTES) {
    return {
      type: "text",
      text: `工具连接回了一张超过 ${MODEL_IMAGE_MAX_BYTES / 1024 / 1024} MiB 的图，太大没放进来。`,
    };
  }
  return { type: "image", data, mimeType };
};

/** MCP 结果里的 text 块原样进模型，image 块过一道格式和大小，资源这类块不进。SDK 已按协议校验过形状，这里只挑类型。 */
const blocksOf = (content: unknown): ResultBlock[] =>
  (Array.isArray(content) ? content : []).flatMap((block): ResultBlock[] => {
    if (block?.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
    if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      return [imageBlock(block.data, block.mimeType)];
    }
    return [];
  });

const textOf = (blocks: readonly ResultBlock[]): string =>
  blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

const reasonOf = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? `（${error.cause.message}）` : "";
  return `${error.message}${cause}`;
};

async function connect(connection: ToolConnectionConfig, signal: AbortSignal): Promise<Client> {
  const client = new Client({ name: "baize-bot-runner", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(connection.url),
    connection.authorization === null ? {} : { requestInit: { headers: { Authorization: connection.authorization } } },
  );
  // SDK 1.30 的 StreamableHTTPClientTransport 把 sessionId 声明成 `string | undefined`，Transport 要的是可省属性，
  // exactOptionalPropertyTypes 下两者不相容，只能在这里转一次。
  // signal 只管 initialize 这一问：一响 SDK 就拒掉并自己关掉 transport，不等它 60 秒的请求超时。
  await client.connect(transport as unknown as Transport, { signal });
  return client;
}

const startConnect = (link: Link): Pending => {
  const control = new AbortController();
  const pending: Pending = { control, settled: false, client: connect(link.connection, control.signal) };
  pending.client.then(
    () => (pending.settled = true),
    () => {
      pending.settled = true;
      if (link.pending === pending) link.pending = null;
    },
  );
  link.pending = pending;
  return pending;
};

// initialize 回了之后再 abort，SDK 还会照发一条 cancelled 通知，所以只撤还没回的。
const cancelConnect = (pending: Pending): void => {
  if (!pending.settled) pending.control.abort();
};

/** 拿连好的 client，没连就连。等 initialize 的时候 signal 一响，这次连接整个撤掉，本次调用当场结束。 */
const clientOf = (link: Link, signal: AbortSignal | undefined): Promise<Client> => {
  const pending = link.pending ?? startConnect(link);
  if (signal === undefined) return pending.client;
  const onAbort = (): void => cancelConnect(pending);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return pending.client.finally(() => signal.removeEventListener("abort", onAbort));
};

/**
 * 把分配给 Bot 的连接里的每个 operation 变成一个 Pi 工具。
 * 撞名先到先得：Pi 自带的名字、`reserved` 里已有的名字和前面连接已注册的名字都跳过，每个跳过 console.warn 一次。
 */
export function createMcpTools(options: {
  readonly botId: BotId;
  readonly connections: readonly ToolConnectionConfig[];
  readonly reserved: ReadonlySet<string>;
}): McpToolSet {
  const taken = new Set([...PI_BUILT_IN_TOOLS, ...options.reserved]);
  const links: Link[] = [];
  const tools: RunnerTool[] = [];
  const servers = new Map<string, string>();

  for (const connection of options.connections) {
    const link: Link = { connection, pending: null };
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
        execute: async (_callId, params, signal) => {
          let client: Client;
          try {
            client = await clientOf(link, signal);
          } catch (error) {
            return {
              content: [{ type: "text", text: `工具连接「${connection.name}」连不上：${reasonOf(error)}` }],
              details: {},
            };
          }
          // 停机和暂停的 abort 顺着 signal 传给 MCP，服务端收到 cancelled 通知，这边不等它回。
          const result = await client.callTool(
            { name: op.name, arguments: params as Record<string, unknown> },
            undefined,
            signal === undefined ? {} : { signal },
          );
          const blocks = blocksOf(result.content);
          const text = textOf(blocks);
          if (result.isError === true) throw new Error(text === "" ? `工具「${op.name}」报错，没有说明` : text);
          return {
            content: blocks.length === 0 ? [{ type: "text", text: "（工具没有返回文字）" }] : blocks,
            details: {},
          };
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
          const pending = link.pending;
          link.pending = null;
          if (pending === null) return;
          cancelConnect(pending);
          const client = await pending.client.catch(() => null);
          await client?.close();
        }),
      );
    },
  };
}
